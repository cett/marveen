// String-contract guards for the starter-pack panel of the admin B2B page: the dashboard has no DOM
// test harness here, so the source, markup and i18n files are read and the wiring is asserted.
// The behaviour is covered by tests/smoke/tenant-starter-pack-ui.spec.ts against a real instance.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')
const JS = read('web/modules/admin-b2b.js')
const HTML = read('web/index.html')
const HU = read('web/lang/hu.js')
const EN = read('web/lang/en.js')
const OPENAPI = read('docs/openapi.yaml')

const slice = (from: string, to: string) => JS.slice(JS.indexOf(from), JS.indexOf(to, JS.indexOf(from) + 1))

describe('who gets the starter-pack controls', () => {
  it('the tenant-row button is rendered only for a global admin, and never for the default tenant', () => {
    const row = slice('function renderTenantList', 'async function toggleTenant')
    expect(row).toMatch(/_globalAdmin && ten\.id !== 'default' \? `<button[^`]*data-action="show-starter"/)
  })

  it('_globalAdmin comes from the same isGlobalAdmin check as the rest of the page, at init and at load', () => {
    expect(JS).toMatch(/let _globalAdmin = false/)
    expect(JS).toMatch(/const isB2bAdmin = isGlobalAdmin\(auth\)\n\s*_globalAdmin = isB2bAdmin/)
    expect(slice('export async function loadAdminB2b', 'if (isGlobalAdmin(auth))')).toMatch(/_globalAdmin = isGlobalAdmin\(auth\)/)
  })

  it('every entry point refuses to act without it', () => {
    expect(slice('async function showStarterPack', 'function renderStarterPack')).toMatch(/if \(!_globalAdmin\) return/)
    expect(slice('async function createStarterPack', 'async function addTenant')).toMatch(/if \(!_globalAdmin \|\| !tenantId\) return/)
  })

  it('the handlers are wired inside the global-admin branch of initAdminB2b', () => {
    const init = slice('export async function initAdminB2b', 'export async function loadAdminB2b')
    const branch = init.slice(init.indexOf('if (isB2bAdmin) {'))
    expect(branch).toMatch(/data-action|dataset\.action === 'show-starter'/)
    expect(branch).toMatch(/\$\('starterPackBtn'\)\?\.addEventListener\('click', createStarterPack\)/)
    expect(init.slice(0, init.indexOf('if (isB2bAdmin) {'))).not.toMatch(/show-starter|starterPackBtn/)
  })
})

describe('what the panel calls and renders', () => {
  it('reads and writes the starter-pack endpoint of the selected tenant, with the picked agent only when the picker is shown', () => {
    expect(JS).toMatch(/fetch\(`\/api\/admin\/tenants\/\$\{enc\}\/starter-pack`\)/)
    const create = slice('async function createStarterPack', 'async function addTenant')
    expect(create).toMatch(/method: 'POST'/)
    expect(create).toMatch(/select && !select\.hidden && select\.value \? \{ agent_id: select\.value \} : \{\}/)
  })

  it('escapes everything it interpolates into markup', () => {
    const render = slice('function renderStarterPack', 'async function createStarterPack')
    expect(render).not.toMatch(/\$\{(?!esc\()/)
  })

  it('an availability change refreshes an open panel of the same tenant', () => {
    const set = slice('async function setAgentAvailability', 'async function showStarterPack')
    expect(set).toMatch(/starterPackContainer'\)\?\.dataset\.tenant === tenantId/)
  })

  it('markup: the panel and the picker start hidden, with the ids the module uses', () => {
    expect(HTML).toMatch(/<div id="starterPackContainer" hidden>/)
    expect(HTML).toMatch(/<select id="starterPackAgent"[^>]*hidden><\/select>/)
    expect(HTML).toMatch(/id="starterPackBtn"/)
    expect(HTML).toMatch(/id="starterPackStatus"/)
  })
})

describe('i18n', () => {
  const keysOf = (src: string) => new Set([...src.matchAll(/'(admin\.b2b\.starter\.[a-z_.]+)'/g)].map(m => m[1]))
  const hu = keysOf(HU)
  const en = keysOf(EN)

  it('hu and en carry the same starter keys', () => {
    expect([...hu].sort()).toEqual([...en].sort())
  })

  it('every key the module builds or names exists', () => {
    // Prefixes the module extends at run time (state., reason., toast.) end in a dot and are checked below.
    const named = [...JS.matchAll(/'(admin\.b2b\.starter\.[a-z_.]+)'/g)].map(m => m[1]!).filter(k => !k.endsWith('.'))
    const toasts = ['created', 'retargeted', 'unchanged'].map(k => `admin.b2b.starter.toast.${k}`)
    const missing = [...named, ...toasts, 'admin.b2b.starter.title'].filter(k => !hu.has(k))
    expect(missing).toEqual([])
  })

  it('every state and every agent-less reason the API can return has a label', () => {
    const enumOf = (schema: string, field: string) => {
      const block = OPENAPI.slice(OPENAPI.indexOf(`    ${schema}:`))
      const at = block.indexOf(`${field}:`)
      return [...block.slice(at, block.indexOf('\n', block.indexOf('enum:', at))).matchAll(/enum: \[([^\]]*)\]/g)][0]![1]!.split(',').map(s => s.trim())
    }
    const states = enumOf('TenantStarterPackState', 'state')
    expect(states.length).toBeGreaterThan(0)
    for (const s of states) expect(hu.has(`admin.b2b.starter.state.${s}`), `state ${s}`).toBe(true)
    // explicit / main_agent / single_enabled only occur together with a chosen agent, so they show no reason line.
    const reasons = enumOf('TenantStarterPackState', 'reason').filter(r => !['explicit', 'main_agent', 'single_enabled'].includes(r))
    expect(reasons.length).toBeGreaterThan(0)
    for (const r of reasons) expect(hu.has(`admin.b2b.starter.reason.${r}`), `reason ${r}`).toBe(true)
  })
})
