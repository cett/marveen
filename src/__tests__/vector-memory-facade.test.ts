// The vector and memory modules on the async db facade: the transaction bodies run on the transaction handle, a
// failed multi-statement write leaves nothing behind, the vec0 delete joins the transaction of its caller, the
// tenant is bound in the delete statement, and the boot import-shadow backfill stays synchronous.
// Real in-memory database, no mocks (the spies only count calls). Each test names the line it protects.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import {
  db, dbx, linkToNeighbors, upsertMemoryLink, syncVecMemoryDelete, insertImportSource, createTenant, deleteTenant,
  deleteMemoryRow,
} from '../db.js'
import { deleteTenantMemory } from '../db/tenant-scoped.js'
import { backfillImportShadowRows } from '../db/vector.js'
import { vecExtensionLoaded } from '../db/connection.js'

// vault.json is file I/O and not what this suite is about.
vi.mock('../web/vault.js', () => ({ purgeSecretsForTenant: vi.fn().mockReturnValue(0) }))

useTestDb()
afterEach(() => { vi.restoreAllMocks() })

const DIM = 768
/** A unit-ish vector along the first axis with a small tilt: every pair of these is far above the link threshold. */
function vec(tilt: number): Buffer {
  const v = new Float32Array(DIM)
  v[0] = 1
  v[1] = tilt
  return Buffer.from(v.buffer)
}

