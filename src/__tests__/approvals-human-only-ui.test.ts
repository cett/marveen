// The Approvals page for a human-only request. The server decides such a request only for a person logged
// in with a global admin session and answers 403 to every token; the page must say so instead of offering
// a dead button: a badge on the row, a banner with a Sign in button, and approve/reject disabled for a
// viewer who cannot decide it. Part 1 tests the pure decision helpers; part 2 runs the real
// web/modules/approvals.js against a minimal fake DOM so the rendered rows are what is asserted; part 3
// holds the wiring (markup, CSS, i18n) as string contracts, the house idiom for frontend code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isHumanOnlyRow, canDecideHumanOnly, isLockedForViewer, shouldShowHumanOnlyBanner,
} from '../../web/modules/approval-human-only.js'
import { readAllCss } from './css-helper.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(__dirname, '../../web', p), 'utf-8')

const ADMIN_SESSION = { authenticated: true, method: 'session', user: 'person-a', role: 'admin', tenant_id: null }
const TENANT_SESSION = { authenticated: true, method: 'session', user: 'user-b', role: 'admin', tenant_id: 'tenant-a' }
const MEMBER_SESSION = { authenticated: true, method: 'session', user: 'user-b', role: 'member', tenant_id: null }
const TOKEN = { authenticated: true, method: 'token', user: null, role: null, tenant_id: null }
const DEVICE = { authenticated: true, method: 'device', role: null, tenant_id: null }

describe('isHumanOnlyRow', () => {
  it('reads the stored snapshot flag', () => {
    expect(isHumanOnlyRow({ human_only: 1 })).toBe(true)
    expect(isHumanOnlyRow({ human_only: 0 })).toBe(false)
    expect(isHumanOnlyRow({})).toBe(false)
    expect(isHumanOnlyRow({ human_only: null })).toBe(false)
    expect(isHumanOnlyRow(null)).toBe(false)
    expect(isHumanOnlyRow(undefined)).toBe(false)
  })
})

describe('canDecideHumanOnly', () => {
  it('is true only for a global admin password-login session', () => {
    expect(canDecideHumanOnly(ADMIN_SESSION)).toBe(true)
  })

  it.each([
    ['a token', TOKEN],
    ['a device key', DEVICE],
    ['a bearer whose answer carries admin fields (the method decides, not the role)', { authenticated: true, method: 'token', role: 'admin', tenant_id: null }],
    ['a tenant-scoped admin session', TENANT_SESSION],
    ['a non-admin session', MEMBER_SESSION],
    ['an unauthenticated caller', { authenticated: false, method: null, role: null, tenant_id: null }],
    ['an unauthenticated answer that still claims a session', { authenticated: false, method: 'session', role: 'admin', tenant_id: null }],
    ['an answer without tenant_id (not read as global)', { authenticated: true, method: 'session', role: 'admin' }],
    ['an answer without a role', { authenticated: true, method: 'session', tenant_id: null }],
    ['no answer (the probe failed)', null],
    ['an undefined answer', undefined],
  ])('is false for %s', (_name, status) => {
    expect(canDecideHumanOnly(status as any)).toBe(false)
  })
})

