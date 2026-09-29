// String-contract guard: the backups "Torles" (delete) confirmation
// modal opened invisibly. backups.js only toggled `.hidden`, but
// `.modal-overlay` (web/css/components/modal.css) is opacity:0/visibility:hidden
// by default and only becomes visible via the `.active` class -- `[hidden]`
// alone toggles display:none/block but never restores opacity/visibility.
// Both must be set on open, and both cleared on close (see web/modules/audit-log.js
// for the same open/close pattern).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKUPS = readFileSync(join(__dirname, '../../web/modules/backups.js'), 'utf-8')

function fnBody(source: string, name: string): string {
  const idx = source.indexOf(`function ${name}(`)
  expect(idx, `function ${name} not found in backups.js`).toBeGreaterThan(-1)
  const open = source.indexOf('{', idx)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close)
}

describe('backups delete-modal UI wiring', () => {
  it('openDeleteModal sets both hidden=false and adds the .active class', () => {
    const body = fnBody(BACKUPS, 'openDeleteModal')
    expect(body).toMatch(/\.hidden\s*=\s*false/)
    expect(body).toMatch(/classList\.add\(\s*['"]active['"]\s*\)/)
  })

  it('closeDeleteModal removes the .active class and sets hidden=true', () => {
    const body = fnBody(BACKUPS, 'closeDeleteModal')
    expect(body).toMatch(/classList\.remove\(\s*['"]active['"]\s*\)/)
    expect(body).toMatch(/\.hidden\s*=\s*true/)
  })

  it('the delete button, cancel button and confirm button all go through the modal helpers, not raw .hidden toggling', () => {
    expect(BACKUPS).toMatch(/closest\(\s*['"]\.backups-delete-btn['"]\s*\)[\s\S]{0,300}openDeleteModal\(\)/)
    expect(BACKUPS).toMatch(/backupsDeleteCancelBtn[^]{0,150}closeDeleteModal\(\)/)
    expect(BACKUPS).toMatch(/backupsDeleteConfirmBtn[^]{0,150}closeDeleteModal\(\)/)
    // Regression guard: no remaining direct `getElementById('backupsDeleteModal').hidden = ...`
    // bypassing the helpers (that was the exact shape of the original bug).
    expect(BACKUPS).not.toMatch(/getElementById\(\s*['"]backupsDeleteModal['"]\s*\)\.hidden\s*=/)
  })
})
