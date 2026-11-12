import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

// GET /api/schedules/dead-letter: scheduled occurrences that did not run. Real database (fresh :memory: per test),
// real route and tenant helpers; only the heavy schedule-runner module and the agent runner are stubbed.

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn(),
  loadLastTickMs: () => null,
  computeTickStatus: () => ({ lastTickMs: null, ageSeconds: null, stale: true }),
}))

let dbMod: typeof import('../db.js')
let conn: typeof import('../db/connection.js')
let route: typeof import('../web/routes/schedules.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'dead-letter-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  conn = await import('../db/connection.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

const NOW = Date.now()
const DAY = 86_400_000

function addSchedule(id: string, tenant: string): void {
  conn.db.prepare("INSERT INTO schedules (id, schedule, agent, tenant_id) VALUES (?, '0 9 * * *', 'agent-a', ?)").run(id, tenant)
}
function addRun(name: string, status: string, ageMs: number, agent = 'agent-a'): void {
  conn.db.prepare('INSERT INTO task_runs (name, agent, ts, status) VALUES (?, ?, ?, ?)').run(name, agent, NOW - ageMs, status)
}
function addPending(task: string, reason: string, lastAgoMs: number): void {
  conn.db.prepare('INSERT INTO pending_task_retries (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason) VALUES (?, ?, ?, ?, 3, ?)')
    .run(task, 'agent-a', NOW - lastAgoMs - 1000, NOW - lastAgoMs, reason)
}

interface Out { status: number; body: unknown }

async function get(rawPath: string, role: 'admin' | 'viewer' | 'agent' = 'admin', tenantId: string | null = null, method = 'GET'): Promise<Out> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', Buffer.alloc(0)); (req as NodeJS.EventEmitter).emit('end') })
  const out: Out = { status: 200, body: null }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader: vi.fn(),
    end(b?: string) { if (b) { try { out.body = JSON.parse(b) } catch { out.body = b } } },
  }
  const url = new URL(`http://localhost:3420${rawPath}`)
  const ctx = { req, res, path: url.pathname, method, url, role, tenantId, auth: { kind: 'session' } } as unknown as RouteContext
  const handled = await route.tryHandleSchedules(ctx)
  expect(handled).toBe(true)
  return out
}

interface Body { days: number; limit: number; truncated: boolean; items: Array<Record<string, unknown>> }
const body = (o: Out): Body => o.body as Body

