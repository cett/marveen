// The W3-1 modules on the async db facade: what has to hold when two calls overlap, that a failed multi-statement
// write leaves nothing behind, and that the transaction bodies of claude-plans run on the transaction handle.
// Real in-memory database, no mocks (the one spy only counts calls). Each test names the line it protects.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'
import {
  db, dbx, beginInflightTurn, endInflightTurn, replaceClaudePlanRows, deleteClaudePlanRow, activatePlanForAgent,
  getActivePlanForAgent, listClaudePlanRows, sweepStaleActivePlans, getOtelLogCursor, getOtelLogHashSalt,
} from '../db.js'
import { replaceClaudePlanRowsSync } from '../db/claude-plans.js'

useTestDb()
afterEach(() => { vi.restoreAllMocks() })

const plan = (id: string) => ({ id, label: `Team ${id}`, configDir: `/tmp/${id}`, planType: 'team' as const, channelsAllowed: true })
const ids = async () => (await listClaudePlanRows()).map((r) => r.id)

describe('endInflightTurn', () => {
  it('of two overlapping ends exactly one reports the row it dropped', async () => {
    await beginInflightTurn('agent-a', { head: 'hello', prompt_hash: 'h1' })
    const results = await Promise.all([endInflightTurn('agent-a'), endInflightTurn('agent-a')])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await endInflightTurn('agent-a')).toBe(false)
  })
})

describe('replaceClaudePlanRows', () => {
  it('a failing delete of a dropped plan rolls the whole replace back: rows, the dropped binding and the upserts', async () => {
    await replaceClaudePlanRows([plan('p1'), plan('p2')])
    await activatePlanForAgent('agent-a', 'p1', 'manual')
    await refuseWrite(dbx, { name: 'plan_delete_blocked', table: 'claude_plans_registry', message: 'blocked', event: 'DELETE' })
    await expect(replaceClaudePlanRows([{ ...plan('p2'), label: 'renamed' }])).rejects.toThrow(/blocked/)
    expect(await ids()).toEqual(['p1', 'p2'])
    expect((await listClaudePlanRows()).find((r) => r.id === 'p2')?.label).toBe('Team p2')
    expect((await getActivePlanForAgent('agent-a'))?.id).toBe('p1')
  })

  it('the transaction body runs on the transaction handle: no dbx call while it is open', async () => {
    await replaceClaudePlanRows([plan('p1')])
    const spies = (['get', 'run', 'all'] as const).map((m) => vi.spyOn(dbx, m))
    await replaceClaudePlanRows([plan('p2')])
    await deleteClaudePlanRow('p2')
    expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 0, 0])
  })

  // SQLite's deferred mode (db.transaction, no BEGIN IMMEDIATE): PostgreSQL has no such mode, so this cell is SQLite-only.
  it.runIf(testDbMode() === 'sqlite')('the transaction is deferred, as db.transaction was (no BEGIN IMMEDIATE)', async () => {
    const exec = vi.spyOn(db, 'exec')
    await replaceClaudePlanRows([plan('p1')])
    await deleteClaudePlanRow('p1')
    const begins = exec.mock.calls.map((c) => String(c[0])).filter((sql) => sql.startsWith('BEGIN'))
    expect(begins).toEqual(['BEGIN', 'BEGIN'])
  })

  // The boot-synchronous twin runs on the raw SQLite connection (@boot-sync-twin): SQLite-only.
  it.runIf(testDbMode() === 'sqlite')('the boot twin leaves the same rows and bindings as the async function for the same input', async () => {
    await replaceClaudePlanRows([plan('p1'), plan('p2')])
    await activatePlanForAgent('agent-a', 'p1', 'manual')
    await activatePlanForAgent('agent-b', 'p2', 'manual')
    replaceClaudePlanRowsSync([{ ...plan('p2'), label: 'renamed' }, plan('p3')])
    expect(await ids()).toEqual(['p2', 'p3'])
    expect((await listClaudePlanRows()).find((r) => r.id === 'p2')?.label).toBe('renamed')
    expect(await getActivePlanForAgent('agent-a')).toBeNull()
    expect((await getActivePlanForAgent('agent-b'))?.id).toBe('p2')
  })
})

