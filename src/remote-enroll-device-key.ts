// The dashboard token a remote-enroll bundle carries (the CLI side of the pairing).
//
// The bundle gets a token minted for ONE device: an admin-role api_tokens row (what the shared
// token gave the device until now), named after the device and revocable on its own from the
// dashboard (DELETE /api/admin/tokens/:id/revoke). The shared dashboard token never goes into a
// bundle. The CLI reaches the dashboard through an injected API client, so this stays pure and
// testable; the client is whatever the caller signs requests with (the operator's token, in
// scripts/remote-access-enroll.ts).

import { RemoteEnrollError } from './remote-enroll-core.js'

export interface DeviceTokenApiResult {
  ok: boolean
  status: number
  body: unknown
}
export type DeviceTokenApi = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<DeviceTokenApiResult>

/** The tag a token name ends with: the FULL install id, so a re-enrollment finds exactly its own predecessor (a prefix could collide). */
export function installTag(installId: string): string {
  return installId
}

/** Token name: a label for people plus the install id, e.g. `Office phone [3f2504e0-4f89-41d3-9a0c-0305e82c3301]`. */
export function deviceTokenName(label: string | undefined, installId: string): string {
  const base = (label ?? '').trim() || 'device'
  return `${base} [${installTag(installId)}]`
}

function fail(what: string, r: DeviceTokenApiResult): never {
  const hint = (r.body as { hint?: unknown } | null)?.hint
  throw new RemoteEnrollError(`${what} answered HTTP ${r.status}${typeof hint === 'string' ? ` (${hint})` : ''}`)
}

/**
 * Mint the admin token for this install id. Enrolling a device again gives it a fresh token: the
 * live token(s) already named for the same install id are revoked first. Returns the raw token,
 * which the dashboard discloses once.
 */
export async function mintDeviceToken(api: DeviceTokenApi, installId: string, name: string): Promise<string> {
  const listed = await api('GET', '/api/admin/tokens')
  const rows = listed.body
  if (!listed.ok || !Array.isArray(rows)) fail('listing the dashboard tokens', listed)
  const suffix = ` [${installTag(installId)}]`
  const prior = (rows as Array<{ id: number; name: string; role: string; revoked_at: number | null }>)
    .filter((t) => t.role === 'admin' && t.revoked_at === null && typeof t.name === 'string' && t.name.endsWith(suffix))
  for (const t of prior) {
    const gone = await api('DELETE', `/api/admin/tokens/${t.id}/revoke`)
    if (!gone.ok) fail(`revoking the previous device token ${t.id}`, gone)
  }

  const made = await api('POST', '/api/admin/tokens', { name, role: 'admin' })
  const token = (made.body as { token?: unknown } | null)?.token
  if (!made.ok || typeof token !== 'string' || token.length === 0) fail('minting the device token', made)
  return token
}
