import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { STORE_DIR } from '../config.js'
import { FLEET_OAUTH_TOKEN_PATH } from '../web/agent-process.js'

// The guard reads HOME (~/.claude) and STORE_DIR at module-eval time via
// config/os, so we drive it through a temp HOME + a controllable env flag and
// only assert the PURE, side-effect-scoped behaviour we can isolate:
// looksLikeSetupToken (structural), the enabled flag, and the platform gate.
import { looksLikeSetupToken, credentialsGuardEnabled } from '../web/claude-credentials-guard.js'

// Boundary mocks for the token-lifecycle functions below: they shell out to
// `claude -p` (execFileSync/execFile) and touch the fleet-token + verified-
// stamp files (readFileSync/writeFileSync/existsSync/renameSync). Default
// implementation calls straight through to the real fn, so module-load-time
// fs/child_process use elsewhere in the import graph (config.js etc.) is
// unaffected; individual tests override with a single mockImplementationOnce
// per expected call so nothing bleeds into the next test.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), execFile: vi.fn(actual.execFile) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    existsSync: vi.fn(actual.existsSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  }
})

const HOME_CREDENTIALS = join(homedir(), '.claude', '.credentials.json')
const VERIFIED_STAMP = join(STORE_DIR, '.claude-oauth-token.verified')
const OAT = 'sk-ant-oat01-' + 'A'.repeat(80)
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex')

function mockFleetTokenMissing() {
  vi.mocked(readFileSync).mockImplementationOnce(((p: unknown) => {
    if (String(p) === FLEET_OAUTH_TOKEN_PATH) { const e: NodeJS.ErrnoException = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    throw new Error(`unexpected readFileSync in test: ${String(p)}`)
  }) as unknown as typeof readFileSync)
}
function mockFleetToken(token: string) {
  vi.mocked(readFileSync).mockImplementationOnce(((p: unknown) => {
    if (String(p) === FLEET_OAUTH_TOKEN_PATH) return token
    throw new Error(`unexpected readFileSync in test: ${String(p)}`)
  }) as unknown as typeof readFileSync)
}
function mockVerifiedHash(hash: string | null) {
  vi.mocked(readFileSync).mockImplementationOnce(((p: unknown) => {
    if (String(p) === VERIFIED_STAMP) {
      if (hash == null) { const e: NodeJS.ErrnoException = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return hash
    }
    throw new Error(`unexpected readFileSync in test: ${String(p)}`)
  }) as unknown as typeof readFileSync)
}

describe('looksLikeSetupToken', () => {
  it('accepts a well-formed setup-token', () => {
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(80))).toBe(true)
  })
  it('rejects a truncated token (the ~80-byte failure mode)', () => {
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(10))).toBe(false)
  })
  it('rejects the wrong prefix (e.g. a credentials JSON blob or api key)', () => {
    expect(looksLikeSetupToken('sk-ant-api03-' + 'A'.repeat(80))).toBe(false)
    expect(looksLikeSetupToken('{"claudeAiOauth":{}}')).toBe(false)
    expect(looksLikeSetupToken('')).toBe(false)
  })
  it('rejects a token with a stray newline / whitespace', () => {
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(80) + '\n')).toBe(false)
    expect(looksLikeSetupToken('  sk-ant-oat01-' + 'A'.repeat(80))).toBe(false)
  })
})

describe('credentialsGuardEnabled', () => {
  const prev = process.env['CLAUDE_CREDENTIALS_GUARD']
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAUDE_CREDENTIALS_GUARD']
    else process.env['CLAUDE_CREDENTIALS_GUARD'] = prev
  })
  it('is OFF by default (flag unset)', () => {
    delete process.env['CLAUDE_CREDENTIALS_GUARD']
    expect(credentialsGuardEnabled()).toBe(false)
  })
  it('is OFF for any value other than exactly "1"', () => {
    process.env['CLAUDE_CREDENTIALS_GUARD'] = 'true'
    expect(credentialsGuardEnabled()).toBe(false)
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '0'
    expect(credentialsGuardEnabled()).toBe(false)
  })
  it('is ON only for "1"', () => {
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '1'
    expect(credentialsGuardEnabled()).toBe(true)
  })
})

