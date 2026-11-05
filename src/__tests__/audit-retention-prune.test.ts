// The retention sweep removes rows and says so: one agent_audit_log row (entity 'system', action
// 'retention_prune') per sweep with the count per table, the cuts, the number of spans that went without ever
// being exported, and whether the export was on. The deletes and the row are one transaction. The manual prune of
// the hook audit log is journaled the same way and no longer accepts a window that wipes the table.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { useTestDb } from './helpers/with-test-db.js'
import { getDb, pruneAuditLogs, pruneHookAuditLog, pruneHookAuditLogJournaled, pruneOtelSpans, setSystemConfig } from '../db.js'
import { tryHandleHookAudit } from '../web/routes/hook-audit.js'
import { hasPermission, resolveRequiredPermission, type Role } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

useTestDb()

const DAY = 86400
const nowSec = () => Math.floor(Date.now() / 1000)

interface PruneRow { agent_id: string; entity: string; action: string; detail: string; tenant_id: string | null }
function pruneRows(): PruneRow[] {
  return getDb().prepare("SELECT agent_id, entity, action, detail, tenant_id FROM agent_audit_log WHERE action = 'retention_prune' ORDER BY id").all() as PruneRow[]
}

function seedOld(): void {
  const db = getDb()
  const old = nowSec() - 200 * DAY
  const fresh = nowSec()
  db.prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('k', '1', '2', 'a', ?)").run(old)
  db.prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('k', '1', '2', 'a', ?)").run(old + 1)
  db.prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('k', '1', '2', 'a', ?)").run(fresh)
  db.prepare("INSERT INTO agent_audit_log (agent_id, entity, action, created_at) VALUES ('a', 'memory', 'create', ?)").run(old)
  db.prepare("INSERT INTO agent_audit_log (agent_id, entity, action, created_at) VALUES ('a', 'memory', 'create', ?)").run(fresh)
  for (const ts of [old, old + 1, old + 2, fresh]) {
    db.prepare("INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict) VALUES (?, 'a', 'PreToolUse', 'allow')").run(ts)
  }
}

function seedSpans(): void {
  const db = getDb()
  const oldMs = Date.now() - 60 * DAY * 1000
  const ins = db.prepare('INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, exported_at) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run('t1', 's1', 'a', 'op', oldMs, null)
  ins.run('t2', 's2', 'a', 'op', oldMs + 1, null)
  ins.run('t3', 's3', 'a', 'op', oldMs + 2, Date.now())
  ins.run('t4', 's4', 'a', 'op', Date.now(), null)
}

describe('pruneAuditLogs: the journal row', () => {
  it('returns and records the number of rows each table lost', async () => {
    seedOld()
    seedSpans()
    const r = await pruneAuditLogs()
    expect(r.deleted).toEqual({
      config_change_log: 2, idea_status_log: 0, store_file_audit: 0, agent_audit_log: 1, hook_audit_log: 3, otel_spans: 3,
    })
    expect(r.deletedTotal).toBe(9)
    const rows = pruneRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'system', entity: 'system', action: 'retention_prune', tenant_id: null })
    const detail = JSON.parse(rows[0].detail)
    expect(detail.trigger).toBe('sweep')
    expect(detail.tables).toEqual(r.deleted)
    expect(detail.deleted_total).toBe(9)
    expect(detail.cutoff_days).toBe(90)
    expect(detail.otel_cutoff_days).toBe(30)
    expect(Math.abs(detail.cutoff_ts - (nowSec() - 90 * DAY))).toBeLessThan(5)
    expect(Math.abs(detail.otel_cutoff_ms - (Date.now() - 30 * DAY * 1000))).toBeLessThan(5000)
  })

  it('counts the spans that were deleted without ever being exported, and says whether the export was on', async () => {
    seedSpans()
    const r = await pruneAuditLogs()
    // t1 and t2 never exported, t3 was, t4 is too new to go.
    expect(r.unexportedDeleted).toBe(2)
    expect(r.deleted.otel_spans).toBe(3)
    const detail = JSON.parse(pruneRows()[0].detail)
    expect(detail.unexported_deleted).toBe(2)
    expect(detail.export_enabled).toBe(false)
  })

  it('records export_enabled true when OTEL_EXPORT_ENABLED is on', async () => {
    await setSystemConfig('OTEL_EXPORT_ENABLED', '1', 'db')
    await pruneAuditLogs()
    expect(JSON.parse(pruneRows()[0].detail).export_enabled).toBe(true)
  })

  it('writes a row even when nothing was deleted (the sweep ran)', async () => {
    const r = await pruneAuditLogs()
    expect(r.deletedTotal).toBe(0)
    expect(pruneRows()).toHaveLength(1)
    expect(JSON.parse(pruneRows()[0].detail).deleted_total).toBe(0)
  })

  it('does not delete its own row, and a second sweep counts only what the first left', async () => {
    seedOld()
    await pruneAuditLogs()
    const second = await pruneAuditLogs()
    expect(second.deleted.agent_audit_log).toBe(0)
    expect(pruneRows()).toHaveLength(2)
  })
})