function addMemory(content: string, opts: { tilt?: number; tenant?: string; agent?: string } = {}): number {
  const row = db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, tenant_id)
     VALUES ('chat-1', ?, 'semantic', 1, 'warm', ?, 0, unixepoch(), unixepoch(), ?) RETURNING id`,
  ).get(content, opts.agent ?? 'agent-v', opts.tenant ?? 'default') as { id: number }
  if (opts.tilt !== undefined) {
    const blob = vec(opts.tilt)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob, row.id)
    if (vecExtensionLoaded) db.prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES(?, ?)').run(BigInt(row.id), blob)
  }
  return row.id
}

const linkCount = (src: number): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM memory_links WHERE src_id = ?').get(src) as { n: number }).n
const memoryExists = (id: number): boolean => db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id) !== undefined
const vecExists = (id: number): boolean => db.prepare('SELECT 1 FROM vec_memories WHERE memory_id = ?').get(BigInt(id)) !== undefined

/** Counts the dbx calls made while a dbx.tx body is open (the body is the part between BEGIN and COMMIT). */
function spyDbxCallsInsideTxBodies(): { insideBody: () => number } {
  let inside = 0
  const realTx = dbx.tx.bind(dbx)
  vi.spyOn(dbx, 'tx').mockImplementation(((fn: Parameters<typeof dbx.tx>[0], opts?: Parameters<typeof dbx.tx>[1]) =>
    realTx(async (tx) => {
      const spies = (['get', 'run', 'all'] as const).map((m) => vi.spyOn(dbx, m))
      try {
        return await fn(tx)
      } finally {
        inside += spies.reduce((n, s) => n + s.mock.calls.length, 0)
        spies.forEach((s) => s.mockRestore())
      }
    }, opts)) as typeof dbx.tx)
  return { insideBody: () => inside }
}

describe('linkToNeighbors', () => {
  it('writes its links on the transaction handle: no dbx call while the body is open, and the links are there', async () => {
    const a = addMemory('a', { tilt: 0 })
    const b = addMemory('b', { tilt: 0.05 })
    const c = addMemory('c', { tilt: 0.1 })
    const spy = spyDbxCallsInsideTxBodies()
    expect(await linkToNeighbors(a)).toBe(2)
    expect(spy.insideBody()).toBe(0)
    expect(linkCount(a)).toBe(2)
    expect([b, c].every((id) => db.prepare('SELECT 1 FROM memory_links WHERE src_id = ? AND dst_id = ?').get(a, id))).toBe(true)
  })

  it('the transaction is deferred, as db.transaction was (no BEGIN IMMEDIATE)', async () => {
    const a = addMemory('a', { tilt: 0 })
    addMemory('b', { tilt: 0.05 })
    const exec = vi.spyOn(db, 'exec')
    await linkToNeighbors(a)
    expect(exec.mock.calls.map((c) => String(c[0])).filter((sql) => sql.startsWith('BEGIN'))).toEqual(['BEGIN'])
  })

  it('a failing link write rolls back the links already written for the memory (all or none)', async () => {
    const a = addMemory('a', { tilt: 0 })
    addMemory('b', { tilt: 0.05 })
    const c = addMemory('c', { tilt: 0.1 })
    db.exec(`CREATE TRIGGER link_blocked BEFORE INSERT ON memory_links WHEN NEW.dst_id = ${c} BEGIN SELECT RAISE(ABORT, 'blocked'); END`)
    await expect(linkToNeighbors(a)).rejects.toThrow(/blocked/)
    expect(linkCount(a)).toBe(0)
  })

  it('a memory without an embedding is no work and no transaction', async () => {
    const a = addMemory('a')
    const tx = vi.spyOn(dbx, 'tx')
    expect(await linkToNeighbors(a)).toBe(0)
    expect(tx).not.toHaveBeenCalled()
  })
})

describe('upsertMemoryLink', () => {
  it('given a transaction handle it joins that transaction: a throw after the call leaves no link', async () => {
    const a = addMemory('a')
    const b = addMemory('b')
    await expect(dbx.tx(async (tx) => {
      await upsertMemoryLink(a, b, 'semantic', 0.5, tx)
      throw new Error('abort after the write')
    })).rejects.toThrow(/abort after the write/)
    expect(linkCount(a)).toBe(0)
  })

  it('without a handle it writes through dbx and answers the row id, the same one on the update path', async () => {
    const a = addMemory('a')
    const b = addMemory('b')
    const first = await upsertMemoryLink(a, b, 'semantic', 0.4)
    expect(await upsertMemoryLink(a, b, 'semantic', 0.9)).toBe(first)
    expect((db.prepare('SELECT weight FROM memory_links WHERE id = ?').get(first) as { weight: number }).weight).toBe(0.9)
  })
})

describe('deleteMemoryRow', () => {
  it('with a tenant the statement itself is bound to it: another tenant\'s row is not deleted', async () => {
    await createTenant('acme', 'Acme')
    const mine = addMemory('mine', { tenant: 'acme' })
    const theirs = addMemory('theirs', { tenant: 'default' })
    expect(await deleteMemoryRow(theirs, 'acme')).toBe(0)
    expect(memoryExists(theirs)).toBe(true)
    expect(await deleteMemoryRow(mine, 'acme')).toBe(1)
    expect(memoryExists(mine)).toBe(false)
  })

  it('without a tenant (the admin) it deletes by id', async () => {
    await createTenant('acme', 'Acme')
    const id = addMemory('x', { tenant: 'acme' })
    expect(await deleteMemoryRow(id)).toBe(1)
  })
})

describe('deleteTenantMemory', () => {
  it('deletes the tenant\'s own row only, and says whether it did', async () => {
    await createTenant('acme', 'Acme')
    const mine = addMemory('mine', { tenant: 'acme' })
    const theirs = addMemory('theirs', { tenant: 'default' })
    expect(await deleteTenantMemory('acme', theirs)).toBe(false)
    expect(memoryExists(theirs)).toBe(true)
    expect(await deleteTenantMemory('acme', mine)).toBe(true)
    expect(memoryExists(mine)).toBe(false)
  })

  it('a failing row delete leaves the row and its vec entry (one transaction)', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    await createTenant('acme', 'Acme')
    const id = addMemory('mine', { tenant: 'acme', tilt: 0.2 })
    db.exec("CREATE TRIGGER memory_delete_blocked BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    await expect(deleteTenantMemory('acme', id)).rejects.toThrow(/blocked/)
    expect(memoryExists(id)).toBe(true)
    expect(vecExists(id)).toBe(true)
  })

  it('the row delete and the vec delete run on the transaction (no dbx call while the body is open) and both are gone', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    await createTenant('acme', 'Acme')
    const id = addMemory('mine', { tenant: 'acme', tilt: 0.2 })
    const spy = spyDbxCallsInsideTxBodies()
    expect(await deleteTenantMemory('acme', id)).toBe(true)
    expect(memoryExists(id)).toBe(false)
    expect(vecExists(id)).toBe(false)
    // syncVecMemoryDelete is the one facade call inside the body: it joins the open transaction (same scope)
    expect(spy.insideBody()).toBe(1)
  })
})

describe('syncVecMemoryDelete', () => {
  it('awaited inside a dbx.tx body it is part of that transaction: a rollback brings the vec entry back', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    const id = addMemory('m', { tilt: 0.2 })
    await expect(dbx.tx(async () => {
      await syncVecMemoryDelete(id)
      expect(vecExists(id)).toBe(false)
      throw new Error('abort')
    })).rejects.toThrow(/abort/)
    expect(vecExists(id)).toBe(true)
  })
})

describe('deleteTenant', () => {
  it('stays a synchronous transaction (a promise body would commit at its first await) and drops rows and vec entries together', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    await createTenant('gone', 'Gone')
    const id = addMemory('m', { tenant: 'gone', tilt: 0.2 })
    const keep = addMemory('k', { tenant: 'default', tilt: 0.3 })
    const result = deleteTenant('gone')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result.memoriesDeleted).toBe(1)
    expect(memoryExists(id)).toBe(false)
    expect(vecExists(id)).toBe(false)
    expect(memoryExists(keep)).toBe(true)
    expect(vecExists(keep)).toBe(true)
  })

  it('a failure after the memories step rolls the memories and their vec entries back', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    await createTenant('gone', 'Gone')
    const id = addMemory('m', { tenant: 'gone', tilt: 0.2 })
    db.exec("CREATE TRIGGER tenant_delete_blocked BEFORE DELETE ON tenants BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    expect(() => deleteTenant('gone')).toThrow(/blocked/)
    expect(memoryExists(id)).toBe(true)
    expect(vecExists(id)).toBe(true)
  })
})

describe('backfillImportShadowRows (the boot twin)', () => {
  it('is synchronous: it answers a number, not a promise, and does nothing when no import row lacks a shadow', () => {
    const result = backfillImportShadowRows()
    expect(result).toBe(0)
  })

  it('creates the shadow row of an import row that has none and links the two', async () => {
    await insertImportSource({
      id: 's1', type: 'local', path: '/docs/s1', label: 's1', intervalHours: 4, enabled: true, now: 100,
      tenantId: 'default', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
    })
    db.prepare(
      `INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
       VALUES ('i1', 's1', '/docs/i1.md', 'i1.md', 'h-i1', 'imported text', NULL, 1, 1, 10)`,
    ).run()
    const result = backfillImportShadowRows()
    expect(result).toBe(1)
    const row = db.prepare('SELECT memory_shadow_id AS id FROM import_memories WHERE id = ?').get('i1') as { id: number | null }
    expect(row.id).not.toBeNull()
    expect(db.prepare('SELECT agent_id, content FROM memories WHERE id = ?').get(row.id)).toEqual({ agent_id: 'import', content: 'imported text' })
  })
})