describe('renameSharedCredentialsIfSafe (flag/platform gates, no fs mutation)', () => {
  const prev = process.env['CLAUDE_CREDENTIALS_GUARD']
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAUDE_CREDENTIALS_GUARD']
    else process.env['CLAUDE_CREDENTIALS_GUARD'] = prev
    vi.resetModules()
  })

  it('returns "disabled" and never touches fs when the flag is off', async () => {
    delete process.env['CLAUDE_CREDENTIALS_GUARD']
    const { renameSharedCredentialsIfSafe } = await import('../web/claude-credentials-guard.js')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('disabled')
  })

  it('returns "not-linux" on macOS even with the flag on (never renames)', async () => {
    // PLATFORM resolves from process.platform at import; on the CI/dev mac this
    // is 'macos'. Guard the assertion to the host so the test is deterministic.
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '1'
    const { renameSharedCredentialsIfSafe } = await import('../web/claude-credentials-guard.js')
    const r = renameSharedCredentialsIfSafe('/nonexistent/claude')
    if (process.platform === 'darwin') {
      expect(r).toBe('not-linux')
    } else {
      // On Linux CI: no fleet token / no credentials.json in the test HOME, so
      // it must resolve to a SAFE non-renaming outcome, never 'renamed'.
      expect(['no-credentials', 'already-renamed', 'token-invalid']).toContain(r)
    }
  })
})

// 2026-07-16 review blocker 1: the sk-ant-oat01 prefix ALONE does not
// discriminate a long-lived setup-token from a rotating browser-login access
// token (both can carry it). Promotion must be longevity-gated, or the boot
// sync would flip healthy rotating-login installs into env-token mode and
// self-inflict the bootcamp incident when the token rotates.
describe('isPromotableSetupCredential', () => {
  const NOW = 1_784_000_000_000
  const DAY = 24 * 60 * 60 * 1000
  const oat = 'sk-ant-oat01-' + 'A'.repeat(80)

  it('promotes the bootcamp shape: oat01 + ~1-year expiry (refreshToken presence is irrelevant)', async () => {
    const { isPromotableSetupCredential } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 365 * DAY }, NOW)).toBe(true)
  })

  it('REJECTS a rotating-family oat01 with short expiry (hours/days)', async () => {
    const { isPromotableSetupCredential } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 8 * 60 * 60 * 1000 }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 30 * DAY }, NOW)).toBe(false)
  })

  it('rejects at exactly the boundary minus one, accepts at the 90-day boundary', async () => {
    const { isPromotableSetupCredential, MIN_PROMOTABLE_LIFETIME_MS } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + MIN_PROMOTABLE_LIFETIME_MS }, NOW)).toBe(true)
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + MIN_PROMOTABLE_LIFETIME_MS - 1 }, NOW)).toBe(false)
  })

  it('rejects a non-setup-token prefix and a missing/absent expiresAt (conservative)', async () => {
    const { isPromotableSetupCredential } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: 'sk-ant-sid01-' + 'A'.repeat(80), expiresAt: NOW + 365 * DAY }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({ accessToken: oat }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({}, NOW)).toBe(false)
  })
})

// 2026-07-16 live-verify FAIL on the reference VPS: `claude auth status` exits
// 0 for a garbage token (it reports the auth SOURCE, it does not validate).
// The real validator is a `claude -p` probe; this classifier turns its outcome
// into ok / auth-rejected / inconclusive so callers never treat a network
// flake as a dead credential.
describe('classifyAuthProbe', () => {
  it('ok: ran clean and answered OK', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: false, output: 'OK' })).toBe('ok')
  })

  it('auth-rejected: the live bug-3 signature (401 Invalid bearer token)', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({
      ran: true, exitedNonZero: true,
      output: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
    })).toBe('auth-rejected')
  })

  it('auth-rejected: invalid API key variant', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: true, output: 'Invalid API key' })).toBe('auth-rejected')
  })

  it('inconclusive: nonzero exit WITHOUT an auth signature (network flake) must not kill a credential', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: true, output: 'fetch failed: ETIMEDOUT' })).toBe('inconclusive')
  })

  it('inconclusive: the probe never ran (binary missing)', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: false, exitedNonZero: true, output: '' })).toBe('inconclusive')
  })

  it('inconclusive: clean exit with an unexpected answer (no OK)', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: false, output: 'I cannot comply' })).toBe('inconclusive')
  })
})

