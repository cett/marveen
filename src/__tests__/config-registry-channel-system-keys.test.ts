import { describe, it, expect } from 'vitest'
import { getSettingDefinition, validateSettingValue, SETTINGS_REGISTRY } from '../config-registry.js'

// Covers the new channel/system registry entries added alongside the
// system_config DB-only write path: TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID,
// CHANNEL_PROVIDER, MAIN_AGENT_ID, WEB_PORT. The generic route-level
// secret-filtering/403 behaviour and the generic DB-only write mechanism are
// already covered elsewhere (settings-routes-remaining.test.ts,
// settings-store.test.ts) -- this file only proves these specific entries'
// own shape and validation rules are correct.

describe('TELEGRAM_BOT_TOKEN / ALLOWED_CHAT_ID registry entries', () => {
  it('are both marked secret + requiresRestart', () => {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_CHAT_ID']) {
      const def = getSettingDefinition(key)
      expect(def, `${key} missing from SETTINGS_REGISTRY`).toBeDefined()
      expect(def!.secret, `${key}.secret`).toBe(true)
      expect(def!.requiresRestart, `${key}.requiresRestart`).toBe(true)
    }
  })

  it('appear exactly once each in the registry (no accidental duplicate key)', () => {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_CHAT_ID']) {
      expect(SETTINGS_REGISTRY.filter((d) => d.key === key)).toHaveLength(1)
    }
  })
})

describe('CHANNEL_PROVIDER registry entry', () => {
  const def = getSettingDefinition('CHANNEL_PROVIDER')!

  it('is not secret, requires a restart, and defaults to telegram', () => {
    expect(def.secret).toBe(false)
    expect(def.requiresRestart).toBe(true)
    expect(def.default).toBe('telegram')
  })

  // Matches ChannelProviderType exactly (src/channel-provider.ts) -- a
  // narrower valueSet here would make a fully-supported provider
  // un-settable from the Settings UI even though the app accepts it.
  it('valueSet covers every ChannelProviderType member', () => {
    expect(def.valueSet).toEqual(['telegram', 'slack', 'discord', 'googlechat', 'teams'])
  })

  it('accepts every valid provider and rejects an unknown one', () => {
    for (const provider of ['telegram', 'slack', 'discord', 'googlechat', 'teams']) {
      expect(validateSettingValue(def, provider)).toEqual({ ok: true, value: provider })
    }
    const result = validateSettingValue(def, 'whatsapp')
    expect(result.ok).toBe(false)
  })
})

describe('MAIN_AGENT_ID registry entry', () => {
  const def = getSettingDefinition('MAIN_AGENT_ID')!

  it('is not secret, requires a restart, and defaults to marveen', () => {
    expect(def.secret).toBe(false)
    expect(def.requiresRestart).toBe(true)
    expect(def.default).toBe('marveen')
    expect(def.type).toBe('string')
  })

  it('accepts an arbitrary non-empty slug', () => {
    expect(validateSettingValue(def, 'acmeai')).toEqual({ ok: true, value: 'acmeai' })
  })
})

describe('WEB_PORT registry entry', () => {
  const def = getSettingDefinition('WEB_PORT')!

  it('is an int, not secret, requires a restart, and defaults to 3420', () => {
    expect(def.type).toBe('int')
    expect(def.secret).toBe(false)
    expect(def.requiresRestart).toBe(true)
    expect(def.default).toBe(3420)
  })

  it('accepts a valid port and rejects out-of-range values', () => {
    expect(validateSettingValue(def, 8080)).toEqual({ ok: true, value: 8080 })
    expect(validateSettingValue(def, 1)).toEqual({ ok: true, value: 1 })
    expect(validateSettingValue(def, 65535)).toEqual({ ok: true, value: 65535 })
    expect(validateSettingValue(def, 0).ok).toBe(false)
    expect(validateSettingValue(def, 70000).ok).toBe(false)
    expect(validateSettingValue(def, 3.5).ok).toBe(false)
  })
})
