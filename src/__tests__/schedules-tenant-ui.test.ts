// UI-side tenant wiring of the scheduled-task page (every task belongs to a tenant).
// Source-assertion test, same pattern as schedules-ui-review-gate.test.ts: the module
// is vanilla DOM code, so the strings the feature depends on are what gets pinned.
// The real browser behaviour is covered by tests/smoke/schedules-tenant-dialog.spec.ts.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, '../../', rel), 'utf-8')
const APP = read('web/modules/schedules.js')
const SELECTOR = read('web/modules/tenant-selector.js')
const HTML = read('web/index.html')
const EN = read('web/lang/en.js')
const HU = read('web/lang/hu.js')

describe('schedules.js: tenant filter', () => {
  it('no longer offers a fleet-only scope (the API does not know it any more)', () => {
    expect(APP).not.toMatch(/'fleet'/)
    expect(APP).toMatch(/initTenantSelector\('schedulesTenantSelectorContainer', \(\) => loadSchedules\(\)\)/)
    expect(SELECTOR).not.toMatch(/extraOptions/)
    expect(EN).not.toMatch(/tenant\.selector\.fleet_only/)
    expect(HU).not.toMatch(/tenant\.selector\.fleet_only/)
  })
})

describe('schedules.js: tenant field in the task dialog', () => {
  it('the field exists in the modal, hidden until the caller is a global admin', () => {
    expect(HTML).toMatch(/id="scheduleTenantGroup" hidden/)
    expect(HTML).toMatch(/<select id="scheduleTenant">/)
    expect(HTML).toMatch(/id="scheduleTenantHint" hidden/)
  })

  it('the field is only filled for a global admin (fetchAdminTenants is empty for everyone else)', () => {
    expect(APP).toMatch(/group\.hidden = _tenants\.length === 0/)
    expect(SELECTOR).toMatch(/auth\?\.role === 'admin' && auth\?\.tenant_id === null\)\) return \[\]/)
  })

  it('picking a tenant narrows the agent list through /api/schedules/agents?tenant=', () => {
    expect(APP).toMatch(/`\/api\/schedules\/agents\?tenant=\$\{encodeURIComponent\(tenant\)\}`/)
    expect(APP).toMatch(/getElementById\('scheduleTenant'\)\.addEventListener\('change'/)
  })

  it('the tenant-narrowed agent list never replaces the label/avatar lookup of the list rows', () => {
    expect(APP).toMatch(/if \(!tenant\) scheduleAgents = agents/)
  })

  it('a background list refresh refreshes only the row lookup, never the open dialog\'s agent selector', () => {
    const load = APP.slice(APP.indexOf('export async function loadSchedules()'), APP.indexOf('async function loadSchedulerHeartbeat'))
    expect(load).toMatch(/refreshScheduleAgentLookup\(\)/)
    expect(load).not.toMatch(/loadScheduleAgents\(/)
    const lookup = APP.slice(APP.indexOf('async function refreshScheduleAgentLookup'), APP.indexOf('let _agentSelectSeq'))
    expect(lookup).not.toMatch(/scheduleAgent'\)/)
  })

  it('the newest agent-selector load wins (stale answers are dropped)', () => {
    expect(APP).toMatch(/const seq = \+\+_agentSelectSeq/)
    expect(APP).toMatch(/if \(seq !== _agentSelectSeq\) return/)
  })

  it('a new task defaults to the filtered tenant, else the default tenant', () => {
    expect(APP).toMatch(/prepareTenantField\(_tenantGetter\?\.\(\) \|\| DEFAULT_TENANT\)/)
  })

  it('an edit pre-selects the task tenant and remembers it, so an unchanged save sends no tenant_id', () => {
    expect(APP).toMatch(/prepareTenantField\(taskTenant\)/)
    expect(APP).toMatch(/if \(tenant\) _editTenant = taskTenant/)
    expect(APP).toMatch(/return editing && picked === _editTenant \? '' : picked/)
    expect(APP).toMatch(/if \(document\.getElementById\('scheduleTenantGroup'\)\.hidden\) return ''/)
  })

  it('moving a task shows the draft hint and the draft toast', () => {
    expect(APP).toMatch(/const moving = _editTenant !== null && tenant !== _editTenant/)
    // The choice of toast is saveToastKey() (unit-tested in schedule-review-ui.test.ts); the dialog
    // only renders the moved-draft one with the tenant's label.
    expect(APP).toMatch(/toast\.key === 'tasks\.toast\.moved_draft' \? t\(toast\.key, \{ tenant: tenantLabel\(toast\.tenant\) \}\)/)
  })
})

describe('schedules.js: tenant on the list', () => {
  it('rows show a tenant badge for a global admin only (_tenants is empty otherwise)', () => {
    expect(APP).toMatch(/_tenants\.length && task\.tenantId \? `<span class="badge"/)
  })

  it('the activate button names the tenant the draft belongs to', () => {
    expect(APP).toMatch(/t\('tasks\.btn\.activate_tenant', \{ tenant: tenantLabel\(task\.tenantId\) \}\)/)
  })
})

describe('i18n: every new tenant key exists in hu and en', () => {
  for (const key of [
    'tasks.tenant.label', 'tasks.tenant.badge_title', 'tasks.tenant.move_hint',
    'tasks.btn.activate_tenant', 'tasks.toast.moved_draft',
  ]) {
    it(key, () => {
      expect(EN).toContain(`'${key}':`)
      expect(HU).toContain(`'${key}':`)
    })
  }

  it('the modal markup references keys that exist', () => {
    expect(HTML).toMatch(/data-i18n="tasks\.tenant\.label"/)
    expect(HTML).toMatch(/data-i18n="tasks\.tenant\.move_hint"/)
  })
})
