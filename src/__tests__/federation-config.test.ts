import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, db, clearSystemConfigCache, reloadSystemConfigCache } from '../db.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { checkBearerToken } from '../web/dashboard-auth.js'
import { getFederationConfigRaw } from '../db/federation.js'
import {
  validateFederationConfig,
  getFederationConfig,
  writeFederationConfig,
  identifyFederationCaller,
  setFederationEnabledPreservingFile,
  setFederationRoutingModePreservingFile,
  removeFederationStore,
  generatePeerInboundToken,
  isAcceptablePeerBaseUrl,
  abandonWindowMsForPeer,
  _setFederationStoreDirForTest,
  _seedFederationConfigForTest,
  _clearFederationConfigForTest,
  reloadFederationForTest,
  FEDERATION_MIN_TOKEN_LENGTH,
  DEFAULT_ABANDON_WINDOW_MINUTES,
  type FederationConfig,
} from '../web/federation/config.js'

// #985 group 5/8's deferred part: federation.json -> system_config
// ('federation_config_json'). Isolated in-memory DB (model-fallback-store.
// test.ts precedent) -- storeDir is only still relevant for the legacy
// .federation-token file (removeFederationStore's other cleanup target).
const TMP = mkdtempSync(join(tmpdir(), 'fed-config-test-'))
const IN_TOKEN = 'f'.repeat(64)
const OUT_TOKEN = 'e'.repeat(64)

