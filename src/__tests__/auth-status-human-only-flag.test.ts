// GET /api/auth/status and the human-only enforce switch. The probe is public and pre-auth, and the
// Approvals page reads `human_only_enforced` from it to decide whether to lock a human-only request's
// buttons. The flag is told to an authenticated caller only: an anonymous caller gets false whether the
// rule is on or off, so the probe discloses nothing about the security mode. The switch is flipped per
// test through a live getter on the config mock.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: false }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
}))

import { initDatabase, createDashboardUser } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { hashPassword } from '../web/password-hash.js'

let realHash: string
beforeAll(async () => { realHash = await hashPassword('correct-horse-battery-1') })

beforeEach(async () => {
  flags.enforce = false
  initDatabase(':memory:')
  await createDashboardUser('person-a', realHash)
})

type Auth = RouteContext['auth']
const TOKEN: Auth = { kind: 'token', tokenName: 'op-token' }
const SESSION: Auth = { kind: 'session', user: 'person-a' }
const DEVICE = { kind: 'device', device: 'device-a' } as unknown as Auth
// A federation caller never resolves on /api/auth/status in production (its token is endpoint-scoped),
// but the payload must not read as authenticated for any kind it does not list.
const FEDERATION: Auth = { kind: 'federation', peer: 'peer-a' }

async function status(auth: Auth): Promise<Record<string, unknown>> {
  const req = new EventEmitter() as any
  req.headers = {}
  let body = ''
  const res = {
    setHeader() {},
    writeHead() {},
    end(b?: string) { body += b ?? '' },
  } as any
  const url = new URL('http://localhost:3420/api/auth/status')
  const ctx = { req, res, path: url.pathname, method: 'GET', url, auth } as unknown as RouteContext
  expect(await tryHandleAuth(ctx)).toBe(true)
  return JSON.parse(body)
}

describe('human_only_enforced in GET /api/auth/status', () => {
  it.each([
    ['a token', TOKEN],
    ['a session', SESSION],
    ['a device key', DEVICE],
  ])('is true for %s when the rule is enforced', async (_n, auth) => {
    flags.enforce = true
    const body = await status(auth)
    expect(body.authenticated).toBe(true)
    expect(body.human_only_enforced).toBe(true)
  })

  it.each([
    ['a token', TOKEN],
    ['a session', SESSION],
    ['a device key', DEVICE],
  ])('is false for %s when the rule is off', async (_n, auth) => {
    flags.enforce = false
    const body = await status(auth)
    expect(body.authenticated).toBe(true)
    expect(body.human_only_enforced).toBe(false)
  })

  it('is false for an anonymous caller even when the rule is enforced (no disclosure)', async () => {
    flags.enforce = true
    const body = await status(undefined)
    expect(body.authenticated).toBe(false)
    expect(body.human_only_enforced).toBe(false)
  })

  it('is false for a caller kind the payload does not count as authenticated, even when enforced', async () => {
    flags.enforce = true
    const body = await status(FEDERATION)
    expect(body.authenticated).toBe(false)
    expect(body.human_only_enforced).toBe(false)
  })

  it('an anonymous answer is byte-identical with the rule on and off', async () => {
    flags.enforce = true
    const on = await status(undefined)
    flags.enforce = false
    const off = await status(undefined)
    expect(JSON.stringify(on)).toBe(JSON.stringify(off))
  })

  it('is always present and always a boolean, so the two shapes cannot be told apart', async () => {
    for (const enforce of [true, false]) {
      flags.enforce = enforce
      for (const auth of [undefined, TOKEN, SESSION, DEVICE, FEDERATION]) {
        const body = await status(auth)
        expect(Object.keys(body)).toContain('human_only_enforced')
        expect(typeof body.human_only_enforced).toBe('boolean')
      }
    }
  })

  it('leaves every other field of the answer as it was', async () => {
    flags.enforce = true
    const on = await status(SESSION)
    flags.enforce = false
    const off = await status(SESSION)
    const { human_only_enforced: a, ...onRest } = on
    const { human_only_enforced: b, ...offRest } = off
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(onRest).toEqual(offRest)
    expect(onRest).toMatchObject({ authenticated: true, method: 'session', user: 'person-a', login_available: true, setup_required: false })
  })
})