describe('the rows', () => {
  it('lists exactly the non-start statuses, never fired or fired_late', async () => {
    addSchedule('task-a', 'default')
    for (const s of ['fired', 'fired_late', 'missed', 'lost', 'error', 'skipped', 'skipped_disabled', 'skipped_not_live', 'skipped_tenant_mismatch', 'skipped_author_inactive', 'skipped_author_unverifiable', 'missing-retrying']) {
      addRun('task-a', s, 1000)
    }
    const o = await get('/api/schedules/dead-letter')
    expect(o.status).toBe(200)
    expect(body(o).items.map((i) => i['status']).sort()).toEqual(
      ['error', 'lost', 'missed', 'skipped', 'skipped_author_inactive', 'skipped_author_unverifiable', 'skipped_disabled', 'skipped_not_live', 'skipped_tenant_mismatch'])
  })

  it('a run row carries exactly kind, task, agent, ts, status', async () => {
    addSchedule('task-a', 'default')
    addRun('task-a', 'missed', 5000)
    const item = body(await get('/api/schedules/dead-letter')).items[0]!
    expect(Object.keys(item).sort()).toEqual(['agent', 'kind', 'status', 'task', 'ts'])
    expect(item).toMatchObject({ kind: 'run', task: 'task-a', agent: 'agent-a', status: 'missed' })
  })

  it('a pending row carries exactly kind, task, agent, the attempt times and counts, the reason and the alert stamp', async () => {
    addSchedule('task-a', 'default')
    addPending('task-a', 'giveup', 2000)
    const item = body(await get('/api/schedules/dead-letter')).items[0]!
    expect(Object.keys(item).sort()).toEqual(
      ['agent', 'alert_sent_at', 'attempt_count', 'first_attempt', 'kind', 'last_attempt', 'reason', 'task'])
    expect(item).toMatchObject({ kind: 'pending', task: 'task-a', agent: 'agent-a', attempt_count: 3, reason: 'giveup', alert_sent_at: null })
  })

  it('shows the pending reasons as stored (giveup, lane-busy, lost-injection)', async () => {
    for (const [i, reason] of ['giveup', 'lane-busy', 'lost-injection'].entries()) {
      addSchedule(`task-${i}`, 'default')
      addPending(`task-${i}`, reason, 1000 * (i + 1))
    }
    const reasons = body(await get('/api/schedules/dead-letter')).items.map((i) => i['reason'])
    expect(reasons).toEqual(['giveup', 'lane-busy', 'lost-injection'])
  })

  it('the response top level is exactly days, limit, truncated, items', async () => {
    const o = await get('/api/schedules/dead-letter')
    expect(Object.keys(o.body as object).sort()).toEqual(['days', 'items', 'limit', 'truncated'])
    expect(body(o)).toMatchObject({ days: 7, limit: 100, truncated: false, items: [] })
  })

  it('runs and pending rows are merged newest first', async () => {
    addSchedule('task-a', 'default')
    addRun('task-a', 'missed', 9000)
    addRun('task-a', 'error', 1000)
    addPending('task-a', 'giveup', 5000)
    const order = body(await get('/api/schedules/dead-letter')).items.map((i) => i['kind'] === 'run' ? i['status'] : 'pending')
    expect(order).toEqual(['error', 'pending', 'missed'])
  })
})

describe('window and limit', () => {
  it('days narrows the run window; the default is 7 days', async () => {
    addSchedule('task-a', 'default')
    addRun('task-a', 'missed', 2 * DAY)
    addRun('task-a', 'error', 8 * DAY)
    expect(body(await get('/api/schedules/dead-letter')).items.map((i) => i['status'])).toEqual(['missed'])
    expect(body(await get('/api/schedules/dead-letter?days=1')).items).toEqual([])
    expect(body(await get('/api/schedules/dead-letter?days=10')).items.map((i) => i['status'])).toEqual(['missed', 'error'])
  })

  it('a pending row older than the window is still listed (it is open now)', async () => {
    addSchedule('task-a', 'default')
    addPending('task-a', 'giveup', 20 * DAY)
    expect(body(await get('/api/schedules/dead-letter?days=1')).items).toHaveLength(1)
  })

  it('limit cuts the list and sets truncated; exactly limit rows is not truncated', async () => {
    addSchedule('task-a', 'default')
    for (let i = 1; i <= 5; i++) addRun('task-a', 'missed', i * 1000)
    const cut = body(await get('/api/schedules/dead-letter?limit=3'))
    expect(cut.items).toHaveLength(3)
    expect(cut.truncated).toBe(true)
    const exact = body(await get('/api/schedules/dead-letter?limit=5'))
    expect(exact.items).toHaveLength(5)
    expect(exact.truncated).toBe(false)
  })

  it('the cut keeps the newest rows across both halves', async () => {
    addSchedule('task-a', 'default')
    addRun('task-a', 'missed', 9000)
    addRun('task-a', 'error', 3000)
    addPending('task-a', 'giveup', 1000)
    const o = body(await get('/api/schedules/dead-letter?limit=2'))
    expect(o.truncated).toBe(true)
    expect(o.items.map((i) => i['kind'] === 'run' ? i['status'] : 'pending')).toEqual(['pending', 'error'])
  })

  it.each([
    ['days=0', 'days'], ['days=31', 'days'], ['days=-1', 'days'], ['days=abc', 'days'], ['days=1.5', 'days'], ['days=', 'days'],
    ['limit=0', 'limit'], ['limit=501', 'limit'], ['limit=-5', 'limit'], ['limit=x', 'limit'], ['limit=', 'limit'],
  ])('%s is a 400 invalid_value on %s', async (qs, field) => {
    const o = await get(`/api/schedules/dead-letter?${qs}`)
    expect(o.status).toBe(400)
    expect(o.body).toMatchObject({ error: 'invalid_value', field })
  })

  it('the bounds themselves are accepted', async () => {
    expect((await get('/api/schedules/dead-letter?days=1&limit=1')).status).toBe(200)
    expect((await get('/api/schedules/dead-letter?days=30&limit=500')).status).toBe(200)
  })
})