describe('deleteClaudePlanRow', () => {
  it('a failing delete of the plan keeps the binding (the two deletes are one transaction)', async () => {
    await replaceClaudePlanRows([plan('p1')])
    await activatePlanForAgent('agent-a', 'p1', 'manual')
    await refuseWrite(dbx, { name: 'plan_delete_blocked', table: 'claude_plans_registry', message: 'blocked', event: 'DELETE' })
    await expect(deleteClaudePlanRow('p1')).rejects.toThrow(/blocked/)
    expect((await getActivePlanForAgent('agent-a'))?.id).toBe('p1')
  })
})

describe('sweepStaleActivePlans', () => {
  it('counts exactly the bindings older than the TTL and leaves the fresh one', async () => {
    await replaceClaudePlanRows([plan('p1')])
    await activatePlanForAgent('agent-a', 'p1', 'manual')
    await activatePlanForAgent('agent-b', 'p1', 'manual')
    await dbx.run('UPDATE agent_active_plans SET last_heartbeat = 1 WHERE agent_id = ?', 'agent-a')
    expect(await sweepStaleActivePlans(10)).toBe(1)
    expect(await getActivePlanForAgent('agent-a')).toBeNull()
    expect((await getActivePlanForAgent('agent-b'))?.id).toBe('p1')
  })
})

describe('the otel log export state', () => {
  it('two overlapping first cursor reads create one row and answer the same value', async () => {
    const results = await Promise.all([getOtelLogCursor('agent_audit_log'), getOtelLogCursor('agent_audit_log')])
    expect(results[0]).toBe(results[1])
    expect(Number((await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM otel_logs_export_state WHERE source = 'agent_audit_log'"))?.n)).toBe(1)
  })

  it('two overlapping first salt reads answer one salt, and the stored one', async () => {
    const [first, second] = await Promise.all([getOtelLogHashSalt(), getOtelLogHashSalt()])
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await getOtelLogHashSalt()).toBe(first)
  })
})

// The replace of the registry and an activation of a plan the replace drops, racing: the activation's row takes the
// foreign key share lock on the plan, the replace waits for it, and once the activation has committed the replace's
// delete finds the row and fails (agent_active_plans_plan_id_fkey, NO ACTION). This is the intended fail-closed outcome,
// not a race to fix: the replace is a rare admin write, its one caller (the route's best-effort mirror write) logs the
// failure and the route still answers, and nothing is lost. The activation stands, the plan stays (the replace rolls
// back as a whole), and no active row is left pointing at a missing plan. Pinned on PostgreSQL only: SQLite has one
// connection, so the two statements cannot overlap.
describe('replaceClaudePlanRows against an activation of the plan it drops (PostgreSQL)', () => {
  it.runIf(testDbMode() === 'pg')('the activation stands, the plan stays, the replace is refused with the foreign key error, no row is orphaned', async () => {
    await replaceClaudePlanRows([plan('p1'), plan('p2')])
    const il = interleave()
    il.hold('activation-parked')
    const activation = dbx.tx(async (tx) => {
      await tx.run("INSERT INTO agent_active_plans (agent_id, plan_id, activated_at, last_heartbeat, source) VALUES ('agent-a', 'p1', unixepoch(), unixepoch(), 'manual')")
      await il.pass('activation-parked')
    })
    await il.reached('activation-parked')
    const replaced = replaceClaudePlanRows([plan('p2')]).then(() => null, (err: unknown) => err)
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('activation-parked')
    }
    await activation
    const err = await replaced
    expect(String(err)).toMatch(/foreign key constraint/)
    expect((await getActivePlanForAgent('agent-a'))?.id).toBe('p1')
    expect(await ids()).toEqual(['p1', 'p2'])
    expect(Number((await dbx.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_active_plans a WHERE NOT EXISTS (SELECT 1 FROM claude_plans_registry r WHERE r.id = a.plan_id)',
    ))?.n)).toBe(0)
  })
})
