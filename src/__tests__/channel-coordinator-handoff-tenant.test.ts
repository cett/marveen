// The tenant of the coordinator's handoff row is the NAMED default-tenant constant (db/tenant-channel-bindings.ts
// UNBOUND_SOURCE_TENANT), not a literal that happens to equal it. The constant is replaced here by another value: a handoff row
// that still says 'default' proves the module hard-codes the tenant instead of using the one definition.
//
// Privacy: neutral fixtures only.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../db/tenant-channel-bindings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/tenant-channel-bindings.js')>()),
  UNBOUND_SOURCE_TENANT: 'owner-tenant-x',
}))

import { closeDatabase, getDb, initProcessDatabase } from '../db/connection.js'
import { createHandoffMessage, HANDOFF_TENANT } from '../channel-coordinator/ingest.js'

afterEach(() => closeDatabase())

describe('the handoff tenant comes from the one definition', () => {
  it('follows UNBOUND_SOURCE_TENANT (a hard-coded literal would still say default)', async () => {
    initProcessDatabase(':memory:')
    expect(HANDOFF_TENANT).toBe('owner-tenant-x')
    const id = await createHandoffMessage('body')
    expect(getDb().prepare('SELECT tenant_id FROM agent_messages WHERE id = ?').get(id)).toEqual({ tenant_id: 'owner-tenant-x' })
  })
})
