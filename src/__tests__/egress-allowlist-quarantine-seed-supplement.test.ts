// Migration 0059 regression guard: 7 RSS-feed hosts added to
// store/egress-allowlist.json after migration 0056's seed was authored
// (#985 group 1 follow-up -- 0056's baked seed does not retroactively pick
// up file edits made after authoring time). Asserts they land in the
// DB-backed table, not just the JSON side-car.
import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, listEgressAllowlistRows } from '../db.js'

const SUPPLEMENT_HOSTS = [
  'www.hwsw.hu',
  'ite.hu',
  'www.marketingszoveg.com',
  'logout.hu',
  'aphexplays.blog.hu',
  'devsolution.hu',
  'hzoltan.com',
]

beforeAll(() => {
  initDatabase(':memory:')
})

describe('migration 0059 seed supplement', () => {
  it('seeds all 7 hosts as domain-type rows in the default tenant', () => {
    const rows = listEgressAllowlistRows(null)
    for (const host of SUPPLEMENT_HOSTS) {
      const row = rows.find((r) => r.value === host)
      expect(row, `expected a seeded row for ${host}`).toBeDefined()
      expect(row!.type).toBe('domain')
      expect(row!.tenant_id).toBe('default')
    }
  })
})
