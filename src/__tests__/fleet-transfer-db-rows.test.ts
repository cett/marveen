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
  it('inserts a key-deduped row once and reports the count', () => {
    expect(importFleetRows('labels', [label])).toBe(1)
    expect(importFleetRows('labels', [label])).toBe(0)
    expect(exportTableRows('labels')).toHaveLength(1)
    expect(fleetRowIdExists('labels', 'l1')).toBe(true)
    expect(fleetRowIdExists('labels', 'nope')).toBe(false)
  })

  it('skips a row that matches the dedupe columns, keeps one that differs', () => {
    expect(importFleetRows('memories', [memory, memory, { ...memory, content: 'other' }])).toBe(2)
    expect(fleetRowExists('memories', { agent_id: 'a1', content: 'remember' })).toBe(true)
    expect(fleetRowExists('memories', { agent_id: 'a2', content: 'remember' })).toBe(false)
    expect(exportMemoryRows()).toHaveLength(2)
  })

  it('treats a missing optional value as NULL', () => {
    importFleetRows('kanban_cards', [{
      id: 'c1', title: 't', status: 'planned', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1,
    }])
    const [card] = exportTableRows('kanban_cards')
    expect(card.description).toBeNull()
    expect(card.sort_order).toBe(0)
  })

  it('refuses a dedupe lookup on a table without a natural key', () => {
    expect(() => fleetRowExists('labels', label)).toThrow(/no natural key/)
  })

  it('rejects a table outside the whitelist', () => {
    expect(() => exportTableRows('sqlite_master' as never)).toThrow(/unknown table/)
    expect(() => fleetRowIdExists('memories' as never, 1)).toThrow(/unknown table/)
    expect(() => importFleetRows('sqlite_master' as FleetImportTable, [label])).toThrow()
  })
})

describe('inFleetImportTransaction', () => {
  it('rolls every write back when the callback throws', () => {
    expect(() => inFleetImportTransaction(() => {
      importFleetRows('labels', [label])
      throw new Error('boom')
    })).toThrow('boom')
    expect(exportTableRows('labels')).toEqual([])
  })
})

describe('listEnabledTenantIds', () => {
  it('leaves out disabled tenants', () => {
    const db = getDb()
    db.prepare("INSERT INTO tenants (id, display_name, created_at) VALUES ('t-on', 'On', 1)").run()
    db.prepare("INSERT INTO tenants (id, display_name, created_at, disabled_at) VALUES ('t-off', 'Off', 1, 2)").run()
    const ids = listEnabledTenantIds()
    expect(ids).toContain('t-on')
    expect(ids).not.toContain('t-off')
  })
})
