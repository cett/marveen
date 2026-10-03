// Role-based nav gating (web/modules/nav-gate.js). Three layers are held together here:
//   1. the gating data against the SERVER's real endpoint permission table: a page is hidden for a
//      role exactly when the role cannot load it, never more (tasks stays open) and never less;
//   2. the gating logic on a fake DOM (hides, never unhides, collapses empty sidebar groups, the
//      router guard sends a gated page to the overview);
//   3. wiring contracts on index.html / app.js / the pollers, so a removed attribute or a dropped
//      call is a red test.
// No browser: the dashboard's ES modules run in node, the DOM is a small stand-in.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_PERMISSIONS, ALL_ROLES, hasPermission, resolveRequiredPermission, type Role } from '../web/rbac.js'
import {
  PAGE_PERMISSIONS,
  TAB_PERMISSIONS,
  STATUS_BLOCK_PERMISSION,
  applyRbacAttrGating,
  isPageAllowed,
  isTabAllowed,
  permissionForPage,
  setNavRole,
} from '../../web/modules/nav-gate.js'
import { roleHas, ROLE_PERMISSIONS } from '../../web/modules/rbac-client.js'
import { SCREEN_ACCESS_ROWS, SCREEN_ACCESS_GAPS } from '../../web/modules/rbac-screen-access-data.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(__dirname, '../../', rel), 'utf-8')
const INDEX_HTML = read('web/index.html')
const APP_JS = read('web/app.js')

type Method = 'GET' | 'POST'

/** The call each gated page makes when it opens (its loader), taken from its module. */
const PAGE_LOAD_CALLS: Record<string, Array<[Method, string]>> = {
  messages: [['GET', '/api/messages'], ['GET', '/api/messages/threads']],
  skills: [['GET', '/api/skills']],
  ideas: [['GET', '/api/ideas']],
  artifacts: [['GET', '/api/artifacts']],
  tokenUsage: [['GET', '/api/token-usage/summary'], ['GET', '/api/costops/budgets']],
  updates: [['GET', '/api/updates'], ['GET', '/api/updates/status']],
  settings: [['GET', '/api/settings'], ['GET', '/api/autonomy'], ['GET', '/api/model-profiles']],
  backups: [['GET', '/api/backups']],
  connectors: [['GET', '/api/connectors'], ['GET', '/api/mcp-catalog']],
  import: [['GET', '/api/import/sources']],
  federation: [['GET', '/api/federation/status'], ['GET', '/api/federation/peers']],
}

/** Pages that stay open to every role because their loader is permitted for every role. */
const OPEN_PAGE_CALLS: Record<string, Array<[Method, string]>> = {
  overview: [['GET', '/api/overview']],
  tasks: [['GET', '/api/schedules'], ['GET', '/api/schedules/agents']],
  agents: [['GET', '/api/agents']],
  memories: [['GET', '/api/memories']],
  kanban: [['GET', '/api/kanban/cards']],
  workspaceDocs: [['GET', '/api/workspace']],
}

const requiredFor = (m: Method, p: string) => resolveRequiredPermission(m, p) ?? 'admin:all'

describe('gating data agrees with the server endpoint permission table', () => {
  it('every gated page has a load-call list and vice versa', () => {
    expect(Object.keys(PAGE_LOAD_CALLS).sort()).toEqual(Object.keys(PAGE_PERMISSIONS).sort())
  })

  it.each(Object.keys(PAGE_LOAD_CALLS))('%s: a role is let in exactly when the server serves every load call', (page) => {
    for (const role of ALL_ROLES) {
      const serverAllows = PAGE_LOAD_CALLS[page]!.every(([m, p]) => hasPermission(role, requiredFor(m, p) as never))
      expect(isPageAllowed(page, role), `${page} / ${role}`).toBe(serverAllows)
    }
  })

  it.each(Object.keys(OPEN_PAGE_CALLS))('%s stays open: no role is refused by the server for its load calls, and it is not gated', (page) => {
    expect(permissionForPage(page)).toBeNull()
    for (const role of ALL_ROLES) {
      expect(isPageAllowed(page, role)).toBe(true)
      for (const [m, p] of OPEN_PAGE_CALLS[page]!) {
        expect(hasPermission(role, requiredFor(m, p) as never), `${page} ${m} ${p} / ${role}`).toBe(true)
      }
    }
  })

  it('background tasks (the "once" tab) need admin:all on the server and the tab says so', () => {
    expect(requiredFor('GET', '/api/background-tasks')).toBe('admin:all')
    expect(TAB_PERMISSIONS['tasks']!['once']).toBe('admin:all')
    for (const role of ALL_ROLES) expect(isTabAllowed('tasks', 'once', role)).toBe(role === 'admin')
    expect(isTabAllowed('tasks', 'scheduled', 'viewer')).toBe(true)
  })

  it('the fleet export/import (the "migrate" tab) is admin:all on the server and gated', () => {
    expect(requiredFor('GET', '/api/fleet/export')).toBe('admin:all')
    expect(requiredFor('POST', '/api/fleet/import')).toBe('admin:all')
    for (const role of ALL_ROLES) expect(isTabAllowed('import', 'migrate', role)).toBe(role === 'admin')
  })

  it('the Claude-status block (GET /api/status) needs the permission the module says', () => {
    expect(requiredFor('GET', '/api/status')).toBe(STATUS_BLOCK_PERMISSION)
  })

  it('every permission the gating names is a real server permission', () => {
    const named = [...Object.values(PAGE_PERMISSIONS), ...Object.values(TAB_PERMISSIONS).flatMap((t) => Object.values(t)), STATUS_BLOCK_PERMISSION]
    for (const perm of named) expect(ALL_PERMISSIONS as readonly string[]).toContain(perm)
  })

  it('federation: agent keeps it, read_only and viewer lose it', () => {
    expect(isPageAllowed('federation', 'admin')).toBe(true)
    expect(isPageAllowed('federation', 'agent')).toBe(true)
    expect(isPageAllowed('federation', 'read_only')).toBe(false)
    expect(isPageAllowed('federation', 'viewer')).toBe(false)
  })
})

