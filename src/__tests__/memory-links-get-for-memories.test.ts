/**
 * Tests for getLinksForMemories (db/vector.ts): returns all memory_links
 * edges touching any id in the given set, used by the dashboard graph view.
 * Uses the real in-memory SQLite DB (same pattern as memory-links-integration.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  initDatabase, getDb,
  upsertMemoryLink, getLinksForMemories,
} from '../db.js'

const AGENT = 'agent-links-for-memories-test'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  getDb().exec(`DELETE FROM memories WHERE agent_id = '${AGENT}'`)
  getDb().exec(`DELETE FROM memory_links WHERE src_id NOT IN (SELECT id FROM memories)`)
})

function insertMemory(content: string): number {
  const db = getDb()
  const info = db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at)
     VALUES ('chat-1', ?, 'semantic', 1, 'warm', ?, 0, unixepoch(), unixepoch())`
  ).run(content, AGENT) as { lastInsertRowid: number | bigint }
  return Number(info.lastInsertRowid)
}

describe('getLinksForMemories', () => {
  it('returns an empty array for an empty id list without querying the DB', () => {
    expect(getLinksForMemories([])).toEqual([])
  })

  it('returns links where the id is the src', () => {
    const a = insertMemory('a')
    const b = insertMemory('b')
    upsertMemoryLink(a, b, 'semantic', 0.5)
    const links = getLinksForMemories([a])
    expect(links).toHaveLength(1)
    expect(links[0].src_id).toBe(a)
    expect(links[0].dst_id).toBe(b)
  })

  it('returns links where the id is the dst', () => {
    const a = insertMemory('c')
    const b = insertMemory('d')
    upsertMemoryLink(a, b, 'explicit', 0.6)
    const links = getLinksForMemories([b])
    expect(links).toHaveLength(1)
    expect(links[0].src_id).toBe(a)
    expect(links[0].dst_id).toBe(b)
  })

  it('does not duplicate a link when both endpoints are in the id set', () => {
    const a = insertMemory('e')
    const b = insertMemory('f')
    upsertMemoryLink(a, b, 'semantic', 0.7)
    const links = getLinksForMemories([a, b])
    expect(links).toHaveLength(1)
  })

  it('excludes links whose endpoints are both outside the id set', () => {
    const a = insertMemory('g')
    const b = insertMemory('h')
    const unrelated = insertMemory('i')
    upsertMemoryLink(a, b, 'semantic', 0.4)
    const links = getLinksForMemories([unrelated])
    expect(links).toEqual([])
  })

  it('orders results by weight descending', () => {
    const a = insertMemory('j')
    const b = insertMemory('k')
    const c = insertMemory('l')
    upsertMemoryLink(a, b, 'semantic', 0.2)
    upsertMemoryLink(a, c, 'semantic', 0.9)
    const links = getLinksForMemories([a])
    expect(links).toHaveLength(2)
    expect(links[0].weight).toBeGreaterThan(links[1].weight)
    expect(links[0].dst_id).toBe(c)
  })
})
