// The skill regen reads the grants of a skill and the agents of the grantee tenant ACROSS tenants (migration 0009, class F and the
// availability table). The unit cell of the regen mocks the db and proves the CONTEXT at the call; this one proves the POLICIES let
// that context see the rows: through the facade as the app role, a tenant or an agent context that opens the regen's system
// context reads the grantee's rows, while the same read in the caller's own context sees nothing. The admin pool is the oracle.
// `npm run test:pg`. Fixtures are neutral.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { runAs, SKILL_REGEN_JOB } from '../../db/context.js'
import { getEnabledAgentsForTenant, getTenantsForAgent } from '../../db/agents.js'
import { listSkillAccess } from '../../db/tasks.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

let db: PgTestDb
beforeAll(async () => {
  db = await createPgTestDb()
  setBackend(db.appDbx(), 'pg') // the facade runs as the app role: row-level security binds every call
})
afterAll(async () => {
  setBackend(null)
  await db.close()
})
beforeEach(async () => {
  await db.pool.query("DELETE FROM skill_tenant_access WHERE skill_id = 'skill-of-a'")
  await db.pool.query("DELETE FROM tenant_agent_availability WHERE tenant_id IN ('tenant-a', 'tenant-b')")
  await db.pool.query("DELETE FROM skills WHERE id = 'skill-of-a'")
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-a', 'Tenant A', 1), ('tenant-b', 'Tenant B', 1) ON CONFLICT DO NOTHING")
  await db.pool.query("INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('skill-of-a', 'skill-of-a', 'x', 'tenant-a', 0)")
  // tenant-a owns the skill and grants it to tenant-b; each tenant has one enabled agent, agent-b serves both
  await db.pool.query("INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by) VALUES ('skill-of-a', 'tenant-b', 'agent-a')")
  await db.pool.query(`INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES
    ('tenant-a', 'agent-a', 1), ('tenant-b', 'agent-b', 1), ('tenant-a', 'agent-b', 1)`)
})

const CALLERS: Array<[string, <T>(fn: () => Promise<T>) => Promise<T>]> = [
  ['a tenant context', (fn) => runAs.tenant('tenant-a', fn)],
  ['an agent context', (fn) => runAs.agent('agent-a', 'tenant-a', fn)],
]

describe('the regen reads the grantee rows as the system context', () => {
  it('the oracle has the grant, the grantee agents and the agent\'s two tenants (construction)', async () => {
    expect((await db.pool.query("SELECT 1 FROM skill_tenant_access WHERE skill_id = 'skill-of-a' AND tenant_id = 'tenant-b'")).rowCount).toBe(1)
    expect((await db.pool.query("SELECT 1 FROM tenant_agent_availability WHERE tenant_id = 'tenant-b' AND agent_id = 'agent-b'")).rowCount).toBe(1)
    expect((await db.pool.query("SELECT 1 FROM tenant_agent_availability WHERE agent_id = 'agent-b'")).rowCount).toBe(2)
  })

  for (const [label, caller] of CALLERS) {
    it(`${label} sees none of the grantee's rows in its own context (the red side) ...`, async () => {
      await caller(async () => {
        expect(await listSkillAccess('skill-of-a')).toEqual([]) // the grant row belongs to the grantee tenant
        expect(await getEnabledAgentsForTenant('tenant-b')).toEqual([])
        expect(await getTenantsForAgent('agent-b')).toEqual(['tenant-a']) // only its own tenant's availability row
      })
    })

    it(`... and the SAME reads see all of them when ${label} opens the regen's system context (the green side)`, async () => {
      await caller(async () => runAs.system(SKILL_REGEN_JOB, async () => {
        expect((await listSkillAccess('skill-of-a')).map((r) => r.tenant_id)).toEqual(['tenant-b'])
        expect(await getEnabledAgentsForTenant('tenant-b')).toEqual(['agent-b'])
        expect((await getTenantsForAgent('agent-b')).sort()).toEqual(['tenant-a', 'tenant-b'])
      }))
    })
  }
})
