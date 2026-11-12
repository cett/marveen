import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  listPendingTaskRetries, deletePendingTaskRetryById, listTaskRunHistory,
  getScheduleFromDb, listSchedulesFromDb, deleteSchedule, setScheduleEnabled, countSchedules,
  activateSchedule, getTenant, listDeadLetterTaskRuns,
} from '../../db.js'
import { buildDeadLetterResponse, parseDeadLetterParams } from '../schedule-dead-letter.js'
import { MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { runAgent } from '../../agent.js'
import { logger } from '../../logger.js'
import { toPendingRetryView } from '../../pending-retries.js'
import { readLastBoot } from '../boot-marker.js'
import { isValidCronShape } from '../cron.js'
import { readBody, json, RequestBodyTooLargeError, SCHEDULE_BODY_MAX_BYTES } from '../http-helpers.js'
import { sanitizeScheduleName, safeJoin } from '../sanitize.js'
import { listAgentNames } from '../agent-config.js'
import { DEFAULT_SCHEDULE_TENANT, creatorTenant, scheduleAgentNamesForTenant, scheduleAgentServesTenant } from '../schedule-tenant.js'
import {
  SCHEDULED_TASKS_DIR, MAX_SCHEDULED_TASK_PROMPT_LEN,
  listScheduledTasks, listScheduledTasksFromFiles, writeScheduledTask, rowToTask, isTaskLive,
} from '../scheduled-tasks-io.js'
import { withScheduleLock } from '../schedule-lock.js'
import { REVIEWED_FIELDS, reviewTriggerFields, reviewValueSha256, scheduleContentHash } from '../schedule-review.js'
import { auditScheduleWrite, isHumanAdmin, notifyScheduleReview, scheduleActor, scheduleAuthor } from '../schedule-review-effects.js'
import { createAuthorChecker } from '../schedule-author.js'
import { runScheduledTaskNow, loadLastTickMs, computeTickStatus } from '../schedule-runner.js'
import { actingAgentId } from '../fleet-agent-identity.js'
import type { RouteContext } from './types.js'

import { noteTenantResolved } from '../../db/context.js'
// Review-gate: every fleet agent authenticates with
// the same shared dashboard-token bearer, which resolves to role='admin' for
// backward-compat (src/web/authz.ts) -- so ctx.role==='admin' cannot tell
// "a human approved this" from "an agent proposed this". A real dashboard
// login (auth.kind==='session') is the only signal that a human is actually
// driving the request; that plus role==='admin' is what "admin" means for
// every review-gate decision below (schedule creation status, activation,
// running a non-live task). This deliberately makes agent-token callers
// weaker here than they are for the rest of this route (which still treats
// them as admin) -- that gap IS the governance boundary this feature exists
// to create. The check itself lives in schedule-review-effects.ts (isHumanAdmin).

// Tenant scope helpers (mirrors artifacts/kanban pattern). Every task belongs to a tenant;
// there is no tenant-less "fleet" scope.
// - Admin with no ?tenant= filter sees all tenants (effectiveTenantId = null → all).
// - Admin with ?tenant=<id> sees only that tenant.
// - Non-admin is restricted to their own tenant.
function effectiveTenant(ctx: RouteContext): string | null {
  if (ctx.role === 'admin') return ctx.url.searchParams.get('tenant') ?? null  // null = all
  return noteTenantResolved(ctx.tenantId ?? 'default')
}

// Does a schedule row fall in the tenant scope effectiveTenant() computed? A missing
// row never matches. A stored NULL (a row older than migration 0066) is the default tenant.
function scheduleTenantMatches(scope: string | null, row: { tenant_id: string | null } | undefined): boolean {
  if (!row) return false
  return scope === null || (row.tenant_id ?? DEFAULT_SCHEDULE_TENANT) === scope
}

function crossTenantBlocked(ctx: RouteContext, scheduleTenantId: string | null): boolean {
  if (ctx.role === 'admin') return false
  return (scheduleTenantId ?? DEFAULT_SCHEDULE_TENANT) !== (ctx.tenantId ?? 'default')
}

// Most tasks a tenant may have waiting for a person (draft or pending_review) at once. Without a
// cap a tenant user, or an agent acting for one, could fill the admin's review queue with
// proposals; the cap is the cheap answer, and applies to creating a draft only (an edit of a
// task the tenant already owns cannot raise the number of tasks it has).
export const MAX_OPEN_REVIEW_PER_TENANT = 20

// Route-level rules for a caller that is not an admin, whatever RBAC_MODE says. They hold in
// shadow mode too, so the permission rows in rbac.ts only add to them. ctx.role === 'admin' (a
// signed-in admin or the shared token every fleet agent uses) is exempt: what those callers may
// write is decided by the review gate, not here.
//  - no tenant: such an account would otherwise read the default tenant's (system) tasks
//    through the `?? 'default'` fallback below; the approvals route closes the same hole.
//  - writes need a signed-in user or an API token. A device key is role 'agent' on tenant
//    'default', exactly the tenant of the system tasks, and is not a person who can be held to
//    the review gate.
//  - writes on the default tenant stay with the admins: its tasks are the fleet's own.
function nonAdminRefusal(ctx: RouteContext): string | null {
  if (ctx.role === 'admin') return null
  if (ctx.tenantId == null) return 'This account is not assigned to a tenant'
  if (ctx.method === 'GET' || ctx.method === 'HEAD') return null
  if (ctx.auth?.kind !== 'session' && ctx.auth?.kind !== 'token') return 'Only a signed-in user or an API token can change schedules'
  if (ctx.tenantId === DEFAULT_SCHEDULE_TENANT) return "Only an admin can change the default tenant's schedules"
  return null
}

// Fields a PUT may write. Everything else in the body is dropped before it reaches
// writeScheduledTask, which would otherwise take any of its keys at face value: the
// review-gate `status` (a draft made live without the human activation step), the
// raw `tenantId`, and the keys that point the runner at a script or change its
// catch-up/stuck handling (`preCheck`, `catchUpMaxAgeMinutes`, `stuckAfterMinutes`,
// `requires`), none of which the dashboard or the CRUD recipe edits. `agent` is
// admin-only and `tenant_id` is human-admin-only: see the PUT handler.
const PUT_FIELDS = [
  'description', 'prompt', 'schedule', 'enabled', 'type', 'skipIfBusy', 'forceSend',
  'targetSession', 'command', 'timeoutMs', 'failThreshold',
] as const

// Resolve a URL-supplied schedule name to an on-disk dir, blocking path
// traversal. sanitizeScheduleName strips everything outside [a-z0-9-] (so no
// "." or "/" survives), the empty check rejects a name that sanitized away
// (which would otherwise resolve to the tasks root and delete/overwrite it),
// and safeJoin is a belt-and-suspenders guard against escaping the base.
function resolveScheduleDir(rawName: string): { name: string; dir: string } | null {
  let decoded: string
  try { decoded = decodeURIComponent(rawName) } catch { return null }
  const name = sanitizeScheduleName(decoded)
  if (!name) return null
  try {
    return { name, dir: safeJoin(SCHEDULED_TASKS_DIR, name) }
  } catch { return null }
}

// Shape check for the command-task fields shared by POST and PUT. Returns the
// 400 body, or null when the fields are fine. `command` must be a non-empty
// string when required; timeoutMs / failThreshold are positive integers when
// present (the runner takes them as milliseconds / a consecutive-failure count).
function validateCommandFields(
  data: { command?: unknown; timeoutMs?: unknown; failThreshold?: unknown },
  opts: { commandRequired: boolean },
): { error: string; field: string; hint: string } | null {
  if (data.command !== undefined && typeof data.command !== 'string') {
    return { error: 'invalid_value', field: 'command', hint: 'command must be a string' }
  }
  if (opts.commandRequired && !(data.command as string | undefined)?.trim()) {
    return { error: 'required', field: 'command', hint: 'A command task needs a command' }
  }
  for (const field of ['timeoutMs', 'failThreshold'] as const) {
    const v = data[field]
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isInteger(v) && v > 0)) {
      return { error: 'invalid_value', field, hint: `${field} must be a positive integer` }
    }
  }
  return null
}

