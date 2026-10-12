// A legacy `/?token=<token>` link must not push an existing login session aside. A token beats the
// session cookie at the auth gate, so a browser that adopted one could no longer decide a human-only
// approval, however logged in the person is. This runs the real "Dashboard auth bootstrap" block of
// web/app.js in a node vm against a fake window, so the order of events (strip the URL, probe without
// the bearer, hold every /api call until the decision, then adopt or not) is exercised for real, not
// only matched as strings.
import { describe, it, expect, vi } from 'vitest'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enrollUnlessSession, adoptUrlTokenUnlessSession } from '../../web/modules/auth-entry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

// The bootstrap IIFE: from its opening line to the first closing `})()` after it.
const START = APP.indexOf('(() => {\n  const TOKEN_KEY')
const END = APP.indexOf('\n})()', START) + '\n})()'.length
const BOOTSTRAP = APP.slice(START, END)

const KEY = 'marveen-dashboard-token'
const SESSION = { authenticated: true, method: 'session', user: 'person-a', login_available: true }
const TOKEN_ONLY = { authenticated: true, method: 'token', user: null, login_available: true }

interface Call { url: string; authorization: string | null }

function boot(opts: { search: string; hash?: string; stored?: string; probe: () => Promise<any>; gate?: Promise<void> }) {
  const calls: Call[] = []
  const store = new Map<string, string>()
  if (opts.stored) store.set(KEY, opts.stored)
  const replaced: string[] = []
  const originalFetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input)
    const h = init?.headers ? new Headers(init.headers) : null
    calls.push({ url, authorization: h ? h.get('Authorization') : null })
    if (url === '/api/auth/status') {
      if (opts.gate) await opts.gate
      return opts.probe()
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  const window: any = {
    location: { pathname: '/', search: opts.search, hash: opts.hash ?? '', origin: 'http://localhost' },
    history: { replaceState: (_s: unknown, _t: unknown, url: string) => { replaced.push(url) } },
    fetch: originalFetch,
    navigator: {},
  }
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  const ctx = vm.createContext({
    window, localStorage, document: { getElementById: () => null }, alert: () => {}, setTimeout,
    URLSearchParams, Headers, Request, console, enrollUnlessSession, adoptUrlTokenUnlessSession,
  })
  vm.runInContext(BOOTSTRAP, ctx)
  return { window, calls, store, replaced }
}

const answer = (body: unknown) => async () => ({ ok: true, json: async () => body })

describe('bootstrap: ?token= link', () => {
  it('extracts the bootstrap block it runs (guards the slice itself)', () => {
    expect(START).toBeGreaterThan(-1)
    expect(BOOTSTRAP).toContain('const TOKEN_KEY')
    expect(BOOTSTRAP).toContain('window.showLoginOverlay = showLoginOverlay')
  })

  it('does NOT adopt the URL token when the browser holds a session: no bearer, nothing stored', async () => {
    const { window, calls, store } = boot({ search: '?token=url-token', probe: answer(SESSION) })
    await window.fetch('/api/approvals')
    const call = calls.find(c => c.url === '/api/approvals')!
    expect(call.authorization).toBeNull()
    expect(store.has(KEY)).toBe(false)
  })

  it('adopts the URL token when the browser holds no session', async () => {
    const { window, calls, store } = boot({ search: '?token=url-token', probe: answer({ authenticated: false, method: null }) })
    await window.fetch('/api/approvals')
    expect(calls.find(c => c.url === '/api/approvals')!.authorization).toBe('Bearer url-token')
    expect(store.get(KEY)).toBe('url-token')
  })

  it('adopts it when the browser is on another token only (not a session)', async () => {
    const { window, calls, store } = boot({ search: '?token=url-token', probe: answer(TOKEN_ONLY) })
    await window.fetch('/api/approvals')
    expect(calls.find(c => c.url === '/api/approvals')!.authorization).toBe('Bearer url-token')
    expect(store.get(KEY)).toBe('url-token')
  })

  it.each([
    ['the probe throws (offline)', async () => { throw new Error('offline') }],
    ['the probe answers an error status', async () => ({ ok: false, json: async () => ({}) })],
    ['the probe answers a body without a method', answer({})],
  ])('adopts it (the old behaviour) when %s', async (_name, probe) => {
    const { window, calls, store } = boot({ search: '?token=url-token', probe })
    await window.fetch('/api/approvals')
    expect(calls.find(c => c.url === '/api/approvals')!.authorization).toBe('Bearer url-token')
    expect(store.get(KEY)).toBe('url-token')
  })

  it('holds every /api call until the decision: a call fired at once does not go out with the old credential', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { window, calls } = boot({ search: '?token=url-token', probe: answer(SESSION), gate })
    const pending = window.fetch('/api/approvals')
    await new Promise(r => setTimeout(r, 20))
    // The probe is out, the page request is not: it waits for the decision.
    expect(calls.map(c => c.url)).toEqual(['/api/auth/status'])
    release()
    await pending
    expect(calls.map(c => c.url)).toEqual(['/api/auth/status', '/api/approvals'])
    expect(calls[1].authorization).toBeNull()
  })

  it('probes without the bearer, so the answer is for the session cookie alone', async () => {
    const { window, calls } = boot({ search: '?token=url-token', probe: answer(SESSION), stored: 'older-token' })
    await window.fetch('/api/approvals')
    expect(calls.find(c => c.url === '/api/auth/status')!.authorization).toBeNull()
  })

  it('strips the token from the visible URL at once, keeping other parameters and the hash, whatever the probe says', () => {
    const a = boot({ search: '?token=url-token&x=1', hash: '#approvals', probe: answer(SESSION) })
    expect(a.replaced).toEqual(['/?x=1#approvals'])
    const b = boot({ search: '?token=url-token', probe: answer(TOKEN_ONLY) })
    expect(b.replaced).toEqual(['/'])
  })

  it('leaves a browser with no token link as it was: stored token used, no probe', async () => {
    const { window, calls } = boot({ search: '', stored: 'stored-token', probe: answer(SESSION) })
    await window.fetch('/api/approvals')
    expect(calls.map(c => c.url)).toEqual(['/api/approvals'])
    expect(calls[0].authorization).toBe('Bearer stored-token')
  })

  it('a non-API call does not wait for or carry the credential', async () => {
    const { window, calls } = boot({ search: '?token=url-token', probe: answer(TOKEN_ONLY) })
    await window.fetch('/lang/en.js')
    expect(calls.find(c => c.url === '/lang/en.js')!.authorization).toBeNull()
  })
})
