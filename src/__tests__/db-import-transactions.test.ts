// db/import.ts on the async facade: upsertImportMemory, deleteImportSource and wipeImportMemories were
// uninterruptible while the module was synchronous. Each is one transaction now (the import row, its shadow
// `memories` row and the link between them), and the ANN index (vec0, raw handle) is only touched after the
// commit. A trigger that aborts the last write of a function stands for the partial failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const vec = vi.hoisted(() => ({ deleted: [] as number[] }))
vi.mock('../db/vector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/vector.js')>()),
  syncVecMemoryDelete: (id: number) => { vec.deleted.push(id) },
}))

import { dbx, getDb, insertImportSource, upsertImportMemory, deleteImportSource, wipeImportMemories } from '../db.js'
import { testDbMode, useTestDb } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'

useTestDb()

const NOW = 1_800_000_000

async function source(id = 'src-a'): Promise<void> {
  await insertImportSource({
    id, type: 'local', path: `/docs/${id}`, label: id, intervalHours: 4, enabled: true, now: NOW,
    tenantId: 'default', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
  })
}

const upsert = (file: string, content: string, hash = `h-${content}`) =>
  upsertImportMemory('src-a', `/docs/${file}`, file, hash, content, 'kw', NOW, 'default')

const count = async (table: string, where = '1=1'): Promise<number> =>
  Number((await dbx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`))?.n)
const importRows = () => count('import_memories')
const shadowRows = () => count('memories', "agent_id = 'import'")

beforeEach(() => { vec.deleted.length = 0 })

describe('upsertImportMemory is one transaction', () => {
  // SQLite only: the trigger is column-specific (BEFORE UPDATE OF <column>), which the refusal helper does not express
  it.runIf(testDbMode() === 'sqlite')('a failure on the last write of a new file leaves neither the import row nor the shadow row', async () => {
    await source()
    getDb().exec(`CREATE TRIGGER fail_link BEFORE UPDATE OF memory_shadow_id ON import_memories
      BEGIN SELECT RAISE(ABORT, 'link failed'); END`)

    await expect(upsert('new.md', 'fresh text')).rejects.toThrow('link failed')

    expect(await importRows()).toBe(0)
    expect(await shadowRows()).toBe(0)
  })

  it.runIf(testDbMode() === 'sqlite')('a failure while syncing the shadow row of a changed file keeps the old import row and shadow text', async () => {
    await source()
    await upsert('note.md', 'old text')
    getDb().exec(`CREATE TRIGGER fail_shadow BEFORE UPDATE OF content ON memories
      BEGIN SELECT RAISE(ABORT, 'shadow failed'); END`)

    await expect(upsert('note.md', 'new text')).rejects.toThrow('shadow failed')

    expect(await dbx.get('SELECT content FROM import_memories')).toEqual({ content: 'old text' })
    expect(await dbx.get("SELECT content FROM memories WHERE agent_id = 'import'")).toEqual({ content: 'old text' })
    expect(vec.deleted).toEqual([])
  })

  it('a changed text drops the ANN entry of the shadow row once, after the commit', async () => {
    await source()
    await upsert('note.md', 'old text')
    const shadowId = (await dbx.get<{ id: number }>("SELECT id FROM memories WHERE agent_id = 'import'"))!.id

    expect(await upsert('note.md', 'new text')).toBe('updated')

    expect(vec.deleted).toEqual([shadowId])
    expect(await dbx.get('SELECT embedding_blob FROM memories WHERE id = ?', shadowId)).toEqual({ embedding_blob: null })
  })

  it('an unchanged text (hash differs only) keeps the ANN entry', async () => {
    await source()
    await upsert('note.md', 'same text', 'hash-1')

    expect(await upsert('note.md', 'same text', 'hash-2')).toBe('updated')

    expect(vec.deleted).toEqual([])
  })

  // SQLite only: on PostgreSQL two first writes of one file both insert and the second hits the primary key (an error, no
  // duplicate row). That is a production finding (no per-file lock on upsertImportMemory), not a harness difference.
  it.runIf(testDbMode() === 'sqlite')('two overlapping calls for one file leave one import row and one shadow row', async () => {
    await source()

    const results = await Promise.all([upsert('race.md', 'same text'), upsert('race.md', 'same text')])

    expect([...results].sort()).toEqual(['added', 'hash_match'])
    expect(await importRows()).toBe(1)
    expect(await shadowRows()).toBe(1)
  })
})

describe('deleteImportSource / wipeImportMemories are one transaction', () => {
  async function seeded(): Promise<number[]> {
    await source()
    await upsert('a.md', 'text a')
    await upsert('b.md', 'text b')
    return (await dbx.all<{ id: number }>('SELECT memory_shadow_id AS id FROM import_memories ORDER BY id')).map(r => r.id)
  }
  const failShadowDelete = () => refuseWrite(dbx, { name: 'fail_delete', table: 'memories', message: 'delete failed', event: 'DELETE' })

  it('deleteImportSource: a failed shadow delete rolls back the detach and the source delete', async () => {
    await seeded()
    await failShadowDelete()

    await expect(deleteImportSource('src-a')).rejects.toThrow('delete failed')

    expect(await count('import_sources')).toBe(1)
    expect(await count('import_memories', 'memory_shadow_id IS NOT NULL')).toBe(2)
    expect(vec.deleted).toEqual([])
  })

  it('deleteImportSource: removes source, import rows and shadow rows, then drops the ANN entries', async () => {
    const shadowIds = await seeded()

    expect(await deleteImportSource('src-a')).toBe(true)

    expect(await count('import_sources')).toBe(0)
    expect(await importRows()).toBe(0)
    expect(await shadowRows()).toBe(0)
    expect([...vec.deleted].sort()).toEqual([...shadowIds].sort())
  })

  it('deleteImportSource: an absent source is false, nothing is dropped', async () => {
    await seeded()

    expect(await deleteImportSource('nope')).toBe(false)

    expect(await shadowRows()).toBe(2)
    expect(vec.deleted).toEqual([])
  })

  it('wipeImportMemories: a failed shadow delete rolls back the detach and the row delete', async () => {
    await seeded()
    await failShadowDelete()

    await expect(wipeImportMemories('src-a')).rejects.toThrow('delete failed')

    expect(await importRows()).toBe(2)
    expect(await count('import_memories', 'memory_shadow_id IS NOT NULL')).toBe(2)
    expect(vec.deleted).toEqual([])
  })

  it('wipeImportMemories: returns the number of rows, removes the shadow rows, drops the ANN entries', async () => {
    const shadowIds = await seeded()

    expect(await wipeImportMemories()).toBe(2)

    expect(await importRows()).toBe(0)
    expect(await shadowRows()).toBe(0)
    expect([...vec.deleted].sort()).toEqual([...shadowIds].sort())
  })
})