export async function tryHandleSchedules(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/schedules' || path.startsWith('/api/schedules/')) {
    const refusal = nonAdminRefusal(ctx)
    if (refusal) { json(res, { error: 'forbidden', hint: refusal }, 403); return true }
  }

  // Scheduler liveness for the dashboard's heartbeat indicator (schedule-state-ui):
  // whether the schedule-runner's tick loop has stamped schedule_last_tick_ms
  // recently. Admin-only -- it is an operator/ops signal, not tenant data,
  // same rationale as model-fallback.ts and costops-budgets.ts.
  if (path === '/api/schedules/tick-status' && method === 'GET') {
    if (ctx.role !== 'admin') {
      json(res, { error: 'forbidden', hint: 'Scheduler tick status is admin-only' }, 403)
      return true
    }
    // lastBoot is additive: the existing fields are unchanged (null until the first boot has been recorded).
    json(res, { ...computeTickStatus(loadLastTickMs(), Date.now()), lastBoot: readLastBoot() })
    return true
  }

  // Dead-letter view (read-only): scheduled occurrences that did not run (non-start task_runs rows in the window plus
  // the retries still pending). Registered here, ahead of every generic /api/schedules/:name handler below, so the
  // segment is never taken for a schedule name. RBAC: the /api/schedules GET prefix rule (schedules:read); the
  // tenant scope is the one /pending uses, so a tenant caller never sees another tenant's rows.
  if (path === '/api/schedules/dead-letter' && method === 'GET') {
    const params = parseDeadLetterParams(ctx.url.searchParams)
    if (!params.ok) {
      json(res, { error: 'invalid_value', field: params.field, hint: params.hint }, 400)
      return true
    }
    const scope = effectiveTenant(ctx)
    const now = Date.now()
    // One row more than the limit, so truncation is known without a second query.
    const runs = await listDeadLetterTaskRuns(now - params.days * 86_400_000, scope, params.limit + 1)
    const pending = await listPendingTaskRetries()
    // the schedule row is read per retry, so the tenant check settles before the filter (an async predicate would be always truthy)
    const visible = await Promise.all(pending.map(async r => scope === null || scheduleTenantMatches(scope, await getScheduleFromDb(r.task_name))))
    json(res, buildDeadLetterResponse(params, runs, pending.filter((_, i) => visible[i])))
    return true
  }

  if (path === '/api/schedules/agents' && method === 'GET') {
    // A tenant caller only sees the agents that serve their tenant (an agent's name is
    // not theirs to enumerate otherwise); an admin sees every agent, or those of the
    // tenant picked with ?tenant=.
    const scope = effectiveTenant(ctx)
    const allowed = new Set(await scheduleAgentNamesForTenant(scope))
    const agents = [
      { name: MAIN_AGENT_ID, label: currentBotName(), avatar: '/api/marveen/avatar' },
      ...listAgentNames().map(n => ({ name: n, label: n, avatar: `/api/agents/${encodeURIComponent(n)}/avatar` }))
    ].filter(a => allowed.has(a.name))
    json(res, agents)
    return true
  }

  if (path === '/api/schedules/expand-questions' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, agent } = JSON.parse(body.toString()) as { prompt: string; agent?: string }
    if (!prompt?.trim()) { json(res, { error: 'required', field: 'prompt', hint: 'Prompt is required' }, 400); return true }

    const aiPrompt = `A felhasznalo egy utemezett feladatot akar letrehozni egy AI agensnek. A rovid leirasa:
"${prompt.trim()}"
${agent ? `Az agens neve: ${agent}` : ''}

Generalj 3-4 feleletvalasztos kerdest, amivel pontositani lehet a feladatot. Minden kerdeshez adj 2-4 valaszlehetoseget.

Valaszolj KIZAROLAG JSON formatumban, semmi mas:
[
  {"question": "Kerdes szovege?", "options": ["Opcio 1", "Opcio 2", "Opcio 3"]},
  {"question": "Masik kerdes?", "options": ["A", "B"]}
]`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) throw new Error('Invalid response format')
      const questions = JSON.parse(jsonMatch[0])
      json(res, questions)
    } catch (err) {
      logger.error({ err }, 'Failed to generate expand questions')
      json(res, { error: 'internal_error', hint: 'Failed to generate questions' }, 500)
    }
    return true
  }

  if (path === '/api/schedules/expand-prompt' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, answers } = JSON.parse(body.toString()) as { prompt: string; answers: { question: string; answer: string }[] }
    if (!prompt?.trim()) { json(res, { error: 'required', field: 'prompt', hint: 'Prompt is required' }, 400); return true }

    const answersText = answers.map((a: { question: string; answer: string }) => `Kerdes: ${a.question}\nValasz: ${a.answer}`).join('\n\n')

    const aiPrompt = `Bovitsd ki ezt a rovid feladat-leirast egy reszletes, egyertelmu promptta amit egy AI asszisztens vegre tud hajtani.
A prompt legyen magyar nyelvu, konkret utasitasokkal.

Rovid leiras: "${prompt.trim()}"

A felhasznalo valaszai a pontosito kerdesekre:
${answersText}

Az eredmeny CSAK a kibovitett prompt szovege legyen, semmi mas. Ne hasznalj code fence-t.`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      let expanded = text.trim()
      if (expanded.startsWith('```')) expanded = expanded.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
      json(res, { prompt: expanded })
    } catch (err) {
      logger.error({ err }, 'Failed to expand prompt')
      json(res, { error: 'internal_error', hint: 'Failed to expand prompt' }, 500)
    }
    return true
  }

  if (path === '/api/schedules' && method === 'GET') {
    const useDb = await countSchedules() > 0
    if (useDb) {
      const scope = effectiveTenant(ctx)
      const rows = scope === null ? await listSchedulesFromDb() : await listSchedulesFromDb({ tenantId: scope })
      // DB rows key on `id`; the frontend (and the file-based branch below)
      // expect `name` -- without this mapping, delete/toggle/run/edit send
      // requests to /api/schedules/undefined and silently 404.
      // contentHash fingerprints what an approval covers; the dashboard sends it back as
      // expected_hash on activation so an admin approves what they were looking at.
      // authorState is the verdict the run-time gate would give today (none = no user-bound author), whatever the
      // gate mode is: a screen has to show a task that would stop in enforce mode. One checker per request, so ten
      // tasks of one author are one lookup. The word is given to every caller; the author's id and names are not.
      const checkAuthor = createAuthorChecker()
      json(res, await Promise.all(rows.map(async r => {
        const task = rowToTask(r)
        const authorState = task.authorUserId == null ? 'none' : await checkAuthor(task)
        // The author's user id and the two names (author, activator) are for an admin: a label can be a privileged
        // account's username, and listing accounts to a tenant caller is a leak. The activation time stays. The hash
        // below does not depend on any of them.
        if (ctx.role !== 'admin') { delete task.authorUserId; delete task.authorLabel; delete task.activatedBy }
        return { ...task, authorState, contentHash: scheduleContentHash({ ...task }, REVIEWED_FIELDS) }
      })))
    } else {
      json(res, listScheduledTasksFromFiles())
    }
    return true
  }

  if (path === '/api/schedules' && method === 'POST') {
    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: SCHEDULE_BODY_MAX_BYTES })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: 'limit_exceeded', hint: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      name: string; description: string; prompt: string; schedule: string; agent?: string;
      type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string;
      command?: string; timeoutMs?: number; failThreshold?: number;
      tenant_id?: string
    }
    const name = sanitizeScheduleName(data.name || '')
    if (!name) { json(res, { error: 'required', field: 'name', hint: 'Name is required' }, 400); return true }
    const isCommand = data.type === 'command'
    // A command task runs a shell command and has no LLM prompt: it needs a
    // command, and the prompt is optional. Every other type still needs a prompt.
    if (isCommand) {
      const bad = validateCommandFields(data, { commandRequired: true })
      if (bad) { json(res, bad, 400); return true }
    } else if (!data.prompt?.trim()) {
      json(res, { error: 'required', field: 'prompt', hint: 'Prompt is required' }, 400); return true
    }
    if ((data.prompt ?? '').length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: 'limit_exceeded', field: 'prompt', hint: `Prompt too large (${(data.prompt ?? '').length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (!data.schedule?.trim()) { json(res, { error: 'required', field: 'schedule', hint: 'Schedule is required' }, 400); return true }
    if (!isValidCronShape(data.schedule)) { json(res, { error: 'invalid_value', field: 'schedule', hint: 'Invalid cron expression' }, 400); return true }

    const useDb = await countSchedules() > 0
    const existing = useDb ? await getScheduleFromDb(name) : existsSync(join(SCHEDULED_TASKS_DIR, name))
    if (existing) { json(res, { error: 'conflict', hint: 'Schedule already exists' }, 409); return true }

    // Which tenant owns the task, first match wins:
    //  1. an admin names one (tenant_id);
    //  2. a non-admin caller: its own tenant;
    //  3. an agent on the shared token (X-Agent-Id, self-declared, not authentication): the tenant
    //     of the request it is serving. The task is only ever a draft and a person activates it,
    //     with the tenant shown, so a wrong claim is caught there;
    //  4. a human at the dashboard names none: the default tenant.
    // Anything else (a shared token with no X-Agent-Id, or an agent whose tenant is ambiguous) is
    // refused instead of guessed.
    const isAdmin = ctx.role === 'admin'
    const claimedAgent = String(req.headers['x-agent-id'] ?? '').trim()
    let tenantId: string | null
    if (!isAdmin) tenantId = ctx.tenantId ?? DEFAULT_SCHEDULE_TENANT
    else if (typeof data.tenant_id === 'string' && data.tenant_id.trim()) tenantId = data.tenant_id.trim()
    else if (isHumanAdmin(ctx)) tenantId = DEFAULT_SCHEDULE_TENANT
    else tenantId = claimedAgent ? await creatorTenant(claimedAgent) : null
    if (!tenantId) {
      json(res, {
        error: 'tenant_required', field: 'tenant_id',
        hint: 'Send tenant_id, or X-Agent-Id when the agent serves a request of one tenant. A shared agent with no request context has no tenant of its own.',
      }, 400)
      return true
    }
    const tenant = await getTenant(tenantId)
    if (!tenant || tenant.disabled_at) {
      json(res, { error: 'invalid_value', field: 'tenant_id', hint: 'Unknown or disabled tenant' }, 400)
      return true
    }
    // A tenant other than the default has no default agent: the fleet main agent may not serve it.
    // A fleet_agent token that names no agent acts as itself (actingAgentId), never as this
    // fallback -- so a fleet agent creating its own tenant's task needs no `agent` field.
    const agent = actingAgentId(ctx, data.agent, tenantId === DEFAULT_SCHEDULE_TENANT ? MAIN_AGENT_ID : '')
    if (!agent) { json(res, { error: 'required', field: 'agent', hint: 'A task of a non-default tenant needs an agent that serves it' }, 400); return true }
    if (!await scheduleAgentServesTenant(agent, tenantId)) {
      json(res, { error: 'invalid_value', field: 'agent', hint: `Agent '${agent}' does not serve tenant '${tenantId}'` }, 400)
      return true
    }

    // Review-gate: only a real human dashboard
    // login creates a task directly as 'live'. Every other caller -- which,
    // per the isHumanAdmin comment above, includes every fleet agent on the
    // shared bearer token -- gets 'draft' regardless of what it asks for;
    // an admin human must activate it (PUT .../activate) before the runner
    // will ever fire it.
    const status: 'draft' | 'live' = isHumanAdmin(ctx) ? 'live' : 'draft'
    if (status === 'draft') {
      const open = (await listSchedulesFromDb({ tenantId })).filter(r => r.status !== 'live').length
      if (open >= MAX_OPEN_REVIEW_PER_TENANT) {
        json(res, {
          error: 'limit_exceeded', field: 'name',
          hint: `This tenant already has ${open} schedules waiting for review (max ${MAX_OPEN_REVIEW_PER_TENANT}); an admin must activate or delete some first`,
        }, 400)
        return true
      }
    }

    // Who wrote it, and (only for a human admin's direct live creation) who activated it. A draft has no activator.
    const author = await scheduleAuthor(ctx)
    const activation = status === 'live' ? { by: author.label, at: Math.floor(Date.now() / 1000) } : undefined
    await writeScheduledTask(name, {
      description: data.description || '',
      prompt: (data.prompt ?? '').trim(),
      schedule: data.schedule.trim(),
      agent,
      enabled: true,
      type: data.type || 'task',
      skipIfBusy: data.skipIfBusy === true,
      forceSend: data.forceSend === true,
      targetSession: data.targetSession || undefined,
      ...(isCommand ? { command: data.command!.trim(), timeoutMs: data.timeoutMs, failThreshold: data.failThreshold } : {}),
      tenantId,
      status,
      author,
      ...(activation ? { activation } : {}),
    })
    await auditScheduleWrite(ctx, 'create', name, tenantId, {
      status, type: data.type || 'task', agent, author_label: author.label, activated_by: activation?.by ?? null,
    })
    if (status === 'draft') await notifyScheduleReview({ name, tenant: tenantId, reason: 'created', by: scheduleActor(ctx).agentId })
    logger.info({ name, schedule: data.schedule, tenantId, status }, 'Scheduled task created')
    json(res, { ok: true, name, status })
    return true
  }

  // Activation: the only way a draft/pending_review
  // task becomes runnable. Human-admin-only (see isHumanAdmin) -- an agent
  // token, even though it otherwise carries role='admin', cannot self-approve
  // its own proposed schedule.
  const scheduleActivateMatch = path.match(/^\/api\/schedules\/([^/]+)\/activate$/)
  if (scheduleActivateMatch && method === 'POST') {
    if (!isHumanAdmin(ctx)) { json(res, { error: 'forbidden', hint: 'Only an authenticated admin can activate a schedule' }, 403); return true }
    const resolved = resolveScheduleDir(scheduleActivateMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name } = resolved
    // Read, hash check, activation and mirror are one step: a save between the hash check and the
    // activation would approve content nobody reviewed (the db is async, nothing else orders them).
    await withScheduleLock(name, async () => {
      const current = await getScheduleFromDb(name)
      if (!current) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
      // The admin's screen was rendered from a content hash (see the list above). If the task
      // changed since -- the tenant edited the draft or the held task before the click --
      // activating would approve content nobody looked at. Optional so a caller that has no
      // screen (the CRUD recipe) keeps working; it is a human-only route either way.
      const currentHash = scheduleContentHash({ ...rowToTask(current) }, REVIEWED_FIELDS)
      const expectedHash = ctx.url.searchParams.get('expected_hash')
      if (expectedHash !== null && expectedHash !== currentHash) {
        json(res, {
          error: 'stale_revision', content_hash: currentHash,
          hint: 'The schedule changed since it was loaded; review the current content and activate again',
        }, 409)
        return true
      }
      // The activator is recorded in the same statement as the status; the author is not touched.
      const activator = scheduleActor(ctx).agentId
      const row = await activateSchedule(name, activator)
      if (!row) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
      await auditScheduleWrite(ctx, 'activate', name, current.tenant_id ?? DEFAULT_SCHEDULE_TENANT, {
        status_before: current.status, content_hash: currentHash, hash_checked: expectedHash !== null,
        author_label: row.author_label ?? null, activated_by: activator,
      })
      // Mirror to file (same pattern as toggle's file-mirror call) so a
      // rollback to the file-based fallback keeps the activated state.
      await writeScheduledTask(name, { status: 'live' })
      logger.info({ name }, 'Scheduled task activated')
      json(res, { ok: true, status: 'live' })
    })
    return true
  }

  // Adoption: a signed-in admin takes over a task whose author may no longer run it. The caller becomes the author
  // (the run-time gate then judges the caller); the status, the content and the activation record stay as they were,
  // so adopting never approves anything and never makes a held task live. Same shape as the activation: human admin
  // only, one lock for the hash check and the write, an optional expected_hash.
  const scheduleAdoptMatch = path.match(/^\/api\/schedules\/([^/]+)\/adopt$/)
  if (scheduleAdoptMatch && method === 'POST') {
    if (!isHumanAdmin(ctx)) { json(res, { error: 'forbidden', hint: 'Only an authenticated admin can adopt a schedule' }, 403); return true }
    const resolved = resolveScheduleDir(scheduleAdoptMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name } = resolved
    await withScheduleLock(name, async () => {
      const current = await getScheduleFromDb(name)
      if (!current) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
      const currentHash = scheduleContentHash({ ...rowToTask(current) }, REVIEWED_FIELDS)
      const expectedHash = ctx.url.searchParams.get('expected_hash')
      if (expectedHash !== null && expectedHash !== currentHash) {
        json(res, {
          error: 'stale_revision', content_hash: currentHash,
          hint: 'The schedule changed since it was loaded; review the current content and adopt again',
        }, 409)
        return true
      }
      // A session whose user row is gone has no id. Writing a NULL author would take the task out of the run-time
      // check altogether, which is the opposite of taking it over: refuse instead.
      const author = await scheduleAuthor(ctx)
      if (author.userId === null) {
        json(res, { error: 'forbidden', hint: 'This session has no dashboard user to take the schedule over' }, 403)
        return true
      }
      await writeScheduledTask(name, { author: { userId: author.userId, label: author.label } })
      await auditScheduleWrite(ctx, 'adopt', name, current.tenant_id ?? DEFAULT_SCHEDULE_TENANT, {
        status: current.status, content_hash: currentHash, hash_checked: expectedHash !== null,
        author_before: current.author_user_id ?? null, author_label_before: current.author_label ?? null,
        author_after: author.userId, author_label_after: author.label,
      })
      logger.info({ name }, 'Scheduled task adopted')
      json(res, { ok: true, status: current.status, author_label: author.label })
    })
    return true
  }

  const scheduleUpdateMatch = path.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleUpdateMatch && method === 'PUT') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = await countSchedules() > 0
    const dbRow = useDb ? await getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: SCHEDULE_BODY_MAX_BYTES })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: 'limit_exceeded', hint: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string
      command?: string; timeoutMs?: number; failThreshold?: number; allowTypeChange?: boolean; tenant_id?: string
    }
    const currentTenant = dbRow?.tenant_id ?? DEFAULT_SCHEDULE_TENANT
    // Tenant move: human admin only. Any other caller asking for it is told so rather
    // than silently ignored, because the move is the one write here that has a sanctioned
    // path. It re-checks the (tenant, agent) pair and sends the task back to draft, so a
    // person re-activates it knowing which tenant it now belongs to.
    let newTenant: string | undefined
    if (data.tenant_id !== undefined && data.tenant_id !== currentTenant) {
      if (!isHumanAdmin(ctx)) {
        json(res, { error: 'forbidden', field: 'tenant_id', hint: 'Only an authenticated admin can move a schedule to another tenant' }, 403)
        return true
      }
      const target = typeof data.tenant_id === 'string' ? await getTenant(data.tenant_id) : undefined
      if (!target || target.disabled_at) {
        json(res, { error: 'invalid_value', field: 'tenant_id', hint: 'Unknown or disabled tenant' }, 400)
        return true
      }
      newTenant = target.id
    }
    // Agent change: admin only (a tenant caller cannot re-point a task), and the pair
    // (resulting tenant, resulting agent) must be valid whenever either side moves.
    const newAgent = ctx.role === 'admin' && typeof data.agent === 'string' && data.agent !== dbRow?.agent ? data.agent : undefined
    if (newAgent !== undefined || newTenant !== undefined) {
      const agent = newAgent ?? dbRow?.agent
      if (agent && !await scheduleAgentServesTenant(agent, newTenant ?? currentTenant)) {
        json(res, {
          error: 'invalid_value', field: newAgent !== undefined ? 'agent' : 'tenant_id',
          hint: `Agent '${agent}' does not serve tenant '${newTenant ?? currentTenant}'`,
        }, 400)
        return true
      }
    }
    // A command task is a shell command, not a prompt: switching it to another
    // type by accident (an old client that only knows task/heartbeat sends
    // type:'task' on every save) would silently turn the nightly backup into a
    // prompt to an LLM. The change needs an explicit allowTypeChange:true.
    if (dbRow?.type === 'command' && data.type !== undefined && data.type !== 'command' && data.allowTypeChange !== true) {
      json(res, {
        error: 'invalid_value', field: 'type',
        hint: 'A command task cannot be changed to another type without allowTypeChange:true',
      }, 400)
      return true
    }
    const resultingType = data.type ?? dbRow?.type
    if (resultingType === 'command') {
      const bad = validateCommandFields(
        { ...data, command: data.command ?? dbRow?.command ?? undefined },
        { commandRequired: true },
      )
      if (bad) { json(res, bad, 400); return true }
    } else {
      const bad = validateCommandFields(data, { commandRequired: false })
      if (bad) { json(res, bad, 400); return true }
    }
    if (data.prompt !== undefined && data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: 'limit_exceeded', field: 'prompt', hint: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (data.schedule !== undefined && !isValidCronShape(data.schedule)) {
      json(res, { error: 'invalid_value', field: 'schedule', hint: 'Invalid cron expression' }, 400)
      return true
    }
    const update: Record<string, unknown> = {}
    for (const f of PUT_FIELDS) if (data[f] !== undefined) update[f] = data[f]
    if (newAgent !== undefined) update.agent = newAgent
    if (newTenant !== undefined) { update.tenantId = newTenant; update.status = 'draft' }

    // Re-review: a caller that is not a human admin cannot change what a live task executes
    // without a person approving it again. The comparison is against the row as it is NOW:
    // dbRow above was read before the body arrived, so a concurrent save may have moved it.
    // The db is async, so the read, the decision and the write run under the schedule lock:
    // the row read here is the row that gets overwritten, and a concurrent activation or edit
    // of this schedule waits for the write instead of interleaving with it.
    // The author of a content write is the caller; looked up before the lock (it does not depend on the row) and
    // only when the patch names a reviewed field at all, so a toggle or a label edit costs no user read.
    const mayChangeContent = Object.keys(update).some(k => (REVIEWED_FIELDS as ReadonlyArray<string>).includes(k))
    const author = mayChangeContent ? await scheduleAuthor(ctx) : null
    const locked = await withScheduleLock(name, async () => {
      const before = useDb ? await getScheduleFromDb(name) : undefined
      // A delete or a tenant move that ran since the checks above must not be written over: an edit never creates
      // the row (writeScheduledTask would upsert one from defaults) and is judged against the tenant as it is now.
      if (useDb && (!before || crossTenantBlocked(ctx, before.tenant_id ?? null))) return null
      const beforeTask: Record<string, unknown> = before ? { ...rowToTask(before) } : {}
      const changed = before ? reviewTriggerFields(beforeTask, update) : []
      const demote = !!before && newTenant === undefined && !isHumanAdmin(ctx)
        && isTaskLive(rowToTask(before)) && changed.length > 0
      if (demote) update.status = 'pending_review'

      // `changed` also lists tenantId/status on a tenant move, which is not a content edit: only a reviewed field
      // makes the caller the author (a move keeps the author and clears the activator, the task has to be
      // activated again).
      const contentChanged = changed.some(f => (REVIEWED_FIELDS as ReadonlyArray<string>).includes(f))
      await writeScheduledTask(name, {
        ...update,
        ...(contentChanged && author ? { author } : {}),
        ...(newTenant !== undefined ? { activation: null } : {}),
      })
      return { before, beforeTask, changed, demote, contentChanged }
    })
    if (!locked) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { before, beforeTask, changed, demote, contentChanged } = locked

    const tenantOfTask = newTenant ?? before?.tenant_id ?? DEFAULT_SCHEDULE_TENANT
    // Per changed field: a fingerprint before and after plus a short preview of the new
    // value, never the whole value (a prompt may hold tenant data).
    const fieldDetail = Object.fromEntries(changed.map(f => [f, {
      before_sha256: reviewValueSha256(beforeTask[f]),
      after_sha256: reviewValueSha256(update[f]),
      preview: typeof update[f] === 'string' ? (update[f] as string).trim().slice(0, 200) : update[f],
    }]))
    await auditScheduleWrite(ctx, demote ? 'review_requested' : 'update', name, tenantOfTask, {
      changed, fields: fieldDetail,
      author_label: contentChanged && author ? author.label : (before?.author_label ?? null),
      activated_by: newTenant !== undefined ? null : (before?.activated_by ?? null),
      ...(newTenant !== undefined ? { moved_to_tenant: newTenant } : {}),
    })
    if (demote) {
      await notifyScheduleReview({ name, tenant: tenantOfTask, reason: 'edited', changed, by: scheduleActor(ctx).agentId })
    }
    logger.info({ name, ...(newTenant !== undefined ? { tenantId: newTenant } : {}), ...(demote ? { reviewRequired: true, changed } : {}) }, 'Scheduled task updated')
    json(res, {
      ok: true,
      ...(newTenant !== undefined ? { tenant_id: newTenant, status: 'draft' } : {}),
      ...(demote ? { status: 'pending_review', review_required: true, changed } : {}),
    })
    return true
  }

  if (scheduleUpdateMatch && method === 'DELETE') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = await countSchedules() > 0
    const dbRow = useDb ? await getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    // Row and files go under the schedule lock: a write of this schedule that is still running would
    // otherwise recreate the files (or the row) after the delete. Like the edit and the toggle, the tenant is
    // judged again under the lock: a row that moved to another tenant (or is gone) since the checks above
    // is not deleted, and the audit entry names the tenant the row had when it was deleted.
    const deleted = await withScheduleLock(name, async () => {
      let fresh: typeof dbRow = null
      if (useDb) {
        fresh = await getScheduleFromDb(name)
        if (!fresh || crossTenantBlocked(ctx, fresh.tenant_id ?? null)) return null
        await deleteSchedule(name)
      }
      // Always remove files too (keeps FS in sync with DB; noop if files missing)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      return { fresh }
    })
    if (!deleted) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const gone = deleted.fresh ?? dbRow
    await auditScheduleWrite(ctx, 'delete', name, gone?.tenant_id ?? DEFAULT_SCHEDULE_TENANT, { status: gone?.status ?? null })
    logger.info({ name }, 'Scheduled task deleted')
    json(res, { ok: true })
    return true
  }

  const scheduleToggleMatch = path.match(/^\/api\/schedules\/([^/]+)\/toggle$/)
  if (scheduleToggleMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleToggleMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = await countSchedules() > 0
    const dbRow = useDb ? await getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    let newEnabled: boolean
    if (useDb && dbRow) {
      // The toggle flips the stored value, so it is read under the schedule lock: two quick clicks flip it twice.
      const flipped = await withScheduleLock(name, async () => {
        const fresh = await getScheduleFromDb(name)
        // Gone (deleted) or moved to another tenant since the checks above: nothing is written.
        if (!fresh || crossTenantBlocked(ctx, fresh.tenant_id ?? null)) return null
        const next = fresh.enabled === 0
        await setScheduleEnabled(name, next)
        // Mirror to file
        await writeScheduledTask(name, { enabled: next })
        return next
      })
      if (flipped === null) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
      newEnabled = flipped
    } else {
      const configPath = join(dir, 'task-config.json')
      let config: Record<string, unknown> = {}
      try {
        const { readFileOr: rfo } = await import('../agent-config.js')
        config = JSON.parse(rfo(configPath, '{}'))
      } catch { /* use empty */ }
      newEnabled = !(config.enabled !== false)
      await writeScheduledTask(name, { enabled: newEnabled })
    }
    await auditScheduleWrite(ctx, 'toggle', name, dbRow?.tenant_id ?? DEFAULT_SCHEDULE_TENANT, { enabled: newEnabled })
    logger.info({ name, enabled: newEnabled }, 'Scheduled task toggled')
    json(res, { ok: true, enabled: newEnabled })
    return true
  }

  const scheduleRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/)
  if (scheduleRunMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleRunMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = await countSchedules() > 0
    const dbRow = useDb ? await getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    // Review-gate bypass guard: run-now must not let an agent-token caller
    // fire a draft task it just created, skipping activation entirely. A
    // human admin may still run-now a draft to preview it before activating.
    const result = await runScheduledTaskNow(name, { allowNotLive: isHumanAdmin(ctx) })
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404
        : (result.error === 'disabled' || result.error === 'not_live' || result.error === 'author_inactive' || result.error === 'author_unverifiable') ? 409 : 400
      json(res, { error: result.error, ...(result.hint ? { hint: result.hint } : {}) }, status)
      return true
    }
    logger.info({ name, result: result.result }, 'Scheduled task run-now fired')
    json(res, { ok: true, result: result.result })
    return true
  }

  if (path === '/api/schedules/pending' && method === 'GET') {
    const now = Date.now()
    // A retry belongs to the tenant of its schedule; one whose schedule is gone, or in
    // another tenant, is not a tenant caller's to see.
    const scope = effectiveTenant(ctx)
    const pending = await listPendingTaskRetries()
    // the schedule row is read per retry, so the tenant check settles before the filter (an async predicate would be always truthy)
    const visible = await Promise.all(pending.map(async r => scope === null || scheduleTenantMatches(scope, await getScheduleFromDb(r.task_name))))
    const rows = pending
      .filter((_, i) => visible[i])
      .map(r => toPendingRetryView(r, now))
    json(res, rows)
    return true
  }

  const scheduleRunsMatch = path.match(/^\/api\/schedules\/([^/]+)\/runs$/)
  if (scheduleRunsMatch && method === 'GET') {
    const resolved = resolveScheduleDir(scheduleRunsMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = await countSchedules() > 0
    const dbRow = useDb ? await getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    const runs = await listTaskRunHistory(name, 10)
    json(res, runs)
    return true
  }

  const pendingCancelMatch = path.match(/^\/api\/schedules\/pending\/(\d+)$/)
  if (pendingCancelMatch && method === 'DELETE') {
    const id = parseInt(pendingCancelMatch[1], 10)
    if (!Number.isFinite(id)) { json(res, { error: 'invalid_value', field: 'id', hint: 'Invalid id' }, 400); return true }
    const pending = (await listPendingTaskRetries()).find(r => r.id === id)
    if (pending && ctx.role !== 'admin' && !scheduleTenantMatches(effectiveTenant(ctx), await getScheduleFromDb(pending.task_name))) {
      json(res, { error: 'not_found', hint: 'Pending retry not found' }, 404)
      return true
    }
    const removed = await deletePendingTaskRetryById(id)
    if (!removed) { json(res, { error: 'not_found', hint: 'Pending retry not found' }, 404); return true }
    logger.info({ id }, 'Pending scheduled-task retry cancelled via API')
    json(res, { ok: true })
    return true
  }

  return false
}
