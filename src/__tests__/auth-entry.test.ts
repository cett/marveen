// The browser side of "a human-only approval is decided in a login session, not with a token": the
// Sign in entry that stays visible while the browser is on a token, and the rule that an enrollment
// link does not push an existing session aside. The decisions are pure functions run here in node;
// the wiring (app.js, profile.js, index.html) is held by string contracts, the house idiom for
// frontend code that has no browser test.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  holdsSession, shouldOfferSignIn, enrollUnlessSession, adoptUrlTokenUnlessSession, applySignInEntry, type SignInEntryDoc,
} from '../../web/modules/auth-entry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(__dirname, '../../web', p), 'utf-8')

const SESSION = { authenticated: true, method: 'session', user: 'person-a', login_available: true }
const TOKEN = { authenticated: true, method: 'token', user: null, login_available: true }

describe('holdsSession', () => {
  it('is true only for a logged-in person', () => {
    expect(holdsSession(SESSION)).toBe(true)
    expect(holdsSession(TOKEN)).toBe(false)
    expect(holdsSession({ authenticated: true, method: 'device' })).toBe(false)
    expect(holdsSession({ authenticated: false, method: null })).toBe(false)
    expect(holdsSession(null)).toBe(false)
    expect(holdsSession(undefined)).toBe(false)
  })

  it('does not read a session claim off an unauthenticated answer', () => {
    expect(holdsSession({ authenticated: false, method: 'session' })).toBe(false)
  })
})

describe('shouldOfferSignIn', () => {
  it('offers the entry on a token when a password login exists', () => {
    expect(shouldOfferSignIn(TOKEN)).toBe(true)
  })

  it.each([
    ['a session already', SESSION],
    ['a device key', { authenticated: true, method: 'device', login_available: true }],
    ['a token but no login to switch to', { ...TOKEN, login_available: false }],
    ['an unauthenticated caller (the login overlay covers that)', { authenticated: false, method: null, login_available: true }],
    ['no answer', null],
  ])('does not offer it for %s', (_name, status) => {
    expect(shouldOfferSignIn(status as any)).toBe(false)
  })
})

describe('enrollUnlessSession', () => {
  const setup = (probe: () => Promise<any>, token = 'tok-new') => {
    const probeStatus = vi.fn(probe)
    const exchange = vi.fn(async (_code: string) => token)
    return { probeStatus, exchange }
  }

  it('trades the code for a token when the browser holds no session', async () => {
    const { probeStatus, exchange } = setup(async () => ({ authenticated: false, method: null }))
    expect(await enrollUnlessSession({ code: 'c1', probeStatus, exchange })).toBe('tok-new')
    expect(exchange).toHaveBeenCalledWith('c1')
  })

  it('trades it when the browser is on a token only', async () => {
    const { probeStatus, exchange } = setup(async () => TOKEN)
    expect(await enrollUnlessSession({ code: 'c1', probeStatus, exchange })).toBe('tok-new')
  })

  it('does NOT trade it when the browser holds a session: the new token would beat the cookie', async () => {
    const { probeStatus, exchange } = setup(async () => SESSION)
    expect(await enrollUnlessSession({ code: 'c1', probeStatus, exchange })).toBe('')
    expect(exchange).not.toHaveBeenCalled()
  })

  it('trades it when the probe fails or answers nothing (the way it worked before the probe)', async () => {
    for (const probe of [async () => { throw new Error('offline') }, async () => null]) {
      const { probeStatus, exchange } = setup(probe)
      expect(await enrollUnlessSession({ code: 'c1', probeStatus, exchange })).toBe('tok-new')
    }
  })

  it('does nothing without a code, and asks nothing', async () => {
    for (const code of ['', null, undefined]) {
      const { probeStatus, exchange } = setup(async () => TOKEN)
      expect(await enrollUnlessSession({ code, probeStatus, exchange })).toBe('')
      expect(probeStatus).not.toHaveBeenCalled()
      expect(exchange).not.toHaveBeenCalled()
    }
  })

  it('passes on an exchange that gave nothing (a spent code)', async () => {
    const { probeStatus } = setup(async () => TOKEN)
    const exchange = vi.fn(async () => '')
    expect(await enrollUnlessSession({ code: 'c1', probeStatus, exchange })).toBe('')
  })
})

describe('adoptUrlTokenUnlessSession', () => {
  const probe = (p: () => Promise<any>) => vi.fn(p)

  it('hands back the link token when the browser holds no session or only a token', async () => {
    for (const status of [{ authenticated: false, method: null }, TOKEN, { authenticated: true, method: 'device' }]) {
      expect(await adoptUrlTokenUnlessSession({ token: 'url-token', probeStatus: probe(async () => status) })).toBe('url-token')
    }
  })

  it('does NOT adopt it when the browser holds a session: the token would beat the cookie', async () => {
    const probeStatus = probe(async () => SESSION)
    expect(await adoptUrlTokenUnlessSession({ token: 'url-token', probeStatus })).toBe('')
    expect(probeStatus).toHaveBeenCalledTimes(1)
  })

  it('adopts it when the probe fails or answers nothing (the way it worked before the probe)', async () => {
    for (const p of [async () => { throw new Error('offline') }, async () => null]) {
      expect(await adoptUrlTokenUnlessSession({ token: 'url-token', probeStatus: probe(p) })).toBe('url-token')
    }
  })

  it('does nothing without a token, and asks nothing', async () => {
    for (const token of ['', null, undefined]) {
      const probeStatus = probe(async () => SESSION)
      expect(await adoptUrlTokenUnlessSession({ token, probeStatus })).toBe('')
      expect(probeStatus).not.toHaveBeenCalled()
    }
  })
})

