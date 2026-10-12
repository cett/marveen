import { describe, it, expect } from 'vitest'
import { deviceTokenName, installTag, mintDeviceToken, type DeviceTokenApi, type DeviceTokenApiResult } from '../remote-enroll-device-key.js'
import { RemoteEnrollError } from '../remote-enroll-core.js'

const INSTALL = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER = '9b2f6a58-1c0e-4d37-8a55-6f1d2c3b4a90'

interface Call { method: string; path: string; body?: unknown }

/** A scripted dashboard: answers by "METHOD path", records every call in order. */
function fakeApi(answers: Record<string, DeviceTokenApiResult>): { api: DeviceTokenApi; calls: Call[] } {
  const calls: Call[] = []
  const api: DeviceTokenApi = async (method, path, body) => {
    calls.push({ method, path, body })
    return answers[`${method} ${path}`] ?? { ok: false, status: 404, body: null }
  }
  return { api, calls }
}

const ok = (body: unknown, status = 200): DeviceTokenApiResult => ({ ok: true, status, body })
const row = (id: number, name: string, over: Partial<{ role: string; revoked_at: number | null }> = {}) =>
  ({ id, name, role: 'admin', revoked_at: null, ...over })

describe('mintDeviceToken', () => {
  it('mints a named admin token and returns the raw token', async () => {
    const { api, calls } = fakeApi({
      'GET /api/admin/tokens': ok([]),
      'POST /api/admin/tokens': ok({ token: 'rawtoken', id: 7 }, 201),
    })
    await expect(mintDeviceToken(api, INSTALL, 'Office phone [3f2504e0]')).resolves.toBe('rawtoken')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/admin/tokens', 'POST /api/admin/tokens'])
    expect(calls[1].body).toEqual({ name: 'Office phone [3f2504e0]', role: 'admin' })
  })

  it('revokes the live earlier token of the SAME install id before minting, and nothing else', async () => {
    const { api, calls } = fakeApi({
      'GET /api/admin/tokens': ok([
        row(3, 'Old phone [3f2504e0]'),
        row(4, `Other phone [${installTag(OTHER)}]`),
        row(5, 'operator'),
        row(6, 'Tablet [3f2504e0]', { revoked_at: 1700000000 }),
        row(8, 'Agent thing [3f2504e0]', { role: 'fleet_agent' }),
      ]),
      'DELETE /api/admin/tokens/3/revoke': ok({ ok: true }),
      'POST /api/admin/tokens': ok({ token: 'fresh' }, 201),
    })
    await mintDeviceToken(api, INSTALL, 'n [3f2504e0]')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/admin/tokens',
      'DELETE /api/admin/tokens/3/revoke',
      'POST /api/admin/tokens',
    ])
  })

  it('does not mint when a previous token cannot be revoked', async () => {
    const { api, calls } = fakeApi({
      'GET /api/admin/tokens': ok([row(3, 'Old [3f2504e0]')]),
      'DELETE /api/admin/tokens/3/revoke': { ok: false, status: 500, body: null },
    })
    await expect(mintDeviceToken(api, INSTALL, 'n')).rejects.toThrow(/revoking the previous device token 3 answered HTTP 500/)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('stops when the token list cannot be read (a 403 is not "no tokens")', async () => {
    const { api, calls } = fakeApi({ 'GET /api/admin/tokens': { ok: false, status: 403, body: { error: 'forbidden' } } })
    await expect(mintDeviceToken(api, INSTALL, 'n')).rejects.toThrow(/listing the dashboard tokens answered HTTP 403/)
    expect(calls).toHaveLength(1)
  })

  it('reports the API hint when the mint is refused, as a RemoteEnrollError', async () => {
    const { api } = fakeApi({
      'GET /api/admin/tokens': ok([]),
      'POST /api/admin/tokens': { ok: false, status: 400, body: { error: 'required', hint: 'name is required' } },
    })
    const err = await mintDeviceToken(api, INSTALL, '').catch((e) => e)
    expect(err).toBeInstanceOf(RemoteEnrollError)
    expect(err.message).toBe('minting the device token answered HTTP 400 (name is required)')
  })

  it('refuses a 2xx answer that carries no token', async () => {
    const { api } = fakeApi({ 'GET /api/admin/tokens': ok([]), 'POST /api/admin/tokens': ok({ ok: true }, 201) })
    await expect(mintDeviceToken(api, INSTALL, 'n')).rejects.toThrow(/minting the device token answered HTTP 201/)
  })
})

describe('deviceTokenName', () => {
  it('is the label plus the install tag, with a default label', () => {
    expect(deviceTokenName('Office phone', INSTALL)).toBe('Office phone [3f2504e0]')
    expect(deviceTokenName('  ', INSTALL)).toBe('device [3f2504e0]')
    expect(deviceTokenName(undefined, INSTALL)).toBe('device [3f2504e0]')
  })
})
