// String-contract guard: the permission matrix and the screen-access matrix
// stay two separate tables/sections, but must share one visual system --
// same legend helper, same cell-marker color classes (admin-b2b-matrix-*).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ADMIN_B2B = readFileSync(join(__dirname, '../../web/modules/admin-b2b.js'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/css/features/admin-b2b.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

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