async function writeConfigFile(obj: unknown): Promise<void> {
  await _seedFederationConfigForTest(obj as string | Record<string, unknown>)
}

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(async () => {
  await _clearFederationConfigForTest()
  rmSync(join(TMP, '.federation-token'), { force: true })
  _setFederationStoreDirForTest(TMP)
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const validPeers = [{ id: 'arthur', baseUrl: 'https://macbook.example.ts.net', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN }]

describe('validateFederationConfig (pure)', () => {
  it('accepts a minimal valid config and defaults systemId to MAIN_AGENT_ID', () => {
    const r = validateFederationConfig({ enabled: true, peers: validPeers })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.systemId).toBe(MAIN_AGENT_ID)
      expect(r.peers[0]).toMatchObject({ id: 'arthur', trust: 'untrusted', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN })
    }
  })

  it('parses peers for DISABLED configs too (lossless disable)', () => {
    const r = validateFederationConfig({ enabled: false, systemId: 'teodor', peers: validPeers })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.enabled).toBe(false)
      expect(r.peers).toHaveLength(1)
    }
  })

  it('is strict about enabled === true', () => {
    for (const enabled of ['true', 1, undefined]) {
      const r = validateFederationConfig({ enabled, peers: validPeers })
      if (typeof r !== 'string') expect(r.enabled).toBe(false)
      else expect.fail(`expected config, got: ${r}`)
    }
  })

  it('defaults routingMode to catalog-first when absent, round-trips a valid mode', () => {
    const def = validateFederationConfig({ enabled: true, peers: validPeers })
    if (typeof def === 'string') return expect.fail(def)
    expect(def.routingMode).toBe('catalog-first')
    for (const mode of ['strong', 'catalog-first', 'advisory'] as const) {
      const r = validateFederationConfig({ enabled: true, routingMode: mode, peers: validPeers })
      if (typeof r === 'string') return expect.fail(r)
      expect(r.routingMode).toBe(mode)
    }
  })

  it('rejects an unknown routingMode (fail-closed)', () => {
    expect(typeof validateFederationConfig({ enabled: true, routingMode: 'aggressive', peers: validPeers })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, routingMode: 5, peers: validPeers })).toBe('string')
  })

  it('allows an EMPTY outboundToken (pairing pending) but rejects a short one', () => {
    const pending = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], outboundToken: '' }] })
    expect(typeof pending).not.toBe('string')
    if (typeof pending !== 'string') expect(pending.peers[0].outboundToken).toBe('')
    const missing = validateFederationConfig({ enabled: true, peers: [{ id: 'arthur', baseUrl: 'https://x.example', inboundToken: IN_TOKEN }] })
    expect(typeof missing).not.toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], outboundToken: 'short' }] })).toBe('string')
  })

  it('REQUIRES a well-formed inboundToken (min length, empty-string bypass guard)', () => {
    for (const inboundToken of [undefined, '', '   ', 'short', 'x'.repeat(FEDERATION_MIN_TOKEN_LENGTH - 1)]) {
      const r = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], inboundToken }] })
      expect(typeof r).toBe('string')
    }
  })

  it('rejects duplicate inbound tokens (cross-peer impersonation guard)', () => {
    const r = validateFederationConfig({
      enabled: true,
      peers: [validPeers[0], { id: 'cecil', baseUrl: 'https://c.example', inboundToken: IN_TOKEN }],
    })
    expect(r).toContain('duplicate inbound token')
  })

  it('rejects peer id equal to own systemId and duplicate peer ids', () => {
    expect(validateFederationConfig({ enabled: true, systemId: 'arthur', peers: validPeers })).toContain('equals own systemId')
    expect(validateFederationConfig({ enabled: true, peers: [...validPeers, { ...validPeers[0], inboundToken: 'g'.repeat(64) }] })).toContain('duplicate peer id')
  })

  it('lowercases systemId and peer ids at validation -- case-insensitive ids, stored lowercase (L1)', () => {
    const r = validateFederationConfig({ enabled: true, systemId: 'Teodor', peers: [{ ...validPeers[0], id: 'Arthur' }] })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.systemId).toBe('teodor')
      expect(r.peers[0].id).toBe('arthur')
    }
  })

  it('detects id collisions ACROSS case (own-system + duplicate)', () => {
    expect(validateFederationConfig({ enabled: true, systemId: 'teodor', peers: [{ ...validPeers[0], id: 'Teodor' }] })).toContain('equals own systemId')
    expect(validateFederationConfig({
      enabled: true, systemId: 'x',
      peers: [validPeers[0], { ...validPeers[0], id: 'ARTHUR', inboundToken: 'a'.repeat(64) }],
    })).toContain('duplicate peer id')
  })

  it('rejects unknown trust values (fail-closed forward-compat)', () => {
    expect(validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], trust: 'trusted' }] })).toContain('trust')
  })

  it('parses the per-peer shareCapabilitySummaries flag strictly and ROUND-TRIPS it (L5)', () => {
    const on = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], shareCapabilitySummaries: true }] })
    if (typeof on === 'string') expect.fail(on)
    // Must survive the validator: every mutating endpoint persists the
    // validator's output, so a dropped field would silently revoke the grant.
    expect(on.peers[0].shareCapabilitySummaries).toBe(true)
    const off = validateFederationConfig({ enabled: true, peers: validPeers })
    if (typeof off === 'string') expect.fail(off)
    expect(off.peers[0].shareCapabilitySummaries).toBeUndefined() // default: not shared
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], shareCapabilitySummaries: 'yes' }] })).toBe('string')
  })

  it('validates abandonWindowMinutes bounds', () => {
    const ok = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], abandonWindowMinutes: 1440 }] })
    if (typeof ok !== 'string') expect(ok.peers[0].abandonWindowMinutes).toBe(1440)
    else expect.fail(ok)
    for (const w of [0, 4, 999999, 1.5, '60']) {
      expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], abandonWindowMinutes: w }] })).toBe('string')
    }
  })

  it('rejects invalid ids and baseUrls; strips trailing slashes', () => {
    expect(typeof validateFederationConfig({ enabled: true, systemId: 'bad name', peers: [] })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], id: 'a/b' }] })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], baseUrl: 'http://evil.example.com' }] })).toBe('string')
    const r = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], baseUrl: 'https://x.example//' }] })
    if (typeof r !== 'string') expect(r.peers[0].baseUrl).toBe('https://x.example')
  })
})

