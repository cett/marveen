import { describe, it, expect } from 'vitest'
import { defaultDeviceKeyName, mintDeviceKey, type DeviceKeyApi, type DeviceKeyApiResult } from '../remote-enroll-device-key.js'
import { RemoteEnrollError } from '../remote-enroll-core.js'

const INSTALL = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER = '9b2f6a58-1c0e-4d37-8a55-6f1d2c3b4a90'

interface Call { method: string; path: string; body?: unknown }

/** A scripted dashboard: answers by "METHOD path", records every call in order. */
function fakeApi(answers: Record<string, DeviceKeyApiResult>): { api: DeviceKeyApi; calls: Call[] } {
  const calls: Call[] = []
  const api: DeviceKeyApi = async (method, path, body) => {
    calls.push({ method, path, body })
    return answers[`${method} ${path}`] ?? { ok: false, status: 404, body: null }
  }
  return { api, calls }
}

const ok = (body: unknown, status = 200): DeviceKeyApiResult => ({ ok: true, status, body })

describe('mintDeviceKey', () => {
  it('mints a named key linked to the install id and returns the raw key', async () => {
    const { api, calls } = fakeApi({
      'GET /api/auth/device-keys': ok({ keys: [] }),
      'POST /api/auth/device-keys': ok({ ok: true, id: 7, key: 'mvdk_abc' }, 201),
    })
    await expect(mintDeviceKey(api, INSTALL, 'Office phone')).resolves.toBe('mvdk_abc')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/auth/device-keys', 'POST /api/auth/device-keys'])
    expect(calls[1].body).toEqual({ name: 'Office phone', install_id: INSTALL })
  })

  it('revokes the earlier key of the SAME install id, before minting, and leaves other devices alone', async () => {
    const { api, calls } = fakeApi({
      'GET /api/auth/device-keys': ok({
        keys: [
          { id: 3, installId: INSTALL },
          { id: 4, installId: OTHER },
          { id: 5, installId: null },
          { id: 6, installId: INSTALL },
        ],
      }),
      'DELETE /api/auth/device-keys/3': ok({ ok: true }),
      'DELETE /api/auth/device-keys/6': ok({ ok: true }),
      'POST /api/auth/device-keys': ok({ key: 'mvdk_new' }, 201),
    })
    await mintDeviceKey(api, INSTALL, 'n')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/auth/device-keys',
      'DELETE /api/auth/device-keys/3',
      'DELETE /api/auth/device-keys/6',
      'POST /api/auth/device-keys',
    ])
  })

  it('does not mint when a previous key cannot be revoked', async () => {
    const { api, calls } = fakeApi({
      'GET /api/auth/device-keys': ok({ keys: [{ id: 3, installId: INSTALL }] }),
      'DELETE /api/auth/device-keys/3': { ok: false, status: 500, body: null },
    })
    await expect(mintDeviceKey(api, INSTALL, 'n')).rejects.toThrow(/revoking the previous device key 3 answered HTTP 500/)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('reports the API hint when the mint is refused, as a RemoteEnrollError', async () => {
    const { api } = fakeApi({
      'GET /api/auth/device-keys': ok({ keys: [] }),
      'POST /api/auth/device-keys': { ok: false, status: 400, body: { error: 'invalid_value', hint: '1-64 chars: letters, digits, space, . _ -' } },
    })
    const err = await mintDeviceKey(api, INSTALL, 'bad/name').catch((e) => e)
    expect(err).toBeInstanceOf(RemoteEnrollError)
    expect(err.message).toBe('minting the device key answered HTTP 400 (1-64 chars: letters, digits, space, . _ -)')
  })

  it('refuses a 2xx answer that carries no key', async () => {
    const { api } = fakeApi({
      'GET /api/auth/device-keys': ok({ keys: [] }),
      'POST /api/auth/device-keys': ok({ ok: true }, 201),
    })
    await expect(mintDeviceKey(api, INSTALL, 'n')).rejects.toThrow(/minting the device key answered HTTP 201/)
  })

  it('stops when the key list cannot be read (a 403 is not "no keys")', async () => {
    const { api, calls } = fakeApi({ 'GET /api/auth/device-keys': { ok: false, status: 403, body: { error: 'forbidden' } } })
    await expect(mintDeviceKey(api, INSTALL, 'n')).rejects.toThrow(/listing the device keys answered HTTP 403/)
    expect(calls).toHaveLength(1)
  })
})

describe('defaultDeviceKeyName', () => {
  it('is device- plus the first 8 characters of the install id, and valid for the name rule', () => {
    const name = defaultDeviceKeyName(INSTALL)
    expect(name).toBe('device-3f2504e0')
    expect(name).toMatch(/^[A-Za-z0-9 ._-]{1,64}$/)
  })
})
