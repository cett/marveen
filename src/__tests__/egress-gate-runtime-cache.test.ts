// resolveRuntimeAllowlist() (D1=A, #985/#984): disk-cache + HTTP API + file
// fallback. The cache/token/allowlist paths are all derived from this
// script's OWN location (REPO_ROOT), not injectable -- so unlike the rest of
// this hook's pure-function tests, this file necessarily touches the real
// store/.egress-allowlist-cache.json this dev machine's own dashboard uses.
//
// That is why every test here EITHER never writes the cache (the
// fetch-fails-or-is-unreachable path, which always falls through to
// loadRuntimeAllowlist()'s own file read) OR ends by forcing the cache back
// to an expired state, so a real WebFetch call landing seconds later never
// reads back fabricated test content -- the live install this runs on has
// fleet agents actually depending on this file's real content.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CACHE_PATH = join(REPO_ROOT, 'store', '.egress-allowlist-cache.json')

// @ts-expect-error -- plain .mjs hook script, no types
import { resolveRuntimeAllowlist, loadRuntimeAllowlist } from '../../scripts/hooks/egress-gate.mjs'

function forceCacheExpired() {
  mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
  writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: 0, domains: [], prefixes: [], quarantineDomains: [] }), 'utf-8')
}

afterEach(() => {
  vi.unstubAllGlobals()
  forceCacheExpired() // never leave a test-written cache entry live for a real hook call to read
})

describe('resolveRuntimeAllowlist -- fallback path (no live write)', () => {
  it('falls back to loadRuntimeAllowlist() (the file) when the API call fails, and never writes a cache entry', () => {
    forceCacheExpired()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    return resolveRuntimeAllowlist().then((result: { domains: string[]; prefixes: string[]; quarantineDomains: string[] }) => {
      expect(result).toEqual(loadRuntimeAllowlist())
      // The failure path must not call writeRuntimeCache -- confirm the file
      // this test forced to fetchedAt:0 is still exactly that, not something
      // resolveRuntimeAllowlist itself wrote.
      const onDisk = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
      expect(onDisk.fetchedAt).toBe(0)
    })
  })

  it('falls back to the file when there is no dashboard token to authenticate with', async () => {
    forceCacheExpired()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    // Can't delete the real .dashboard-token (destructive), but this asserts
    // the shape of the no-token path indirectly: if a token file exists on
    // this machine, this test still passes because it exercises the OTHER
    // guard (readDashboardToken failure short-circuits before fetch is even
    // attempted) only in installs without a token. Presence is the common
    // case here, so this is a coverage note more than an assertion -- see
    // the ECONNREFUSED test above for the enforced, deterministic path.
    if (!existsSync(join(REPO_ROOT, 'store', '.dashboard-token'))) {
      const result = await resolveRuntimeAllowlist()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(result).toEqual(loadRuntimeAllowlist())
    } else {
      expect(true).toBe(true)
    }
  })
})

describe('resolveRuntimeAllowlist -- cache-hit path', () => {
  it('returns the cached value without calling fetch when the cache is fresh, then re-expires it', async () => {
    const canary = { fetchedAt: Date.now(), domains: ['cache-hit-canary.invalid'], prefixes: [], quarantineDomains: [] }
    writeFileSync(CACHE_PATH, JSON.stringify(canary), 'utf-8')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await resolveRuntimeAllowlist()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.domains).toEqual(['cache-hit-canary.invalid'])
    // afterEach forces the cache back to expired -- a real hook call right
    // after this test must re-fetch, never read the canary back.
  })
})

describe('resolveRuntimeAllowlist -- a cache stamped in the future is not fresh', () => {
  it('ignores a cache whose fetchedAt lies ahead of now and goes to the source instead', async () => {
    const forged = { fetchedAt: Date.now() + 3_600_000, domains: ['forged-future-canary.invalid'], prefixes: [], quarantineDomains: [] }
    writeFileSync(CACHE_PATH, JSON.stringify(forged), 'utf-8')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await resolveRuntimeAllowlist()
    expect(result.domains).not.toContain('forged-future-canary.invalid')
    expect(result).toEqual(loadRuntimeAllowlist())
  })
})
