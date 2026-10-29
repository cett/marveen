// The two disable paths that flip the master switch without a validated document (PUT /peers with a body
// that is not a valid config, and POST /remove) must not report a disable the store refused. When the
// write fails the cache still says enabled, so the route answers 500, leaves the poller, the queued
// messages, the stored peers and the legacy token file alone, and the switch stays visibly on. An
// unreadable stored document is the other reason the flip answers false; it is already fail-closed, so a
// remove still has to be able to clear it.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, createAgentMessage, getAgentMessage } from '../db.js'
import { db } from '../db/connection.js'
import { tryHandleFederation, _resetInboxDedupForTest } from '../web/routes/federation.js'
import {
  _setFederationStoreDirForTest,
  _seedFederationConfigForTest,
  _clearFederationConfigForTest,
  getFederationConfig,
} from '../web/federation/config.js'
import { getFederationConfigRaw, FEDERATION_CONFIG_KEY } from '../db/federation.js'
import type { RouteContext } from '../web/routes/types.js'

const TMP = mkdtempSync(join(tmpdir(), 'fed-disable-failure-test-'))
const IN_TOKEN = 'a'.repeat(64)
const ENABLED_DOC = { enabled: true, systemId: 'localsys', peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN }] }

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

/** Every write of the federation config row throws from now on (the database refuses it). */
function breakConfigWrites(): void {
  for (const op of ['INSERT', 'UPDATE']) {
    db.exec(`CREATE TRIGGER fed_cfg_block_${op.toLowerCase()} BEFORE ${op} ON system_config WHEN NEW.key = '${FEDERATION_CONFIG_KEY}' BEGIN SELECT RAISE(ABORT, 'config write blocked'); END`)
  }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(async () => {
  db.exec('DROP TRIGGER IF EXISTS fed_cfg_block_insert; DROP TRIGGER IF EXISTS fed_cfg_block_update')
  await _clearFederationConfigForTest()
  _setFederationStoreDirForTest(TMP)
  _resetInboxDedupForTest()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('PUT /api/federation/peers with a body that is not a valid config (flag-only disable)', () => {
  it('disables a healthy store (positive control)', async () => {
    await _seedFederationConfigForTest(ENABLED_DOC)
    const q = await createAgentMessage('a', 'teodor/x', 'queued')
    const r = await call('PUT', '/api/federation/peers', { enabled: false, peers: 'oops' })
    expect(r.statusCode).toBe(200)
    expect(getFederationConfig().enabled).toBe(false)
    expect((await getAgentMessage(q.id))?.status).toBe('failed')
  })

  it('answers 500 and leaves the switch on, the queue and the stored peers alone when the write fails', async () => {
    await _seedFederationConfigForTest(ENABLED_DOC)
    const q = await createAgentMessage('a', 'teodor/x', 'queued')
    const before = getFederationConfigRaw()
    breakConfigWrites()
    const r = await call('PUT', '/api/federation/peers', { enabled: false, peers: 'oops' })
    expect(r.statusCode).toBe(500)
    expect(r.json.error).toBe('internal_error')
    expect(String(r.json.hint)).toMatch(/stays enabled/)
    expect(getFederationConfig().enabled).toBe(true)
    expect(getFederationConfigRaw()).toBe(before)
    expect((await getAgentMessage(q.id))?.status).toBe('pending')
  })
})

describe('POST /api/federation/remove', () => {
  it('clears a healthy store (positive control)', async () => {
    await _seedFederationConfigForTest(ENABLED_DOC)
    const r = await call('POST', '/api/federation/remove')
    expect(r.json.ok).toBe(true)
    expect(getFederationConfigRaw()).toBeUndefined()
  })

  it('answers 500 and removes nothing when the disable write fails', async () => {
    await _seedFederationConfigForTest(ENABLED_DOC)
    writeFileSync(join(TMP, '.federation-token'), 'legacy'.repeat(11))
    const q = await createAgentMessage('a', 'teodor/x', 'queued')
    const before = getFederationConfigRaw()
    breakConfigWrites()
    const r = await call('POST', '/api/federation/remove')
    expect(r.statusCode).toBe(500)
    expect(String(r.json.hint)).toMatch(/stays enabled/)
    expect(getFederationConfig().enabled).toBe(true)
    expect(getFederationConfigRaw()).toBe(before)
    expect(existsSync(join(TMP, '.federation-token'))).toBe(true)
    expect((await getAgentMessage(q.id))?.status).toBe('pending')
  })

  it('still clears a stored document that is unreadable garbage (already fail-closed)', async () => {
    await _seedFederationConfigForTest('not json {')
    expect(getFederationConfig().enabled).toBe(false)
    const q = await createAgentMessage('a', 'teodor/x', 'queued')
    const r = await call('POST', '/api/federation/remove')
    expect(r.statusCode).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(getFederationConfigRaw()).toBeUndefined()
    expect((await getAgentMessage(q.id))?.status).toBe('failed')
  })
})
