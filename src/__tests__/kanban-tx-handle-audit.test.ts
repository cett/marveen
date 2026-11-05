// The three kanban transactions that write an audit row (createKanbanSubtasks, promoteIdeaToKanban, deleteKanbanCard):
// every statement of the body, the idea unit of promoteIdeaToKanban and the audit row included, runs on the
// transaction handle, and the audit row on the handle of its SAVEPOINT. On SQLite a call on the facade inside the body
// lands in the same transaction anyway (one connection), so the behaviour alone cannot tell the handle from the
// facade. On PostgreSQL the facade call would be another connection and another transaction: an orphan card, an idea
// without its log row, an audit row for a card that rolled back. This test therefore watches the facade itself: while
// a transaction scope is open, NOTHING may reach it (a nested dbx.tx included). Plus the atomicity that rests on it,
// and the rule that an audit failure inside a body is thrown to its savepoint (rolled back and released), not
// swallowed: a swallowed INSERT error would leave a PostgreSQL transaction aborted (25P02).
//
// Privacy: neutral fixtures only (agent-a, idea-1).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { createKanbanCard, createKanbanSubtasks, deleteKanbanCard, promoteIdeaToKanban, createIdea, getKanbanCard, getDb } from '../db.js'
import { dbx } from '../db.js'
import { currentTxScope } from '../db/tx-lock.js'
import { logger } from '../logger.js'

useTestDb()

interface FacadeCall { op: string; sql: string }
let insideTx: FacadeCall[] = []

/** Record every call that reaches the facade while a transaction scope is open; `failLookups` breaks the tenants lookup. */
function watchFacade(failLookups = false): void {
  insideTx = []
  for (const op of ['run', 'get', 'all', 'exec', 'tx'] as const) {
    const real = dbx[op] as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, op).mockImplementation(((...a: unknown[]) => {
      if (currentTxScope() !== undefined) insideTx.push({ op, sql: String(a[0]).slice(0, 70) })
      if (failLookups && /FROM (tenants|tenant_agent_availability|agent_tenant_context)/.test(String(a[0]))) return Promise.reject(new Error('lookup down'))
      return real.apply(dbx, a)
    }) as never)
  }
}

/** The text of every db.exec (BEGIN, COMMIT, SAVEPOINT, ROLLBACK TO, RELEASE) from now on. */
function recordExec(): string[] {
  const seen: string[] = []
  const db = getDb()
  const original = db.exec.bind(db)
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => { seen.push(sql); return original(sql) })
  return seen
}

const addIdea = (id = 'idea-1') =>
  createIdea({ id, title: 'Idea', description: null, category: 'x', status: 'new', source: 'test', kanban_id: null, impact: null, effort: null, tenant_id: 'default' })
const ideaRow = (id = 'idea-1') => getDb().prepare('SELECT status, kanban_id FROM idea_box WHERE id = ?').get(id) as { status: string; kanban_id: string | null } | undefined
const statusLog = (id = 'idea-1') => (getDb().prepare('SELECT COUNT(*) AS n FROM idea_status_log WHERE idea_id = ?').get(id) as { n: number }).n
const cardCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }).n
const audits = (action: string) =>
  getDb().prepare("SELECT agent_id, entity_id, tenant_id FROM agent_audit_log WHERE entity = 'kanban' AND action = ? ORDER BY id").all(action) as
    { agent_id: string; entity_id: string; tenant_id: string | null }[]
const blockAuditWrites = () =>
  getDb().exec("CREATE TRIGGER audit_blocked BEFORE INSERT ON agent_audit_log BEGIN SELECT RAISE(ABORT, 'audit refused'); END")

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

/** The ROLLBACK TO of the audit savepoint: opened right before it, released right after, under the same name. */
function expectOneRolledBackSavepoint(sql: string[]): void {
  const rollbacks = sql.filter((s) => /^ROLLBACK TO /.test(s))
  expect(rollbacks, JSON.stringify(sql)).toHaveLength(1)
  const at = sql.indexOf(rollbacks[0])
  const name = rollbacks[0].replace('ROLLBACK TO ', '')
  expect(sql[at - 1]).toBe(`SAVEPOINT ${name}`)
  expect(sql[at + 1]).toBe(`RELEASE ${name}`)
  expect(sql[sql.length - 1]).toBe('COMMIT')
}

