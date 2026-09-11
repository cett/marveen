// Shape + reference-gate guard for the dashboard's "screen access" matrix
// section (the second half of the Users-tab RBAC view). Unlike the permission
// mirror (rbac-permission-matrix-data.test.ts), this data is NOT a 1:1 mirror
// of a single source function: screen-level nav gating is spread ad-hoc across
// app.js and several web/modules/*.js files, several rows intentionally out of
// sync with the backend enforce truth (that's the documented gap list -- see
// SCREEN_ACCESS_GAPS in the data file). A full functional drift-guard isn't
// possible for those rows without first doing the frontend nav-gate work this
// task deliberately does NOT include.
//
// What IS checkable, and checked here: the five screens the spec called out
// as "existing frontend gates, reference, unchanged" (vault, auditLog,
// adminB2b, adminRbac, profile) have real, stable nav-hide conditions in
// source. This test greps for those exact conditions so a future rename or
// removal of the guard is caught, even though the bulk of the matrix remains a
// plain, manually-kept data table.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCREEN_ACCESS_ROLES,
  SCREEN_ACCESS_ROWS,
  SCREEN_ACCESS_GAPS,
} from '../../web/modules/rbac-screen-access-data.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_JS = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const PROFILE_JS = readFileSync(join(__dirname, '../../web/modules/profile.js'), 'utf-8')

const VALID_LEVELS = new Set(['full', 'ro', 'gap', 'none'])
const EXPECTED_SCREEN_COUNT = 27

describe('rbac-screen-access-data shape', () => {
  it('has the expected number of screens, each with a unique key', () => {
    expect(SCREEN_ACCESS_ROWS.length).toBe(EXPECTED_SCREEN_COUNT)
    const keys = SCREEN_ACCESS_ROWS.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every row covers exactly SCREEN_ACCESS_ROLES with a valid access level', () => {
    for (const row of SCREEN_ACCESS_ROWS) {
      expect(Object.keys(row.roles).sort()).toEqual([...SCREEN_ACCESS_ROLES].sort())
      for (const role of SCREEN_ACCESS_ROLES) {
        expect(VALID_LEVELS.has(row.roles[role])).toBe(true)
      }
      expect(row.backend).toBeTruthy()
    }
  })

  it('admin always has full access', () => {
    for (const row of SCREEN_ACCESS_ROWS) {
      expect(row.roles.admin).toBe('full')
    }
  })

  it('SCREEN_ACCESS_GAPS lists exactly the screens that have at least one gap cell', () => {
    const rowsWithGap = SCREEN_ACCESS_ROWS.filter((r) => Object.values(r.roles).includes('gap')).map((r) => r.key)
    expect([...SCREEN_ACCESS_GAPS].sort()).toEqual([...rowsWithGap].sort())
  })
})

describe('rbac-screen-access-data vs the actual (reference, unchanged) frontend nav gates', () => {
  it('vault + auditLog + adminB2b: admin+global-only nav reveal is still role===admin && tenant_id===null', () => {
    expect(APP_JS).toMatch(/revealAdminNav[\s\S]{0,200}auth\?\.role === 'admin' && auth\?\.tenant_id === null/)
    expect(APP_JS).toMatch(/revealVaultNav[\s\S]{0,200}auth\?\.role === 'admin' && auth\?\.tenant_id === null/)
    expect(APP_JS).toMatch(/revealAuditLogNav[\s\S]{0,200}auth\?\.role === 'admin' && auth\?\.tenant_id === null/)
  })

  it('adminRbac: nav reveal is still gated by can(admin:all)', () => {
    expect(APP_JS).toMatch(/revealAdminRbacNav[\s\S]{0,100}can\('admin:all'\)/)
  })

  it('profile: nav is still revealed only once a session profile loads', () => {
    expect(PROFILE_JS).toMatch(/function renderSidebarUser/)
    expect(PROFILE_JS).toMatch(/nav\.hidden = false/)
  })

  it('the matrix marks all four of these screens as none for every non-admin role', () => {
    for (const key of ['vault', 'auditLog', 'adminB2b', 'adminRbac']) {
      const row = SCREEN_ACCESS_ROWS.find((r) => r.key === key)
      expect(row).toBeTruthy()
      expect(row!.roles.agent).toBe('none')
      expect(row!.roles.read_only).toBe('none')
      expect(row!.roles.viewer).toBe('none')
    }
  })
})
