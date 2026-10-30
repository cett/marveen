// The hash-bound approval storage on the async facade, pinned so that each named wrong change fails here and not
// only in tsc or the linter:
//   - every condition of the guarded writes (consume by id / by hash, the sender's adoption), one broken row each;
//   - the interleave that bypasses the transaction lock (a second writer between the deciding read and the write);
//   - the success and its journal row being ONE transaction;
//   - the transaction modes (consume and claim default, open-once immediate);
//   - the best-effort journal never turning a refusal into a failure or an unhandled rejection;
//   - a database error rejecting instead of answering ok;
//   - a raw-connection writer meeting an open facade transaction (a known limit until the tenant delete moves over);
//   - the `await` at every call site.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  db, dbx, createApproval, getApproval, resolveApproval, listApprovalEvents,
  consumeApproval, claimApproval, createApprovalOnce, useUpApproval, adoptReservation, journalConsumeRefusal,
} from '../db.js'
import type { Tx } from '../db/facade.js'
import { useTestDb } from './helpers/with-test-db.js'

const FILE_DB = join(mkdtempSync(join(tmpdir(), 'approval-vault-')), 'test.db')
useTestDb({ path: FILE_DB })
// The database is a file (a second connection must see it), so the rows of one test are removed before the next.
beforeEach(() => { db.exec('DELETE FROM approval_events; DELETE FROM approvals') })
afterEach(() => { vi.restoreAllMocks() })

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const WINDOW = 1800
const NOW = 2_000_000_000
let seq = 0

/** An email_send request of `agent` for `hash`, approved by a person's session 10 s before NOW. */
async function approved(opts: { agent?: string; hash?: string } = {}): Promise<string> {
  const id = `ap-${++seq}`
  await createApproval({
    id, agent_id: opts.agent ?? 'agent-a', category: 'email_send', action_description: 'x',
    tenant_id: 'default', human_only: true, content_hash: opts.hash ?? HASH,
  })
  expect(await resolveApproval(id, 'approved', 'human:session:owner', null, 'dashboard_session')).toBe(true)
  db.prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(NOW - 10, id)
  return id
}

const params = { content_hash: HASH, principal: 'agent-a', tenant_id: 'default', window_s: WINDOW, now: NOW }
const claim = { ...params, category: 'email_send' }

// Wraps the transaction handle of every dbx.tx so a test can look at, hold or fail a statement of the body.
interface TxHooks { get?: (sql: string) => Promise<void> | void; run?: (sql: string) => Promise<void> | void; afterGet?: (sql: string) => Promise<void> | void }
function hookTx(hooks: TxHooks): { modes: Array<string | undefined> } {
  const modes: Array<string | undefined> = []
  const real = dbx.tx.bind(dbx)
  vi.spyOn(dbx, 'tx').mockImplementation((fn: (tx: Tx) => Promise<unknown>, opts?: { mode?: 'deferred' | 'immediate' }) => {
    modes.push(opts?.mode)
    return real((tx: Tx) => fn({
      ...tx,
      get: async (sql: string, ...p: unknown[]) => {
        await hooks.get?.(sql)
        const row = await tx.get(sql, ...p)
        await hooks.afterGet?.(sql)
        return row
      },
      run: async (sql: string, ...p: unknown[]) => { await hooks.run?.(sql); return tx.run(sql, ...p) },
    } as Tx), opts) as never
  })
  return { modes }
}

describe('consume by id and by hash: each condition of the guarded write', () => {
  // One broken condition per row: the control row (nothing broken) is used up, every other one is not.
  const cases: Array<[string, (id: string) => void, Partial<typeof params> & { id?: string }]> = [
    ['an unknown id', () => undefined, { id: 'nope' }],
    ['a category that is not consumable', (id) => { db.prepare("UPDATE approvals SET category = 'other' WHERE id = ?").run(id) }, {}],
    ['a request still pending', (id) => { db.prepare("UPDATE approvals SET status = 'pending' WHERE id = ?").run(id) }, {}],
    ['a rejected request', (id) => { db.prepare("UPDATE approvals SET status = 'rejected' WHERE id = ?").run(id) }, {}],
    ['a row used up already', (id) => { db.prepare('UPDATE approvals SET consumed_at = 1 WHERE id = ?').run(id) }, {}],
    ['another hash', () => undefined, { content_hash: OTHER }],
    ['another tenant', () => undefined, { tenant_id: 'tenant-b' }],
    ['another agent', () => undefined, { principal: 'agent-b' }],
    ['a decision older than the window', (id) => { db.prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(NOW - WINDOW - 1, id) }, {}],
    ['a decision made by a token', (id) => { db.prepare("UPDATE approvals SET resolved_via = 'bearer' WHERE id = ?").run(id) }, {}],
    ['a decision with no recorded way', (id) => { db.prepare('UPDATE approvals SET resolved_via = NULL WHERE id = ?').run(id) }, {}],
  ]

  it('the control row is used up, with who, when and under which ref', async () => {
    const id = await approved()
    expect(await useUpApproval(id, params, NOW, 'r-1')).toBe(true)
    expect(await getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_by: 'agent-a', consumed_ref: 'r-1', used_at: null })
  })

  it('with seal it stamps the effect too', async () => {
    const id = await approved()
    expect(await useUpApproval(id, params, NOW, 'r-1', true)).toBe(true)
    expect(await getApproval(id)).toMatchObject({ consumed_at: NOW, used_at: NOW, used_ref: 'r-1' })
  })

  it.each(cases)('%s: nothing is written', async (_label, breakRow, override) => {
    const id = await approved()
    breakRow(id)
    const before = await getApproval(id)
    expect(await useUpApproval(override.id ?? id, { ...params, ...override }, NOW, 'r-1')).toBe(false)
    expect(await getApproval(id)).toEqual(before)
  })
})