describe('pruneAuditLogs: one transaction', () => {
  it('rolls every delete back when the journal row cannot be written', async () => {
    seedOld()
    seedSpans()
    getDb().exec(`CREATE TRIGGER block_prune_row BEFORE INSERT ON agent_audit_log WHEN NEW.action = 'retention_prune'
                  BEGIN SELECT RAISE(ABORT, 'journal refused'); END`)
    await expect(pruneAuditLogs()).rejects.toThrow(/journal refused/)
    const count = (sql: string) => (getDb().prepare(sql).get() as { n: number }).n
    expect(count('SELECT COUNT(*) AS n FROM config_change_log')).toBe(3)
    expect(count('SELECT COUNT(*) AS n FROM hook_audit_log')).toBe(4)
    expect(count('SELECT COUNT(*) AS n FROM otel_spans')).toBe(4)
    expect(count("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'create'")).toBe(2)
  })

  it('writes no journal row when one of the deletes fails', async () => {
    seedOld()
    getDb().exec(`CREATE TRIGGER block_hook_delete BEFORE DELETE ON hook_audit_log
                  BEGIN SELECT RAISE(ABORT, 'delete refused'); END`)
    await expect(pruneAuditLogs()).rejects.toThrow(/delete refused/)
    expect(pruneRows()).toHaveLength(0)
    // The deletes that ran before the failing one are undone too.
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM config_change_log').get() as { n: number }).n).toBe(3)
  })
})

describe('the single-table prunes return what they removed', () => {
  it('pruneHookAuditLog and pruneOtelSpans return the row count', async () => {
    seedOld()
    seedSpans()
    expect(await pruneHookAuditLog(90 * DAY)).toBe(3)
    expect(await pruneOtelSpans(30 * DAY * 1000)).toBe(3)
    expect(await pruneHookAuditLog(90 * DAY)).toBe(0)
  })
})

// ---- POST /api/hook-audit/prune -----------------------------------------------------------------

function makeCtx(body: string | object | undefined, extra: Partial<RouteContext> = {}): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = 'POST'
  req.headers = {}
  setImmediate(() => {
    ;(req as NodeJS.EventEmitter).emit('data', buf)
    ;(req as NodeJS.EventEmitter).emit('end')
  })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const ctx = {
    req, res, path: '/api/hook-audit/prune', method: 'POST', url: new URL('http://localhost/api/hook-audit/prune'), ...extra,
  } as unknown as RouteContext
  return { ctx, out }
}

const hookRows = () => (getDb().prepare('SELECT COUNT(*) AS n FROM hook_audit_log').get() as { n: number }).n

describe('POST /api/hook-audit/prune: the window', () => {
  for (const [label, body] of [
    ['zero', { older_than_secs: 0 }],
    ['a negative number', { older_than_secs: -10 }],
    ['below one day', { older_than_secs: 86399 }],
    ['a fraction', { older_than_secs: 172800.5 }],
    ['a string', { older_than_secs: '172800' }],
    ['a boolean', { older_than_secs: true }],
  ] as Array<[string, object]>) {
    it(`refuses ${label} with 400 and deletes nothing`, async () => {
      seedOld()
      const before = hookRows()
      const { ctx, out } = makeCtx(body)
      await tryHandleHookAudit(ctx)
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'older_than_secs' })
      expect(hookRows()).toBe(before)
      expect(pruneRows()).toHaveLength(0)
    })
  }

  for (const [label, body] of [['an array', '[]'], ['a number', '5'], ['null', 'null']] as Array<[string, string]>) {
    it(`refuses a body that is ${label} with 400`, async () => {
      seedOld()
      const { ctx, out } = makeCtx(body)
      await tryHandleHookAudit(ctx)
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'body' })
      expect(hookRows()).toBe(4)
    })
  }

  it('an empty body uses the 30 day default', async () => {
    seedOld()
    const { ctx, out } = makeCtx(undefined)
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, deleted: 3 })
  })

  it('exactly one day is accepted', async () => {
    const { ctx, out } = makeCtx({ older_than_secs: 86400 })
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(200)
  })
})

