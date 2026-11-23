// Unit tests for bootstrapDashboardToken (startup enrollment), on both engines (useTestDb).
//
// Verifies these contracts (the last group is the rotation of the shared token):
//   1. First boot: dashboard token hash inserted with role=admin, tenant='default'
//   2. Idempotent: second call is a no-op (ON CONFLICT DO NOTHING, no error)
//   3. Error-safe: if the DB throws, the function catches and does not rethrow

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { dbx, enrollDashboardApiToken } from '../db.js'
import { bootstrapDashboardToken } from '../web/token-bootstrap.js'
import { resolveApiToken } from '../web/auth-gate.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

const RAW_TOKEN = 'test-dashboard-token-abc123'

const states = () =>
  dbx.all<{ token_hash: string; revoked_at: number | null }>(
    "SELECT token_hash, revoked_at FROM api_tokens WHERE name = 'dashboard' ORDER BY id",
  )

describe('bootstrapDashboardToken', () => {
  it('enrolls the token on first boot with correct fields', async () => {
    await bootstrapDashboardToken(RAW_TOKEN)

    const row = await dbx.get<{
      token_hash: string
      name: string
      role: string
      tenant_id: string
      expires_at: number | null
      revoked_at: number | null
    }>('SELECT token_hash, name, role, tenant_id, expires_at, revoked_at FROM api_tokens WHERE name = ?', 'dashboard')

    expect(row).toBeDefined()
    expect(row!.token_hash).toBe(sha256(RAW_TOKEN))
    expect(row!.name).toBe('dashboard')
    expect(row!.role).toBe('admin')
    expect(row!.tenant_id).toBe('default')
    expect(row!.expires_at).toBeNull()
    expect(row!.revoked_at).toBeNull()
  })

  it('sets created_at to a plausible unix timestamp', async () => {
    const before = Math.floor(Date.now() / 1000)
    await bootstrapDashboardToken(RAW_TOKEN)
    const after = Math.floor(Date.now() / 1000)

    const row = await dbx.get<{ created_at: number }>('SELECT created_at FROM api_tokens WHERE name = ?', 'dashboard')

    expect(row!.created_at).toBeGreaterThanOrEqual(before)
    expect(row!.created_at).toBeLessThanOrEqual(after)
  })

  it('is idempotent: second call is a no-op, row count stays 1', async () => {
    await bootstrapDashboardToken(RAW_TOKEN)
    await bootstrapDashboardToken(RAW_TOKEN)

    const count = await dbx.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_tokens WHERE name = ?', 'dashboard')
    expect(Number(count!.n)).toBe(1)
  })

  it('does not throw when the DB transaction throws (error-safe), and inserts no row', async () => {
    const spy = vi.spyOn(dbx, 'tx').mockImplementation(() => { throw new Error('DB locked') })
    try {
      await expect(bootstrapDashboardToken(RAW_TOKEN)).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(await states()).toEqual([])
  })

  it('different tokens produce different hashes (no collision risk)', async () => {
    await bootstrapDashboardToken('token-one')
    await bootstrapDashboardToken('token-two')

    const hashes = (await states()).map((r) => r.token_hash).sort()
    expect(hashes).toEqual([sha256('token-one'), sha256('token-two')].sort())
  })

  describe('rotation of the shared token', () => {
    it('revokes the previous dashboard row when a new token is enrolled, and keeps the new one valid', async () => {
      await bootstrapDashboardToken('token-old')
      await bootstrapDashboardToken('token-new')

      const [old, fresh] = await states()
      expect(old.token_hash).toBe(sha256('token-old'))
      expect(old.revoked_at).not.toBeNull()
      expect(fresh.token_hash).toBe(sha256('token-new'))
      expect(fresh.revoked_at).toBeNull()
    })

    it('revokes every earlier dashboard row, not only the last one', async () => {
      await bootstrapDashboardToken('t1')
      await bootstrapDashboardToken('t2')
      await bootstrapDashboardToken('t3')
      expect((await states()).map((r) => r.revoked_at !== null)).toEqual([true, true, false])
    })

    it('cleans up two active rows left by an install from before rotation revoked the old one', async () => {
      const now = Math.floor(Date.now() / 1000)
      for (const t of ['legacy-a', 'legacy-b']) {
        await dbx.run("INSERT INTO api_tokens (token_hash, name, role, created_at) VALUES (?, 'dashboard', 'admin', ?)", sha256(t), now)
      }
      expect(await enrollDashboardApiToken(sha256('legacy-b'), now)).toBe(0) // the row exists, nothing inserted
      expect(await resolveApiToken('legacy-a')).toEqual({ found: false, registeredButInvalid: true })
      expect(await resolveApiToken('legacy-b')).toMatchObject({ found: true })
    })

    it('restoring an old token file (A -> B -> A) revokes B and does not resurrect A', async () => {
      await bootstrapDashboardToken('token-a')
      await bootstrapDashboardToken('token-b')
      await bootstrapDashboardToken('token-a')
      expect(await resolveApiToken('token-b')).toEqual({ found: false, registeredButInvalid: true })
      // A was revoked by the first rotation and is not un-revoked; the rollback in the module header is the way back
      expect(await resolveApiToken('token-a')).toEqual({ found: false, registeredButInvalid: true })
    })

    it('a restart with the same token revokes nothing', async () => {
      await bootstrapDashboardToken('token-old')
      await bootstrapDashboardToken('token-new')
      const before = await states()
      await bootstrapDashboardToken('token-new')
      expect(await states()).toEqual(before)
    })

    it('leaves the tokens of other names alone (browser, device and agent tokens survive a rotation)', async () => {
      const now = Math.floor(Date.now() / 1000)
      for (const name of ['browser 2026-10-12 ab12', 'Office phone [x]', 'ci-token']) {
        await dbx.run("INSERT INTO api_tokens (token_hash, name, role, created_at) VALUES (?, ?, 'admin', ?)", sha256(name), name, now)
      }
      await bootstrapDashboardToken('token-old')
      await bootstrapDashboardToken('token-new')
      const others = await dbx.all<{ revoked_at: number | null }>("SELECT revoked_at FROM api_tokens WHERE name != 'dashboard'")
      expect(others).toHaveLength(3)
      expect(others.every((r) => r.revoked_at === null)).toBe(true)
    })

    it('a rotated-away token no longer authenticates; it does not fall through to an admin grant', async () => {
      await bootstrapDashboardToken('token-old')
      await bootstrapDashboardToken('token-new')
      expect(await resolveApiToken('token-old')).toEqual({ found: false, registeredButInvalid: true })
      expect(await resolveApiToken('token-new')).toMatchObject({ found: true, role: 'admin' })
    })

    it('does not resurrect a row that was revoked on purpose when the same token boots again', async () => {
      await bootstrapDashboardToken('token-old')
      await dbx.run("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'dashboard'")
      await bootstrapDashboardToken('token-old')
      expect((await states())[0].revoked_at).toBe(1)
    })
  })
})