describe('isLockedForViewer and the banner rule', () => {
  const pendingHo = { id: 'a1', status: 'pending', human_only: 1 }
  const pendingPlain = { id: 'a2', status: 'pending', human_only: 0 }
  const doneHo = { id: 'a3', status: 'approved', human_only: 1 }

  it('locks a pending human-only row for everyone but the global admin session', () => {
    expect(isLockedForViewer(pendingHo, TOKEN)).toBe(true)
    expect(isLockedForViewer(pendingHo, TENANT_SESSION)).toBe(true)
    expect(isLockedForViewer(pendingHo, null)).toBe(true)
    expect(isLockedForViewer(pendingHo, ADMIN_SESSION)).toBe(false)
  })

  it('never locks a plain row, and never a resolved one (nothing left to decide)', () => {
    expect(isLockedForViewer(pendingPlain, TOKEN)).toBe(false)
    expect(isLockedForViewer(doneHo, TOKEN)).toBe(false)
    expect(isLockedForViewer(null, TOKEN)).toBe(false)
  })

  it('shows the banner only when a pending human-only row is locked for this viewer', () => {
    expect(shouldShowHumanOnlyBanner([pendingPlain, pendingHo], TOKEN)).toBe(true)
    expect(shouldShowHumanOnlyBanner([pendingPlain, pendingHo], ADMIN_SESSION)).toBe(false)
    expect(shouldShowHumanOnlyBanner([pendingPlain, doneHo], TOKEN)).toBe(false)
    expect(shouldShowHumanOnlyBanner([], TOKEN)).toBe(false)
    expect(shouldShowHumanOnlyBanner(null as any, TOKEN)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------
// The real approvals.js in a fake DOM.

interface FakeEl { innerHTML: string; textContent: string; hidden: boolean; listeners: Record<string, Array<() => void>>; addEventListener(t: string, cb: () => void): void; querySelectorAll(): never[]; querySelector(): null }
function fakeEl(): FakeEl {
  const el: FakeEl = {
    innerHTML: '', textContent: '', hidden: true, listeners: {},
    addEventListener(t, cb) { (el.listeners[t] ||= []).push(cb) },
    querySelectorAll: () => [], querySelector: () => null,
  }
  return el
}

const ROWS = [
  { id: 'h1', agent_id: 'agent-a', category: 'email_send', action_description: 'send a mail', status: 'pending', human_only: 1, requested_at: 1, timeout_at: null },
  { id: 'p1', agent_id: 'agent-b', category: 'deploy', action_description: 'ship it', status: 'pending', human_only: 0, requested_at: 2, timeout_at: null },
  { id: 'h2', agent_id: 'agent-a', category: 'email_send', action_description: 'old mail', status: 'approved', human_only: 1, requested_at: 3, timeout_at: null, resolved_by: 'human:session:person-a', resolved_at: 4 },
]

async function renderFor(viewer: unknown | 'fail', rows = ROWS) {
  const els: Record<string, FakeEl> = {}
  const get = (id: string) => (els[id] ||= fakeEl())
  const win: any = { _i18n: {}, _brandTokens: {} }
  // Real English strings, so the assertions read what a person would see.
  vm.runInNewContext(read('lang/en.js'), { window: win })
  const showLoginOverlay = vi.fn()
  win.showLoginOverlay = showLoginOverlay
  vi.stubGlobal('window', win)
  vi.stubGlobal('localStorage', { getItem: () => null })
  vi.stubGlobal('document', { addEventListener: () => {}, getElementById: get, querySelectorAll: () => [] })
  vi.stubGlobal('setInterval', () => 0)
  vi.stubGlobal('clearInterval', () => {})
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.startsWith('/api/approvals')) {
      return { ok: true, json: async () => ({ items: rows, total: rows.length, counts: { pending: 2, approved: 1, rejected: 0, timeout: 0 }, oldest_pending: null }) }
    }
    if (url === '/api/auth/status') {
      if (viewer === 'fail') throw new Error('offline')
      return { ok: true, json: async () => viewer }
    }
    return { ok: false, json: async () => ({}) }
  })
  vi.resetModules()
  // @ts-expect-error -- plain browser module without a .d.ts (only its pure helpers have one)
  const mod = await import('../../web/modules/approvals.js')
  await mod.loadApprovalsPage()
  await mod.initApprovals()
  return { els, tbody: get('approvalsTbody').innerHTML, banner: get('approvalsHumanOnlyBanner'), showLoginOverlay }
}

/** The <tr> of one row, cut out of the rendered tbody. */
function rowHtml(tbody: string, id: string): string {
  const start = tbody.indexOf(`data-approval-id="${id}"`)
  expect(start).toBeGreaterThan(-1)
  const end = tbody.indexOf('</tr>', start)
  return tbody.slice(start, end)
}
const decideButtons = (row: string) => row.match(/<button class="btn approvals-decide"[^>]*>/g) ?? []

describe('approvals.js rendering', () => {
  beforeEach(() => { vi.useRealTimers() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('a token viewer: the human-only row is badged and its buttons are disabled, with the banner up', async () => {
    const { tbody, banner } = await renderFor(TOKEN)
    const row = rowHtml(tbody, 'h1')
    expect(row).toContain('approvals-humanonly-badge')
    expect(row).toContain('Human only')
    const buttons = decideButtons(row)
    expect(buttons).toHaveLength(2)
    for (const b of buttons) {
      expect(b).toMatch(/\sdisabled\b/)
      expect(b).toContain('title="Can only be decided from a password login"')
    }
    expect(banner.hidden).toBe(false)
  })

  it('leaves a plain pending row exactly as before: no badge, enabled buttons', async () => {
    const { tbody } = await renderFor(TOKEN)
    const row = rowHtml(tbody, 'p1')
    expect(row).not.toContain('approvals-humanonly-badge')
    const buttons = decideButtons(row)
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b).not.toMatch(/\sdisabled\b/)
  })

  it('a global admin session sees the buttons as before, still sees the badge, and no banner', async () => {
    const { tbody, banner } = await renderFor(ADMIN_SESSION)
    const row = rowHtml(tbody, 'h1')
    expect(row).toContain('approvals-humanonly-badge')
    for (const b of decideButtons(row)) expect(b).not.toMatch(/\sdisabled\b/)
    expect(banner.hidden).toBe(true)
  })

  it.each([
    ['a tenant-scoped admin session', TENANT_SESSION],
    ['a non-admin session', MEMBER_SESSION],
    ['a device key', DEVICE],
    ['an unknown viewer (the status probe failed)', 'fail'],
  ])('%s cannot decide it either: disabled buttons and the banner', async (_name, viewer) => {
    const { tbody, banner } = await renderFor(viewer)
    for (const b of decideButtons(rowHtml(tbody, 'h1'))) expect(b).toMatch(/\sdisabled\b/)
    expect(banner.hidden).toBe(false)
  })

  it('a resolved human-only row carries the badge but has nothing to lock, and alone it raises no banner', async () => {
    const { tbody, banner } = await renderFor(TOKEN, [ROWS[2]])
    const row = rowHtml(tbody, 'h2')
    expect(row).toContain('approvals-humanonly-badge')
    expect(decideButtons(row)).toHaveLength(0)
    expect(banner.hidden).toBe(true)
  })

  it('no banner when no human-only request is pending', async () => {
    const { banner } = await renderFor(TOKEN, [ROWS[1]])
    expect(banner.hidden).toBe(true)
  })

  it('the Sign in button opens the login overlay', async () => {
    const { els, showLoginOverlay } = await renderFor(TOKEN)
    const click = els['approvalsSignInBtn'].listeners['click']
    expect(click).toHaveLength(1)
    click[0]()
    expect(showLoginOverlay).toHaveBeenCalledTimes(1)
  })

  it('the badge text is escaped, not injected', async () => {
    // The category is user data; the badge sits next to it in the same cell.
    const evil = [{ ...ROWS[0], category: '<img src=x onerror=1>' }]
    const { tbody } = await renderFor(TOKEN, evil)
    expect(tbody).not.toContain('<img src=x')
    expect(tbody).toContain('&lt;img src=x')
  })
})

describe('wiring contracts', () => {
  const HTML = read('index.html')
  const MOD = read('modules/approvals.js')
  const CSS = readAllCss()

  it('the page asks who the viewer is with the credential a decision carries (the patched fetch)', () => {
    expect(MOD).toMatch(/import \{[^}]*isLockedForViewer[^}]*\} from '\.\/approval-human-only\.js'/)
    expect(MOD).toContain("fetch('/api/auth/status')")
    // The decision itself is untouched: the server stays the gate.
    expect(MOD).toContain("method: 'PATCH'")
  })

  it('the banner and its Sign in button are in the markup, hidden by default', () => {
    expect(HTML).toMatch(/id="approvalsHumanOnlyBanner"[^>]*\bhidden\b/)
    expect(HTML).toContain('id="approvalsSignInBtn"')
    expect(HTML).toContain('data-i18n="approvals.humanonly.banner"')
    expect(HTML).toContain('data-i18n="approvals.humanonly.signin"')
  })

  it('both languages carry every human-only text, and the CSS styles the banner and the badge', () => {
    for (const lang of ['en', 'hu']) {
      const src = read(`lang/${lang}.js`)
      for (const k of ['badge', 'badge_title', 'banner', 'signin', 'locked']) {
        expect(src).toContain(`'approvals.humanonly.${k}'`)
      }
    }
    expect(CSS).toContain('.approvals-humanonly-badge')
    expect(CSS).toContain('.approvals-humanonly-banner[hidden]')
  })
})
