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

  it('an admin file scan that did not answer is told (notice above the grid + toast), never swallowed into an empty list', () => {
    expect(load).toContain('scanFailures({ globalRes, localRes })')
    expect(load).toContain('_renderScanWarning(failures)')
    expect(load).toMatch(/if \(failures\.length\) showToast\(t\('skills\.scan_failed\.toast'\)\)/)
    // the notice is cleared at the start of every load, and its element is in the page
    expect(SOURCE).toMatch(/export async function loadGlobalSkills\(\) \{\n  _renderScanWarning\(\[\]\)/)
    expect(HTML).toMatch(/id="skillsScanWarning"[^>]*hidden/)
  })

  it('a tenant row carries its tenant on the card and in the detail, and the delete confirm names it', () => {
    expect(SOURCE).toMatch(/_isTenantSkill\(entry\) \{\n\s+return entry\.origin === 'sql' && !!entry\.tenantId && entry\.tenantId !== 'fleet'/)
    expect(SOURCE).toContain("${escapeHtml(displayName)} ${sourceBadge} ${tenantBadge} ${stateBadge}")
    expect(SOURCE).toContain("t('skills.badge.tenant', { id: skill.tenantId })")
    expect(SOURCE).toContain("t('skills.detail.tenant', { id: _skillDetailTenantId })")
    expect(SOURCE).toContain("t('skills.confirm.delete_tenant', { name: _skillDetailCurrentName, id: _skillDetailTenantId })")
  })

  it('delete and edit of a database row go to /api/skills/sql/:id; the delete button is for a row and an admin only', () => {
    expect(SOURCE).toContain("fetch(`/api/skills/sql/${encodeURIComponent(_skillDetailSqlId)}`, { method: 'DELETE' })")
    expect(SOURCE).toContain('deleteBtn.hidden = !(flags.canDelete && _skillsIsAdmin)')
    // the guard comes first, then the confirm, then the DELETE
    expect(SOURCE).toMatch(/if \(!_skillDetailSqlId\) return\n[\s\S]{0,400}if \(!confirm\(confirmText\)\) return/)
    expect(HTML).toMatch(/id="skillDetailDeleteBtn"[^>]*hidden/)
  })
})
