import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../db.js'
import { tryHandleFederation, _resetInboxDedupForTest } from '../web/routes/federation.js'
import {
  _setFederationStoreDirForTest,
  _seedFederationConfigForTest,
  _clearFederationConfigForTest,
  getFederationConfig,
} from '../web/federation/config.js'
import { getFederationConfigRaw } from '../db/federation.js'
import type { RouteContext } from '../web/routes/types.js'

// The peer mutations (add, patch, remove, rotate) are read-modify-writes of the whole stored document. Since the
// write became an awaited one, two requests in flight at once must still both land: each reads what the other
// wrote (mutateFederationConfig, one transaction), so no peer reappears after a removal, no token is lost.

const TMP = mkdtempSync(join(tmpdir(), 'fed-concurrent-test-'))
const IN_TOKEN = 'a'.repeat(64)
const OUT_TOKEN = 'b'.repeat(64)
const peer = (id: string, extra: Record<string, unknown> = {}) => ({
  id, baseUrl: `https://${id}.example.ts.net`, inboundToken: id.padEnd(64, 'x'), outboundToken: OUT_TOKEN, ...extra,
})

function fakeCtx(method: string, path: string, body?: string): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* noop */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* noop */ },
  } as unknown as RouteContext['res']
  if (body !== undefined) {
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(body))
      ;(req as unknown as EventEmitter).emit('end')
    })
  }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function call(method: string, path: string, body?: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(method, path, body === undefined ? undefined : JSON.stringify(body))
  expect(await tryHandleFederation(ctx)).toBe(true)
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(res.body) } catch { /* empty */ }
  return { statusCode: res.statusCode || 200, json: parsed }
}

const storedPeers = (): Array<Record<string, unknown>> => JSON.parse(getFederationConfigRaw()!).peers as Array<Record<string, unknown>>
const storedIds = (): string[] => storedPeers().map((p) => p.id as string).sort()
const add = (id: string) => call('POST', '/api/federation/peers', { id, baseUrl: `https://${id}.example.ts.net` })

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(async () => {
  await _clearFederationConfigForTest()
  _setFederationStoreDirForTest(TMP)
  _resetInboxDedupForTest()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('overlapping peer mutations all land', () => {
  it('three peers added at once: all three are stored, and the cache shows them', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [] })
    const results = await Promise.all([add('alpha'), add('bravo'), add('charlie')])
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201])
    expect(storedIds()).toEqual(['alpha', 'bravo', 'charlie'])
    expect(getFederationConfig().peers.map((p) => p.id).sort()).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('the token each add handed out is the one stored for that peer', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [] })
    const [a, b] = await Promise.all([add('alpha'), add('bravo')])
    const byId = new Map(storedPeers().map((p) => [p.id as string, p.inboundToken as string]))
    expect(byId.get('alpha')).toBe(a.json.inboundToken)
    expect(byId.get('bravo')).toBe(b.json.inboundToken)
  })

  it('an add and a removal of another peer at once: the removed peer stays removed, the new one is there', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [peer('old')] })
    const [added, removed] = await Promise.all([add('fresh'), call('DELETE', '/api/federation/peers/old')])
    expect([added.statusCode, removed.statusCode]).toEqual([201, 200])
    expect(storedIds()).toEqual(['fresh'])
  })

  it('a rotation and a patch of the same peer at once: the rotated token and the new url both survive', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [peer('arthur', { inboundToken: IN_TOKEN })] })
    const [rotated, patched] = await Promise.all([
      call('POST', '/api/federation/peers/arthur/rotate-inbound-token'),
      call('PATCH', '/api/federation/peers/arthur', { baseUrl: 'https://moved.example.ts.net' }),
    ])
    expect([rotated.statusCode, patched.statusCode]).toEqual([200, 200])
    const [stored] = storedPeers()
    expect(stored!.baseUrl).toBe('https://moved.example.ts.net')
    expect(stored!.inboundToken).toBe(rotated.json.inboundToken)
    expect(stored!.inboundToken).not.toBe(IN_TOKEN)
  })

  it('two rotations at once: the stored token is the last one handed out, never a token nobody got', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [peer('arthur', { inboundToken: IN_TOKEN })] })
    const [r1, r2] = await Promise.all([
      call('POST', '/api/federation/peers/arthur/rotate-inbound-token'),
      call('POST', '/api/federation/peers/arthur/rotate-inbound-token'),
    ])
    expect(r1.json.inboundToken).not.toBe(r2.json.inboundToken)
    expect(storedPeers()[0]!.inboundToken).toBe(r2.json.inboundToken)
  })

  it('a removal and a rotation of the same peer at once: the peer does not come back', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [peer('arthur', { inboundToken: IN_TOKEN })] })
    const [removed, rotated] = await Promise.all([
      call('DELETE', '/api/federation/peers/arthur'),
      call('POST', '/api/federation/peers/arthur/rotate-inbound-token'),
    ])
    expect(removed.statusCode).toBe(200)
    expect(rotated.statusCode).toBe(404) // it ran after the removal and saw no such peer
    expect(storedPeers()).toEqual([])
    expect(getFederationConfig().peers).toEqual([])
  })

  it('the same peer added twice at once: one 201 and one 409, one stored peer', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [] })
    const results = await Promise.all([add('alpha'), add('alpha')])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(storedIds()).toEqual(['alpha'])
  })

  it('the same peer removed twice at once: one 200 and one 404', async () => {
    await _seedFederationConfigForTest({ enabled: true, peers: [peer('arthur')] })
    const results = await Promise.all([call('DELETE', '/api/federation/peers/arthur'), call('DELETE', '/api/federation/peers/arthur')])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 404])
    expect(storedPeers()).toEqual([])
  })

  it('an add at once with the enabled flip and a routing-mode change: nothing the owner set is reset', async () => {
    await _seedFederationConfigForTest({ enabled: true, routingMode: 'strong', peers: [peer('arthur')] })
    await Promise.all([
      add('alpha'),
      call('POST', '/api/federation/enabled', { enabled: false }),
      call('POST', '/api/federation/routing-mode', { mode: 'advisory' }),
    ])
    const raw = JSON.parse(getFederationConfigRaw()!)
    expect(raw.enabled).toBe(false)
    expect(raw.routingMode).toBe('advisory')
    expect(storedIds()).toEqual(['alpha', 'arthur'])
  })
})

describe('a stored document that fails validation is left alone', () => {
  it.each([
    ['add', () => add('alpha')],
    ['patch', () => call('PATCH', '/api/federation/peers/arthur', { baseUrl: 'https://x.example.ts.net' })],
    ['remove', () => call('DELETE', '/api/federation/peers/arthur')],
    ['rotate', () => call('POST', '/api/federation/peers/arthur/rotate-inbound-token')],
  ])('%s answers 409 and writes nothing', async (_name, run) => {
    await _seedFederationConfigForTest({ enabled: true, peers: [peer('arthur', { inboundToken: 'short' })] })
    const before = getFederationConfigRaw()
    const r = await run()
    expect(r.statusCode).toBe(409)
    expect(getFederationConfigRaw()).toBe(before)
  })
})
