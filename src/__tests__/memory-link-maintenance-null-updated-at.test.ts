/**
 * runLinkMaintenance selects memories by `COALESCE(updated_at, created_at)`. saveMemory does not write updated_at,
 * so a memory that was never edited has updated_at NULL, and `NULL >= cutoff` is never true: the nightly run did
 * not see it, neither to embed it (step 1) nor to link it (step 2). Real in-memory DB; Ollama is replaced by a
 * stubbed fetch, vectors are 768-dimensional like the real ones.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { initDatabase, getDb, runLinkMaintenance } from '../db.js'

const AGENT = 'agent-null-updated-at'
const DAY = 86400

function vec(...lead: number[]): Buffer {
  const buf = Buffer.alloc(768 * 4)
  lead.forEach((v, i) => buf.writeFloatLE(v, i * 4))
  return buf
}

function insert(opts: { content: string; embedding?: Buffer; createdAgoDays?: number; updatedAgoDays?: number | null; agent?: string }): number {
  const now = Math.floor(Date.now() / 1000)
  const created = now - Math.round((opts.createdAgoDays ?? 0) * DAY)
  const updated = opts.updatedAgoDays == null ? null : now - Math.round(opts.updatedAgoDays * DAY)
  const info = getDb().prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, updated_at, embedding_blob)
     VALUES ('chat-1', ?, 'semantic', 1, 'warm', ?, 0, ?, ?, ?, ?)`
  ).run(opts.content, opts.agent ?? AGENT, created, created, updated, opts.embedding ?? null) as { lastInsertRowid: number | bigint }
  return Number(info.lastInsertRowid)
}

function semanticLinksOf(id: number): number {
  return (getDb().prepare(
    `SELECT COUNT(*) AS c FROM memory_links WHERE link_type = 'semantic' AND (src_id = ? OR dst_id = ?)`
  ).get(id, id) as { c: number }).c
}

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('runLinkMaintenance: a memory that was never edited (updated_at NULL)', () => {
  it('links two fresh NULL-updated_at memories with each other', async () => {
    const a = insert({ content: 'fresh a', embedding: vec(1, 0, 0) })
    const b = insert({ content: 'fresh b', embedding: vec(1, 0.01, 0) })
    expect(semanticLinksOf(a) + semanticLinksOf(b)).toBe(0)

    const r = await runLinkMaintenance()

    expect(r.memoriesAttempted).toBeGreaterThanOrEqual(2)
    expect(r.linksCreated).toBeGreaterThanOrEqual(1)
    expect(semanticLinksOf(a)).toBeGreaterThanOrEqual(1)
    expect(semanticLinksOf(b)).toBeGreaterThanOrEqual(1)
  })

  it('embeds a fresh NULL-updated_at memory that has no embedding yet (step 1)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ embedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) }),
    })))
    const id = insert({ content: 'fresh without embedding' })

    const r = await runLinkMaintenance()
    vi.unstubAllGlobals()

    expect(r.reembedded).toBeGreaterThanOrEqual(1)
    const row = getDb().prepare('SELECT embedding_blob FROM memories WHERE id = ?').get(id) as { embedding_blob: Buffer | null }
    expect(row.embedding_blob).not.toBeNull()
  })
})

describe('runLinkMaintenance: the window still applies', () => {
  it('an old NULL-updated_at memory is outside the default 7 days and inside a wide max_age', async () => {
    const id = insert({ content: 'old never edited', embedding: vec(0, 1, 0), createdAgoDays: 100 })

    const narrow = await runLinkMaintenance()
    const attemptedNarrow = narrow.memoriesAttempted
    const linksBefore = semanticLinksOf(id)
    const wide = await runLinkMaintenance({ maxAge: 200 * DAY })

    expect(linksBefore).toBe(0)
    expect(wide.memoriesAttempted).toBe(attemptedNarrow + 1)
  })

  it('a recent created_at does not count when updated_at is set and old (updated_at wins)', async () => {
    insert({ content: 'created now, edited long ago', embedding: vec(0, 0, 1), createdAgoDays: 0, updatedAgoDays: 100 })

    const narrow = await runLinkMaintenance()
    const wide = await runLinkMaintenance({ maxAge: 200 * DAY })

    expect(wide.memoriesAttempted).toBeGreaterThan(narrow.memoriesAttempted)
  })
})
