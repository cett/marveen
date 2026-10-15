/**
 * memory_links.weight has CHECK(weight > 0 AND weight <= 1). A cosine similarity computed in floating point can
 * land a hair above 1 for (near-)identical embeddings, and is NaN for a zero vector. Either used to make the
 * insert throw and abort the whole link maintenance run. Real in-memory SQLite, embeddings written as BLOBs
 * (the ANN extension is not available in tests, the cross-agent import path scans the BLOBs).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, getDb, upsertMemoryLink, linkToNeighbors, runLinkMaintenance, linkMaintenanceFailedSystemically,
  WEIGHT_ROUNDING_TOLERANCE,
} from '../db.js'

const DIM = 768

// A vector whose double-precision cosine with itself is 1.0000000000000002 (found by search, see the assertion below).
const OVER_ONE = Array.from({ length: DIM }, (_, i) => Math.fround(Math.sin(i + 1)))
const ZERO = new Array<number>(DIM).fill(0)

function cosine(a: number[], b: number[]): number {
  let d = 0, x = 0, y = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  return d / (Math.sqrt(x) * Math.sqrt(y))
}

function blob(floats: number[]): Buffer {
  const buf = Buffer.allocUnsafe(floats.length * 4)
  floats.forEach((v, i) => buf.writeFloatLE(v, i * 4))
  return buf
}

// Import shadow rows search the whole fleet by BLOB scan, so these links form without the ANN extension.
function addMemory(content: string, floats: number[], agent = 'import'): number {
  const db = getDb()
  const info = db.prepare(
    `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
     VALUES (?, 'chat-1', 'semantic', ?, 'warm', unixepoch(), unixepoch(), unixepoch())`
  ).run(agent, content) as { lastInsertRowid: number | bigint }
  const id = Number(info.lastInsertRowid)
  db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob(floats), id)
  return id
}

const links = (src: number) => getDb()
  .prepare("SELECT dst_id, weight FROM memory_links WHERE src_id = ? AND link_type = 'semantic'")
  .all(src) as { dst_id: number; weight: number }[]

beforeEach(() => {
  initDatabase(':memory:')
})

describe('the fixture really is above 1', () => {
  it('has a self cosine greater than 1 in double precision', () => {
    expect(cosine(OVER_ONE, OVER_ONE)).toBeGreaterThan(1)
  })
})

describe('upsertMemoryLink', () => {
  it('stores a weight a rounding error above 1 as 1 instead of throwing', () => {
    const a = addMemory('a', OVER_ONE)
    const b = addMemory('b', OVER_ONE)
    expect(() => upsertMemoryLink(a, b, 'semantic', 1.0000000000000002)).not.toThrow()
    expect(links(a)[0].weight).toBe(1)
  })

  it('leaves an ordinary weight alone', () => {
    const a = addMemory('a', OVER_ONE)
    const b = addMemory('b', OVER_ONE)
    upsertMemoryLink(a, b, 'semantic', 0.8)
    expect(links(a)[0].weight).toBeCloseTo(0.8)
  })
})

describe('linkToNeighbors', () => {
  it('links two identical embeddings (cosine a rounding error above 1) with weight 1', async () => {
    const a = addMemory('a', OVER_ONE)
    const b = addMemory('b', OVER_ONE)
    await expect(linkToNeighbors(a)).resolves.toBe(1)
    expect(links(a)).toEqual([{ dst_id: b, weight: 1 }])
  })

  it('skips a zero-vector neighbour (cosine NaN) and still links the valid one', async () => {
    const a = addMemory('a', OVER_ONE)
    addMemory('zero', ZERO)
    const good = addMemory('good', OVER_ONE)
    await expect(linkToNeighbors(a)).resolves.toBe(1)
    expect(links(a).map(l => l.dst_id)).toEqual([good])
  })

  it('skips a neighbour with a non-positive similarity even when the caller passes a threshold of 0', async () => {
    const pos = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0))
    const neg = Array.from({ length: DIM }, (_, i) => (i === 0 ? -1 : 0))
    const a = addMemory('a', pos)
    addMemory('opposite', neg)
    addMemory('orthogonal', Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : 0)))
    await expect(linkToNeighbors(a, 5, 0)).resolves.toBe(0)
    expect(links(a)).toEqual([])
  })
})

describe('runLinkMaintenance', () => {
  it('finishes when a pair has a cosine above 1', async () => {
    addMemory('a', OVER_ONE)
    addMemory('b', OVER_ONE)
    const result = await runLinkMaintenance()
    expect(result.linksCreated).toBe(2)
    expect(result.linksFailed).toBe(0)
  })

  it('does not let one memory whose links cannot be written stop the run, and counts it', async () => {
    const a = addMemory('a', OVER_ONE)
    const b = addMemory('b', OVER_ONE)
    const c = addMemory('c', OVER_ONE)
    // A write that fails for one source only, whatever the reason.
    getDb().exec(`CREATE TRIGGER fail_one BEFORE INSERT ON memory_links WHEN NEW.src_id = ${a}
                  BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
    const result = await runLinkMaintenance()
    expect(result.linksFailed).toBe(1)
    expect(links(a)).toEqual([])
    expect(links(b).length).toBeGreaterThan(0)
    expect(links(c).length).toBeGreaterThan(0)
    expect(result.linksCreated).toBe(links(b).length + links(c).length)
  })
})

describe('upsertMemoryLink: the rounding tolerance is narrow', () => {
  it('stores a weight within the tolerance above 1 as 1', () => {
    const a = addMemory('a', OVER_ONE)
    const b = addMemory('b', OVER_ONE)
    upsertMemoryLink(a, b, 'semantic', 1 + WEIGHT_ROUNDING_TOLERANCE / 2)
    expect(links(a)[0].weight).toBe(1)
  })

  it.each([1.5, 1 + 1e-8, Number.POSITIVE_INFINITY, Number.NaN, 0, -0.2])('does not store %s: it is a caller bug and fails loudly', (w) => {
    const a = addMemory('a', OVER_ONE)
    const b = addMemory('b', OVER_ONE)
    expect(() => upsertMemoryLink(a, b, 'semantic', w)).toThrow(/constraint failed/)
    expect(links(a)).toEqual([])
  })
})

describe('linkToNeighbors: all of a memory\'s links or none', () => {
  it('rolls back the links already written when a later write fails', async () => {
    const a = addMemory('a', OVER_ONE)
    addMemory('b', OVER_ONE)
    addMemory('c', OVER_ONE)
    // The second link written for `a` fails, whichever neighbour that is.
    getDb().exec(`CREATE TRIGGER fail_second BEFORE INSERT ON memory_links
                  WHEN NEW.src_id = ${a} AND (SELECT COUNT(*) FROM memory_links WHERE src_id = ${a}) >= 1
                  BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
    await expect(linkToNeighbors(a)).rejects.toThrow(/simulated write failure/)
    expect(links(a)).toEqual([])
  })

  it('keeps all links of a memory when every write succeeds', async () => {
    const a = addMemory('a', OVER_ONE)
    addMemory('b', OVER_ONE)
    addMemory('c', OVER_ONE)
    await expect(linkToNeighbors(a)).resolves.toBe(2)
    expect(links(a)).toHaveLength(2)
  })
})

describe('linkMaintenanceFailedSystemically', () => {
  it.each([
    [0, 0, false],
    [0, 50, false],
    [1, 1, false], // a single failure is never enough to call the environment broken
    [1, 3, false],
    [2, 2, true],
    [2, 3, true],
    [2, 4, false], // exactly half is not a majority
    [2, 10, false],
    [3, 5, true],
    [6, 10, true],
  ])('%i failed of %i attempted -> systemic %s', (failed, attempted, expected) => {
    expect(linkMaintenanceFailedSystemically({ linksFailed: failed, memoriesAttempted: attempted })).toBe(expected)
  })
})

describe('runLinkMaintenance: attempted memories', () => {
  it('reports how many memories it tried', async () => {
    addMemory('a', OVER_ONE)
    addMemory('b', OVER_ONE)
    addMemory('c', ZERO)
    const result = await runLinkMaintenance()
    expect(result.memoriesAttempted).toBe(3)
    expect(result.linksFailed).toBe(0)
  })

  it('counts every memory as failed when no link can be written at all', async () => {
    addMemory('a', OVER_ONE)
    addMemory('b', OVER_ONE)
    addMemory('c', OVER_ONE)
    getDb().exec(`CREATE TRIGGER fail_all BEFORE INSERT ON memory_links BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
    const result = await runLinkMaintenance()
    expect(result).toMatchObject({ linksCreated: 0, linksFailed: 3, memoriesAttempted: 3 })
    expect(linkMaintenanceFailedSystemically(result)).toBe(true)
  })
})
