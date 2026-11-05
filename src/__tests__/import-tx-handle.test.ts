// deleteImportSource, wipeImportMemories and upsertImportMemory (src/db/import.ts) each run in ONE transaction: the
// import rows, their shadow `memories` rows and the link between them. Every statement of the three bodies, and of the
// helpers they call, must run on the transaction handle. On SQLite a call on the facade inside the body lands in the
// same transaction anyway (one connection), so the behaviour alone cannot tell the handle from the facade. On
// PostgreSQL the facade call would be another connection and another transaction: the shadow-id SELECT would not see
// the detach, the DELETE could commit in part (a shadow `memories` row without its import row, or the reverse), and the
// read-then-write of the upsert would lose its atomicity. This test therefore watches the facade itself: while a
// transaction scope is open, NOTHING may reach it (a nested dbx.tx included). Plus the atomicity that rests on it and
// the rule that the ANN (vec0) delete runs after the commit and never after a rollback.
//
// Privacy: neutral fixtures only (src-a, a.md).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const vec = vi.hoisted(() => ({ calls: [] as Array<{ id: number; insideTx: boolean }>, scope: (() => false) as () => boolean }))
vi.mock('../db/vector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/vector.js')>()),
  syncVecMemoryDelete: (id: number) => { vec.calls.push({ id, insideTx: vec.scope() }) },
}))

import { dbx, getDb, insertImportSource, upsertImportMemory, deleteImportSource, wipeImportMemories } from '../db.js'
import { currentTxScope } from '../db/tx-lock.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const NOW = 1_800_000_000

interface FacadeCall { op: string; sql: string }
let insideTx: FacadeCall[] = []

/** Record every call that reaches the facade while a transaction scope is open. */
function watchFacade(): void {
  insideTx = []
  for (const op of ['run', 'get', 'all', 'exec', 'tx'] as const) {
    const real = dbx[op] as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, op).mockImplementation(((...a: unknown[]) => {
      if (currentTxScope() !== undefined) insideTx.push({ op, sql: String(a[0]).slice(0, 70) })
      return real.apply(dbx, a)
    }) as never)
  }
}

async function source(id = 'src-a'): Promise<void> {
  await insertImportSource({
    id, type: 'local', path: `/docs/${id}`, label: id, intervalHours: 4, enabled: true, now: NOW,
    tenantId: 'default', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
  })
}
const upsert = (file: string, content: string, hash = `h-${content}`, sourceId = 'src-a') =>
  upsertImportMemory(sourceId, `/docs/${file}`, file, hash, content, 'kw', NOW, 'default')