describe('screen-access matrix agrees with the gating', () => {
  it('no gap cell is left: every gated page is "none" for the roles that cannot open it', () => {
    expect([...SCREEN_ACCESS_GAPS]).toEqual([])
    for (const row of SCREEN_ACCESS_ROWS) {
      if (!(row.key in PAGE_PERMISSIONS)) continue
      for (const role of ALL_ROLES) {
        expect(row.roles[role] === 'none', `${row.key} / ${role}`).toBe(!isPageAllowed(row.key, role))
      }
    }
  })

  it('every gated page has a matrix row', () => {
    const keys = SCREEN_ACCESS_ROWS.map((r) => r.key)
    for (const page of Object.keys(PAGE_PERMISSIONS)) expect(keys).toContain(page)
  })
})

describe('roleHas (the synchronous core of can)', () => {
  it('mirrors the role -> permission map', () => {
    for (const role of ALL_ROLES) {
      for (const perm of ALL_PERMISSIONS) expect(roleHas(role, perm), `${role} ${perm}`).toBe(ROLE_PERMISSIONS[role]!.has(perm))
    }
  })

  it('no role (legacy bearer token, not resolved yet) is allowed; an unknown role is refused', () => {
    expect(roleHas(null, 'admin:all')).toBe(true)
    expect(roleHas(undefined, 'admin:all')).toBe(true)
    expect(roleHas('made-up-role', 'memories:read')).toBe(false)
  })
})

// ── fake DOM ────────────────────────────────────────────────────────────────

interface FakeEl {
  hidden: boolean
  attrs: Record<string, string>
  cls: string[]
  children: FakeEl[]
  getAttribute(n: string): string | null
  setAttribute(n: string, v: string): void
  hasAttribute(n: string): boolean
  querySelectorAll(sel: string): FakeEl[]
}

function el(attrs: Record<string, string> = {}, cls: string[] = [], children: FakeEl[] = [], hidden = false): FakeEl {
  const e: FakeEl = {
    hidden, attrs: { ...attrs }, cls, children,
    getAttribute: (n) => (n in e.attrs ? e.attrs[n]! : null),
    setAttribute: (n, v) => { e.attrs[n] = v },
    hasAttribute: (n) => n in e.attrs,
    querySelectorAll(sel: string) {
      const all: FakeEl[] = []
      const walk = (n: FakeEl) => n.children.forEach((c) => { all.push(c); walk(c) })
      walk(e)
      if (sel === '[data-rbac-perm]') return all.filter((x) => 'data-rbac-perm' in x.attrs)
      if (sel === '.sb-group') return all.filter((x) => x.cls.includes('sb-group'))
      if (sel === '.sb-link') return all.filter((x) => x.cls.includes('sb-link'))
      throw new Error('unsupported selector ' + sel)
    },
  }
  return e
}
const link = (perm?: string, hidden = false) => el(perm ? { 'data-rbac-perm': perm } : {}, ['sb-link'], [], hidden)