describe('POST /api/hook-audit/prune: the journal', () => {
  it('records who asked, how many rows went and the cut, in a retention_prune row', async () => {
    seedOld()
    const { ctx, out } = makeCtx({ older_than_secs: 100 * DAY }, { auth: { kind: 'session', user: 'alice' } } as Partial<RouteContext>)
    await tryHandleHookAudit(ctx)
    expect(out.body).toEqual({ ok: true, deleted: 3 })
    const rows = pruneRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'alice', entity: 'system', action: 'retention_prune', tenant_id: null })
    const detail = JSON.parse(rows[0].detail)
    expect(detail).toMatchObject({ trigger: 'manual', actor_kind: 'session', tables: { hook_audit_log: 3 }, deleted_total: 3, cutoff_days: 100 })
    expect(Math.abs(detail.cutoff_ts - (nowSec() - 100 * DAY))).toBeLessThan(5)
  })

  it('journals a call that removed nothing', async () => {
    const { ctx } = makeCtx({ older_than_secs: 30 * DAY })
    await tryHandleHookAudit(ctx)
    expect(JSON.parse(pruneRows()[0].detail).deleted_total).toBe(0)
  })

  it('writes no row and removes nothing when the journal row cannot be written', async () => {
    seedOld()
    getDb().exec(`CREATE TRIGGER block_prune_row BEFORE INSERT ON agent_audit_log WHEN NEW.action = 'retention_prune'
                  BEGIN SELECT RAISE(ABORT, 'journal refused'); END`)
    const { ctx } = makeCtx({ older_than_secs: 100 * DAY })
    await expect(tryHandleHookAudit(ctx)).rejects.toThrow(/journal refused/)
    expect(hookRows()).toBe(4)
  })
})

describe('POST /api/hook-audit/prune: who may call it', () => {
  // The route is not in the permission table, so it takes the rule for an unlisted route: admin:all. The
  // fallback is pinned here so a later entry that loosens it, or a change of the fallback, shows up.
  it('needs admin:all: no other role holds it', () => {
    const need = resolveRequiredPermission('POST', '/api/hook-audit/prune') ?? 'admin:all'
    expect(need).toBe('admin:all')
    for (const r of ['agent', 'read_only', 'viewer', 'fleet_agent'] as Role[]) expect(hasPermission(r, need), r).toBe(false)
    expect(hasPermission('admin', need)).toBe(true)
  })
})

// ---- windows, transaction mode, the cut of the unexported counter ------------------------------

const insertHook = (ts: number): void => {
  getDb().prepare("INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict) VALUES (?, 'a', 'PreToolUse', 'allow')").run(ts)
}
const hookTimes = (): number[] => (getDb().prepare('SELECT ts FROM hook_audit_log ORDER BY ts').all() as { ts: number }[]).map((r) => r.ts)

/** The text of every db.exec from now on (BEGIN, BEGIN IMMEDIATE, SAVEPOINT, COMMIT ...). */
function recordExec(): string[] {
  const db = getDb()
  const original = db.exec.bind(db)
  const seen: string[] = []
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => { seen.push(sql); return original(sql) })
  return seen
}

describe('the windows', () => {
  it('the sweep keeps a 10 day old hook row and deletes a 200 day old one (the window is days, not seconds)', async () => {
    insertHook(nowSec() - 10 * DAY)
    insertHook(nowSec() - 200 * DAY)
    const r = await pruneAuditLogs()
    expect(r.deleted.hook_audit_log).toBe(1)
    expect(hookTimes()).toHaveLength(1)
    expect(Math.abs(hookTimes()[0] - (nowSec() - 10 * DAY))).toBeLessThan(5)
    expect(JSON.parse(pruneRows()[0].detail).tables.hook_audit_log).toBe(1)
  })

  it('the manual prune without a window keeps a 15 day old row and deletes a 40 day old one (default 30 days)', async () => {
    insertHook(nowSec() - 15 * DAY)
    insertHook(nowSec() - 40 * DAY)
    const { ctx, out } = makeCtx(undefined)
    await tryHandleHookAudit(ctx)
    expect(out.body).toEqual({ ok: true, deleted: 1 })
    expect(hookTimes()).toHaveLength(1)
    expect(Math.abs(hookTimes()[0] - (nowSec() - 15 * DAY))).toBeLessThan(5)
  })
})

