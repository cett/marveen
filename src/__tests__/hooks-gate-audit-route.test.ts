// POST /api/hooks/gate-audit: the audit write of the PreToolUse gates (scripts/hooks/gate_audit_lib.py) in PostgreSQL mode.
// Real in-memory SQLite (no mocks). The PostgreSQL side (the app role, row-level security, the NULL tenant under the system job,
// one transaction with a real failure) is src/__tests__/pg/hooks-gate-audit.pg.test.ts; the no-context exemption of this route is
// pinned in hooks-tenant-context-bootstrap.test.ts. Neutral fixtures only (agent-a, agent-b).
//
// What these cells pin (each has a red a removed guard gives; the mutants are named in the PR text):
//   - the caller is the agent the TOKEN names: an agent_id in the body is ignored, no token agent is a 403
//   - every enum and bound is enforced HERE, not trusted from the hook: the gate, the decision, the reason code (never free text),
//     the sizes of the two lists, n, ts; a bad entry anywhere is a 400 and NOTHING is written (the counts of a good first entry too)
//   - a row carries the fixed fields only: a field the contract does not name (a command, a path) has nowhere to go
//   - the counts ADD (an upsert), a deny row lands with the token's agent, tenant NULL and the session id as trace_id, a `w3c-` trace
//     id is dropped, ts is clamped to [now - 7 days, now + 60 s]
//   - ONE transaction: a write that fails half way leaves neither the counts nor the rows
//   - the RBAC row (hook-gate:write, fleet_agent and admin only) and the sets are the Python constants of the hook (parity cell)
import { afterEach, describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { dbx, type Tx } from '../db/facade.js'
import { useTestDb } from './helpers/with-test-db.js'
import {
  DECISIONS, GATES, MAX_AGE_SECS, MAX_COUNTS, MAX_COUNT_N, MAX_DENIES, MAX_FUTURE_SECS, REASONS, clampTs, tryHandleHooksGateAudit,
} from '../web/routes/hooks-gate-audit.js'
import { ENDPOINT_PERMISSION_TABLE, hasPermission, resolveRequiredPermission, type Role } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

useTestDb()

function call(body: unknown, tokenAgentId: string | undefined, method = 'POST') {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420/api/hooks/gate-audit')
  const ctx = { req, res, path: url.pathname, method, url, role: 'fleet_agent', tokenAgentId, tenantId: null } as unknown as RouteContext
  return { ctx, out }
}

async function post(body: unknown, agent: string | null = 'agent-a') {
  const { ctx, out } = call(body, agent ?? undefined)
  expect(await tryHandleHooksGateAudit(ctx)).toBe(true)
  return out
}

const now = () => Math.floor(Date.now() / 1000)
const count = (gate: string, decision: string, reason: string, n = 1) => ({ gate, decision, reason, n })
const deny = (gate: string, reason = 'denied', extra: Record<string, unknown> = {}) => ({ gate, reason, ts: now(), ...extra })

interface CountRow { gate: string; decision: string; reason: string; count: number; first_at: number; updated_at: number }
interface AuditRow {
  agent_id: string | null; hook_type: string; verdict: string; tool_name: string | null; content_hash: string | null; reason: string | null
  session_id: string | null; trigger_source: string | null; tenant_id: string | null; trace_id: string | null; ts: number
}
const counts = () => dbx.all<CountRow>('SELECT gate, decision, reason, count, first_at, updated_at FROM gate_decision_counts ORDER BY gate, decision, reason')
const rows = () => dbx.all<AuditRow>('SELECT agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id, trace_id, ts FROM hook_audit_log ORDER BY id')
const nothingWritten = async () => { expect(await counts()).toEqual([]); expect(await rows()).toEqual([]) }

describe('who the caller is', () => {
  it('refuses a token that names no agent (403), and writes nothing', async () => {
    const out = await post({ counts: [count('destructive-gate', 'allow', '')], denies: [] }, null)
    expect(out.status).toBe(403)
    await nothingWritten()
  })

  it('ignores an agent_id in the body (and in an entry): the row is the token agent\'s', async () => {
    const out = await post({ agent_id: 'agent-b', counts: [], denies: [{ ...deny('destructive-gate'), agent_id: 'agent-b' }] }, 'agent-a')
    expect(out.status).toBe(200)
    expect((await rows()).map((r) => r.agent_id)).toEqual(['agent-a'])
  })

  it('a GET (or any other method) is not the route', async () => {
    const { ctx } = call({}, 'agent-a', 'GET')
    expect(await tryHandleHooksGateAudit(ctx)).toBe(false)
  })

  it('a body that is not a JSON object is 400 parse_error', async () => {
    for (const raw of ['not json', '[]', 'null', '"x"', '']) {
      const { ctx, out } = call(raw, 'agent-a')
      expect(await tryHandleHooksGateAudit(ctx)).toBe(true)
      expect(out.status, raw).toBe(400)
      expect(out.body).toMatchObject({ error: 'parse_error' })
    }
    await nothingWritten()
  })
})

describe('validation: enforced on the server, a bad entry anywhere writes nothing', () => {
  const good = count('destructive-gate', 'allow', '')
  const bad: [string, unknown][] = [
    ['an unknown gate in a count', { counts: [count('not-a-gate', 'allow', '')] }],
    ['an unknown decision', { counts: [count('destructive-gate', 'maybe', '')] }],
    ['a free-text reason on a deny count', { counts: [count('destructive-gate', 'deny', 'because the command rm -rf was bad')] }],
    ['a reason on an allow count', { counts: [count('destructive-gate', 'allow', 'denied')] }],
    ['an empty reason on a deny count', { counts: [count('destructive-gate', 'deny', '')] }],
    ['a missing reason on an error count', { counts: [{ gate: 'destructive-gate', decision: 'error', n: 1 }] }],
    ['n = 0', { counts: [count('destructive-gate', 'allow', '', 0)] }],
    ['n above the cap', { counts: [count('destructive-gate', 'allow', '', MAX_COUNT_N + 1)] }],
    ['n a float', { counts: [count('destructive-gate', 'allow', '', 1.5)] }],
    ['n a string', { counts: [count('destructive-gate', 'allow', '', '3' as unknown as number)] }],
    ['n negative', { counts: [count('destructive-gate', 'allow', '', -1)] }],
    ['counts not a list', { counts: { gate: 'destructive-gate' } }],
    ['too many counts', { counts: Array.from({ length: MAX_COUNTS + 1 }, () => good) }],
    ['a count that is not an object', { counts: ['destructive-gate'] }],
    ['an unknown gate in a deny', { denies: [deny('not-a-gate')] }],
    ['a free-text reason on a deny', { denies: [deny('destructive-gate', 'the command was dangerous')] }],
    ['a deny reason that is the empty string', { denies: [deny('destructive-gate', '')] }],
    ['ts a string', { denies: [{ gate: 'destructive-gate', reason: 'denied', ts: '123' }] }],
    ['ts a float', { denies: [{ gate: 'destructive-gate', reason: 'denied', ts: 1.5 }] }],
    ['ts missing', { denies: [{ gate: 'destructive-gate', reason: 'denied' }] }],
    ['trace_id a number', { denies: [deny('destructive-gate', 'denied', { trace_id: 7 })] }],
    ['denies not a list', { denies: 'destructive-gate' }],
    ['too many denies', { denies: Array.from({ length: MAX_DENIES + 1 }, () => deny('destructive-gate')) }],
    ['a deny that is not an object', { denies: [null] }],
  ]
  for (const [name, body] of bad) {
    it(`${name}: 400 invalid_value and nothing is written, not even the valid first entry`, async () => {
      const first = { counts: [good], denies: [deny('secret-read-gate')] }
      const merged: { counts: unknown[]; denies: unknown[] } = { ...first, ...(body as object) }
      // the bad part replaces its own list, and a valid sibling entry sits in front of it in the same list
      const b = body as { counts?: unknown[]; denies?: unknown[] }
      if (Array.isArray(b.counts)) merged.counts = [good, ...b.counts]
      if (Array.isArray(b.denies)) merged.denies = [deny('secret-read-gate'), ...b.denies]
      const out = await post(merged)
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value' })
      await nothingWritten()
    })
  }

  it('the caps themselves are accepted (20 counts, 50 denies, n 10000)', async () => {
    const out = await post({
      counts: Array.from({ length: MAX_COUNTS }, (_, i) => count('destructive-gate', 'allow', '', i === 0 ? MAX_COUNT_N : 1)),
      denies: Array.from({ length: MAX_DENIES }, () => deny('destructive-gate')),
    })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, counts: MAX_COUNTS, denies: MAX_DENIES })
    expect((await rows()).length).toBe(MAX_DENIES)
  })

  it('an empty request is acknowledged and writes nothing (a hook with nothing to send is not an error)', async () => {
    expect((await post({})).body).toEqual({ ok: true, counts: 0, denies: 0 })
    expect((await post({ counts: [], denies: [] })).body).toEqual({ ok: true, counts: 0, denies: 0 })
    await nothingWritten()
  })
})