// liveTestToken runs the runbook step-5 probe synchronously (execFileSync).
// The isolated tmpdir + rmSync cleanup are real (harmless side effects); only
// the `claude` invocation itself is mocked so no real binary is shelled out.
describe('liveTestToken', () => {
  it('true on a clean "OK" answer', async () => {
    const { liveTestToken } = await import('../web/claude-credentials-guard.js')
    vi.mocked(execFileSync).mockImplementationOnce((() => 'OK\n') as unknown as typeof execFileSync)
    expect(liveTestToken(OAT, '/usr/local/bin/claude')).toBe(true)
  })

  it('false on an answer without OK', async () => {
    const { liveTestToken } = await import('../web/claude-credentials-guard.js')
    vi.mocked(execFileSync).mockImplementationOnce((() => 'I cannot comply') as unknown as typeof execFileSync)
    expect(liveTestToken(OAT, '/usr/local/bin/claude')).toBe(false)
  })

  it('false when the probe throws (timeout / missing binary)', async () => {
    const { liveTestToken } = await import('../web/claude-credentials-guard.js')
    vi.mocked(execFileSync).mockImplementationOnce((() => { throw new Error('ETIMEDOUT') }) as unknown as typeof execFileSync)
    expect(liveTestToken(OAT, '/usr/local/bin/claude')).toBe(false)
  })
})

// liveProbeAuth is the async twin: callback-style execFile, isolated config
// dir, and it must strip any inherited auth env before applying envOverride
// (a stale CLAUDE_CODE_OAUTH_TOKEN in process.env must never leak into the
// probe -- that would test the wrong credential).
describe('liveProbeAuth', () => {
  it('ok on a clean OK answer', async () => {
    const { liveProbeAuth } = await import('../web/claude-credentials-guard.js')
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(null, 'OK\n', '')
    }) as unknown as typeof execFile)
    expect(await liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: OAT }, '/usr/local/bin/claude')).toBe('ok')
  })

  it('auth-rejected on a 401 signature', async () => {
    const { liveProbeAuth } = await import('../web/claude-credentials-guard.js')
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(new Error('exit 1'), '', 'Invalid bearer token')
    }) as unknown as typeof execFile)
    expect(await liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'dead' }, '/usr/local/bin/claude')).toBe('auth-rejected')
  })

  it('inconclusive when the binary is missing (ENOENT)', async () => {
    const { liveProbeAuth } = await import('../web/claude-credentials-guard.js')
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: NodeJS.ErrnoException, stdout: string, stderr: string) => void) => {
      const e = new Error('spawn ENOENT') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      cb(e, '', '')
    }) as unknown as typeof execFile)
    expect(await liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: OAT }, '/nonexistent/claude')).toBe('inconclusive')
  })

  it('strips an inherited CLAUDE_CODE_OAUTH_TOKEN so only envOverride is tested', async () => {
    const { liveProbeAuth } = await import('../web/claude-credentials-guard.js')
    const prev = process.env['CLAUDE_CODE_OAUTH_TOKEN']
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'stale-inherited-token'
    try {
      vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, opts: { env: Record<string, string> }, cb: (err: unknown, stdout: string, stderr: string) => void) => {
        expect(opts.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fresh-token')
        cb(null, 'OK', '')
      }) as unknown as typeof execFile)
      expect(await liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'fresh-token' }, '/usr/local/bin/claude')).toBe('ok')
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
      else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = prev
    }
  })
})

