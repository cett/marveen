// Real-DB checks for the whitelisted fleet export/import helpers that the
// fleet-transfer tests stub out: idempotent inserts, the dedupe keys, and the
// closed table list.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  exportTableRows,
  exportMemoryRows,
  fleetRowExists,
  fleetRowIdExists,
  importFleetRows,
  listEnabledTenantIds,
  inFleetImportTransaction,
  type FleetImportTable,
} from '../db/fleet-transfer.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const label = { id: 'l1', name: 'bug', color: '#f00', created_at: 1 }
const memory = {
  chat_id: '', content: 'remember', sector: 'semantic', salience: 1, created_at: 5, accessed_at: 5,
  agent_id: 'a1', category: 'warm', auto_generated: 0, keywords: null,
}

describe('importFleetRows', () => {
  it('inserts a key-deduped row once and reports the count', async () => {
    expect(await importFleetRows('labels', [label])).toBe(1)
    expect(await importFleetRows('labels', [label])).toBe(0)
    expect(await exportTableRows('labels')).toHaveLength(1)
    expect(await fleetRowIdExists('labels', 'l1')).toBe(true)
    expect(await fleetRowIdExists('labels', 'nope')).toBe(false)
  })

  it('skips a row that matches the dedupe columns, keeps one that differs', async () => {
    expect(await importFleetRows('memories', [memory, memory, { ...memory, content: 'other' }])).toBe(2)
    expect(await fleetRowExists('memories', { agent_id: 'a1', content: 'remember' })).toBe(true)
    expect(await fleetRowExists('memories', { agent_id: 'a2', content: 'remember' })).toBe(false)
    expect(await exportMemoryRows()).toHaveLength(2)
  })

  it('treats a missing optional value as NULL', async () => {
    await importFleetRows('kanban_cards', [{
      id: 'c1', title: 't', status: 'planned', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1,
    }])
    const [card] = await exportTableRows('kanban_cards')
    expect(card.description).toBeNull()
    expect(card.sort_order).toBe(0)
  })

  it('refuses a dedupe lookup on a table without a natural key', async () => {
    await expect(fleetRowExists('labels', label)).rejects.toThrow(/no natural key/)
  })

  it('rejects a table outside the whitelist', async () => {
    await expect(exportTableRows('sqlite_master' as never)).rejects.toThrow(/unknown table/)
    await expect(fleetRowIdExists('memories' as never, 1)).rejects.toThrow(/unknown table/)
    await expect(importFleetRows('sqlite_master' as FleetImportTable, [label])).rejects.toThrow()
  })

  it('two overlapping imports of the same deduped row insert it once', async () => {
    const counts = await Promise.all([importFleetRows('memories', [memory]), importFleetRows('memories', [memory])])
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    expect(await exportMemoryRows()).toHaveLength(1)
  })
})

describe('inFleetImportTransaction', () => {
  it('rolls every write back when the callback throws', async () => {
    await expect(inFleetImportTransaction(async () => {
      await importFleetRows('labels', [label])
      // the write is really inside the transaction (visible to it) before the throw takes it back
      expect(await exportTableRows('labels')).toHaveLength(1)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await exportTableRows('labels')).toEqual([])
  })

  it('rolls the earlier tables back when a later insert is refused', async () => {
    await expect(inFleetImportTransaction(async () => {
      await importFleetRows('labels', [label])
      // a status outside the table's CHECK list: the insert is refused after the label went in
      await importFleetRows('kanban_cards', [{
        id: 'c1', title: 't', status: 'bogus', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1,
      }])
    })).rejects.toThrow(/CHECK constraint/)
    expect(await exportTableRows('labels')).toEqual([])
  })

  it('commits every write of a body that finishes', async () => {
    await inFleetImportTransaction(async () => {
      await importFleetRows('labels', [label])
      await importFleetRows('memories', [memory])
    })
    expect(await exportTableRows('labels')).toHaveLength(1)
    expect(await exportMemoryRows()).toHaveLength(1)
  })

  it('does not interleave two overlapping imports: the deduped row lands once and both finish', async () => {
    const run = () => inFleetImportTransaction(async () => {
      await importFleetRows('labels', [label])
      await importFleetRows('memories', [memory])
    })
    await Promise.all([run(), run()])
    expect(await exportTableRows('labels')).toHaveLength(1)
    expect(await exportMemoryRows()).toHaveLength(1)
  })
})

describe('listEnabledTenantIds', () => {
  it('leaves out disabled tenants', async () => {
    const db = getDb()
    db.prepare("INSERT INTO tenants (id, display_name, created_at) VALUES ('t-on', 'On', 1)").run()
    db.prepare("INSERT INTO tenants (id, display_name, created_at, disabled_at) VALUES ('t-off', 'Off', 1, 2)").run()
    const ids = await listEnabledTenantIds()
    expect(ids).toContain('t-on')
    expect(ids).not.toContain('t-off')
  })
})