// A repeated parameter used to take the FIRST value and drop the rest unvalidated (URLSearchParams.get), so
// `limit=10&limit=abc` answered 200. Any repeat is a 400 now, the same value twice included: one rule, no "an
// error only when the values differ".
describe('a repeated days or limit', () => {
  it.each([
    ['days=1&days=2', 'days'], ['days=1&days=1', 'days'], ['days=2&days=abc', 'days'],
    ['limit=10&limit=abc', 'limit'], ['limit=10&limit=10', 'limit'], ['limit=abc&limit=10', 'limit'],
    ['days=1&limit=5&limit=6', 'limit'], ['limit=5&days=1&limit=6', 'limit'], ['days=1&days=2&limit=5', 'days'],
  ])('%s is a 400 invalid_value on %s, with a "given once" hint', async (qs, field) => {
    const o = await get(`/api/schedules/dead-letter?${qs}`)
    expect(o.status).toBe(400)
    expect(o.body).toMatchObject({ error: 'invalid_value', field, hint: `${field} must be given once` })
  })

  it('days is judged before limit when both are wrong', async () => {
    const o = await get('/api/schedules/dead-letter?limit=1&limit=2&days=1&days=2')
    expect(o.body).toMatchObject({ field: 'days' })
    const both = await get('/api/schedules/dead-letter?days=abc&limit=1&limit=2')
    expect(both.body).toMatchObject({ field: 'days', hint: 'days must be an integer from 1 to 30' })
  })

  it('each parameter once, in any order, is the answer it always was', async () => {
    addSchedule('task-a', 'default')
    addRun('task-a', 'missed', 2 * DAY)
    for (const qs of ['days=2&limit=5', 'limit=5&days=2']) {
      const o = await get(`/api/schedules/dead-letter?${qs}`)
      expect(o.status).toBe(200)
      expect(body(o)).toMatchObject({ days: 2, limit: 5, truncated: false })
    }
  })

  it('both absent give the defaults, 7 days and 100 rows', async () => {
    const o = body(await get('/api/schedules/dead-letter'))
    expect(o).toMatchObject({ days: 7, limit: 100, truncated: false, items: [] })
  })

  it('an unrelated repeated parameter is not this rule (only days and limit are counted)', async () => {
    expect((await get('/api/schedules/dead-letter?foo=1&foo=2&days=1&limit=1')).status).toBe(200)
  })

  it('the /api/v1 path is the same route: it normalizes to the path the handler serves', async () => {
    const { normalizePath } = await import('../web/routes/versioning.js')
    const v1 = normalizePath('/api/v1/schedules/dead-letter')
    expect(v1.path).toBe('/api/schedules/dead-letter')
    const o = await get(`${v1.path}?days=1&days=2`)
    expect(o.status).toBe(400)
    expect(o.body).toMatchObject({ error: 'invalid_value', field: 'days' })
  })
})

