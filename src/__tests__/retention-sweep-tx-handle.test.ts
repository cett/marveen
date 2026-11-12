// The retention sweep (pruneAuditLogs) and the manual hook-audit prune (pruneHookAuditLogJournaled) run their deletes AND
// the journal row in one transaction ("no deletion without its record, no record without the deletion"). On SQLite a
// call on the facade inside the transaction body lands in the same transaction anyway (one connection), so the
// behaviour alone cannot tell a statement on the transaction handle from one on the facade. On PostgreSQL the facade
// call would be another connection and another transaction. This test therefore watches the facade itself: while a
// transaction scope is open, NOTHING may reach it. Plus the atomicity that rests on it.
//
// Privacy: neutral fixtures only (agent-a, key-a).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { dbx, pruneAuditLogs, pruneHookAuditLogJournaled, writeAgentAuditLog } from '../db.js'
import { currentTxScope } from '../db/tx-lock.js'

useTestDb()

const DAY = 86400
const nowSec = () => Math.floor(Date.now() / 1000)
// Older than every window (the audit window is 90 days, the span window 30).
const VERY_OLD = () => nowSec() - 400 * DAY

interface FacadeCall { op: string; inTx: boolean; sql: string }
let facadeCalls: FacadeCall[] = []

/** Record every call that reaches the facade (dbx.run / get / all / exec) and whether a transaction scope was open. */
function watchFacade(): void {
  facadeCalls = []
  for (const op of ['run', 'get', 'all', 'exec'] as const) {
    const real = dbx[op] as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, op).mockImplementation(((...a: unknown[]) => {
      facadeCalls.push({ op, inTx: currentTxScope() !== undefined, sql: String(a[0]).slice(0, 70) })
      return real.apply(dbx, a)
    }) as never)
  }
}
const insideTx = () => facadeCalls.filter((c) => c.inTx)

async function count(table: string): Promise<number> {
  return ((await dbx.get(`SELECT COUNT(*) AS n FROM ${table}`)) as { n: number }).n
}
async function seedOldRows(): Promise<void> {
  await dbx.run("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('key-a', '1', '2', 'agent-a', ?)", VERY_OLD())
  await dbx.run("INSERT INTO hook_audit_log (ts, hook_type, verdict) VALUES (?, 'Stop', 'allow')", VERY_OLD())
}
/** The next journal row cannot be written: an INSERT of a retention_prune row aborts. */
async function breakTheJournal(): Promise<void> {
  await dbx.exec(`CREATE TRIGGER no_prune_journal BEFORE INSERT ON agent_audit_log
    WHEN NEW.action = 'retention_prune' BEGIN SELECT RAISE(ABORT, 'journal write refused'); END`)
}
const journalRows = async () => ((await dbx.get("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'retention_prune'")) as { n: number }).n

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe('the harness', () => {
  it('sees a facade call made while a transaction is open (so zero below is not an empty claim)', async () => {
    watchFacade()
    await dbx.tx(async () => { await dbx.run('SELECT 1') })
    expect(insideTx().map((c) => c.op)).toEqual(['run'])
  })

  it('sees a facade call made outside a transaction as outside', async () => {
    watchFacade()
    await dbx.run('SELECT 1')
    expect(facadeCalls).toHaveLength(1)
    expect(insideTx()).toHaveLength(0)
  })
})

describe('pruneAuditLogs: every statement of the sweep transaction goes through the transaction handle', () => {
  it('no call reaches the facade while the transaction is open, and the sweep still deletes and journals', async () => {
    await seedOldRows()
    watchFacade()
    const result = await pruneAuditLogs()
    expect(insideTx(), JSON.stringify(insideTx())).toHaveLength(0)
    expect(result.deleted.config_change_log).toBe(1)
    expect(result.deleted.hook_audit_log).toBe(1)
    expect(await journalRows()).toBe(1)
  })

  it('when the journal row cannot be written the deletes roll back with it', async () => {
    await seedOldRows()
    await breakTheJournal()
    await expect(pruneAuditLogs()).rejects.toThrow('journal write refused')
    expect(await count('config_change_log')).toBe(1)
    expect(await count('hook_audit_log')).toBe(1)
    expect(await journalRows()).toBe(0)
  })
})

describe('pruneHookAuditLogJournaled: the same proof for the manual prune', () => {
  it('no call reaches the facade while the transaction is open, and the prune still deletes and journals', async () => {
    await seedOldRows()
    watchFacade()
    const removed = await pruneHookAuditLogJournaled(30 * DAY, { agentId: 'agent-a' })
    expect(insideTx(), JSON.stringify(insideTx())).toHaveLength(0)
    expect(removed).toBe(1)
    expect(await count('hook_audit_log')).toBe(0)
    expect(await count('config_change_log')).toBe(1) // the manual prune touches the hook log only
    expect(await journalRows()).toBe(1)
  })

  it('when the journal row cannot be written the delete rolls back with it', async () => {
    await seedOldRows()
    await breakTheJournal()
    await expect(pruneHookAuditLogJournaled(30 * DAY, { agentId: 'agent-a' })).rejects.toThrow('journal write refused')
    expect(await count('hook_audit_log')).toBe(1)
    expect(await journalRows()).toBe(0)
  })
})

describe('writeAgentAuditLog keeps its default for every other caller', () => {
  it('without a handle it writes on the facade, exactly as before', async () => {
    watchFacade()
    await writeAgentAuditLog({ agent_id: 'agent-a', entity: 'system', action: 'create', tenant_id: null })
    const inserts = facadeCalls.filter((c) => c.op === 'run' && c.sql.startsWith('INSERT INTO agent_audit_log'))
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.inTx).toBe(false)
    expect(await count('agent_audit_log')).toBe(1)
  })

  it('with a handle it writes on that handle and not on the facade', async () => {
    await dbx.tx(async (tx) => {
      watchFacade()
      await writeAgentAuditLog({ agent_id: 'agent-a', entity: 'system', action: 'create', tenant_id: null }, tx)
      expect(facadeCalls).toHaveLength(0)
    })
    expect(await count('agent_audit_log')).toBe(1)
  })
})
