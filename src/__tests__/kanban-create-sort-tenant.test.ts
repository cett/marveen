import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { dbx } from '../db/facade.js'
import { createKanbanCard, getKanbanCard, createTenant } from '../db.js'

// The end of a column is the end of the column OF THE CARD'S TENANT (row-level security, step S3): the sort-order maximum
// of createKanbanCard carries the card's own tenant. Under a tenant context the policy would hide the other tenant's rows
// by itself, but the clause is a statement of the query, and a privileged or a single-tenant run must give the same
// answer. These cells run on BOTH engines (the PORTED list): the other tenant's column has a far larger order, so a
// tenant-blind maximum lands the new card after it. Each cell asserts its own construction first. Neutral fixtures.

useTestDb()

const order = async (id: string): Promise<number> => (await getKanbanCard(id))!.sort_order

async function twoColumns(): Promise<void> {
  await createTenant('tenant-a', 'Tenant A')
  await createTenant('tenant-b', 'Tenant B')
  await createKanbanCard({ id: 'card-a0', title: 'a-first', tenant_id: 'tenant-a' })
  await createKanbanCard({ id: 'card-b0', title: 'b-first', tenant_id: 'tenant-b' })
  await dbx.run("UPDATE kanban_cards SET sort_order = 100 WHERE id = 'card-b0'") // the other tenant's column is far longer
  expect([await order('card-a0'), await order('card-b0')]).toEqual([0, 100])
}

describe('createKanbanCard: the end of the column is the end of the column of the card\'s tenant', () => {
  it('a new card of tenant A lands at the end of A\'s column, not after tenant B\'s far larger order', async () => {
    await twoColumns()
    await createKanbanCard({ id: 'card-a1', title: 'a-second', tenant_id: 'tenant-a' })
    expect(await order('card-a1')).toBe(1)
  })

  it('and the other way round: a new card of tenant B lands after B\'s own last card', async () => {
    await twoColumns()
    await createKanbanCard({ id: 'card-b1', title: 'b-second', tenant_id: 'tenant-b' })
    expect(await order('card-b1')).toBe(101)
  })

  it('the first card of a tenant with an empty column starts at 0 although another tenant\'s column is long', async () => {
    await twoColumns()
    await createTenant('tenant-c', 'Tenant C')
    await createKanbanCard({ id: 'card-c0', title: 'c-first', tenant_id: 'tenant-c' })
    expect(await order('card-c0')).toBe(0)
  })

  it('a card without a tenant takes the default tenant column, which the named tenants do not shape', async () => {
    await twoColumns()
    await createKanbanCard({ id: 'card-d0', title: 'default-first' })
    expect((await getKanbanCard('card-d0'))?.tenant_id).toBe('default')
    expect(await order('card-d0')).toBe(0)
  })

  it('only the same status column counts: a card in another status of the same tenant does not move the end', async () => {
    await twoColumns()
    await createKanbanCard({ id: 'card-a-wip', title: 'a-wip', status: 'in_progress', tenant_id: 'tenant-a' })
    await dbx.run("UPDATE kanban_cards SET sort_order = 50 WHERE id = 'card-a-wip'")
    await createKanbanCard({ id: 'card-a1', title: 'a-second', tenant_id: 'tenant-a' })
    expect(await order('card-a1')).toBe(1)
  })
})
