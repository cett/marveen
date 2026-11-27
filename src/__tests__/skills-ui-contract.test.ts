// web/modules/skills.js is a browser module (DOM, fetch), so the contract of the Skills screen is read from its source:
// the list comes from the database, the machine-wide file scans are an admin-only add-on, a delete goes to a row and only to a row.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '../../web/modules/skills.js'), 'utf8')
const HTML = readFileSync(join(here, '../../web/index.html'), 'utf8')

function body(startMarker: string): string {
  const start = SOURCE.indexOf(startMarker)
  expect(start, startMarker).toBeGreaterThan(-1)
  return SOURCE.slice(start, start + 2600)
}

describe('Skills screen contract', () => {
  const load = body('export async function loadGlobalSkills()')

  it('lists from GET /api/skills/sql and fails visibly (no silent fall back to the file scan) when it does not answer', () => {
    expect(load).toContain("fetch('/api/skills/sql')")
    expect(load).toMatch(/if \(!sqlRes\.ok\) throw/)
  })

  it('calls the machine-wide file scans only for an admin', () => {
    expect(load).toContain("can('admin:all')")
    expect(load).toMatch(/isAdmin \? fetch\('\/api\/skills'\)/)
    expect(load).toMatch(/isAdmin \? fetch\('\/api\/skills\/local'\)/)
    // and never unconditionally
    expect(load).not.toMatch(/[^?:] fetch\('\/api\/skills'\)/)
  })

  it('merges through the pure module, and opens a card with the merged entry', () => {
    expect(SOURCE).toContain("from './skills-merge.js'")
    expect(load).toContain('mergeSkills(')
    expect(SOURCE).toContain('openSkillDetail(skill)')
  })

  it('delete and edit of a database row go to /api/skills/sql/:id; the delete button is for a row and an admin only', () => {
    expect(SOURCE).toContain("fetch(`/api/skills/sql/${encodeURIComponent(_skillDetailSqlId)}`, { method: 'DELETE' })")
    expect(SOURCE).toContain('deleteBtn.hidden = !(flags.canDelete && _skillsIsAdmin)')
    expect(SOURCE).toMatch(/if \(!_skillDetailSqlId\) return\n\s+if \(!confirm/)
    expect(HTML).toMatch(/id="skillDetailDeleteBtn"[^>]*hidden/)
  })
})