// syncFleetTokenFromSharedCredentials backfills store/.claude-oauth-token from
// a terminal-pasted `claude setup-token` result that only landed in the shared
// ~/.claude/.credentials.json (2026-07-15 bootcamp gap).
describe('syncFleetTokenFromSharedCredentials', () => {
  it('short-circuits when a fleet token file already exists', async () => {
    const { syncFleetTokenFromSharedCredentials } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    expect(await syncFleetTokenFromSharedCredentials()).toBe('fleet-token-present')
  })

  it('no-credentials when neither the fleet token nor the shared file exist', async () => {
    const { syncFleetTokenFromSharedCredentials } = await import('../web/claude-credentials-guard.js')
    mockFleetTokenMissing()
    vi.mocked(readFileSync).mockImplementationOnce((() => { throw new Error('ENOENT') }) as unknown as typeof readFileSync)
    expect(await syncFleetTokenFromSharedCredentials()).toBe('no-credentials')
  })

  it('not-setup-token when the shared credential is a short-lived rotating token', async () => {
    const { syncFleetTokenFromSharedCredentials } = await import('../web/claude-credentials-guard.js')
    mockFleetTokenMissing()
    vi.mocked(readFileSync).mockImplementationOnce((() =>
      JSON.stringify({ claudeAiOauth: { accessToken: OAT, expiresAt: Date.now() + 8 * 60 * 60 * 1000 } })
    ) as unknown as typeof readFileSync)
    expect(await syncFleetTokenFromSharedCredentials()).toBe('not-setup-token')
  })

  it('live-test-failed when a promotable credential fails the live probe', async () => {
    const { syncFleetTokenFromSharedCredentials } = await import('../web/claude-credentials-guard.js')
    mockFleetTokenMissing()
    vi.mocked(readFileSync).mockImplementationOnce((() =>
      JSON.stringify({ claudeAiOauth: { accessToken: OAT, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 } })
    ) as unknown as typeof readFileSync)
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(new Error('exit 1'), '', 'Invalid bearer token')
    }) as unknown as typeof execFile)
    expect(await syncFleetTokenFromSharedCredentials()).toBe('live-test-failed')
  })

  it('synced: promotes a live-verified long-lived credential to the fleet token file', async () => {
    const { syncFleetTokenFromSharedCredentials } = await import('../web/claude-credentials-guard.js')
    mockFleetTokenMissing()
    vi.mocked(readFileSync).mockImplementationOnce((() =>
      JSON.stringify({ claudeAiOauth: { accessToken: OAT, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 } })
    ) as unknown as typeof readFileSync)
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(null, 'OK', '')
    }) as unknown as typeof execFile)
    vi.mocked(writeFileSync).mockImplementationOnce((() => undefined) as unknown as typeof writeFileSync)
    vi.mocked(writeFileSync).mockImplementationOnce((() => undefined) as unknown as typeof writeFileSync)
    expect(await syncFleetTokenFromSharedCredentials()).toBe('synced')
    expect(vi.mocked(writeFileSync).mock.calls[0][0]).toBe(FLEET_OAUTH_TOKEN_PATH)
    expect(vi.mocked(writeFileSync).mock.calls[0][1]).toBe(OAT)
  })
})

// quarantineFleetToken demotes a fleet token proven dead so newly launched
// agents fall back to shared-file auth instead of re-injecting a 401 forever.
describe('quarantineFleetToken', () => {
  it('returns false (no-op) when there is no fleet token file to quarantine', async () => {
    const { quarantineFleetToken } = await import('../web/claude-credentials-guard.js')
    vi.mocked(existsSync).mockImplementationOnce((() => false) as unknown as typeof existsSync)
    expect(quarantineFleetToken('test')).toBe(false)
  })

  it('renames the token file to .bad and returns true', async () => {
    const { quarantineFleetToken } = await import('../web/claude-credentials-guard.js')
    vi.mocked(existsSync).mockImplementationOnce((() => true) as unknown as typeof existsSync)
    vi.mocked(rmSync).mockImplementationOnce((() => undefined) as unknown as typeof rmSync)
    const renamed: [unknown, unknown][] = []
    vi.mocked(renameSync).mockImplementationOnce(((from: unknown, to: unknown) => { renamed.push([from, to]) }) as unknown as typeof renameSync)
    expect(quarantineFleetToken('proven dead')).toBe(true)
    expect(renamed[0][0]).toBe(FLEET_OAUTH_TOKEN_PATH)
    expect(renamed[0][1]).toBe(FLEET_OAUTH_TOKEN_PATH + '.bad')
  })

  it('returns false when the rename itself fails', async () => {
    const { quarantineFleetToken } = await import('../web/claude-credentials-guard.js')
    vi.mocked(existsSync).mockImplementationOnce((() => true) as unknown as typeof existsSync)
    vi.mocked(renameSync).mockImplementationOnce((() => { throw new Error('EACCES') }) as unknown as typeof renameSync)
    expect(quarantineFleetToken('test')).toBe(false)
  })
})