describe('the harness', () => {
  it('sees a facade call and a nested facade transaction made while a transaction is open (so zero below is not an empty claim)', async () => {
    watchFacade()
    await dbx.tx(async () => { await dbx.run('SELECT 1'); await dbx.tx(() => Promise.resolve()) })
    expect(insideTx.map((c) => c.op)).toEqual(['run', 'tx'])
  })
})

/**
 * Wraps the handles dbx.tx hands out and records the nesting depth (0 = the transaction, 1 = a savepoint of it) of
 * the handle every agent_audit_log INSERT ran on. On one SQLite connection the outer handle and the savepoint handle
 * write the same way, so only the handle itself tells them apart.
 */
function trackAuditHandleDepths(): number[] {
  const depths: number[] = []
  type H = { get: unknown; all: unknown; run: (sql: string, ...p: unknown[]) => Promise<unknown>; exec: unknown; tx: (fn: (h: H) => Promise<unknown>, o?: unknown) => Promise<unknown> }
  const wrap = (h: H, depth: number): H => ({
    get: h.get,
    all: h.all,
    exec: h.exec,
    run: (sql, ...p) => { if (/^INSERT INTO agent_audit_log/.test(sql)) depths.push(depth); return h.run(sql, ...p) },
    tx: (fn, o) => h.tx((inner) => fn(wrap(inner, depth + 1)), o),
  })
  const real = dbx.tx.bind(dbx) as unknown as (fn: (h: H) => Promise<unknown>, o?: unknown) => Promise<unknown>
  vi.spyOn(dbx, 'tx').mockImplementation(((fn: (h: H) => Promise<unknown>, o?: unknown) => real((h) => fn(wrap(h, 0)), o)) as never)
  return depths
}

describe('the audit rows are written on the handle of their own savepoint, not the transaction handle and not the facade', () => {
  it('the harness: an audit row written on the transaction handle is seen at depth 0', async () => {
    const depths = trackAuditHandleDepths()
    await dbx.tx(async (tx) => { await tx.run("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'kanban', 'create')") })
    expect(depths).toEqual([0])
  })

  it('createKanbanSubtasks: one savepoint handle per audit row', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent' })
    const depths = trackAuditHandleDepths()
    await createKanbanSubtasks('p1', [{ title: 'A' }, { title: 'B' }], 'bot')
    expect(depths).toEqual([1, 1])
  })

  it('promoteIdeaToKanban: one savepoint handle per audit row', async () => {
    await addIdea()
    const depths = trackAuditHandleDepths()
    await promoteIdeaToKanban('idea-1', [{ id: 'k1', title: 'Parent' }, { id: 'k2', title: 'Kid', parent_id: 'k1' }], { from: 'new', actor: 'bot', note: 'n' })
    expect(depths).toEqual([1, 1])
  })

  it('deleteKanbanCard: the delete audit row', async () => {
    await createKanbanCard({ id: 'c1', title: 'One' })
    const depths = trackAuditHandleDepths()
    await deleteKanbanCard('c1')
    expect(depths).toEqual([1])
  })
})

describe('createKanbanSubtasks: the subtask rows, the comment and the audit rows run on the handle', () => {
  it('0 facade calls inside; one create audit row per subtask, stamped with the tenant of its agent', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent' })
    watchFacade()
    const ids = await createKanbanSubtasks('p1', [{ title: 'A', assignee: 'agent-a' }, { title: 'B' }], 'bot')
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(audits('create').filter((r) => ids.includes(r.entity_id)).map((r) => [r.agent_id, r.tenant_id])).toEqual([['agent-a', 'default'], ['system', 'default']])
  })

  it('an audit that cannot be written is rolled back in its own savepoint and released; the subtasks and the comment stay', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent' })
    blockAuditWrites()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const sql = recordExec()
    const ids = await createKanbanSubtasks('p1', [{ title: 'A' }], 'bot')
    expect(ids).toHaveLength(1)
    expect(cardCount()).toBe(2)
    expect(warn.mock.calls.some((c) => /audit write failed/.test(String(c[1])))).toBe(true)
    expectOneRolledBackSavepoint(sql)
  })
})

