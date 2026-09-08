// String-contract guards for the admin-b2b Users tab (permission matrix,
// screen-access matrix, user-row scope chip): read the real source/CSS/i18n
// files and assert the pieces are actually wired together, so a future edit
// that drifts the markup, class names, or i18n keys fails CI.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ADMIN_B2B = readFileSync(join(__dirname, '../../web/modules/admin-b2b.js'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/css/features/admin-b2b.css'), 'utf-8')
const INDEX_HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

// The permission matrix and the screen-access matrix stay two separate
// tables/sections, but must share one visual system -- same legend helper,
// same cell-marker color classes (admin-b2b-matrix-*).
describe('admin-b2b RBAC matrix visual unification', () => {
  it('both renderers build their legend through the shared renderMatrixLegend helper', () => {
    expect(ADMIN_B2B).toMatch(/function renderMatrixLegend/)
    const permissionSection = ADMIN_B2B.slice(ADMIN_B2B.indexOf('function renderPermissionMatrix'), ADMIN_B2B.indexOf('function renderScreenAccessMatrix'))
    const screenSection = ADMIN_B2B.slice(ADMIN_B2B.indexOf('function renderScreenAccessMatrix'))
    expect(permissionSection).toMatch(/renderMatrixLegend\(/)
    expect(screenSection).toMatch(/renderMatrixLegend\(/)
  })

  it('both renderers only emit the shared admin-b2b-matrix-* cell-marker classes, not a separate yes/no pair', () => {
    expect(ADMIN_B2B).not.toMatch(/admin-b2b-perm-yes|admin-b2b-perm-no\b|admin-b2b-access-/)
    expect(ADMIN_B2B).toMatch(/MATRIX_LEVEL_SYMBOLS/)
  })

  it('admin-b2b.css defines one shared legend class and one shared level-color family used by both tables', () => {
    expect(CSS).toMatch(/\.admin-b2b-matrix-legend\s*\{/)
    for (const level of ['full', 'ro', 'gap', 'none']) {
      expect(CSS).toMatch(new RegExp(`\\.admin-b2b-matrix-${level}\\s*\\{`))
    }
    expect(CSS).not.toMatch(/\.admin-b2b-access-legend|\.admin-b2b-perm-yes|\.admin-b2b-perm-no\b/)
  })

  it('hu.js and en.js define the permission-matrix legend keys alongside the existing screen-access ones', () => {
    for (const key of [
      'admin.b2b.permission_matrix.legend.full',
      'admin.b2b.permission_matrix.legend.none',
      'admin.b2b.screen_access.legend.full',
      'admin.b2b.screen_access.legend.ro',
      'admin.b2b.screen_access.legend.gap',
      'admin.b2b.screen_access.legend.none',
    ]) {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    }
  })
})

// String-contract guard for the Users-tab permission matrix. The functional
// drift check lives in rbac-permission-matrix-data.test.ts; this only guards
// that the pieces are actually wired together (container div in index.html,
// renderPermissionMatrix called from the users tab, i18n keys present in
// both languages).
describe('admin-b2b permission matrix UI wiring', () => {
  it('index.html has the permissionMatrix container inside panel-users', () => {
    expect(INDEX_HTML).toMatch(/id="userList"[\s\S]{0,300}id="permissionMatrix"/)
  })

  it('admin-b2b.js imports the permission-matrix data mirror', () => {
    expect(ADMIN_B2B).toMatch(/import\s*\{[^}]*PERMISSION_MATRIX_CATEGORIES[^}]*\}\s*from\s*'\.\/rbac-permission-matrix-data\.js'/)
  })

  it('renderPermissionMatrix is called when the users tab is shown', () => {
    expect(ADMIN_B2B).toMatch(/tab === 'users'.*renderPermissionMatrix\(\)/)
  })

  it('hu.js and en.js both define the permission-matrix i18n keys', () => {
    for (const key of [
      'admin.b2b.permission_matrix.title',
      'admin.b2b.permission_matrix.role.admin',
      'admin.b2b.permission_matrix.cat.memory',
      'admin.b2b.perm.memories.read.label',
      'admin.b2b.perm.admin.all.desc',
    ]) {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    }
  })

  it('index.html has the screenAccessMatrix container inside panel-users', () => {
    expect(INDEX_HTML).toMatch(/id="permissionMatrix"[\s\S]{0,500}id="screenAccessMatrix"/)
  })

  it('admin-b2b.js imports the screen-access data mirror', () => {
    expect(ADMIN_B2B).toMatch(/import\s*\{[^}]*SCREEN_ACCESS_ROWS[^}]*\}\s*from\s*'\.\/rbac-screen-access-data\.js'/)
  })

  it('renderScreenAccessMatrix is called when the users tab is shown', () => {
    expect(ADMIN_B2B).toMatch(/tab === 'users'.*renderScreenAccessMatrix\(\)/)
  })

  it('hu.js and en.js both define the screen-access i18n keys', () => {
    for (const key of [
      'admin.b2b.screen_access.title',
      'admin.b2b.screen_access.shadow_note',
      'admin.b2b.screen_access.legend.gap',
      'admin.b2b.screen_access.screen.overview',
      'admin.b2b.screen_access.screen.profile',
    ]) {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    }
  })
})

// The tenant-user scope chip and the global-admin scope chip must render as
// the same badge markup so the two cases look visually consistent (only the
// label differs).
describe('admin-b2b user-row scope chip UI wiring', () => {
  it('renders a single badge span for both the tenant-user and global-admin case', () => {
    const match = ADMIN_B2B.match(/\$\{u\.tenant_id \? esc\(u\.tenant_id\) : t\('admin\.b2b\.user\.scope_fleet',[^}]*\)\}/)
    expect(match).toBeTruthy()
    expect(ADMIN_B2B).toMatch(/<span class="badge" data-variant="neutral">\$\{u\.tenant_id \? esc\(u\.tenant_id\) : t\('admin\.b2b\.user\.scope_fleet'/)
  })

  it('hu.js and en.js both define the fleet-scope i18n key', () => {
    expect(HU).toContain(`'admin.b2b.user.scope_fleet'`)
    expect(EN).toContain(`'admin.b2b.user.scope_fleet'`)
  })
})
