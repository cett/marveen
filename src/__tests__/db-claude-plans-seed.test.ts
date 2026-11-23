// The registry seed from the two JSON side-cars (store/claude-plans.json and store/claude-plans-state.json), on both engines.
// seedClaudePlansRegistryMirrorAsync is the PostgreSQL counterpart of the boot seed: a table that already has rows is left
// alone, and a plan id in the state file that the registry does not hold fails the foreign key for that entry only.
// The files are throwaway ones in a temp directory: the store's own files are never touched.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbx, upsertClaudePlanRow } from '../db.js'
import { seedClaudePlansRegistryMirrorAsync } from '../db/index.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'carl-claude-plans-seed-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const plansFile = (): string => join(dir, 'claude-plans.json')
const stateFile = (): string => join(dir, 'claude-plans-state.json')

const PLANS = [
  { id: 'plan-a', label: 'Plan A', configDir: 'config-a', planType: 'personal', channelsAllowed: true },
  { id: 'plan-b', label: 'Plan B', configDir: 'config-b', planType: 'team', expectedOrgType: 'team-org' },
  { id: 'no-label', configDir: 'config-x', planType: 'personal' }, // skipped: no label
]

const registryIds = async (): Promise<string[]> =>
  (await dbx.all<{ id: string }>('SELECT id FROM claude_plans_registry ORDER BY id')).map((r) => r.id)
const activeOf = async (): Promise<Record<string, { plan_id: string; source: string }>> => {
  const rows = await dbx.all<{ agent_id: string; plan_id: string; source: string }>('SELECT agent_id, plan_id, source FROM agent_active_plans')
  return Object.fromEntries(rows.map((r) => [r.agent_id, { plan_id: r.plan_id, source: r.source }]))
}

beforeEach(async () => {
  await dbx.run('DELETE FROM agent_active_plans')
  await dbx.run('DELETE FROM claude_plans_registry')
  writeFileSync(plansFile(), JSON.stringify(PLANS))
  writeFileSync(stateFile(), JSON.stringify({ activePlanByAgent: { 'agent-a': 'plan-a' } }))
})

describe('seedClaudePlansRegistryMirrorAsync', () => {
  it('fills an empty registry from claude-plans.json (an entry without a label is skipped) and the active plans from the state file', async () => {
    await seedClaudePlansRegistryMirrorAsync(dir)
    expect(await registryIds()).toEqual(['plan-a', 'plan-b'])
    expect(await dbx.get<Record<string, unknown>>("SELECT label, config_dir, plan_type, channels_allowed, expected_org_type FROM claude_plans_registry WHERE id = 'plan-b'"))
      .toMatchObject({ label: 'Plan B', config_dir: 'config-b', plan_type: 'team', channels_allowed: 0, expected_org_type: 'team-org' })
    expect(await activeOf()).toEqual({ 'agent-a': { plan_id: 'plan-a', source: 'manual' } })
  })

  it('leaves a registry that already has rows alone: nothing is removed and nothing is overwritten', async () => {
    await upsertClaudePlanRow({ id: 'plan-keep', label: 'Keep', configDir: 'config-keep', planType: 'personal', channelsAllowed: false })
    await seedClaudePlansRegistryMirrorAsync(dir)
    expect(await registryIds()).toEqual(['plan-keep'])
  })

  it('a plan id in the state file that the registry does not hold is skipped alone; the other agents are still activated', async () => {
    writeFileSync(stateFile(), JSON.stringify({
      activePlanByAgent: { 'agent-a': 'plan-a', 'agent-b': 'plan-gone', 'agent-c': 'plan-b' },
    }))
    await seedClaudePlansRegistryMirrorAsync(dir)
    expect(await activeOf()).toEqual({
      'agent-a': { plan_id: 'plan-a', source: 'manual' },
      'agent-c': { plan_id: 'plan-b', source: 'manual' },
    })
  })

  // The second guard: an active-plan table that already has rows is left alone, so the state file cannot overwrite a binding
  // that a rotation or a manual switch made since (the first guard only covers the registry).
  it('an active plan that is already there is not overwritten by the state file (the second guard)', async () => {
    await upsertClaudePlanRow({ id: 'plan-a', label: 'Plan A', configDir: 'config-a', planType: 'personal', channelsAllowed: true })
    await upsertClaudePlanRow({ id: 'plan-b', label: 'Plan B', configDir: 'config-b', planType: 'team', channelsAllowed: false })
    await dbx.run("INSERT INTO agent_active_plans (agent_id, plan_id, source) VALUES ('agent-a', 'plan-b', 'rotation')")
    await seedClaudePlansRegistryMirrorAsync(dir)
    expect(await activeOf()).toEqual({ 'agent-a': { plan_id: 'plan-b', source: 'rotation' } })
  })
})