describe('promoteIdeaToKanban: the cards, the idea unit and the audit rows run on the handle', () => {
  const promote = (id = 'idea-1') =>
    promoteIdeaToKanban(id, [{ id: 'k1', title: 'Parent', assignee: 'agent-a' }, { id: 'k2', title: 'Kid', parent_id: 'k1' }], { from: 'new', actor: 'bot', note: 'n' })

  it('0 facade calls inside (the idea unit and its savepoint included); the idea, its log row and the audit rows are written', async () => {
    await addIdea()
    watchFacade()
    expect(await promote()).toBe(true)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(ideaRow()).toEqual({ status: 'kanban', kanban_id: 'k1' })
    expect(statusLog()).toBe(1)
    expect(audits('create').map((r) => [r.entity_id, r.agent_id, r.tenant_id])).toEqual([['k1', 'agent-a', 'default'], ['k2', 'system', 'default']])
  })

  it('an unknown tenant stays an unknown tenant: the rows are stamped NULL, still nothing reaches the facade inside', async () => {
    await addIdea()
    watchFacade(true)
    expect(await promote()).toBe(true)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(audits('create').map((r) => r.tenant_id)).toEqual([null, null])
  })

  it('the idea log row cannot be written: no card stays and the idea is unchanged', async () => {
    await addIdea()
    getDb().exec("CREATE TRIGGER log_blocked BEFORE INSERT ON idea_status_log BEGIN SELECT RAISE(ABORT, 'log refused'); END")
    await expect(promote()).rejects.toThrow('log refused')
    expect(cardCount()).toBe(0)
    expect(ideaRow()).toEqual({ status: 'new', kanban_id: null })
    expect(audits('create')).toEqual([])
  })

  it('the idea row is gone: false, and nothing is written (no card, no log row, no audit row)', async () => {
    expect(await promote('idea-gone')).toBe(false)
    expect(cardCount()).toBe(0)
    expect(statusLog('idea-gone')).toBe(0)
    expect(audits('create')).toEqual([])
  })

  it('an audit that cannot be written is rolled back in its own savepoint and released; the cards and the idea change stay', async () => {
    await addIdea()
    blockAuditWrites()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const sql = recordExec()
    expect(await promoteIdeaToKanban('idea-1', [{ id: 'k1', title: 'Parent' }], { from: 'new', actor: 'bot', note: 'n' })).toBe(true)
    expect(cardCount()).toBe(1)
    expect(ideaRow()).toEqual({ status: 'kanban', kanban_id: 'k1' })
    expect(statusLog()).toBe(1)
    expect(warn.mock.calls.some((c) => /audit write failed/.test(String(c[1])))).toBe(true)
    expectOneRolledBackSavepoint(sql)
  })
})

describe('deleteKanbanCard: the delete and its audit row run on the handle', () => {
  it('0 facade calls inside; the delete audit row is written with the tenant of the card agent', async () => {
    await createKanbanCard({ id: 'c1', title: 'One', assignee: 'agent-a' })
    watchFacade()
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(audits('delete').map((r) => [r.entity_id, r.agent_id, r.tenant_id])).toEqual([['c1', 'agent-a', 'default']])
  })

  it('an audit that cannot be written is rolled back in its own savepoint and released; the delete stays', async () => {
    await createKanbanCard({ id: 'c1', title: 'One' })
    blockAuditWrites()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const sql = recordExec()
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(await getKanbanCard('c1')).toBeUndefined()
    expect(warn.mock.calls.some((c) => /audit write failed/.test(String(c[1])))).toBe(true)
    expectOneRolledBackSavepoint(sql)
  })
})
