import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// DB-fixture pattern (#985 group 5/8): agent-desired-state.ts now reads/writes
// the single system_config row 'agents_desired' (a JSON array) instead of
// store/agents-desired.json -- see db-system-config.test.ts for why each test
// needs its own module instance (config.js/db/connection.js resolve STORE_DIR
// once, at import time).
let storeDir: string
let dbMod: typeof import('../db.js')
let store: typeof import('../web/agent-desired-state.js')

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'desired-state-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  store = await import('../web/agent-desired-state.js')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('getDesiredAgents', () => {
  it('returns empty Set when no row exists', () => {
    expect(store.getDesiredAgents().size).toBe(0)
  })

  it('returns empty Set when the stored row is invalid JSON', async () => {
    await dbMod.setSystemConfig('agents_desired', '{bad}')
    expect(store.getDesiredAgents().size).toBe(0)
  })

  it('returns empty Set when the stored row is non-array JSON', async () => {
    await dbMod.setSystemConfig('agents_desired', '{"key":"val"}')
    expect(store.getDesiredAgents().size).toBe(0)
  })
})

describe('addDesiredAgent', () => {
  it('creates the row and adds the agent', async () => {
    await store.addDesiredAgent('agent-a')
    const set = store.getDesiredAgents()
    expect(set.has('agent-a')).toBe(true)
  })

  it('is idempotent -- adding twice does not duplicate', async () => {
    await store.addDesiredAgent('agent-a')
    await store.addDesiredAgent('agent-a')
    expect(store.getDesiredAgents().size).toBe(1)
  })

  it('accumulates multiple agents', async () => {
    await store.addDesiredAgent('agent-a')
    await store.addDesiredAgent('agent-d')
    const set = store.getDesiredAgents()
    expect(set.has('agent-a')).toBe(true)
    expect(set.has('agent-d')).toBe(true)
  })
})

describe('removeDesiredAgent', () => {
  it('removes an existing agent', async () => {
    await store.addDesiredAgent('agent-a')
    await store.removeDesiredAgent('agent-a')
    expect(store.getDesiredAgents().has('agent-a')).toBe(false)
  })

  it('is idempotent -- removing a non-present agent does not throw', async () => {
    await expect(store.removeDesiredAgent('nonexistent')).resolves.toBeUndefined()
    expect(store.getDesiredAgents().size).toBe(0)
  })

  it('does not remove other agents', async () => {
    await store.addDesiredAgent('agent-a')
    await store.addDesiredAgent('agent-d')
    await store.removeDesiredAgent('agent-a')
    const set = store.getDesiredAgents()
    expect(set.has('agent-a')).toBe(false)
    expect(set.has('agent-d')).toBe(true)
  })
})

describe('overlapping writes (read-modify-write that cannot lose an update)', () => {
  it('four overlapping addDesiredAgent calls all land', async () => {
    await Promise.all(['agent-a', 'agent-b', 'agent-c', 'agent-d'].map((n) => store.addDesiredAgent(n)))
    expect([...store.getDesiredAgents()].sort()).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-d'])
  })

  it('overlapping add and remove of different agents: neither is lost', async () => {
    await store.addDesiredAgent('agent-keep')
    await store.addDesiredAgent('agent-drop')
    await Promise.all([
      store.addDesiredAgent('agent-new1'),
      store.removeDesiredAgent('agent-drop'),
      store.addDesiredAgent('agent-new2'),
      store.removeDesiredAgent('agent-never-there'),
    ])
    expect([...store.getDesiredAgents()].sort()).toEqual(['agent-keep', 'agent-new1', 'agent-new2'])
  })

  it('the stored row (not only the cache) holds every overlapping change', async () => {
    await Promise.all(['agent-a', 'agent-b', 'agent-c'].map((n) => store.addDesiredAgent(n)))
    const stored = JSON.parse(dbMod.getSystemConfig('agents_desired')!.value) as string[]
    expect(stored).toEqual(['agent-a', 'agent-b', 'agent-c']) // sorted, no duplicate, nothing lost
  })

  it('an unparseable stored value counts as empty for the next add (as getDesiredAgents reads it)', async () => {
    await dbMod.setSystemConfig('agents_desired', '{bad}')
    await store.addDesiredAgent('agent-a')
    expect([...store.getDesiredAgents()]).toEqual(['agent-a'])
  })

  it('a failed write is answered, not thrown (start/stop paths): the set is unchanged', async () => {
    await store.addDesiredAgent('agent-a')
    const failing = vi.spyOn(await import('../db/connection.js').then((m) => m.db), 'exec').mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(store.addDesiredAgent('agent-b')).resolves.toBeUndefined()
    failing.mockRestore()
    expect([...store.getDesiredAgents()]).toEqual(['agent-a'])
  })

  it('setDesiredAgents replaces the whole set (sorted, deduplicated) after the write resolves', async () => {
    await store.addDesiredAgent('agent-old')
    await store.setDesiredAgents(['agent-z', 'agent-a', 'agent-z'])
    expect([...store.getDesiredAgents()]).toEqual(['agent-a', 'agent-z'])
  })
})
