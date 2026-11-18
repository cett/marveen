// countApprovalsRequestedSince (db/vault.ts): the hourly allowance of owner notices is counted per tenant. A request of
// another tenant, of the same agent and category and inside the window, must not count against this tenant's allowance.
// Test only: the production count already filters on the tenant; this pins it.
//
// Privacy: neutral fixtures only (agent-a, email_send, default and other tenants).

import { describe, expect, it } from 'vitest'
import { countApprovalsRequestedSince, createApproval } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const SINCE = Math.floor(Date.now() / 1000) - 3600

describe('countApprovalsRequestedSince: the count is the own tenant only', () => {
  it('two requests of the default tenant and one of another tenant, all in the window: each tenant counts its own', async () => {
    await createApproval({ id: 'req-own-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default' })
    await createApproval({ id: 'req-own-2', agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default' })
    await createApproval({ id: 'req-other-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'other' })
    expect(await countApprovalsRequestedSince({ agent_id: 'agent-a', category: 'email_send', tenant_id: 'default', since: SINCE })).toBe(2)
    expect(await countApprovalsRequestedSince({ agent_id: 'agent-a', category: 'email_send', tenant_id: 'other', since: SINCE })).toBe(1)
  })
})