describe('what is written', () => {
  it('the counts ADD (an upsert): two requests make one row with the sum, first_at kept', async () => {
    await post({ counts: [count('destructive-gate', 'allow', '', 3), count('destructive-gate', 'deny', 'denied')] })
    const first = await counts()
    await dbx.run('UPDATE gate_decision_counts SET first_at = 1, updated_at = 1')
    await post({ counts: [count('destructive-gate', 'allow', '', 4)] })
    const after = await counts()
    expect(first.map((r) => [r.decision, r.reason, r.count])).toEqual([['allow', '', 3], ['deny', 'denied', 1]])
    expect(after.map((r) => [r.decision, r.reason, r.count])).toEqual([['allow', '', 7], ['deny', 'denied', 1]])
    expect(after[0]!.first_at).toBe(1) // the first request's time is kept
    expect(after[0]!.updated_at).toBeGreaterThan(1) // and the update time moves
  })

  it('a duplicated key inside one request adds up too', async () => {
    await post({ counts: [count('destructive-gate', 'allow', '', 2), count('destructive-gate', 'allow', '', 5)] })
    expect((await counts()).map((r) => r.count)).toEqual([7])
  })

  it('a deny row has the fixed fields only: the token agent, PreToolUse, deny, the gate, the reason code, the tenant the SERVER resolved for the token agent (default for an agent that serves none), the session id as trace_id', async () => {
    const t = now()
    const out = await post({ denies: [{ gate: 'tenant-skill-gate', reason: 'input_too_large', ts: t, trace_id: 'sess-1234.ab_c:d' }] }, 'agent-a')
    expect(out.status).toBe(200)
    expect(await rows()).toEqual([{
      agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'deny', tool_name: null, content_hash: null, reason: 'input_too_large',
      session_id: null, trigger_source: 'tenant-skill-gate', tenant_id: 'default', trace_id: 'sess-1234.ab_c:d', ts: t,
    }])
  })

  it('a field the contract does not name has nowhere to go: a command, a path, a recipient in the entry or the body are never stored', async () => {
    const sentinel = 'SENTINEL-must-never-be-stored'
    await post({
      command: sentinel, path: sentinel, recipient: sentinel,
      counts: [{ ...count('email-approval-gate', 'deny', 'denied'), command: sentinel, tool_input: sentinel }],
      denies: [{ ...deny('email-approval-gate'), command: sentinel, tool_name: sentinel, content_hash: sentinel, session_id: sentinel, recipient: sentinel }],
    })
    const dump = JSON.stringify([await counts(), await rows()])
    expect(dump).not.toContain(sentinel)
    expect((await rows())[0]).toMatchObject({ tool_name: null, content_hash: null, session_id: null })
  })

  it('a `w3c-` trace id is dropped (as in the generic writer): the row does not carry it', async () => {
    for (const t of ['w3c-abc', 'W3C-abc', 'not an id with spaces', 'a'.repeat(200)]) await post({ denies: [deny('destructive-gate', 'denied', { trace_id: t })] })
    for (const r of await rows()) expect(r.trace_id === null || !/^w3c-/i.test(r.trace_id)).toBe(true)
    expect((await rows()).map((r) => r.trace_id)).not.toContain('w3c-abc')
    expect((await rows()).map((r) => r.trace_id)).not.toContain('not an id with spaces')
  })

  it('ts is clamped to [now - 7 days, now + 60 s]: inside is kept, outside is the server time', async () => {
    const t = now()
    const cases: [string, number, (ts: number) => boolean][] = [
      ['an old one', t - MAX_AGE_SECS - 100, (ts) => Math.abs(ts - t) <= 2],
      ['the epoch', 0, (ts) => Math.abs(ts - t) <= 2],
      ['a negative one', -5, (ts) => Math.abs(ts - t) <= 2],
      ['far in the future', t + MAX_FUTURE_SECS + 1000, (ts) => Math.abs(ts - t) <= 2],
      ['inside, a day old', t - 86400, (ts) => ts === t - 86400],
      ['inside, almost seven days', t - MAX_AGE_SECS + 30, (ts) => ts === t - MAX_AGE_SECS + 30],
      ['inside, a few seconds ahead (clock skew)', t + 30, (ts) => ts === t + 30],
    ]
    for (const [, ts] of cases) await post({ denies: [{ gate: 'destructive-gate', reason: 'denied', ts }] })
    const stored = (await rows()).map((r) => r.ts)
    cases.forEach(([name, , ok], i) => expect(ok(stored[i]!), `${name}: stored ${stored[i]}`).toBe(true))
  })

  it('clampTs at the exact edges', () => {
    const t = 1_700_000_000
    expect(clampTs(t - MAX_AGE_SECS, t)).toBe(t - MAX_AGE_SECS)
    expect(clampTs(t - MAX_AGE_SECS - 1, t)).toBe(t)
    expect(clampTs(t + MAX_FUTURE_SECS, t)).toBe(t + MAX_FUTURE_SECS)
    expect(clampTs(t + MAX_FUTURE_SECS + 1, t)).toBe(t)
  })
})

