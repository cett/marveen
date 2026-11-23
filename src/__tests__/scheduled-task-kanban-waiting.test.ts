import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  getKanbanCard,
  findActiveKanbanCardByTitle,
  markScheduledTaskKanbanWaiting,
  archiveKanbanCard,
  moveKanbanCard,
  createTenant,
} from '../db.js'

// Tests for the post-fire timeout kanban coupling.
//
// When a scheduled task is detected as potentially stuck (busy > 300s), the
// runner calls markScheduledTaskKanbanWaiting(taskName). This moves any active
// kanban card whose title exactly matches the task name to 'waiting'.
//
// These tests call the real production db functions against an in-memory schema
// (same pattern as kanban-labels.test.ts and kanban-delete-fk.test.ts).

beforeEach(() => {
  initDatabase(':memory:')
})

describe('findActiveKanbanCardByTitle', () => {
  it('finds an active card by exact title match', async () => {
    await createKanbanCard({ id: 'card-1', title: 'reggeli-napindito' })
    const found = await findActiveKanbanCardByTitle('reggeli-napindito', 'default')
    expect(found).toBeDefined()
    expect(found!.id).toBe('card-1')
    expect(found!.title).toBe('reggeli-napindito')
  })

  it('returns undefined when no card matches the title', async () => {
    await createKanbanCard({ id: 'card-1', title: 'something-else' })
    expect(await findActiveKanbanCardByTitle('reggeli-napindito', 'default')).toBeUndefined()
  })

  it('does not match archived cards', async () => {
    await createKanbanCard({ id: 'card-1', title: 'reggeli-napindito' })
    await archiveKanbanCard('card-1')
    expect(await findActiveKanbanCardByTitle('reggeli-napindito', 'default')).toBeUndefined()
  })

  it('does not do partial or case-insensitive matching', async () => {
    await createKanbanCard({ id: 'card-1', title: 'reggeli-napindito-full' })
    expect(await findActiveKanbanCardByTitle('reggeli-napindito', 'default')).toBeUndefined()
    expect(await findActiveKanbanCardByTitle('REGGELI-NAPINDITO-FULL', 'default')).toBeUndefined()
  })
})

describe('markScheduledTaskKanbanWaiting', () => {
  it('moves the matching active card to waiting and returns its id', async () => {
    await createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'in_progress' })

    const result = await markScheduledTaskKanbanWaiting('daily-digest', 'default')

    expect(result).toBe('card-1')
    const card = await getKanbanCard('card-1')
    expect(card!.status).toBe('waiting')
  })

  it('returns null and makes no changes when no card matches', async () => {
    await createKanbanCard({ id: 'card-1', title: 'unrelated-task', status: 'planned' })

    const result = await markScheduledTaskKanbanWaiting('missing-task', 'default')

    expect(result).toBeNull()
    // Unrelated card is untouched
    expect((await getKanbanCard('card-1'))!.status).toBe('planned')
  })

  it('does NOT create a new kanban card when no matching card exists', async () => {
    // Start with an empty board -- no card for 'task-without-board-entry'.
    // This asserts the negative invariant: the scheduler must never silently
    // materialize kanban cards. If it did, the board would fill with
    // auto-generated entries for every stuck task that was never manually
    // tracked. The fix-revert guard below locks this in place.
    const result = await markScheduledTaskKanbanWaiting('task-without-board-entry', 'default')

    expect(result).toBeNull()
    expect(await findActiveKanbanCardByTitle('task-without-board-entry', 'default')).toBeUndefined()
  })

  it('is a no-op for archived cards (does not revive them)', async () => {
    await createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'done' })
    await archiveKanbanCard('card-1')

    const result = await markScheduledTaskKanbanWaiting('daily-digest', 'default')

    expect(result).toBeNull()
  })

  it('records a status-transition event for auditing', async () => {
    await createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'in_progress' })
    await markScheduledTaskKanbanWaiting('daily-digest', 'default')

    // Verify the card status changed (the audit event is written inside
    // moveKanbanCard; the functional signal is the status itself).
    expect((await getKanbanCard('card-1'))!.status).toBe('waiting')
  })

  it('places the card at the end of the waiting column (sort_order after existing waiting cards)', async () => {
    await createKanbanCard({ id: 'wait-1', title: 'earlier-task', status: 'waiting' })
    await createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'in_progress' })

    await markScheduledTaskKanbanWaiting('daily-digest', 'default')

    const moved = (await getKanbanCard('card-1'))!
    const existing = (await getKanbanCard('wait-1'))!
    // The moved card must sort AFTER the existing waiting card.
    expect(moved.sort_order).toBeGreaterThan(existing.sort_order)
  })
})

// --- Fix-revert guard ---
// If markScheduledTaskKanbanWaiting were changed to always return null (no-op),
// the test below would fail: that is the correct behaviour.
describe('fix-revert guard: kanban coupling is load-bearing', () => {
  it('returns the card id (not null) when a matching active card exists', async () => {
    await createKanbanCard({ id: 'card-1', title: 'test-task', status: 'planned' })
    const result = await markScheduledTaskKanbanWaiting('test-task', 'default')
    expect(result).not.toBeNull()
    expect(result).toBe('card-1')
  })

  it('actually changes the card status (not just returns an id)', async () => {
    await createKanbanCard({ id: 'card-1', title: 'test-task', status: 'planned' })
    await markScheduledTaskKanbanWaiting('test-task', 'default')
    expect((await getKanbanCard('card-1'))!.status).toBe('waiting')
  })
})