describe('the sender adopting the gate reservation: each condition of the adoption write', () => {
  const reserve = async (): Promise<string> => {
    const id = await approved()
    db.prepare("UPDATE approvals SET consumed_at = ?, consumed_by = 'agent-a', consumed_ref = 'gate-send-1' WHERE id = ?").run(NOW - 5, id)
    return id
  }
  const adoptParams = { principal: 'agent-a', tenant_id: 'default', content_hash: HASH, category: 'email_send' }
  const since = NOW - 120

  const cases: Array<[string, (id: string) => void, Partial<typeof adoptParams>]> = [
    ['another category', () => undefined, { category: 'other' }],
    ['another hash', () => undefined, { content_hash: OTHER }],
    ['another tenant', () => undefined, { tenant_id: 'tenant-b' }],
    ['another agent (the row is the sender\'s own reservation)', (id) => { db.prepare("UPDATE approvals SET consumed_by = 'agent-b' WHERE id = ?").run(id) }, { principal: 'agent-b' }],
    ['a reservation taken by another consumer', (id) => { db.prepare("UPDATE approvals SET consumed_by = 'agent-b' WHERE id = ?").run(id) }, {}],
    ['a request that is no longer approved', (id) => { db.prepare("UPDATE approvals SET status = 'rejected' WHERE id = ?").run(id) }, {}],
    ['a decision made by a token', (id) => { db.prepare("UPDATE approvals SET resolved_via = 'bearer' WHERE id = ?").run(id) }, {}],
    ['a row nobody reserved', (id) => { db.prepare('UPDATE approvals SET consumed_at = NULL WHERE id = ?').run(id) }, {}],
    ['a reservation older than the adoption window', (id) => { db.prepare('UPDATE approvals SET consumed_at = ? WHERE id = ?').run(since - 1, id) }, {}],
    ['a reservation by a plain gate ref', (id) => { db.prepare("UPDATE approvals SET consumed_ref = 'gate-1' WHERE id = ?").run(id) }, {}],
    ['a reservation already sealed', (id) => { db.prepare('UPDATE approvals SET used_at = 1 WHERE id = ?').run(id) }, {}],
  ]

  it('the control reservation is adopted and sealed under the sender ref', async () => {
    const id = await reserve()
    expect(await adoptReservation(id, adoptParams, since, NOW, 'send-1')).toBe(true)
    expect(await getApproval(id)).toMatchObject({ used_at: NOW, used_ref: 'send-1' })
  })

  it.each(cases)('%s: nothing is written', async (_label, breakRow, override) => {
    const id = await reserve()
    breakRow(id)
    const before = await getApproval(id)
    expect(await adoptReservation(id, { ...adoptParams, ...override }, since, NOW, 'send-1')).toBe(false)
    expect(await getApproval(id)).toEqual(before)
  })
})

