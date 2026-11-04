import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The main agent ('boss' here) is never part of the desired run-state: its lifecycle is service-managed, so an entry
// could never be removed again (/api/agents/<main>/stop answers 400) and the readers that start the desired agents
// would open a second, unused `agent-<main>` session. Same DB-fixture pattern as agent-desired-state.test.ts.
let storeDir: string
let dbMod: typeof import('../db.js')
let store: typeof import('../web/agent-desired-state.js')

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'desired-main-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  vi.doMock('../config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../config.js')>()),
    MAIN_AGENT_ID: 'boss',
  }))
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  store = await import('../web/agent-desired-state.js')
})

afterEach(() => {
  vi.doUnmock('../config.js')
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

function stored(): string[] {
  const row = dbMod.getSystemConfig('agents_desired')
  return row ? JSON.parse(row.value) : []
}

describe('getDesiredAgents', () => {
  it('leaves the main agent out of a stored set that holds it', async () => {
    await dbMod.setSystemConfig('agents_desired', JSON.stringify(['boss', 'worker-a']))
    expect([...store.getDesiredAgents()]).toEqual(['worker-a'])
  })

  it('returns a sub-agent unchanged', async () => {
    await dbMod.setSystemConfig('agents_desired', JSON.stringify(['worker-a', 'worker-b']))
    expect([...store.getDesiredAgents()].sort()).toEqual(['worker-a', 'worker-b'])
  })
})

describe('addDesiredAgent', () => {
  it('does not record the main agent (a start request or the shutdown flush for it)', async () => {
    await store.addDesiredAgent('boss')
    expect(dbMod.getSystemConfig('agents_desired')).toBeUndefined()
    expect(store.getDesiredAgents().has('boss')).toBe(false)
    // positive control: the fixture does record, so the undefined row above is the filter and not a dead store
    await store.addDesiredAgent('worker-a')
    expect(stored()).toEqual(['worker-a'])
  })

  it('does not write the main agent back when a sub-agent is added to a set that held it', async () => {
    await dbMod.setSystemConfig('agents_desired', JSON.stringify(['boss']))
    await store.addDesiredAgent('worker-a')
    expect(stored()).toEqual(['worker-a'])
  })

  it('still records a sub-agent', async () => {
    await store.addDesiredAgent('worker-a')
    expect(stored()).toEqual(['worker-a'])
  })
})

describe('setDesiredAgents (fleet-transfer import)', () => {
  it('drops the main agent from an imported list', async () => {
    await store.setDesiredAgents(['boss', 'worker-b', 'worker-a'])
    expect(stored()).toEqual(['worker-a', 'worker-b'])
  })
})

describe('pruneMainAgentFromDesired', () => {
  it('removes the main agent from the stored row and reports it', async () => {
    await dbMod.setSystemConfig('agents_desired', JSON.stringify(['boss', 'worker-a']))
    expect(await store.pruneMainAgentFromDesired()).toBe(true)
    expect(stored()).toEqual(['worker-a'])
  })

  it('removes a row that held only the main agent down to an empty list', async () => {
    await dbMod.setSystemConfig('agents_desired', JSON.stringify(['boss']))
    expect(await store.pruneMainAgentFromDesired()).toBe(true)
    expect(stored()).toEqual([])
  })

  it('is a no-op the second time (one-time migration)', async () => {
    await dbMod.setSystemConfig('agents_desired', JSON.stringify(['boss', 'worker-a']))
    expect(await store.pruneMainAgentFromDesired()).toBe(true)
    expect(await store.pruneMainAgentFromDesired()).toBe(false)
    expect(stored()).toEqual(['worker-a'])
  })

  it('does not touch a row without the main agent', async () => {
    const raw = '["worker-b","worker-a"]' // deliberately unsorted: a rewrite would sort it
    await dbMod.setSystemConfig('agents_desired', raw)
    expect(await store.pruneMainAgentFromDesired()).toBe(false)
    expect(dbMod.getSystemConfig('agents_desired')?.value).toBe(raw)
    // positive control: the same fixture does rewrite a row that holds the main agent, so the no-op above is the
    // function leaving a clean row alone and not a prune that never runs
    await dbMod.setSystemConfig('agents_desired', '["boss","worker-b","worker-a"]')
    expect(await store.pruneMainAgentFromDesired()).toBe(true)
    expect(stored()).toEqual(['worker-a', 'worker-b'])
  })

  it('does nothing without a stored row', async () => {
    expect(await store.pruneMainAgentFromDesired()).toBe(false)
    expect(dbMod.getSystemConfig('agents_desired')).toBeUndefined()
  })
})