/** Make every statement of the request that matches `fragment` fail, inside the transaction (the same on both backends). */
function failStatementsMatching(fragment: string): void {
  const real = dbx.tx.bind(dbx)
  vi.spyOn(dbx, 'tx').mockImplementation(((fn: (tx: Tx) => Promise<unknown>, opts?: unknown) =>
    real((tx: Tx) => fn(Object.assign(Object.create(tx), {
      run: (sql: string, ...params: unknown[]) => (sql.includes(fragment) ? Promise.reject(new Error('forced statement failure')) : tx.run(sql, ...params)),
    }) as Tx), opts as never)) as typeof dbx.tx)
}

describe('one transaction: a write that fails half way leaves neither the counts nor the rows', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('the counts are written first, then the deny rows: a failing row insert rolls the counts back', async () => {
    failStatementsMatching('INTO hook_audit_log')
    const { ctx } = call({ counts: [count('destructive-gate', 'deny', 'denied')], denies: [deny('destructive-gate')] }, 'agent-a')
    await expect(tryHandleHooksGateAudit(ctx)).rejects.toThrow('forced statement failure')
    vi.restoreAllMocks()
    expect(await counts()).toEqual([]) // red when the counts are committed in a transaction of their own
  })

  it('the second deny failing takes the first deny and the counts with it', async () => {
    let seen = 0
    const real = dbx.tx.bind(dbx)
    vi.spyOn(dbx, 'tx').mockImplementation(((fn: (tx: Tx) => Promise<unknown>, opts?: unknown) =>
      real((tx: Tx) => fn(Object.assign(Object.create(tx), {
        run: (sql: string, ...params: unknown[]) => (sql.includes('INTO hook_audit_log') && ++seen === 2 ? Promise.reject(new Error('forced statement failure')) : tx.run(sql, ...params)),
      }) as Tx), opts as never)) as typeof dbx.tx)
    const { ctx } = call({ counts: [count('destructive-gate', 'deny', 'denied', 2)], denies: [deny('destructive-gate'), deny('secret-read-gate')] }, 'agent-a')
    await expect(tryHandleHooksGateAudit(ctx)).rejects.toThrow('forced statement failure')
    vi.restoreAllMocks()
    await nothingWritten()
  })

  it('a rejected request is not acknowledged: the answer is never ok:true after a failure', async () => {
    failStatementsMatching('INTO gate_decision_counts')
    const { ctx, out } = call({ counts: [count('destructive-gate', 'allow', '')] }, 'agent-a')
    await expect(tryHandleHooksGateAudit(ctx)).rejects.toThrow()
    expect(out.body).toBeNull()
  })
})