describe('a second writer between the deciding read and the write', () => {
  // The transaction lock keeps other FACADE callers out of the body; it does not stop another connection or
  // process. The WHERE of the write is then the only line: the row the read picked is gone, so the claim answers
  // refused, not ok. (A raw write on the same connection stands in for the other writer.)
  const takeRowAway = () => { db.prepare("UPDATE approvals SET consumed_at = 1, consumed_by = 'someone-else', consumed_ref = 'x'").run() }

  it('claim: the usable row is used up after the read -> not ok, nothing of this claim written', async () => {
    const id = await approved()
    let fired = false
    hookTx({ afterGet: (sql) => { if (!fired && /status = 'approved' AND consumed_at IS NULL/.test(sql)) { fired = true; takeRowAway() } } })
    const out = await claimApproval({ ...claim, ref: 'r-1' })
    expect(fired).toBe(true)
    expect(out.ok).toBe(false)
    expect(await getApproval(id)).toMatchObject({ consumed_by: 'someone-else' })
    expect(await listApprovalEvents(id)).toHaveLength(1) // only the refusal journal row
  })

  it('claim send: the gate reservation is sealed by someone else after the read -> not adopted', async () => {
    const id = await approved()
    db.prepare("UPDATE approvals SET consumed_at = ?, consumed_by = 'agent-a', consumed_ref = 'gate-send-1' WHERE id = ?").run(NOW - 5, id)
    let fired = false
    hookTx({ afterGet: (sql) => { if (!fired && /consumed_ref LIKE 'gate-send-%' AND used_at IS NULL/.test(sql)) { fired = true; db.prepare('UPDATE approvals SET used_at = 1, used_ref = ?').run('other-sender') } } })
    const out = await claimApproval({ ...claim, now: NOW, ref: 'send-1', mode: 'send' })
    expect(fired).toBe(true)
    expect(out.ok && out.adopted).not.toBe(true)
    expect(await getApproval(id)).toMatchObject({ used_ref: 'other-sender' })
  })
})

describe('the success and its journal row are one transaction', () => {
  const failJournal = (): void => { hookTx({ run: (sql) => { if (/INSERT INTO approval_events/.test(sql)) throw new Error('database unavailable') } }) }

  it('consume by id: a journal error after the write leaves the approval unused', async () => {
    const id = await approved()
    failJournal()
    await expect(consumeApproval({ ...params, id, ref: 'r-1' })).rejects.toThrow('database unavailable')
    vi.restoreAllMocks()
    expect(await getApproval(id)).toMatchObject({ consumed_at: null, consumed_by: null })
  })

  it('claim: a journal error after the write leaves the approval unused', async () => {
    const id = await approved()
    failJournal()
    await expect(claimApproval({ ...claim, ref: 'r-1' })).rejects.toThrow('database unavailable')
    vi.restoreAllMocks()
    expect(await getApproval(id)).toMatchObject({ consumed_at: null })
  })

  it('claim send: the first journal row and the second belong together', async () => {
    const id = await approved()
    let n = 0
    hookTx({ run: (sql) => { if (/INSERT INTO approval_events/.test(sql) && ++n === 2) throw new Error('database unavailable') } })
    await expect(claimApproval({ ...claim, now: NOW, ref: 'send-1', mode: 'send' })).rejects.toThrow('database unavailable')
    vi.restoreAllMocks()
    expect(await getApproval(id)).toMatchObject({ consumed_at: null, used_at: null })
    expect(await listApprovalEvents(id)).toHaveLength(0)
  })
})