describe('isAcceptablePeerBaseUrl / abandonWindowMsForPeer / token mint', () => {
  it('requires https except on loopback', () => {
    expect(isAcceptablePeerBaseUrl('https://any.example')).toBe(true)
    expect(isAcceptablePeerBaseUrl('http://127.0.0.1:3432')).toBe(true)
    expect(isAcceptablePeerBaseUrl('http://192.168.1.10:3420')).toBe(false)
  })

  it('abandon window defaults to 60 min and honours per-peer override', () => {
    const cfg: FederationConfig = {
      enabled: true, systemId: 'a',
      peers: [
        { id: 'fast', baseUrl: 'https://x', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, trust: 'untrusted' },
        { id: 'laptop', baseUrl: 'https://y', outboundToken: OUT_TOKEN, inboundToken: 'g'.repeat(64), trust: 'untrusted', abandonWindowMinutes: 1440 },
      ],
    }
    expect(abandonWindowMsForPeer(cfg, 'fast')).toBe(DEFAULT_ABANDON_WINDOW_MINUTES * 60_000)
    expect(abandonWindowMsForPeer(cfg, 'laptop')).toBe(1440 * 60_000)
    expect(abandonWindowMsForPeer(cfg, 'unknown')).toBe(DEFAULT_ABANDON_WINDOW_MINUTES * 60_000)
    // Case-insensitive: a pre-normalization stored row may carry 'Laptop/x'.
    expect(abandonWindowMsForPeer(cfg, 'Laptop')).toBe(1440 * 60_000)
  })

  it('mints 64-hex tokens', () => {
    expect(generatePeerInboundToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(generatePeerInboundToken()).not.toBe(generatePeerInboundToken())
  })
})

describe('fail-closed store reads', () => {
  it('missing row / garbage JSON / one invalid peer -> disabled with no peers', async () => {
    expect(getFederationConfig().enabled).toBe(false)
    await _seedFederationConfigForTest('{not json')
    expect(getFederationConfig().enabled).toBe(false)
    await writeConfigFile({ enabled: true, peers: [validPeers[0], { id: 'bad peer!', baseUrl: 'https://x.example', inboundToken: 'g'.repeat(64) }] })
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.peers).toHaveLength(0)
  })

  it('valid enabled document -> enabled with parsed peers', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.peers.map((p) => p.id)).toEqual(['arthur'])
  })

  // D4 decision C (plan 984): a DB READ failure (not a garbage/invalid
  // document -- the DB call itself throwing, e.g. a locked/corrupt file)
  // must fail-closed the same as an invalid document, but log at error
  // level, not warn. A mutation flipping loadConfigFromDb()'s try/catch to
  // fail OPEN (or dropping it entirely) survived the suite before this test
  // existed -- nothing exercised a genuine throw from getFederationConfigRaw().
  it('a genuine DB read failure (not just a missing/invalid row) fail-closes and logs at error level', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    expect(getFederationConfig().enabled).toBe(true) // sanity: would be true if the read worked

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    db.exec('ALTER TABLE system_config RENAME TO system_config_test_down')
    try {
      clearSystemConfigCache() // the system_config read cache would answer without touching the table
      reloadFederationForTest() // clear the cache so the next read actually hits the DB
      const cfg = getFederationConfig()
      expect(cfg.enabled).toBe(false)
      expect(cfg.peers).toHaveLength(0)
      expect(errorSpy).toHaveBeenCalled()
      const [logArg, msgArg] = errorSpy.mock.calls[0]!
      expect(msgArg).toMatch(/DB read failed/)
      expect(logArg).toHaveProperty('err')
    } finally {
      db.exec('ALTER TABLE system_config_test_down RENAME TO system_config')
      reloadSystemConfigCache()
      errorSpy.mockRestore()
      reloadFederationForTest()
    }
  })
})

describe('identifyFederationCaller', () => {
  it('identifies the matching peer and only while enabled', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    expect(identifyFederationCaller(`Bearer ${IN_TOKEN}`, checkBearerToken)).toBe('arthur')
    expect(identifyFederationCaller(`Bearer ${'0'.repeat(64)}`, checkBearerToken)).toBeNull()
    expect(identifyFederationCaller(undefined, checkBearerToken)).toBeNull()
    await writeConfigFile({ enabled: false, peers: validPeers })
    // Disabled: no auth work at all -- a disabled peer presents as plain 401.
    expect(identifyFederationCaller(`Bearer ${IN_TOKEN}`, checkBearerToken)).toBeNull()
  })

  it('never authenticates against an empty/short stored token', async () => {
    // Hand-seeded doc with a short inbound token fail-closes the WHOLE
    // config, so the caller loop never even sees it.
    await writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: '' }] })
    expect(identifyFederationCaller('Bearer  ', checkBearerToken)).toBeNull()
  })
})