describe('applyRbacAttrGating', () => {
  it('hides the elements whose permission the role lacks and marks them', () => {
    const open = link(); const admin = link('admin:all'); const fed = link('federation:read')
    const root = el({}, [], [el({}, ['sb-group'], [open, admin, fed])])
    expect(applyRbacAttrGating(root as never, 'viewer')).toBe(2)
    expect([open.hidden, admin.hidden, fed.hidden]).toEqual([false, true, true])
    expect(admin.hasAttribute('data-rbac-hidden')).toBe(true)
    expect(open.hasAttribute('data-rbac-hidden')).toBe(false)
  })

  it('an admin sees everything, and so does a caller with no session role', () => {
    for (const role of ['admin', null]) {
      const a = link('admin:all'); const f = link('federation:read')
      const root = el({}, [], [el({}, ['sb-group'], [a, f])])
      expect(applyRbacAttrGating(root as never, role as never)).toBe(0)
      expect([a.hidden, f.hidden]).toEqual([false, false])
    }
  })

  it('an unknown role is refused everything that is gated, nothing that is not', () => {
    const a = link('admin:all'); const open = link()
    applyRbacAttrGating(el({}, [], [el({}, ['sb-group'], [a, open])]) as never, 'made-up-role')
    expect([a.hidden, open.hidden]).toEqual([true, false])
  })

  it('never unhides: a link hidden by someone else stays hidden for a role that may open it', () => {
    const vaultLike = link('admin:all', true)
    applyRbacAttrGating(el({}, [], [el({}, ['sb-group'], [vaultLike])]) as never, 'admin')
    expect(vaultLike.hidden).toBe(true)
  })

  it('collapses a sidebar group whose links were all gated away', () => {
    const stats = el({}, ['sb-group'], [link('admin:all')])
    const team = el({}, ['sb-group'], [link(), link('admin:all')])
    applyRbacAttrGating(el({}, [], [stats, team]) as never, 'agent')
    expect(stats.hidden).toBe(true)
    expect(team.hidden).toBe(false)
  })

  it('does not collapse a group that was already empty of links for other reasons', () => {
    const g = el({}, ['sb-group'], [link(undefined, true)])
    applyRbacAttrGating(el({}, [], [g]) as never, 'viewer')
    expect(g.hidden).toBe(false)
  })

  it('is idempotent', () => {
    const a = link('admin:all')
    const root = el({}, [], [el({}, ['sb-group'], [a])])
    expect(applyRbacAttrGating(root as never, 'viewer')).toBe(1)
    expect(applyRbacAttrGating(root as never, 'viewer')).toBe(0)
  })
})

describe('router guard (switchPage)', () => {
  let core: typeof import('../../web/modules/app-core.js')
  let landed: string | null

  beforeEach(async () => {
    // i18n.js (imported by app-core) touches window/localStorage at load; switchPage touches document.
    const doc = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, documentElement: { lang: '' } }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    vi.stubGlobal('navigator', { language: 'hu' })
    core = await import('../../web/modules/app-core.js')
    landed = null
    for (const page of [...Object.keys(PAGE_PERMISSIONS), 'overview', 'tasks', 'agents']) {
      core.registerPage(page, { enter: () => { landed = page } })
    }
    core.registerAlias('bgTasks', 'tasks')
    core.registerAlias('migrate', 'import')
    core.setPageGuard(isPageAllowed)
  })

  it('a role without the permission is sent to the overview, for every gated page', () => {
    setNavRole('viewer')
    for (const page of Object.keys(PAGE_PERMISSIONS)) {
      landed = null
      core.switchPage(page)
      expect(landed, page).toBe('overview')
    }
  })

  it('an admin and a caller with no role reach every gated page', () => {
    for (const role of ['admin', null]) {
      setNavRole(role)
      for (const page of Object.keys(PAGE_PERMISSIONS)) {
        core.switchPage(page)
        expect(landed, `${page} / ${role}`).toBe(page)
      }
    }
  })

  it('federation: agent gets in, viewer does not', () => {
    setNavRole('agent'); core.switchPage('federation'); expect(landed).toBe('federation')
    setNavRole('viewer'); core.switchPage('federation'); expect(landed).toBe('overview')
  })

  it('an alias into a gated page is guarded after it resolves (#migrate -> import)', () => {
    setNavRole('viewer'); core.switchPage('migrate'); expect(landed).toBe('overview')
    setNavRole('admin'); core.switchPage('migrate'); expect(landed).toBe('import')
  })

  it('an open page is never redirected, whatever the role', () => {
    setNavRole('viewer')
    for (const page of ['tasks', 'agents', 'overview']) { core.switchPage(page); expect(landed).toBe(page) }
    core.switchPage('bgTasks'); expect(landed).toBe('tasks') // the alias lands on the open page, the tab is guarded in app.js
  })

  it('without a guard nothing is redirected (the guard is what does the work)', () => {
    core.setPageGuard(null as never)
    setNavRole('viewer')
    core.switchPage('settings')
    expect(landed).toBe('settings')
  })
})