describe('the transaction modes are kept', () => {
  it('consume and claim take the default (deferred) mode, open-once the immediate one', async () => {
    const id = await approved()
    const { modes } = hookTx({})
    await consumeApproval({ ...params, id, ref: 'r-1' })
    await claimApproval({ ...claim, ref: 'r-2' })
    await createApprovalOnce({ id: 'req-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: OTHER, max_pending: 5 })
    expect(modes).toEqual([undefined, undefined, 'immediate'])
  })

  // BEGIN IMMEDIATE takes the write lock at once: a second connection cannot start a write while the body is open.
  it('open-once holds the write lock from its first statement: a second connection is refused', async () => {
    const other = new Database(FILE_DB, { timeout: 0 })
    try {
      let refused = ''
      hookTx({
        afterGet: () => {
          try { other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK') } catch (err) { refused = (err as { code?: string }).code ?? String(err) }
        },
      })
      await createApprovalOnce({ id: 'req-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: OTHER, max_pending: 5 })
      expect(refused).toBe('SQLITE_BUSY')
    } finally {
      other.close()
    }
  })
})

describe('the best-effort journal never fails the answer', () => {
  // The write is awaited INSIDE the try. Without the await a rejection escapes the catch as an unhandled rejection
  // (which ends the process by default), while the answer itself would still look fine.
  async function noUnhandledRejection(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = []
    const listener = (reason: unknown): void => { seen.push(reason) }
    process.on('unhandledRejection', listener)
    try {
      await run()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    } finally {
      process.off('unhandledRejection', listener)
    }
    return seen
  }
  const failJournalOutsideTx = () => {
    const original = dbx.run.bind(dbx)
    vi.spyOn(dbx, 'run').mockImplementation(async (sql: string, ...p: unknown[]) => {
      if (/INSERT INTO approval_events/.test(sql)) throw new Error('journal unavailable')
      return original(sql, ...p)
    })
  }

  it('a refused consume: the refusal stands, nothing is unhandled', async () => {
    const id = await approved()
    failJournalOutsideTx()
    let outcome: Awaited<ReturnType<typeof consumeApproval>> | undefined
    const seen = await noUnhandledRejection(async () => { outcome = await consumeApproval({ ...params, id, content_hash: OTHER }) })
    expect(outcome).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(seen).toEqual([])
  })

  it('journalConsumeRefusal itself resolves on a journal error', async () => {
    const id = await approved()
    const approval = await getApproval(id)
    failJournalOutsideTx()
    const seen = await noUnhandledRejection(async () => {
      await expect(journalConsumeRefusal(approval!, 'hash_mismatch', 'agent-a', null)).resolves.toBeUndefined()
    })
    expect(seen).toEqual([])
  })

  it('a deduplicated open-once: the existing request is returned, nothing is unhandled', async () => {
    const req = { agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH, max_pending: 5 }
    expect(await createApprovalOnce({ ...req, id: 'req-1' })).toMatchObject({ ok: true, deduplicated: false })
    failJournalOutsideTx()
    let outcome: Awaited<ReturnType<typeof createApprovalOnce>> | undefined
    const seen = await noUnhandledRejection(async () => { outcome = await createApprovalOnce({ ...req, id: 'req-2' }) })
    expect(outcome).toMatchObject({ ok: true, deduplicated: true })
    expect(outcome?.ok && outcome.approval.id).toBe('req-1')
    expect(seen).toEqual([])
  })
})

describe('a database error rejects, it never answers ok', () => {
  it('consume by id: the guarded write fails', async () => {
    const id = await approved()
    const seen: string[] = []
    hookTx({ run: (sql) => { seen.push(sql); if (/UPDATE approvals SET consumed_at/.test(sql)) throw new Error('database unavailable') } })
    await expect(consumeApproval({ ...params, id, ref: 'r-1' })).rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/UPDATE approvals SET consumed_at/)
  })

  it('claim: the read that picks the usable row fails', async () => {
    const id = await approved()
    const seen: string[] = []
    hookTx({ get: (sql) => { seen.push(sql); if (/status = 'approved' AND consumed_at IS NULL/.test(sql)) throw new Error('database unavailable') } })
    await expect(claimApproval({ ...claim, ref: 'r-1' })).rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/status = 'approved' AND consumed_at IS NULL/)
    vi.restoreAllMocks()
    expect(await getApproval(id)).toMatchObject({ consumed_at: null })
  })

  it('open-once: the insert fails', async () => {
    const seen: string[] = []
    hookTx({ run: (sql) => { seen.push(sql); if (/INSERT INTO approvals/.test(sql)) throw new Error('database unavailable') } })
    await expect(createApprovalOnce({ id: 'req-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH, max_pending: 5 }))
      .rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/INSERT INTO approvals/)
  })
})

describe('a raw-connection writer meets an open facade transaction (known limit)', () => {
  // The tenant delete still writes `approvals` on the raw connection. On one SQLite connection such a write does
  // not wait for the facade's transaction lock: it runs INSIDE the transaction that is open at that moment, and is
  // rolled back with it. The tenant delete moves onto the facade later; until then this is the behaviour.
  it('a raw write joins the open transaction and is undone with it', async () => {
    const id = await approved()
    await expect(dbx.tx(async (tx) => {
      await tx.run('SELECT 1')
      db.prepare("UPDATE approvals SET action_description = 'raw' WHERE id = ?").run(id)
      throw new Error('roll back')
    })).rejects.toThrow('roll back')
    expect((await getApproval(id))?.action_description).toBe('x')
  })

  it('a raw transaction opened inside it becomes a savepoint of it', async () => {
    const id = await approved()
    await expect(dbx.tx(async (tx) => {
      await tx.run('SELECT 1')
      db.transaction(() => { db.prepare("UPDATE approvals SET action_description = 'raw' WHERE id = ?").run(id) })()
      throw new Error('roll back')
    })).rejects.toThrow('roll back')
    expect((await getApproval(id))?.action_description).toBe('x')
  })
})

// A Promise is truthy and has no `.ok`: a missing `await` makes the outcome unreadable, and the approval has been
// used up already. tsc and the linter catch it; this keeps a build that skips them from being the only guard.
describe('the call sites await', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').split('\n')
  const callLines = (rel: string, fn: string) =>
    read(rel).filter((l) => l.includes(`${fn}(`) && !/^\s*(\/\/|\*|import)/.test(l) && !/\bfunction\s/.test(l))

  const sites: Array<[string, string[]]> = [
    ['../web/routes/approvals-consume.ts', ['consumeApproval', 'claimApproval']],
    ['../web/routes/approvals.ts', ['createApprovalOnce']],
    ['../db/vault.ts', ['useUpApproval', 'adoptReservation', 'journalConsumeRefusal', 'recordApprovalEvent', 'getApproval', 'createApproval']],
  ]

  it.each(sites.flatMap(([file, fns]) => fns.map((fn) => [file, fn] as const)))('%s: every call of %s is awaited', (file, fn) => {
    const lines = callLines(file, fn)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(new RegExp(`await\\s+${fn}\\(`))
  })
})
