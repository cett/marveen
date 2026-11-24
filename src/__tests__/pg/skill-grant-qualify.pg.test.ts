// The write-back qualification of the skill sync (`agentQualifies`): "does this agent serve the owner tenant of the skill, or a
// tenant the skill is granted to". Both reads span tenants. The caller is an agent context, which sees the rows of its own
// tenant only, and a SHARED agent runs under the `_multi_` sentinel and sees none: read in the caller's own context the answer
// is wrong (false for an agent that does qualify). The check therefore runs as the narrow system context and returns one
// boolean. The admin pool seeds and is the oracle. `npm run test:pg`. Fixtures are neutral.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { currentDbContext, getDbContextStats, resetDbContextForTest, runAs } from '../../db/context.js'
import { agentHasEnabledAvailability, listSkillAccess } from '../../db/tasks.js'
import { agentQualifies } from '../../skill-sync.js'
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
  await db.pool.query("DELETE FROM tenant_agent_availability WHERE tenant_id IN ('tenant-a', 'tenant-b', 'tenant-c')")
  await db.pool.query("DELETE FROM skills WHERE id = 'skill-of-a'")
  await db.pool.query(`INSERT INTO tenants (id, display_name, created_at) VALUES
    ('tenant-a', 'Tenant A', 1), ('tenant-b', 'Tenant B', 1), ('tenant-c', 'Tenant C', 1) ON CONFLICT DO NOTHING`)
  await db.pool.query("INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('skill-of-a', 'skill-of-a', 'x', 'tenant-a', 0)")
  await db.pool.query("INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by) VALUES ('skill-of-a', 'tenant-b', 'agent-a')")
  await db.pool.query(`INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES
    ('tenant-a', 'agent-owner', 1), ('tenant-b', 'agent-grantee', 1), ('tenant-b', 'agent-off', 0), ('tenant-c', 'agent-other', 1)`)
})

// the callers: an agent of the owner tenant, a shared agent (the sentinel tenant), a plain tenant context, a grantee's agent
const CALLERS: Array<[string, <T>(fn: () => Promise<T>) => Promise<T>]> = [
  ['an agent of the owner tenant', (fn) => runAs.agent('agent-x', 'tenant-a', fn)],
  ['a shared agent (the sentinel tenant)', (fn) => runAs.agent('agent-x', '_multi_', fn)],
  ['a tenant context of the owner', (fn) => runAs.tenant('tenant-a', fn)],
  ['an agent of the grantee tenant', (fn) => runAs.agent('agent-x', 'tenant-b', fn)],
]

describe('agentQualifies answers the same to every caller', () => {
  it('the oracle: the grant and the availability rows exist (construction)', async () => {
    expect((await db.pool.query("SELECT 1 FROM skill_tenant_access WHERE skill_id = 'skill-of-a' AND tenant_id = 'tenant-b'")).rowCount).toBe(1)
    expect((await db.pool.query("SELECT 1 FROM tenant_agent_availability WHERE agent_id = 'agent-grantee' AND enabled = 1")).rowCount).toBe(1)
  })

  it('the unwrapped reads are wrong for a caller outside the grantee tenant (the red side the fix removes)', async () => {
    // an agent that serves the GRANTEE tenant does not qualify when the two reads run in the owner agent's context
    await runAs.agent('agent-x', 'tenant-a', async () => {
      expect(await listSkillAccess('skill-of-a')).toEqual([])
      expect(await agentHasEnabledAvailability('agent-grantee', ['tenant-a', 'tenant-b'])).toBe(false)
    })
    await runAs.agent('agent-x', '_multi_', async () => {
      expect(await agentHasEnabledAvailability('agent-owner', ['tenant-a'])).toBe(false) // a shared agent sees no tenant row at all
    })
  })

  for (const [label, caller] of CALLERS) {
    it(`${label}: the grantee's agent and the owner's agent qualify, nobody else does`, async () => {
      await caller(async () => {
        expect(await agentQualifies('skill-of-a', 'tenant-a', 'agent-grantee')).toBe(true) // served through the grant
        expect(await agentQualifies('skill-of-a', 'tenant-a', 'agent-owner')).toBe(true) // served through the owner tenant
        expect(await agentQualifies('skill-of-a', 'tenant-a', 'agent-off')).toBe(false) // disabled in the grantee tenant
        expect(await agentQualifies('skill-of-a', 'tenant-a', 'agent-other')).toBe(false) // enabled in a tenant without the grant
        expect(await agentQualifies('skill-of-a', 'tenant-a', 'agent-unknown')).toBe(false)
      })
    })

    it(`${label}: the context is restored and the grant table stays closed to it (the policy is not widened)`, async () => {
      await caller(async () => {
        const before = currentDbContext()
        await agentQualifies('skill-of-a', 'tenant-a', 'agent-grantee')
        expect(currentDbContext()).toEqual(before)
        expect(await listSkillAccess('skill-of-a')).toEqual(label.includes('grantee') ? [expect.objectContaining({ tenant_id: 'tenant-b' })] : [])
      })
    })
  }

  it('the check opens the SANCTIONED system context: from an agent or a tenant context it is no counted escalation', async () => {
    resetDbContextForTest()
    await runAs.agent('agent-x', '_multi_', () => agentQualifies('skill-of-a', 'tenant-a', 'agent-grantee'))
    await runAs.tenant('tenant-a', () => agentQualifies('skill-of-a', 'tenant-a', 'agent-grantee'))
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('a grant that is revoked stops qualifying the grantee agent', async () => {
    await db.pool.query("DELETE FROM skill_tenant_access WHERE skill_id = 'skill-of-a'")
    await runAs.agent('agent-x', 'tenant-a', async () => {
      expect(await agentQualifies('skill-of-a', 'tenant-a', 'agent-grantee')).toBe(false)
      expect(await agentQualifies('skill-of-a', 'tenant-a', 'agent-owner')).toBe(true)
    })
  })
})