describe('the RBAC row', () => {
  it('is an explicit table row (hook-gate:write), not the admin:all fallback an agent token does not hold', () => {
    expect(ENDPOINT_PERMISSION_TABLE.some((e) => e.method === 'POST' && e.pathPattern === '/api/hooks/gate-audit' && !e.prefix && e.permission === 'hook-gate:write')).toBe(true)
    expect(resolveRequiredPermission('POST', '/api/hooks/gate-audit')).toBe('hook-gate:write')
    expect(resolveRequiredPermission('POST', '/api/hooks/gate-audit/extra')).toBeNull()
    expect(resolveRequiredPermission('GET', '/api/hooks/gate-audit')).not.toBe('hook-gate:write')
  })

  it('is held by fleet_agent and admin and by no tenant-user role', () => {
    for (const r of ['fleet_agent', 'admin'] as Role[]) expect(hasPermission(r, 'hook-gate:write'), r).toBe(true)
    for (const r of ['agent', 'read_only', 'viewer'] as Role[]) expect(hasPermission(r, 'hook-gate:write'), r).toBe(false)
  })
})

describe('parity: the sets and caps are the ones of the Python hook', () => {
  const python = JSON.parse(execFileSync('python3', ['-c', [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(__dirname, '..', '..', 'scripts', 'hooks'))})`,
    'import gate_audit_lib as l',
    'print(json.dumps({"gates": sorted(l.GATES), "decisions": sorted(l.DECISIONS), "reasons": sorted(l.REASONS),',
    ' "drain_batch": l.DRAIN_BATCH, "count_keys": l.MAX_COUNT_KEYS, "count_n": l.MAX_COUNT_N}))',
  ].join('\n')], { encoding: 'utf-8' })) as { gates: string[]; decisions: string[]; reasons: string[]; drain_batch: number; count_keys: number; count_n: number }

  it('gates, decisions and reason codes are the same sets (a gate added on one side only fails here)', () => {
    expect([...GATES].sort()).toEqual(python.gates)
    expect([...DECISIONS].sort()).toEqual(python.decisions)
    expect([...REASONS].sort()).toEqual(python.reasons)
  })

  it('the hook never builds a request the route would refuse: its batch and count caps equal the route caps', () => {
    expect(python.drain_batch).toBe(MAX_DENIES)
    expect(python.count_keys).toBe(MAX_COUNTS)
    expect(python.count_n).toBe(MAX_COUNT_N)
  })
})