// quarantineFleetTokenIfDead is the event-driven twin: probe the CURRENT
// fleet token and only quarantine on a CONFIRMED auth-rejected verdict, never
// on a network flake ('inconclusive').
describe('quarantineFleetTokenIfDead', () => {
  it('no-token when the fleet token file is absent', async () => {
    const { quarantineFleetTokenIfDead } = await import('../web/claude-credentials-guard.js')
    mockFleetTokenMissing()
    expect(await quarantineFleetTokenIfDead()).toBe('no-token')
  })

  it('healthy when the live probe passes', async () => {
    const { quarantineFleetTokenIfDead } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(null, 'OK', '')
    }) as unknown as typeof execFile)
    vi.mocked(writeFileSync).mockImplementationOnce((() => undefined) as unknown as typeof writeFileSync)
    expect(await quarantineFleetTokenIfDead()).toBe('healthy')
  })

  it('quarantined when the live probe confirms auth-rejected', async () => {
    const { quarantineFleetTokenIfDead } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(new Error('exit 1'), '', 'Invalid bearer token')
    }) as unknown as typeof execFile)
    vi.mocked(existsSync).mockImplementationOnce((() => true) as unknown as typeof existsSync)
    vi.mocked(rmSync).mockImplementationOnce((() => undefined) as unknown as typeof rmSync)
    vi.mocked(renameSync).mockImplementationOnce((() => undefined) as unknown as typeof renameSync)
    expect(await quarantineFleetTokenIfDead()).toBe('quarantined')
  })

  it('inconclusive on a network flake never quarantines', async () => {
    const { quarantineFleetTokenIfDead } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(new Error('fetch failed'), '', 'ETIMEDOUT')
    }) as unknown as typeof execFile)
    expect(await quarantineFleetTokenIfDead()).toBe('inconclusive')
  })
})

// fleetTokenBootPass is the once-per-boot lifecycle pass: promote, validate
// (cached or live), or quarantine a stale/dead fleet token.
describe('fleetTokenBootPass', () => {
  it('delegates to syncFleetTokenFromSharedCredentials when no fleet token exists', async () => {
    const { fleetTokenBootPass } = await import('../web/claude-credentials-guard.js')
    mockFleetTokenMissing()
    vi.mocked(readFileSync).mockImplementationOnce((() => { throw new Error('ENOENT') }) as unknown as typeof readFileSync)
    expect(await fleetTokenBootPass()).toBe('no-credentials')
  })

  it('malformed-left-alone when the fleet token file content is not setup-token shaped', async () => {
    const { fleetTokenBootPass } = await import('../web/claude-credentials-guard.js')
    mockFleetToken('not-a-real-token')
    expect(await fleetTokenBootPass()).toBe('malformed-left-alone')
  })

  it('validated-cached when the stamp already matches the token hash (no live probe)', async () => {
    const { fleetTokenBootPass } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    mockVerifiedHash(tokenHash(OAT))
    // No execFile mock queued: a cache hit must never shell out.
    expect(await fleetTokenBootPass()).toBe('validated-cached')
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })

  it('validated on a fresh live probe pass, and stamps the hash', async () => {
    const { fleetTokenBootPass } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    mockVerifiedHash('some-other-hash')
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(null, 'OK', '')
    }) as unknown as typeof execFile)
    vi.mocked(writeFileSync).mockImplementationOnce((() => undefined) as unknown as typeof writeFileSync)
    expect(await fleetTokenBootPass()).toBe('validated')
  })

  it('quarantined when the live probe confirms the token is dead', async () => {
    const { fleetTokenBootPass } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    mockVerifiedHash(null)
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(new Error('exit 1'), '', 'Invalid bearer token')
    }) as unknown as typeof execFile)
    vi.mocked(existsSync).mockImplementationOnce((() => true) as unknown as typeof existsSync)
    vi.mocked(rmSync).mockImplementationOnce((() => undefined) as unknown as typeof rmSync)
    vi.mocked(renameSync).mockImplementationOnce((() => undefined) as unknown as typeof renameSync)
    expect(await fleetTokenBootPass()).toBe('quarantined')
  })

  it('validate-inconclusive on a network flake (never quarantines, never caches)', async () => {
    const { fleetTokenBootPass } = await import('../web/claude-credentials-guard.js')
    mockFleetToken(OAT)
    mockVerifiedHash(null)
    vi.mocked(execFile).mockImplementationOnce(((_bin: unknown, _args: unknown, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(new Error('fetch failed'), '', 'ETIMEDOUT')
    }) as unknown as typeof execFile)
    expect(await fleetTokenBootPass()).toBe('validate-inconclusive')
  })
})