describe('the transactions take the write lock up front', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('pruneAuditLogs opens one BEGIN IMMEDIATE', async () => {
    const sql = recordExec()
    await pruneAuditLogs()
    expect(sql.filter((q) => /^BEGIN/.test(q))).toEqual(['BEGIN IMMEDIATE'])
    expect(sql[sql.length - 1]).toBe('COMMIT')
  })

  it('pruneHookAuditLogJournaled opens one BEGIN IMMEDIATE', async () => {
    const sql = recordExec()
    await pruneHookAuditLogJournaled(30 * DAY, { agentId: 'alice' })
    expect(sql.filter((q) => /^BEGIN/.test(q))).toEqual(['BEGIN IMMEDIATE'])
    expect(sql[sql.length - 1]).toBe('COMMIT')
  })
})

// The clock is fixed to the millisecond so a span can sit exactly on the cut.
describe('the span cut, with a fixed clock', () => {
  const NOW_SEC = 1_800_000_000
  const NOW_MS = NOW_SEC * 1000
  const OTEL_CUT_MS = NOW_MS - 30 * DAY * 1000
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  const spanAt = (id: string, startMs: number, exportedAt: number | null = null): void => {
    getDb().prepare('INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, exported_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`t-${id}`, `s-${id}`, 'a', 'op', startMs, exportedAt)
  }
  const spanIds = (): string[] => (getDb().prepare('SELECT span_id FROM otel_spans ORDER BY span_id').all() as { span_id: string }[]).map((r) => r.span_id)

  it('a span exactly on the cut is neither deleted nor counted; one millisecond older is both', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    spanAt('older', OTEL_CUT_MS - 1)
    spanAt('on-cut', OTEL_CUT_MS)
    spanAt('newer', OTEL_CUT_MS + 1)
    const r = await pruneAuditLogs()
    expect(r.otelCutoffMs).toBe(OTEL_CUT_MS)
    expect(r.deleted.otel_spans).toBe(1)
    expect(r.unexportedDeleted).toBe(1)
    expect(spanIds()).toEqual(['s-newer', 's-on-cut'])
  })

  it('the count and the delete use the same cut while the clock moves between the reads', async () => {
    const base = Date.now()
    const center = base - 30 * DAY * 1000
    // Unexported spans every 500 ms around where the cut will fall, a minute either side.
    const starts: number[] = []
    for (let i = -120; i <= 120; i++) starts.push(center + i * 500)
    starts.forEach((st, i) => spanAt(String(i).padStart(3, '0'), st))
    let t = base
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000)) // every read of the clock is a second later
    const r = await pruneAuditLogs()
    vi.restoreAllMocks()
    const expected = starts.filter((st) => st < r.otelCutoffMs).length
    expect(expected).toBeGreaterThan(0)
    expect(expected).toBeLessThan(starts.length)
    expect(r.deleted.otel_spans).toBe(expected)
    expect(r.unexportedDeleted).toBe(expected)
    expect(spanIds()).toHaveLength(starts.length - expected)
    expect(JSON.parse(pruneRows()[0].detail).otel_cutoff_ms).toBe(r.otelCutoffMs)
    expect(JSON.parse(pruneRows()[0].detail).unexported_deleted).toBe(expected)
  })

  it('the journal row of a sweep holds the exact cuts and windows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    const r = await pruneAuditLogs()
    const detail = JSON.parse(pruneRows()[0].detail)
    expect(detail).toMatchObject({
      trigger: 'sweep', cutoff_days: 90, cutoff_ts: NOW_SEC - 90 * DAY, otel_cutoff_days: 30, otel_cutoff_ms: OTEL_CUT_MS,
    })
    expect(r).toMatchObject({ cutoffDays: 90, cutoffTs: NOW_SEC - 90 * DAY, otelCutoffDays: 30, otelCutoffMs: OTEL_CUT_MS })
  })

  it('the journal row of a manual prune holds the exact window and cut', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    const { ctx } = makeCtx({ older_than_secs: 100 * DAY })
    await tryHandleHookAudit(ctx)
    expect(JSON.parse(pruneRows()[0].detail)).toMatchObject({ trigger: 'manual', cutoff_days: 100, cutoff_ts: NOW_SEC - 100 * DAY })
  })
})
