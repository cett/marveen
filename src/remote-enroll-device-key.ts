// The dashboard device key a remote-enroll bundle carries (the CLI side of the pairing).
//
// The bundle gets a key minted for ONE device -- named, revocable one by one -- and never the
// shared dashboard token. The CLI reaches the dashboard through an injected API client, so this
// stays pure and testable; the client is whatever the caller signs requests with (the operator's
// token, in scripts/remote-access-enroll.ts).

import { RemoteEnrollError } from './remote-enroll-core.js'

export interface DeviceKeyApiResult {
  ok: boolean
  status: number
  body: unknown
}
export type DeviceKeyApi = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<DeviceKeyApiResult>

/** Default device-key name: stable per install id, valid for the API's name rule. */
export function defaultDeviceKeyName(installId: string): string {
  return `device-${installId.slice(0, 8)}`
}

function fail(what: string, r: DeviceKeyApiResult): never {
  const hint = (r.body as { hint?: unknown } | null)?.hint
  throw new RemoteEnrollError(`${what} answered HTTP ${r.status}${typeof hint === 'string' ? ` (${hint})` : ''}`)
}

/**
 * Mint the device key for this install id. Enrolling a device again gives it a fresh key: the
 * key(s) already linked to the same install id are revoked first (that revoke also drops the
 * matching authorized_keys line, which the enrollment writes again right after). Returns the raw
 * key, which the dashboard discloses once.
 */
export async function mintDeviceKey(api: DeviceKeyApi, installId: string, name: string): Promise<string> {
  const listed = await api('GET', '/api/auth/device-keys')
  if (!listed.ok) fail('listing the device keys', listed)
  const keys = (listed.body as { keys?: Array<{ id: number; installId: string | null }> } | null)?.keys ?? []
  for (const k of keys.filter((x) => x.installId === installId)) {
    const gone = await api('DELETE', `/api/auth/device-keys/${k.id}`)
    if (!gone.ok) fail(`revoking the previous device key ${k.id}`, gone)
  }

  const made = await api('POST', '/api/auth/device-keys', { name, install_id: installId })
  const key = (made.body as { key?: unknown } | null)?.key
  if (!made.ok || typeof key !== 'string' || key.length === 0) fail('minting the device key', made)
  return key
}
