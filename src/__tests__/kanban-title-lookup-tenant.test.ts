import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import {
  createKanbanCard,
  getKanbanCard,
  findActiveKanbanCardByTitle,
  markScheduledTaskKanbanWaiting,
  archiveKanbanCard,
  moveKanbanCard,
  createTenant,
} from '../db.js'

// The tenant is a parameter of both lookups the schedule runner makes by the task name (row-level security, step S2b): the
// card of the task's tenant is found and moved, never the card another tenant titled the same, and the end of the waiting
// column is the end of the column of the task's tenant. These cells run on BOTH engines (the PORTED list): the clause is
// a statement of the query, and a stubbed or SQLite-only run cannot see it missing on PostgreSQL.
// Each cell first asserts its own construction (both cards exist, equal titles, different tenants), so it cannot pass
// because the second card was never there. Fixtures are neutral names.

useTestDb()

const TITLE = 'nightly-job'

async function tenants(): Promise<void> {
  await createTenant('tenant-a', 'Tenant A')
  await createTenant('tenant-b', 'Tenant B')
}

// The card of tenant B is created FIRST, so a tenant-blind LIMIT 1 finds it.
async function twoCards(): Promise<void> {
  await tenants()
  await createKanbanCard({ id: 'card-b', title: TITLE, status: 'in_progress', tenant_id: 'tenant-b' })
  await createKanbanCard({ id: 'card-a', title: TITLE, status: 'in_progress', tenant_id: 'tenant-a' })
  const a = (await getKanbanCard('card-a'))!
  const b = (await getKanbanCard('card-b'))!
  expect(a.title).toBe(b.title)
  expect([a.tenant_id, b.tenant_id]).toEqual(['tenant-a', 'tenant-b'])
}

describe('findActiveKanbanCardByTitle: the card of the asked tenant', () => {
  it('finds the card of the asked tenant in both directions, whichever card was created first', async () => {
    await twoCards()
    expect((await findActiveKanbanCardByTitle(TITLE, 'tenant-a'))?.id).toBe('card-a')
    expect((await findActiveKanbanCardByTitle(TITLE, 'tenant-b'))?.id).toBe('card-b')
  })

  it('finds nothing for a tenant without such a card although another tenant has one', async () => {
    await tenants()
    await createKanbanCard({ id: 'card-b', title: TITLE, tenant_id: 'tenant-b' })
    expect((await getKanbanCard('card-b'))?.tenant_id).toBe('tenant-b')
    expect(await findActiveKanbanCardByTitle(TITLE, 'tenant-a')).toBeUndefined()
    expect(await findActiveKanbanCardByTitle(TITLE, 'default')).toBeUndefined()
  })

  it('does not match an archived card of the asked tenant and does not fall over to the other tenant', async () => {
    await twoCards()
    await archiveKanbanCard('card-a')
    expect((await getKanbanCard('card-a'))?.archived_at).not.toBeNull()
    expect(await findActiveKanbanCardByTitle(TITLE, 'tenant-a')).toBeUndefined()
    expect((await findActiveKanbanCardByTitle(TITLE, 'tenant-b'))?.id).toBe('card-b')
  })
})

describe('markScheduledTaskKanbanWaiting: only the card of the task tenant', () => {
  it('moves only the card of the task tenant: the other tenant card keeps its status and its sort order', async () => {
    await twoCards()
    const otherBefore = (await getKanbanCard('card-b'))!
    expect(await markScheduledTaskKanbanWaiting(TITLE, 'tenant-a')).toBe('card-a')
    expect((await getKanbanCard('card-a'))!.status).toBe('waiting')
    const otherAfter = (await getKanbanCard('card-b'))!
    expect([otherAfter.status, otherAfter.sort_order]).toEqual([otherBefore.status, otherBefore.sort_order])
    expect(otherAfter.status).toBe('in_progress')
  })

  it('is null and moves nothing for a task whose tenant has no such card, although another tenant has one', async () => {
    await tenants()
    await createKanbanCard({ id: 'card-b', title: TITLE, status: 'in_progress', tenant_id: 'tenant-b' })
    expect((await getKanbanCard('card-b'))?.tenant_id).toBe('tenant-b')
    expect(await markScheduledTaskKanbanWaiting(TITLE, 'tenant-a')).toBeNull()
    expect((await getKanbanCard('card-b'))!.status).toBe('in_progress')
  })

  it('puts the card at the end of the waiting column OF THE TASK TENANT, not of every tenant', async () => {
    await twoCards()
    // the other tenant has a waiting column with a far larger sort order; the task tenant has a small one
    await createKanbanCard({ id: 'wait-a', title: 'earlier-a', status: 'in_progress', tenant_id: 'tenant-a' })
    await createKanbanCard({ id: 'wait-b', title: 'earlier-b', status: 'in_progress', tenant_id: 'tenant-b' })
    expect(await moveKanbanCard('wait-a', 'waiting', 200, 'owner')).toBe(true)
    expect(await moveKanbanCard('wait-b', 'waiting', 9000, 'owner')).toBe(true)
    expect((await getKanbanCard('wait-a'))!.sort_order).toBe(200)
    expect((await getKanbanCard('wait-b'))!.sort_order).toBe(9000)
    expect(await markScheduledTaskKanbanWaiting(TITLE, 'tenant-a')).toBe('card-a')
    expect((await getKanbanCard('card-a'))!.sort_order).toBe(300)
  })
})
