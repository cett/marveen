import { readBody, json } from '../http-helpers.js'
import { NON_ADMIN_SETTING_KEYS, NON_ADMIN_SETTING_ROW_FIELDS, pickFields } from '../non-admin-views.js'
import { logger } from '../../logger.js'
import { SETTINGS_REGISTRY, validateSettingValue } from '../../config-registry.js'
import { getEffectiveSettingValue, setOverride } from '../../settings-store.js'
import { logConfigChange } from '../../db.js'
import { RBAC_MODE_KEY, parseRbacMode, refreshRbacMode, describeRbacMode } from '../rbac-mode.js'
import { denyUnlessHumanSessionAlways, denyUnlessHumanOnlyEnforced } from '../session-only-guard.js'
import { humanSessionOf } from '../approval-human-only.js'
import { ROTATION_MODE_KEY, readRotationMode, parseRotationModeStrict } from '../plan-rotation-mode.js'
import { resetRotationGuards } from '../claude-plans-state.js'
import type { RouteContext } from './types.js'

const SECRET_MASK = '***'

export async function tryHandleSettings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/settings' && method === 'GET') {
    // secret:true entries are included so the UI can show/edit them, but the
    // real value never leaves this process -- getEffectiveSettingValue() is
    // never called for a secret key, the row always reports the mask.
    // Every session reads the language at boot. Anyone but the admin gets only the allowlisted keys and
    // row fields; the filter runs BEFORE the values are read, so nothing else is even resolved for them.
    const isAdmin = ctx.role === 'admin'
    const visible = isAdmin ? SETTINGS_REGISTRY : SETTINGS_REGISTRY.filter((def) => NON_ADMIN_SETTING_KEYS.includes(def.key))
    // CLAUDE_ROTATION_MODE reports what the monitor applies, like RBAC_MODE: an env-file value or a row that
    // did not come through the settings route must not read as the live mode. Read before the synchronous map.
    const rotation = visible.some((d) => d.key === ROTATION_MODE_KEY) ? await readRotationMode() : null
    const rows = visible.map((def) => {
      // RBAC_MODE reports what the gate actually applies (not the raw row): `value` is the live mode,
      // `stored` the row and `reason` why a stored shadow is not in force (null when they agree).
      const rbac = def.key === RBAC_MODE_KEY ? describeRbacMode() : null
      return {
        key: def.key,
        type: def.type,
        value: rbac
          ? rbac.effective
          : def.key === ROTATION_MODE_KEY && rotation
            ? rotation.mode
            : def.secret
              ? SECRET_MASK
              : getEffectiveSettingValue(def.key),
        ...(rbac ? { stored: rbac.stored, reason: rbac.reason } : {}),
        ...(def.key === ROTATION_MODE_KEY && rotation ? { stored: rotation.stored, reason: rotation.reason } : {}),
        default: def.default,
        description: def.description,
        module: def.module,
        requiresRestart: def.requiresRestart,
        valueSet: def.valueSet,
        min: def.min,
        max: def.max,
        secret: def.secret,
        envOnly: def.envOnly === true,
      }
    })
    json(res, { settings: isAdmin ? rows : rows.map((r) => pickFields(r, NON_ADMIN_SETTING_ROW_FIELDS)) })
    return true
  }

  if (path === '/api/settings' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { key, value, actor } = JSON.parse(body.toString())

      if (!key || typeof key !== 'string') {
        json(res, { error: 'required', field: 'key', hint: 'key must be a non-empty string' }, 400)
        return true
      }

      const def = SETTINGS_REGISTRY.find((s) => s.key === key)
      if (!def) {
        json(res, { error: 'not_found', hint: `Unknown setting key: ${key}` }, 404)
        return true
      }
      if (def.secret) {
        // Standalone admin check, independent of the fleet-wide RBAC_MODE
        // shadow/enforce toggle: applyRbacGate() is a no-op in shadow mode,
        // so relying on it alone would let any authenticated caller write a
        // secret while RBAC_MODE stays 'shadow'.
        if (ctx.role !== 'admin') {
          json(res, { error: 'forbidden', hint: 'Only admin can change secret settings' }, 403)
          return true
        }
        if (value === SECRET_MASK) {
          // Mask-writeback: the UI re-submitted the masked placeholder
          // unchanged (e.g. saved the form without editing the secret
          // field). Treat as a no-op, never write the literal mask to DB.
          json(res, { ok: true, key, value: SECRET_MASK, requiresRestart: def.requiresRestart })
          return true
        }
      }

      if (def.envOnly) {
        // Checked after the admin gate so a non-admin still gets the plain 403, and before validation
        // and the write so nothing reaches system_config (which this key is never read from).
        json(res, { error: 'not_supported', hint: `${key} can only be set in the env file, not through the API` }, 400)
        return true
      }

      // Validate before touching anything. setOverride re-validates
      // internally too, but checking here lets us read the "old" value for
      // the change log without assuming the write will succeed.
      const validation = validateSettingValue(def, value)
      if (!validation.ok) {
        json(res, { error: 'invalid_value', field: 'value', hint: validation.hint }, 400)
        return true
      }

      // Loosening the RBAC gate is the one write that switches a protection off, so it needs a person:
      // a token, the main agent's included, must not be able to open its own gate. Tightening is open
      // to any admin caller. Checked before anything is written.
      const isRbacMode = key === RBAC_MODE_KEY
      const looseningRbac = isRbacMode && parseRbacMode(validation.value) === 'shadow'
      // A human session proves a person only while a token cannot mint one: with the human-only switch
      // off a token can create the dashboard admin that would loosen the gate, so loosening is refused then.
      if (
        looseningRbac &&
        await denyUnlessHumanOnlyEnforced(
          ctx,
          'settings.rbac_mode.loosen',
          'Switching the RBAC gate to shadow is only possible while APPROVAL_HUMAN_ONLY_ENFORCE is on; with it off a token can create the dashboard user that would do it',
        )
      ) {
        return true
      }
      if (
        looseningRbac &&
        await denyUnlessHumanSessionAlways(
          ctx,
          'settings.rbac_mode.loosen',
          'Switching the RBAC gate to shadow needs a person logged in to the dashboard as a global admin',
        )
      ) {
        return true
      }

      // CLAUDE_ROTATION_MODE decides whether an unattended process may restart the main agent's session. Every
      // write needs a person logged in as a global admin (a token, the main agent's included, is refused for
      // off and observe too: nobody quietly switches the monitor off), and moving TO act also needs the
      // human-only switch on: with it off a token can create the dashboard user that would do it.
      const isRotationMode = key === ROTATION_MODE_KEY
      let rotationHuman: { user: string } | null = null
      if (isRotationMode) {
        if (
          parseRotationModeStrict(validation.value) === 'act' &&
          await denyUnlessHumanOnlyEnforced(
            ctx,
            'settings.rotation_mode.write',
            'Switching the plan-rotation monitor to act is only possible while APPROVAL_HUMAN_ONLY_ENFORCE is on; with it off a token can create the dashboard user that would do it',
          )
        ) {
          return true
        }
        if (
          await denyUnlessHumanSessionAlways(
            ctx,
            'settings.rotation_mode.write',
            'The plan-rotation mode can only be changed by a person logged in to the dashboard as a global admin',
          )
        ) {
          return true
        }
        rotationHuman = await humanSessionOf(ctx.req)
      }

      // For the rotation mode the journal actor is the session's user, not the body's free-text field.
      const resolvedActor = rotationHuman
        ? rotationHuman.user
        : typeof actor === 'string' && actor ? actor : 'dashboard'
      const oldValue = getEffectiveSettingValue(key)
      const result = await setOverride(key, value)
      if (!result.ok) {
        json(res, { error: 'internal_error', hint: result.error }, 500)
        return true
      }

      // secret:true keys: the audit trail (config_change_log DB rows + the
      // pino log) must never carry the real value in plaintext, even though
      // this same write path is fine to log verbatim for non-secret keys.
      // Before S6 this branch was unreachable for a secret key (POST always
      // 403'd), so the plaintext logging here was harmless dead code for
      // them; S6 opens the write path, so this mask closes it in the same
      // step that introduced the exposure.
      const loggedOldValue = def.secret ? SECRET_MASK : oldValue
      const loggedNewValue = def.secret ? SECRET_MASK : validation.value!
      await logConfigChange(key, loggedOldValue, loggedNewValue, resolvedActor)
      logger.info({ key, oldValue: loggedOldValue, newValue: loggedNewValue }, 'Setting updated')
      if (isRotationMode) {
        // A person has written the mode: that re-arms a tripped breaker and a restart-failure give-up.
        try {
          if (resetRotationGuards(Date.now())) logger.info({ actor: resolvedActor }, 'Plan-rotation guards reset by a mode change')
        } catch (err) {
          logger.warn({ err }, 'Could not reset the plan-rotation guards')
        }
      }
      if (isRbacMode) {
        // The write and its journal row are both in: the cache can now read a consistent pair.
        await refreshRbacMode()
        // The notice to the main agent comes from refreshRbacMode (every switch to shadow); the actor is in the journal.
        if (looseningRbac) {
          logger.warn({ actor: resolvedActor, oldValue }, 'RBAC_MODE set to shadow: the RBAC gate no longer blocks')
        }
      }
      json(res, { ok: true, key, value: validation.value, requiresRestart: def.requiresRestart })
    } catch (err) {
      logger.error({ err }, 'Failed to update setting')
      json(res, { error: 'internal_error', hint: 'Failed to update setting' }, 500)
    }
    return true
  }

  return false
}