describe('lossless enable/disable + removal', () => {
  it('setFederationEnabledPreservingFile flips the flag and keeps peers -- even INVALID ones stay in the store', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    expect(await setFederationEnabledPreservingFile(false)).toBe(true)
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.peers).toHaveLength(1) // lossless: peers survive the flip
    expect(await setFederationEnabledPreservingFile(true)).toBe(true)
    expect(getFederationConfig().enabled).toBe(true)

    // The critical data-loss edge: an INVALID stored peer fail-closes the
    // VIEW (peers: []), but the flag flip must not write that emptiness back.
    await writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: 'short' }] })
    expect(getFederationConfig().peers).toHaveLength(0) // view is fail-closed
    expect(await setFederationEnabledPreservingFile(false)).toBe(true)
    const raw = JSON.parse(getFederationConfigRaw()!)
    expect(raw.peers).toHaveLength(1) // the store still has the peer
    expect(raw.enabled).toBe(false)
  })

  it('returns false on unreadable garbage (nothing to flip; validator already fail-closes)', async () => {
    await _seedFederationConfigForTest('{oops')
    expect(await setFederationEnabledPreservingFile(false)).toBe(false)
  })

  it('setFederationRoutingModePreservingFile sets the mode, keeps peers + enabled, survives an invalid stored peer', async () => {
    await writeConfigFile({ enabled: true, routingMode: 'catalog-first', peers: validPeers })
    expect(await setFederationRoutingModePreservingFile('strong')).toBe(true)
    const cfg = getFederationConfig()
    expect(cfg.routingMode).toBe('strong')
    expect(cfg.enabled).toBe(true) // untouched
    expect(cfg.peers).toHaveLength(1) // lossless
    // Invalid stored peer -> the VIEW fail-closes, but the store (incl. the peer) is kept.
    await writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: 'short' }] })
    expect(await setFederationRoutingModePreservingFile('advisory')).toBe(true)
    const raw = JSON.parse(getFederationConfigRaw()!)
    expect(raw.routingMode).toBe('advisory')
    expect(raw.peers).toHaveLength(1)
  })

  it('removeFederationStore deletes the config row + legacy token file and is idempotent', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    writeFileSync(join(TMP, '.federation-token'), 'legacy'.repeat(11))
    await removeFederationStore()
    expect(getFederationConfigRaw()).toBeUndefined()
    expect(existsSync(join(TMP, '.federation-token'))).toBe(false)
    expect(getFederationConfig().enabled).toBe(false)
    await removeFederationStore() // idempotent
  })

  it('writeFederationConfig refreshes the cache synchronously', async () => {
    await writeFederationConfig({ enabled: true, systemId: 'teodor', peers: [{ id: 'arthur', baseUrl: 'https://x.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, trust: 'untrusted' }] })
    expect(getFederationConfig().enabled).toBe(true)
    expect(getFederationConfig().peers[0].id).toBe('arthur')
  })
})

describe('reloadFederationForTest', () => {
  it('is still exported and clears the cache (legacy-named seam, kept for other federation test files)', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    expect(getFederationConfig().enabled).toBe(true)
    reloadFederationForTest()
    expect(getFederationConfig().enabled).toBe(true) // same stored doc, just re-read
  })
})

describe('overlapping writes and the auth gate (writers are awaited read-modify-writes)', () => {
  const bearer = `Bearer ${IN_TOKEN}`
  const gate = (): string | null => identifyFederationCaller(bearer, checkBearerToken)

  it('an enabled flip and a routing-mode change started together both land, in either order', async () => {
    for (const order of ['flip-first', 'mode-first'] as const) {
      await writeConfigFile({ enabled: true, routingMode: 'catalog-first', peers: validPeers })
      const flip = (): Promise<boolean> => setFederationEnabledPreservingFile(false)
      const mode = (): Promise<boolean> => setFederationRoutingModePreservingFile('strong')
      const results = order === 'flip-first' ? await Promise.all([flip(), mode()]) : (await Promise.all([mode(), flip()])).reverse()
      expect(results).toEqual([true, true])
      const raw = JSON.parse(getFederationConfigRaw()!)
      expect(raw.enabled, order).toBe(false)
      expect(raw.routingMode, order).toBe('strong')
      expect(raw.peers, order).toHaveLength(1)
      const cfg = getFederationConfig()
      expect(cfg.enabled, order).toBe(false)
      expect(cfg.routingMode, order).toBe('strong')
    }
  })

  it('many overlapping routing-mode and enabled writes: the last one of each kind wins and nothing else changes', async () => {
    await writeConfigFile({ enabled: true, routingMode: 'catalog-first', peers: validPeers })
    await Promise.all([
      setFederationRoutingModePreservingFile('advisory'),
      setFederationEnabledPreservingFile(false),
      setFederationRoutingModePreservingFile('strong'),
      setFederationEnabledPreservingFile(true),
      setFederationRoutingModePreservingFile('advisory'),
    ])
    const raw = JSON.parse(getFederationConfigRaw()!)
    expect(raw.routingMode).toBe('advisory')
    expect(raw.enabled).toBe(true)
    expect(raw.peers).toHaveLength(1)
    expect(getFederationConfig()).toMatchObject({ enabled: true, routingMode: 'advisory' })
  })

  it('the gate refuses the moment a disable resolves (a switched-off federation accepts no peer)', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    expect(gate()).toBe('arthur') // primes the cache with the enabled document
    expect(await setFederationEnabledPreservingFile(false)).toBe(true)
    expect(gate()).toBeNull() // the very next synchronous check, not "eventually"
    expect(await setFederationEnabledPreservingFile(true)).toBe(true)
    expect(gate()).toBe('arthur')
  })

  it('writeFederationConfig: the gate sees the new document as soon as the write resolves', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    expect(gate()).toBe('arthur') // cache primed
    const disabled = validateFederationConfig({ enabled: false, peers: validPeers })
    if (typeof disabled === 'string') throw new Error(disabled)
    await writeFederationConfig(disabled)
    expect(gate()).toBeNull()
    expect(getFederationConfig().enabled).toBe(false)
  })

  it('removeFederationStore: the gate refuses as soon as the removal resolves', async () => {
    await writeConfigFile({ enabled: true, peers: validPeers })
    expect(gate()).toBe('arthur') // cache primed
    await removeFederationStore()
    expect(gate()).toBeNull()
    expect(getFederationConfigRaw()).toBeUndefined()
  })

  it.each([
    ['unparseable text', '{oops'],
    ['a JSON array', '[1,2]'],
    ['a JSON scalar', '42'],
  ])('garbage in the store (%s): both setters answer false and write nothing', async (_label, garbage) => {
    await _seedFederationConfigForTest(garbage)
    const before = getFederationConfigRaw()
    expect(await setFederationEnabledPreservingFile(true)).toBe(false)
    expect(await setFederationRoutingModePreservingFile('strong')).toBe(false)
    expect(getFederationConfigRaw()).toBe(before)
    expect(gate()).toBeNull() // and the view stays fail-closed
  })

  it('an enable of a stored document with an invalid peer reports false (the view stays disabled) but keeps the data', async () => {
    await writeConfigFile({ enabled: false, peers: [{ ...validPeers[0], inboundToken: 'short' }] })
    expect(await setFederationEnabledPreservingFile(true)).toBe(false)
    expect(JSON.parse(getFederationConfigRaw()!)).toMatchObject({ enabled: true })
    expect(JSON.parse(getFederationConfigRaw()!).peers).toHaveLength(1)
    expect(gate()).toBeNull()
  })
})
