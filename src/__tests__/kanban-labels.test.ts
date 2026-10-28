// Contract tests for the kanban label registry + card<->label join table.
//
// These call the real production entry points (db.js) against an in-memory
// database seeded with the production schema, mirroring the pattern used by
// kanban-delete-fk.test.ts for deleteKanbanCard.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, deleteKanbanCard,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForCard, getLabelsForAllCards,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('label registry CRUD', () => {
  it('creates and lists a label', async () => {
    await createLabel({ id: 'lbl-a', name: 'bug', color: '#3b82f6' })
    expect(await listLabels()).toEqual([{ id: 'lbl-a', name: 'bug', color: '#3b82f6', created_at: expect.any(Number), tenant_id: 'default' }])
  })

  it('updates name and colour independently', async () => {
    await createLabel({ id: 'lbl-a', name: 'bug', color: '#3b82f6' })
    expect(await updateLabel('lbl-a', { color: '#10b981' })).toBe(true)
    expect(await getLabel('lbl-a')).toMatchObject({ name: 'bug', color: '#10b981' })

    expect(await updateLabel('lbl-a', { name: 'defect' })).toBe(true)
    expect(await getLabel('lbl-a')).toMatchObject({ name: 'defect', color: '#10b981' })
  })

  it('returns false updating a non-existent label', async () => {
    expect(await updateLabel('nope', { name: 'x' })).toBe(false)
  })

  it('deletes a label and its card associations (no dangling join rows)', async () => {
    await createKanbanCard({ id: 'card-a', title: 'Card A' })
    await createLabel({ id: 'lbl-a', name: 'bug', color: '#3b82f6' })
    await addLabelToCard('card-a', 'lbl-a')
    expect(await getLabelsForCard('card-a')).toHaveLength(1)

    expect(await deleteLabel('lbl-a')).toBe(true)
    expect(await getLabel('lbl-a')).toBeUndefined()
    expect(await getLabelsForCard('card-a')).toHaveLength(0)
  })

  it('returns false deleting a non-existent label', async () => {
    expect(await deleteLabel('nope')).toBe(false)
  })
})

describe('card <-> label associations', () => {
  beforeEach(async () => {
    await createKanbanCard({ id: 'card-a', title: 'Card A' })
    await createKanbanCard({ id: 'card-b', title: 'Card B' })
    await createLabel({ id: 'lbl-bug', name: 'bug', color: '#3b82f6' })
    await createLabel({ id: 'lbl-q2', name: 'q2', color: '#10b981' })
  })

  it('attaches a label to a card and reads it back', async () => {
    await addLabelToCard('card-a', 'lbl-bug')
    expect(await getLabelsForCard('card-a')).toEqual([
      { id: 'lbl-bug', name: 'bug', color: '#3b82f6', created_at: expect.any(Number), tenant_id: 'default' },
    ])
    expect(await getLabelsForCard('card-b')).toHaveLength(0)
  })

  it('is idempotent -- attaching the same label twice does not duplicate it', async () => {
    await addLabelToCard('card-a', 'lbl-bug')
    await addLabelToCard('card-a', 'lbl-bug')
    expect(await getLabelsForCard('card-a')).toHaveLength(1)
  })

  it('removes a label from a card', async () => {
    await addLabelToCard('card-a', 'lbl-bug')
    expect(await removeLabelFromCard('card-a', 'lbl-bug')).toBe(true)
    expect(await getLabelsForCard('card-a')).toHaveLength(0)
  })

  it('returns false removing an association that does not exist', async () => {
    expect(await removeLabelFromCard('card-a', 'lbl-bug')).toBe(false)
  })

  it('bulk-loads labels for all cards in one map', async () => {
    await addLabelToCard('card-a', 'lbl-bug')
    await addLabelToCard('card-a', 'lbl-q2')
    await addLabelToCard('card-b', 'lbl-q2')

    const map = await getLabelsForAllCards()
    expect(map.get('card-a')).toHaveLength(2)
    expect(map.get('card-b')).toHaveLength(1)
    expect(map.has('card-c')).toBe(false)
  })

  it('drops a card label association when the card is deleted', async () => {
    await addLabelToCard('card-a', 'lbl-bug')
    expect(await deleteKanbanCard('card-a')).toBe(true)
    // The label itself must survive -- only the association is gone.
    expect(await getLabel('lbl-bug')).toBeDefined()
    expect((await getLabelsForAllCards()).has('card-a')).toBe(false)
  })
})