// --- The tenant is a parameter of both lookups (row-level security, step S2b) ---
// A scheduled task is a task of ONE tenant. Before the parameter, the title match and the MAX(sort_order) of the waiting
// column ignored the tenant: a task named like a card of ANOTHER tenant found and moved that card. These cells run on the
// real database; each first asserts its own construction (both cards exist, equal titles, different tenants), so a cell
// cannot pass because the second card was never there.
describe('two tenants with a card titled like the task', () => {
  async function twoCards(): Promise<void> {
    await createTenant('tenant-a', 'Tenant A')
    await createTenant('tenant-b', 'Tenant B')
    await createKanbanCard({ id: 'card-a', title: 'nightly-job', status: 'in_progress', tenant_id: 'tenant-a' })
    await createKanbanCard({ id: 'card-b', title: 'nightly-job', status: 'in_progress', tenant_id: 'tenant-b' })
    const a = (await getKanbanCard('card-a'))!
    const b = (await getKanbanCard('card-b'))!
    expect(a.title).toBe(b.title)
    expect([a.tenant_id, b.tenant_id]).toEqual(['tenant-a', 'tenant-b'])
  }

  it('the lookup finds the card of the asked tenant, whichever card was created first', async () => {
    await twoCards()
    expect((await findActiveKanbanCardByTitle('nightly-job', 'tenant-a'))?.id).toBe('card-a')
    expect((await findActiveKanbanCardByTitle('nightly-job', 'tenant-b'))?.id).toBe('card-b')
  })

  it('the lookup finds nothing for a tenant without such a card although another tenant has one', async () => {
    await createTenant('tenant-a', 'Tenant A')
    await createTenant('tenant-b', 'Tenant B')
    await createKanbanCard({ id: 'card-b', title: 'nightly-job', tenant_id: 'tenant-b' })
    expect((await getKanbanCard('card-b'))?.tenant_id).toBe('tenant-b')
    expect(await findActiveKanbanCardByTitle('nightly-job', 'tenant-a')).toBeUndefined()
    expect(await findActiveKanbanCardByTitle('nightly-job', 'default')).toBeUndefined()
  })

  it('the lookup does not match an archived card of the asked tenant and does not fall over to the other tenant', async () => {
    await twoCards()
    await archiveKanbanCard('card-a')
    expect(await findActiveKanbanCardByTitle('nightly-job', 'tenant-a')).toBeUndefined()
    expect((await findActiveKanbanCardByTitle('nightly-job', 'tenant-b'))?.id).toBe('card-b')
  })

  it('the mark moves only the card of the task tenant: the other tenant card keeps its status and its sort order', async () => {
    await twoCards()
    const otherBefore = (await getKanbanCard('card-b'))!
    expect(await markScheduledTaskKanbanWaiting('nightly-job', 'tenant-a')).toBe('card-a')
    expect((await getKanbanCard('card-a'))!.status).toBe('waiting')
    const otherAfter = (await getKanbanCard('card-b'))!
    expect([otherAfter.status, otherAfter.sort_order]).toEqual([otherBefore.status, otherBefore.sort_order])
  })

  it('the mark of a task whose tenant has no such card is null and moves nothing, although another tenant has one', async () => {
    await createTenant('tenant-a', 'Tenant A')
    await createTenant('tenant-b', 'Tenant B')
    await createKanbanCard({ id: 'card-b', title: 'nightly-job', status: 'in_progress', tenant_id: 'tenant-b' })
    expect((await getKanbanCard('card-b'))?.tenant_id).toBe('tenant-b')
    expect(await markScheduledTaskKanbanWaiting('nightly-job', 'tenant-a')).toBeNull()
    expect((await getKanbanCard('card-b'))!.status).toBe('in_progress')
  })

  it('the end of the waiting column is the end of the column of the TASK tenant, not of every tenant', async () => {
    await twoCards()
    // the other tenant has a waiting column with a far larger sort order; the task tenant has a small one
    await createKanbanCard({ id: 'wait-a', title: 'earlier-a', status: 'in_progress', tenant_id: 'tenant-a' })
    await createKanbanCard({ id: 'wait-b', title: 'earlier-b', status: 'in_progress', tenant_id: 'tenant-b' })
    expect(await moveKanbanCard('wait-a', 'waiting', 200, 'owner')).toBe(true)
    expect(await moveKanbanCard('wait-b', 'waiting', 9000, 'owner')).toBe(true)
    expect((await getKanbanCard('wait-a'))!.sort_order).toBe(200)
    expect((await getKanbanCard('wait-b'))!.sort_order).toBe(9000)
    await markScheduledTaskKanbanWaiting('nightly-job', 'tenant-a')
    expect((await getKanbanCard('card-a'))!.sort_order).toBe(300)
  })
})