describe('applySignInEntry', () => {
  function fakeDoc() {
    const listeners: Array<(e: { preventDefault(): void }) => void> = []
    const el = {
      hidden: true,
      dataset: {} as Record<string, string | undefined>,
      addEventListener(_type: string, cb: (e: { preventDefault(): void }) => void) { listeners.push(cb) },
    }
    const doc: SignInEntryDoc = { getElementById: (id: string) => (id === 'navSignIn' ? el : null) }
    return { doc, el, click: () => { const e = { preventDefault: vi.fn() }; listeners.forEach(l => l(e)); return e } }
  }

  it('shows the entry on a token and hides it once there is a session', () => {
    const { doc, el } = fakeDoc()
    applySignInEntry(TOKEN, doc, () => {})
    expect(el.hidden).toBe(false)
    applySignInEntry(SESSION, doc, () => {})
    expect(el.hidden).toBe(true)
  })

  it('opens the login on click, once per click even when applied again, and swallows the link default', () => {
    const { doc, click } = fakeDoc()
    const open = vi.fn()
    applySignInEntry(TOKEN, doc, open)
    applySignInEntry(TOKEN, doc, open)
    const e = click()
    expect(open).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('stays hidden for a status it cannot read, and tolerates a page without the entry', () => {
    const { doc, el } = fakeDoc()
    applySignInEntry(null, doc, () => {})
    expect(el.hidden).toBe(true)
    expect(() => applySignInEntry(TOKEN, { getElementById: () => null }, () => {})).not.toThrow()
  })
})

describe('wiring contracts', () => {
  const APP = read('app.js')
  const PROFILE = read('modules/profile.js')
  const HTML = read('index.html')

  it('the enrollment exchange in app.js goes through the session check, with a bearer-less probe', () => {
    expect(APP).toMatch(/import \{ enrollUnlessSession, adoptUrlTokenUnlessSession \} from '\.\/modules\/auth-entry\.js'/)
    expect(APP).toMatch(/enrollUnlessSession\(\{[\s\S]*?code: urlEnroll[\s\S]*?\}\)/)
    // The probe is one shared function that must not carry the bearer: originalFetch, not the patched window.fetch.
    expect(APP).toMatch(/async function probeCookieStatus\(\) \{\s*const r = await originalFetch\('\/api\/auth\/status'\)/)
    expect(APP).toMatch(/probeStatus: probeCookieStatus,\s*exchange: enrollWithCode/)
    // The old direct call is gone: nothing trades the URL code without the check.
    expect(APP).not.toMatch(/enrollPromise = enrollWithCode\(/)
  })

  it('the ?token= link in app.js goes through the session check and every /api call waits for it', () => {
    expect(APP).toMatch(/adoptUrlTokenUnlessSession\(\{ token: urlToken, probeStatus: probeCookieStatus \}\)/)
    // No synchronous adoption of the URL token any more.
    expect(APP).not.toMatch(/let sessionToken = urlToken/)
    expect(APP).not.toMatch(/localStorage\.setItem\(TOKEN_KEY, urlToken\)/)
    expect(APP).toMatch(/if \(urlTokenPromise\) await urlTokenPromise/)
  })

  it('the sidebar entry is hidden by default, a button, and labelled', () => {
    expect(HTML).toMatch(/<button[^>]*class="sb-signin"[^>]*id="navSignIn"[^>]*\bhidden\b/)
    expect(HTML).toContain('data-i18n="auth.entry.signin"')
    expect(HTML).toContain('data-i18n-title="auth.entry.title"')
  })

  it('profile.js applies the entry from the status answer before it returns for a non-session caller', () => {
    const apply = PROFILE.indexOf('applySignInEntry(status)')
    const early = PROFILE.indexOf("if (status.method !== 'session'")
    expect(apply).toBeGreaterThan(-1)
    expect(early).toBeGreaterThan(apply)
    expect(PROFILE).toMatch(/import \{ applySignInEntry \} from '\.\/auth-entry\.js'/)
  })

  it('the entry opens the same login overlay the 401 handler uses', () => {
    expect(APP).toContain('window.showLoginOverlay = showLoginOverlay')
    expect(read('modules/auth-entry.js')).toContain('window.showLoginOverlay?.()')
  })

  it('both languages carry the entry texts', () => {
    for (const lang of ['en', 'hu']) {
      const src = read(`lang/${lang}.js`)
      expect(src).toContain("'auth.entry.signin'")
      expect(src).toContain("'auth.entry.title'")
    }
  })
})