const count = (table: string, where = '1=1'): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n
const shadowIds = () => (getDb().prepare('SELECT memory_shadow_id AS id FROM import_memories WHERE memory_shadow_id IS NOT NULL ORDER BY id').all() as { id: number }[]).map((r) => r.id)
const abortOn = (name: string, event: string, table: string) =>
  getDb().exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, '${name}'); END`)

beforeEach(() => { vi.restoreAllMocks(); vec.calls.length = 0; vec.scope = () => currentTxScope() !== undefined })
afterEach(() => { vi.restoreAllMocks() })

describe('the harness', () => {
  it('sees a facade call and a nested facade transaction made while a transaction is open (so zero below is not an empty claim)', async () => {
    watchFacade()
    await dbx.tx(async () => { await dbx.run('SELECT 1'); await dbx.tx(() => Promise.resolve()) })
    expect(insideTx.map((c) => c.op)).toEqual(['run', 'tx'])
  })
})

describe('deleteImportSource: every statement runs on the transaction handle', () => {
  async function seeded(): Promise<void> {
    await source()
    await upsert('a.md', 'text a')
    await upsert('b.md', 'text b')
  }

  it('a source with shadow rows: 0 facade calls inside; source, import rows and shadow rows are gone, the ANN delete ran after the commit', async () => {
    await seeded()
    const ids = shadowIds()
    watchFacade()
    expect(await deleteImportSource('src-a')).toBe(true)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(count('import_sources')).toBe(0)
    expect(count('import_memories')).toBe(0)
    expect(count('memories', "agent_id = 'import'")).toBe(0)
    expect(vec.calls.map((c) => c.id).sort()).toEqual([...ids].sort())
    expect(vec.calls.every((c) => !c.insideTx)).toBe(true)
  })

  it('a source without shadow rows: 0 facade calls inside, nothing to drop', async () => {
    await source()
    watchFacade()
    expect(await deleteImportSource('src-a')).toBe(true)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(count('import_sources')).toBe(0)
    expect(vec.calls).toEqual([])
  })

  it('an absent source: false, 0 facade calls inside, no ANN delete; the rows it had detached stay detached (as before)', async () => {
    await source()
    await upsert('a.md', 'text a')
    // an import row whose source row is gone: the detach runs, the source delete changes nothing, the unit commits
    getDb().pragma('foreign_keys = OFF')
    getDb().prepare("UPDATE import_memories SET source_id = 'src-gone'").run()
    getDb().pragma('foreign_keys = ON')
    watchFacade()
    expect(await deleteImportSource('src-gone')).toBe(false)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(count('import_memories', 'memory_shadow_id IS NULL')).toBe(1)
    expect(count('memories', "agent_id = 'import'")).toBe(1)
    expect(vec.calls).toEqual([])
  })

  it('a shadow delete that cannot be written rolls back the detach, the source delete and the shadow rows; no ANN delete', async () => {
    await seeded()
    abortOn('shadow_delete_refused', 'DELETE', 'memories')
    await expect(deleteImportSource('src-a')).rejects.toThrow('shadow_delete_refused')
    expect(count('import_sources')).toBe(1)
    expect(count('import_memories', 'memory_shadow_id IS NOT NULL')).toBe(2)
    expect(count('memories', "agent_id = 'import'")).toBe(2)
    expect(vec.calls).toEqual([])
  })
})

describe('wipeImportMemories: every statement runs on the transaction handle', () => {
  async function seeded(): Promise<void> {
    await source('src-a')
    await source('src-b')
    await upsert('a.md', 'text a', undefined, 'src-a')
    await upsert('b.md', 'text b', undefined, 'src-b')
  }

  it('one source: 0 facade calls inside; only its rows and shadow rows go, the ANN delete ran after the commit', async () => {
    await seeded()
    const kept = (getDb().prepare("SELECT memory_shadow_id AS id FROM import_memories WHERE source_id = 'src-b'").get() as { id: number }).id
    watchFacade()
    expect(await wipeImportMemories('src-a')).toBe(1)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(count('import_memories')).toBe(1)
    expect(shadowIds()).toEqual([kept])
    expect(vec.calls).toHaveLength(1)
    expect(vec.calls[0].insideTx).toBe(false)
  })

  it('every source: 0 facade calls inside; all rows and shadow rows go', async () => {
    await seeded()
    watchFacade()
    expect(await wipeImportMemories()).toBe(2)
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(count('import_memories')).toBe(0)
    expect(count('memories', "agent_id = 'import'")).toBe(0)
    expect(vec.calls).toHaveLength(2)
  })

  it('a shadow delete that cannot be written rolls back the detach and the row delete; no ANN delete', async () => {
    await seeded()
    abortOn('shadow_delete_refused', 'DELETE', 'memories')
    await expect(wipeImportMemories('src-a')).rejects.toThrow('shadow_delete_refused')
    expect(count('import_memories')).toBe(2)
    expect(count('import_memories', 'memory_shadow_id IS NOT NULL')).toBe(2)
    expect(vec.calls).toEqual([])
  })
})

describe('upsertImportMemory: every statement runs on the transaction handle', () => {
  beforeEach(async () => { await source() })

  it("added: 0 facade calls inside; the import row, the shadow row and the link are written", async () => {
    watchFacade()
    expect(await upsert('a.md', 'text a')).toBe('added')
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(count('import_memories', 'memory_shadow_id IS NOT NULL')).toBe(1)
    expect(count('memories', "agent_id = 'import'")).toBe(1)
  })

  it('updated, text changed: 0 facade calls inside; the shadow text follows, the ANN delete ran after the commit', async () => {
    await upsert('a.md', 'old text')
    const [shadow] = shadowIds()
    watchFacade()
    expect(await upsert('a.md', 'new text')).toBe('updated')
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(getDb().prepare('SELECT content FROM memories WHERE id = ?').get(shadow)).toEqual({ content: 'new text' })
    expect(vec.calls).toEqual([{ id: shadow, insideTx: false }])
  })

  it('updated, hash only: 0 facade calls inside; the ANN entry is kept', async () => {
    await upsert('a.md', 'same text', 'hash-1')
    watchFacade()
    expect(await upsert('a.md', 'same text', 'hash-2')).toBe('updated')
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(vec.calls).toEqual([])
  })

  it('hash_match: 0 facade calls inside', async () => {
    await upsert('a.md', 'same text', 'hash-1')
    watchFacade()
    expect(await upsert('a.md', 'same text', 'hash-1')).toBe('hash_match')
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
  })

  it('updated with a missing shadow row (the defensive branch): 0 facade calls inside; the shadow row is created and linked', async () => {
    await upsert('a.md', 'old text')
    getDb().prepare('UPDATE import_memories SET memory_shadow_id = NULL').run()
    getDb().prepare("DELETE FROM memories WHERE agent_id = 'import'").run()
    expect(shadowIds()).toEqual([])
    watchFacade()
    expect(await upsert('a.md', 'new text')).toBe('updated')
    expect(insideTx, JSON.stringify(insideTx)).toHaveLength(0)
    expect(count('memories', "agent_id = 'import'")).toBe(1)
    expect(shadowIds()).toHaveLength(1)
  })

  it('added, the shadow insert cannot be written: no import row stays', async () => {
    abortOn('shadow_insert_refused', 'INSERT', 'memories')
    await expect(upsert('a.md', 'text a')).rejects.toThrow('shadow_insert_refused')
    expect(count('import_memories')).toBe(0)
    expect(count('memories', "agent_id = 'import'")).toBe(0)
  })

  it('updated, the shadow update cannot be written: the import row update rolls back (old hash and content stay), no ANN delete', async () => {
    await upsert('a.md', 'old text', 'hash-old')
    abortOn('shadow_update_refused', 'UPDATE', 'memories')
    await expect(upsert('a.md', 'new text', 'hash-new')).rejects.toThrow('shadow_update_refused')
    expect(getDb().prepare('SELECT content_hash, content FROM import_memories').get()).toEqual({ content_hash: 'hash-old', content: 'old text' })
    expect(vec.calls).toEqual([])
  })
})
