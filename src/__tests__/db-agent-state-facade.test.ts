// The pilot module on the async facade: agent_state. The operations return Promises and go through dbx;
// the synchronous twins for the boot chain give the same rows, and nothing but db/index.ts may call them.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentState, setAgentState, getAgentStateSync, setAgentStateSync, importAgentStateFromFile, getDbContextStats } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

describe('getAgentState / setAgentState (async, through dbx)', () => {
  it('return Promises', async () => {
    const write = setAgentState('pilot-a', 'gate_run_state', { n: 1 })
    expect(write).toBeInstanceOf(Promise)
    await write
    const read = getAgentState('pilot-a', 'gate_run_state')
    expect(read).toBeInstanceOf(Promise)
    expect(await read).toMatchObject({ agent_id: 'pilot-a', state_key: 'gate_run_state', state_value: '{"n":1}', tenant_id: 'default' })
  })

  it('upsert: the second write replaces the value and keeps one row', async () => {
    await setAgentState('pilot-a', 'gate_run_state', { n: 1 })
    await setAgentState('pilot-a', 'gate_run_state', { n: 2 })
    expect((await getAgentState('pilot-a', 'gate_run_state'))?.state_value).toBe('{"n":2}')
  })

  it('a missing row is undefined, and the tenant id is stored', async () => {
    expect(await getAgentState('nobody', 'gate_run_state')).toBeUndefined()
    await setAgentState('pilot-t', 'blackboard_hygiene_nudges', { x: 1 }, 'acme')
    expect((await getAgentState('pilot-t', 'blackboard_hygiene_nudges'))?.tenant_id).toBe('acme')
  })

  it('go through the facade (counted as db calls)', async () => {
    await setAgentState('pilot-c', 'gate_run_state', 1)
    await getAgentState('pilot-c', 'gate_run_state')
    expect(getDbContextStats().total).toBe(2)
  })
})

describe('the boot-synchronous twins', () => {
  it('read and write the same rows as the async functions', async () => {
    setAgentStateSync('pilot-s', 'kanban_audit_last_audit_at', 1800000000)
    expect((await getAgentState('pilot-s', 'kanban_audit_last_audit_at'))?.state_value).toBe('1800000000')
    await setAgentState('pilot-s', 'kanban_audit_last_audit_at', 1800000600)
    expect(getAgentStateSync('pilot-s', 'kanban_audit_last_audit_at')?.state_value).toBe('1800000600')
    expect(getAgentStateSync('nobody', 'kanban_audit_last_audit_at')).toBeUndefined()
  })

  it('do not count as facade calls', () => {
    setAgentStateSync('pilot-s2', 'gate_run_state', 1)
    getAgentStateSync('pilot-s2', 'gate_run_state')
    expect(getDbContextStats().total).toBe(0)
  })

  it('importAgentStateFromFile is unchanged: only inserts what is absent', () => {
    expect(importAgentStateFromFile('gate_run_state', { 'pilot-i': { a: 1 } })).toBe(1)
    expect(importAgentStateFromFile('gate_run_state', { 'pilot-i': { a: 2 } })).toBe(0)
    expect(getAgentStateSync('pilot-i', 'gate_run_state')?.state_value).toBe('{"a":1}')
  })

  it('only the boot chain (db/index.ts) calls the synchronous twins', () => {
    const srcDir = fileURLToPath(new URL('..', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name === '__tests__') continue
          walk(full)
        } else if (name.endsWith('.ts')) {
          const rel = full.slice(srcDir.length)
          if (rel === 'db/agent-state.ts' || rel === 'db/index.ts') continue
          if (/\b(get|set)AgentStateSync\b/.test(readFileSync(full, 'utf8'))) offenders.push(rel)
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })
})