describe('parseDeadLetterParams (pure)', () => {
  const parse = async (qs: string) => {
    const { parseDeadLetterParams } = await import('../web/schedule-dead-letter.js')
    return parseDeadLetterParams(new URLSearchParams(qs))
  }

  it('absent -> the defaults; one value each -> that value', async () => {
    expect(await parse('')).toEqual({ ok: true, days: 7, limit: 100 })
    expect(await parse('days=3&limit=40')).toEqual({ ok: true, days: 3, limit: 40 })
  })

  it('a repeat names the parameter, days first', async () => {
    expect(await parse('days=1&days=1')).toEqual({ ok: false, field: 'days', hint: 'days must be given once' })
    expect(await parse('limit=1&limit=1')).toEqual({ ok: false, field: 'limit', hint: 'limit must be given once' })
    expect(await parse('limit=1&limit=2&days=1&days=2')).toMatchObject({ ok: false, field: 'days' })
    // three occurrences are a repeat too (the rule is "more than one", not "exactly two")
    expect(await parse('days=1&days=1&days=1')).toMatchObject({ ok: false, field: 'days' })
  })

  it('the single-value rules are unchanged: empty, signed, decimal, text and out-of-range are all invalid', async () => {
    for (const qs of ['days=', 'days=+5', 'days=1.5', 'days=abc', 'days=0', 'days=31', 'days=-1', 'days=1234567']) {
      expect(await parse(qs), qs).toMatchObject({ ok: false, field: 'days' })
    }
    for (const qs of ['limit=', 'limit=+5', 'limit=1.5', 'limit=abc', 'limit=0', 'limit=501', 'limit=-1']) {
      expect(await parse(qs), qs).toMatchObject({ ok: false, field: 'limit' })
    }
    expect(await parse('days=1&limit=1')).toEqual({ ok: true, days: 1, limit: 1 })
    expect(await parse('days=30&limit=500')).toEqual({ ok: true, days: 30, limit: 500 })
  })
})

describe('tenant isolation', () => {
  beforeEach(() => {
    addSchedule('task-a', 'tenant-a')
    addSchedule('task-b', 'tenant-b')
    addRun('task-a', 'missed', 1000)
    addRun('task-b', 'error', 2000)
    addRun('task-gone', 'lost', 3000) // its schedule was deleted
    addPending('task-a', 'giveup', 4000)
    addPending('task-b', 'lane-busy', 5000)
    addPending('task-gone', 'lost-injection', 6000)
  })

  const tasks = (o: Out): string[] => body(o).items.map((i) => String(i['task'])).sort()

  it('a tenant caller sees only the rows of their own tenant schedules', async () => {
    expect(tasks(await get('/api/schedules/dead-letter', 'viewer', 'tenant-a'))).toEqual(['task-a', 'task-a'])
    expect(tasks(await get('/api/schedules/dead-letter', 'viewer', 'tenant-b'))).toEqual(['task-b', 'task-b'])
  })

  it('the two author statuses follow the same tenant filter: a tenant caller sees only their own, an admin sees both', async () => {
    addRun('task-a', 'skipped_author_inactive', 7000)
    addRun('task-b', 'skipped_author_unverifiable', 8000)
    addRun('task-gone', 'skipped_author_inactive', 9000)
    const statusesOf = (o: Out): string[] => body(o).items.filter((i) => i['kind'] === 'run').map((i) => `${String(i['task'])}|${String(i['status'])}`).sort()
    expect(statusesOf(await get('/api/schedules/dead-letter', 'viewer', 'tenant-a'))).toEqual(['task-a|missed', 'task-a|skipped_author_inactive'])
    expect(statusesOf(await get('/api/schedules/dead-letter', 'viewer', 'tenant-b'))).toEqual(['task-b|error', 'task-b|skipped_author_unverifiable'])
    // positive pair: the unfiltered admin sees all three, including the one whose schedule is gone
    expect(statusesOf(await get('/api/schedules/dead-letter'))).toEqual([
      'task-a|missed', 'task-a|skipped_author_inactive', 'task-b|error', 'task-b|skipped_author_unverifiable',
      'task-gone|lost', 'task-gone|skipped_author_inactive',
    ])
  })

  it('a tenant caller never sees the row of a deleted schedule', async () => {
    const all = tasks(await get('/api/schedules/dead-letter', 'viewer', 'tenant-a')).concat(tasks(await get('/api/schedules/dead-letter', 'viewer', 'tenant-b')))
    expect(all).not.toContain('task-gone')
  })

  it('a tenant with no schedules sees nothing', async () => {
    expect(body(await get('/api/schedules/dead-letter', 'viewer', 'tenant-c')).items).toEqual([])
  })

  it('an unfiltered admin sees every tenant and the deleted-schedule rows', async () => {
    expect(tasks(await get('/api/schedules/dead-letter'))).toEqual(['task-a', 'task-a', 'task-b', 'task-b', 'task-gone', 'task-gone'])
  })

  it('an admin with ?tenant= sees that tenant only (deleted-schedule rows drop out)', async () => {
    expect(tasks(await get('/api/schedules/dead-letter?tenant=tenant-b'))).toEqual(['task-b', 'task-b'])
  })

  it('the limit counts after the tenant filter (another tenant\'s newer rows cannot crowd the caller out)', async () => {
    for (let i = 0; i < 5; i++) addRun('task-b', 'missed', 100 + i)
    const o = body(await get('/api/schedules/dead-letter?limit=1', 'viewer', 'tenant-a'))
    expect(o.items).toHaveLength(1)
    expect(o.items[0]!['task']).toBe('task-a')
  })

  it('a caller without a tenant is refused', async () => {
    expect((await get('/api/schedules/dead-letter', 'viewer', null)).status).toBe(403)
  })

  it('a default-tenant schedule is visible to the default-tenant caller', async () => {
    addSchedule('task-d', 'default')
    addRun('task-d', 'missed', 500)
    expect(tasks(await get('/api/schedules/dead-letter', 'viewer', 'default'))).toEqual(['task-d'])
  })
})

