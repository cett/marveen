// String-contract guard for the Users-tab row markup: the tenant-user scope
// chip and the global-admin scope chip must render with the same badge markup
// so the two cases look visually consistent (only the label differs).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ADMIN_B2B = readFileSync(join(__dirname, '../../web/modules/admin-b2b.js'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

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
