// String-contract guard for the Users-tab permission matrix.
// The functional drift check lives in rbac-permission-matrix-data.test.ts;
// this only guards that the pieces are actually wired together (container
// div in index.html, renderPermissionMatrix called from the users tab,
// i18n keys present in both languages).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ADMIN_B2B = readFileSync(join(__dirname, '../../web/modules/admin-b2b.js'), 'utf-8')
const INDEX_HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

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
})