describe('routing', () => {
  it('the path is the dead-letter list, not a schedule named dead-letter (no 404 not_found)', async () => {
    const o = await get('/api/schedules/dead-letter')
    expect(o.status).toBe(200)
    expect(o.body).not.toMatchObject({ error: 'not_found' })
    expect(Array.isArray(body(o).items)).toBe(true)
  })

  it('a schedule really named dead-letter is still reachable on its sub-routes (runs)', async () => {
    addSchedule('dead-letter', 'default')
    const o = await get('/api/schedules/dead-letter/runs')
    expect(o.status).toBe(200)
    expect(Array.isArray(o.body)).toBe(true)
  })

  // No GET handler takes a bare /api/schedules/:name today, so a late placement would still work; the order is pinned
  // so that adding one later (or moving this block below the PUT / DELETE / runs matchers) cannot start swallowing it.
  it('the handler sits ahead of every generic /api/schedules/:name matcher in the route file', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'routes', 'schedules.ts'), 'utf8')
    const deadLetter = src.indexOf("path === '/api/schedules/dead-letter'")
    expect(deadLetter).toBeGreaterThan(-1)
    for (const generic of ['const scheduleActivateMatch', 'const scheduleUpdateMatch', 'const scheduleToggleMatch', 'const scheduleRunMatch', 'const scheduleRunsMatch']) {
      const at = src.indexOf(generic)
      expect(at, generic).toBeGreaterThan(-1)
      expect(deadLetter, `dead-letter must come before ${generic}`).toBeLessThan(at)
    }
  })

  it('only GET is the dead-letter view', async () => {
    const o = await get('/api/schedules/dead-letter', 'admin', null, 'DELETE')
    expect(o.body).not.toHaveProperty('items')
  })

  it('writes nothing: the tables are unchanged after a read', async () => {
    addSchedule('task-a', 'default')
    addRun('task-a', 'missed', 1000)
    addPending('task-a', 'giveup', 1000)
    const count = (t: string): number => (conn.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
    const before = [count('task_runs'), count('pending_task_retries'), count('schedules')]
    await get('/api/schedules/dead-letter')
    expect([count('task_runs'), count('pending_task_retries'), count('schedules')]).toEqual(before)
  })
})