describe('wiring contracts', () => {
  it('every gated nav link carries data-rbac-perm with the permission the module names', () => {
    for (const [page, perm] of Object.entries(PAGE_PERMISSIONS)) {
      const tag = INDEX_HTML.match(new RegExp(`<a [^>]*class="sb-link"[^>]*data-page="${page}"[^>]*>`))
      expect(tag, `nav link for ${page}`).not.toBeNull()
      expect(tag![0], page).toContain(`data-rbac-perm="${perm}"`)
    }
  })

  it('no nav link of an open page is gated by attribute', () => {
    for (const page of Object.keys(OPEN_PAGE_CALLS)) {
      const tag = INDEX_HTML.match(new RegExp(`<a [^>]*class="sb-link"[^>]*data-page="${page}"[^>]*>`))
      if (tag) expect(tag[0], page).not.toContain('data-rbac-perm')
    }
  })

  it('every data-rbac-perm value in index.html is a real permission', () => {
    const values = [...INDEX_HTML.matchAll(/data-rbac-perm="([^"]+)"/g)].map((m) => m[1]!)
    expect(values.length).toBeGreaterThanOrEqual(16)
    for (const v of values) expect(ALL_PERMISSIONS as readonly string[]).toContain(v)
  })

  it('the "once" tab button and the four elements of the status block are gated', () => {
    expect(INDEX_HTML).toMatch(/data-tab="once" data-rbac-perm="admin:all"/)
    expect(INDEX_HTML).toMatch(/class="ov-activity-header" style="margin-top:18px;" data-rbac-perm="admin:all"/)
    expect(INDEX_HTML).toMatch(/id="statusOverall" data-rbac-perm="admin:all"/)
    expect(INDEX_HTML).toMatch(/id="statusServices" data-rbac-perm="admin:all"/)
    expect(INDEX_HTML).toMatch(/class="status-incidents" data-rbac-perm="admin:all"/)
  })

  it('app.js installs the guard, runs the gating, and checks the status and tab permissions', () => {
    expect(APP_JS).toMatch(/setPageGuard\(isPageAllowed\)/)
    expect(APP_JS).toMatch(/initNavGating\(\{ currentPage: getCurrentPage, switchPage \}\)/)
    // the status module is only loaded after the permission check
    expect(APP_JS).toMatch(/can\(STATUS_BLOCK_PERMISSION\)\)\) return\s+const m = await lazyLoad\('status-costs'/)
    expect(APP_JS).toMatch(/isTabAllowed\('tasks', targetTab\)\) targetTab = 'scheduled'/)
    expect(APP_JS).toMatch(/isTabAllowed\('import', targetTab\)\) targetTab = 'sources'/)
  })

  it('the 5-minute updates poll and the federation status call are skipped for a role that cannot be served', () => {
    const updates = read('web/modules/updates.js')
    expect(updates).toMatch(/async function pollUpdatesBadge\(\) \{[\s\S]{0,400}if \(!\(await can\('admin:all'\)\)\) return/)
    const agents = read('web/modules/agents.js')
    expect(agents).toMatch(/can\('federation:read'\)\s+\.then\(\(ok\) => \(ok \? fetch\('\/api\/federation\/status'\)/)
  })

  it('the admin-only boot calls (onboarding status, connector banner, network info) are skipped for a role without admin:all', () => {
    for (const p of ['/api/onboarding/status', '/api/connectors-hu/status', '/api/network-info', '/api/models/available']) expect(requiredFor('GET', p), p).toBe('admin:all')
    const onboarding = read('web/modules/onboarding.js')
    expect(onboarding).toMatch(/import \{ can \} from '\.\/rbac-client\.js'/)
    expect(onboarding).toMatch(/async function fetchOnboardingStatus\(\) \{[\s\S]{0,200}if \(!\(await can\('admin:all'\)\)\) return null/)
    expect(APP_JS).toMatch(/can\('admin:all'\)\.then\(\(ok\) => \{ if \(ok\) checkStatus\(\); else banner\.hidden = true \}\)/)
    expect(read('web/modules/agents-detail.js')).toMatch(/export async function loadAvailableModels\(\) \{[\s\S]{0,200}if \(!\(await can\('admin:all'\)\)\) return/)
    expect(read('web/modules/schedules.js')).toMatch(/can\('admin:all'\)\.then\(ok => \(ok \? fetch\('\/api\/network-info'\) : null\)\)/)
  })
})
