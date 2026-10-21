// Failure modes of the asynchronous authentication path that the lane tests do not reach, each pinned so that a
// named wrong change fails here (and not only in tsc): a swallowed database error on one lane, the attempt cap of
// the device-key lookup, a rotation that is not one transaction, an observer that turns a 401 into a 500, and the
// `await` in front of resolveAuth in the request handler. Taken from the QA probes of the change.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type http from 'node:http'
import { dbx, insertApiToken, listActiveApiTokensByName, rotateApiToken, getApiTokenRowById } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { createDeviceKey, resolveDeviceKey, revokeDeviceKey, _clearDeviceKeyCacheForTest, _cacheForTest } from '../web/auth-device-keys.js'
import { observeRefusedSharedToken } from '../web/token-shadow.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()
afterEach(() => { vi.restoreAllMocks() })

const mkReq = (headers: Record<string, string>): http.IncomingMessage => ({ headers }) as unknown as http.IncomingMessage
const ask = (raw: string, dbLookups: boolean) =>
  resolveAuth(mkReq({ authorization: `Bearer ${raw}` }), new URL('http://127.0.0.1:3420/api/memories'), '/api/memories', 'GET', 'f'.repeat(64), dbLookups)

describe('auth path: database failure handling per lane', () => {
  // With dbLookups on, the rejection of a device-key bearer comes from the api_tokens lane (step 1) and the
  // device-key lane is never reached. dbLookups off skips that lane, so this one reaches resolveDeviceKey: a
  // `.catch(() => null)` around it would turn the failure into "no such key" and fail this test.
  it('device-key lane: a database failure rejects when the api_tokens lane is skipped', async () => {
    vi.spyOn(dbx, 'get').mockRejectedValue(new Error('database unavailable'))
    await expect(ask('mvdk_not-a-real-key', false)).rejects.toThrow('database unavailable')
  })

  // Only the FIRST statement fails. A `.catch(() => undefined)` around the token lookup would read it as "no such
  // token" and let the file token through; failing every statement (as the lane tests do) cannot tell them apart.
  it('a failure of only the first lookup statement still rejects, with no fallback to the file token', async () => {
    vi.spyOn(dbx, 'get').mockRejectedValueOnce(new Error('database unavailable'))
    await expect(ask('f'.repeat(64), true)).rejects.toThrow('database unavailable')
  })
})

// The SSE pane-stream lane (?token=) has its own lookups after the header lanes: the check that the in-memory
// dashboard token was revoked, and the device-key lookup. A failure in either must reject too; the first would
// otherwise read as "not revoked" and let the file token through.
describe('SSE ?token= lane: a database failure rejects', () => {
  const FILE_TOKEN = 'f'.repeat(64)
  const sse = (q: string, dbLookups: boolean) =>
    resolveAuth(mkReq({}), new URL(`http://127.0.0.1:3420/api/agents/agent-a/pane/stream?token=${q}`), '/api/agents/agent-a/pane/stream', 'GET', FILE_TOKEN, dbLookups)

  it('a failing in-memory-revoked check does not let the file token through', async () => {
    vi.spyOn(dbx, 'get').mockRejectedValue(new Error('database unavailable'))
    await expect(sse(FILE_TOKEN, true)).rejects.toThrow('database unavailable')
  })

  it('a failing device-key lookup rejects (the api_tokens lanes are off)', async () => {
    vi.spyOn(dbx, 'get').mockRejectedValue(new Error('database unavailable'))
    await expect(sse('mvdk_not-a-real-key', false)).rejects.toThrow('database unavailable')
  })
})

describe('device-key lookup that keeps racing a removal', () => {
  // Every read is overtaken by a removal (5 of them). After 3 attempts the lookup must deny (fail closed), not
  // trust a row it read across a removal; without the cap it would loop until the removals stop and then accept.
  it('denies after 3 attempts and caches nothing', async () => {
    const k = await createDeviceKey('racy')
    expect(await resolveDeviceKey(k.key)).not.toBeNull()
    _clearDeviceKeyCacheForTest()
    const original = dbx.get.bind(dbx)
    let bumps = 0
    vi.spyOn(dbx, 'get').mockImplementation(async (sql: string, ...p: unknown[]) => {
      const row = await original(sql, ...p)
      if (sql.includes('FROM device_keys WHERE key_hash') && bumps < 5) { bumps++; await revokeDeviceKey(99999) }
      return row
    })
    expect(await resolveDeviceKey(k.key)).toBeNull()
    expect(_cacheForTest.size).toBe(0)
  })
})

describe('rotateApiToken is one transaction', () => {
  // If the replacement cannot be inserted (its hash is taken), the revoke must roll back: the old token stays
  // active. A revoke outside the transaction would leave zero valid tokens (a lock-out) and fail this.
  it('a replacement that cannot be inserted rolls the revoke back, so the old token stays active', async () => {
    const old = await insertApiToken({ tokenHash: 'old-hash', name: 'tx-check', role: 'viewer', tenantId: 'default', createdAt: 1, expiresAt: null })
    await insertApiToken({ tokenHash: 'taken-hash', name: 'other', role: 'viewer', tenantId: 'default', createdAt: 1, expiresAt: null })
    await expect(rotateApiToken(old, 'taken-hash', 100, null)).rejects.toThrow(/UNIQUE/i)
    expect((await getApiTokenRowById(old.id))?.revoked_at).toBeNull()
    expect((await listActiveApiTokensByName('tx-check', 200)).map((r) => r.token_hash)).toEqual(['old-hash'])
  })
})

describe('the refused-token observation never turns a 401 into a 500', () => {
  // `expect(() => asyncFn()).not.toThrow()` asserts nothing (an async function does not throw synchronously);
  // this one awaits the result, so a catch that rethrows fails it.
  it('a database failure inside observeRefusedSharedToken resolves, it does not reject', async () => {
    vi.spyOn(dbx, 'get').mockRejectedValue(new Error('database unavailable'))
    await expect(observeRefusedSharedToken(mkReq({ authorization: 'Bearer old-shared' }), 'GET', '/api/agents')).resolves.toBeUndefined()
  })
})

describe('the request handler awaits resolveAuth', () => {
  // Without the `await`, `auth` is a Promise: `auth.kind` is undefined, `authenticated` becomes true for every
  // request and the gate lets everything through. tsc catches it, but a build that skips the type-check must not
  // be the only guard, so the call site is pinned.
  it('web.ts calls resolveAuth with await, and nothing else is assigned from it', () => {
    // Line based, not a comment-stripping regex: web.ts holds path globs ('/api/*') that a block-comment regex
    // would take for a comment start and swallow the call site.
    const lines = readFileSync(fileURLToPath(new URL('../web.ts', import.meta.url)), 'utf8').split('\n')
      .filter((l) => /\bresolveAuth\(/.test(l) && !/^\s*(\/\/|\*|import)/.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/await\s+resolveAuth\(/)
  })
})
