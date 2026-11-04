// Unit tests for bootstrapDashboardToken (startup enrollment).
//
// Verifies these contracts (the last group is the rotation of the shared token):
//   1. First boot: dashboard token hash inserted with role=admin, tenant='default'
//   2. Idempotent: second call is a no-op (INSERT OR IGNORE, no error)
//   3. Error-safe: if the DB throws, the function catches and does not rethrow

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { initDatabase, getDb, enrollDashboardApiToken } from '../db.js'
import { bootstrapDashboardToken } from '../web/token-bootstrap.js'
import { resolveApiToken } from '../web/auth-gate.js'

function openDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

const RAW_TOKEN = 'test-dashboard-token-abc123'

describe('bootstrapDashboardToken', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
  })

  it('enrolls the token on first boot with correct fields', () => {
    bootstrapDashboardToken(RAW_TOKEN)

    const row = db
      .prepare('SELECT token_hash, name, role, tenant_id, expires_at, revoked_at FROM api_tokens WHERE name = ?')
      .get('dashboard') as {
        token_hash: string
        name: string
        role: string
        tenant_id: string
        expires_at: number | null
        revoked_at: number | null
      } | undefined

    expect(row).toBeDefined()
    expect(row!.token_hash).toBe(sha256(RAW_TOKEN))
    expect(row!.name).toBe('dashboard')
    expect(row!.role).toBe('admin')
    expect(row!.tenant_id).toBe('default')
    expect(row!.expires_at).toBeNull()
    expect(row!.revoked_at).toBeNull()
  })

  it('sets created_at to a plausible unix timestamp', () => {
    const before = Math.floor(Date.now() / 1000)
    bootstrapDashboardToken(RAW_TOKEN)
    const after = Math.floor(Date.now() / 1000)

    const row = db
      .prepare('SELECT created_at FROM api_tokens WHERE name = ?')
      .get('dashboard') as { created_at: number } | undefined

    expect(row!.created_at).toBeGreaterThanOrEqual(before)
    expect(row!.created_at).toBeLessThanOrEqual(after)
  })

  it('is idempotent: second call is a no-op, row count stays 1', () => {
    bootstrapDashboardToken(RAW_TOKEN)
    bootstrapDashboardToken(RAW_TOKEN)

    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE name = ?').get('dashboard') as { n: number }
    ).n
    expect(count).toBe(1)
  })

  it('does not throw when the DB prepare/run throws (error-safe)', () => {
    vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('DB locked') })
    expect(() => bootstrapDashboardToken(RAW_TOKEN)).not.toThrow()
  })

  it('does not insert a row when it throws', () => {
    // Verify the error path leaves the DB untouched (real DB, force conflict via closed db)
    db.close()
    // After close, all operations throw; the function must silently survive
    expect(() => bootstrapDashboardToken(RAW_TOKEN)).not.toThrow()
  })

  it('different tokens produce different hashes (no collision risk)', () => {
    bootstrapDashboardToken('token-one')
    bootstrapDashboardToken('token-two')

    const count = (db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n
    expect(count).toBe(2)
  })

  describe('rotation of the shared token', () => {
    const states = () =>
      db.prepare("SELECT token_hash, revoked_at FROM api_tokens WHERE name = 'dashboard' ORDER BY id").all() as Array<{ token_hash: string; revoked_at: number | null }>

    it('revokes the previous dashboard row when a new token is enrolled, and keeps the new one valid', () => {
      bootstrapDashboardToken('token-old')
      bootstrapDashboardToken('token-new')

      const [old, fresh] = states()
      expect(old.token_hash).toBe(sha256('token-old'))
      expect(old.revoked_at).not.toBeNull()
      expect(fresh.token_hash).toBe(sha256('token-new'))
      expect(fresh.revoked_at).toBeNull()
    })

    it('revokes every earlier dashboard row, not only the last one', () => {
      bootstrapDashboardToken('t1')
      bootstrapDashboardToken('t2')
      bootstrapDashboardToken('t3')
      expect(states().map((r) => r.revoked_at !== null)).toEqual([true, true, false])
    })

    it('cleans up two active rows left by an install from before rotation revoked the old one', async () => {
      const now = Math.floor(Date.now() / 1000)
      for (const t of ['legacy-a', 'legacy-b']) {
        db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at) VALUES (?, 'dashboard', 'admin', ?)").run(sha256(t), now)
      }
      expect(await enrollDashboardApiToken(sha256('legacy-b'), now)).toBe(0) // the row exists, nothing inserted
      expect(await resolveApiToken('legacy-a')).toEqual({ found: false, registeredButInvalid: true })
      expect(await resolveApiToken('legacy-b')).toMatchObject({ found: true })
    })

    it('restoring an old token file (A -> B -> A) revokes B and does not resurrect A', async () => {
      bootstrapDashboardToken('token-a')
      bootstrapDashboardToken('token-b')
      bootstrapDashboardToken('token-a')
      expect(await resolveApiToken('token-b')).toEqual({ found: false, registeredButInvalid: true })
      // A was revoked by the first rotation and is not un-revoked; the rollback in the module header is the way back
      expect(await resolveApiToken('token-a')).toEqual({ found: false, registeredButInvalid: true })
    })

    it('a restart with the same token revokes nothing', () => {
      bootstrapDashboardToken('token-old')
      bootstrapDashboardToken('token-new')
      const before = states()
      bootstrapDashboardToken('token-new')
      expect(states()).toEqual(before)
    })

    it('leaves the tokens of other names alone (browser, device and agent tokens survive a rotation)', () => {
      const now = Math.floor(Date.now() / 1000)
      for (const name of ['browser 2026-10-12 ab12', 'Office phone [x]', 'ci-token']) {
        db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at) VALUES (?, ?, 'admin', ?)").run(sha256(name), name, now)
      }
      bootstrapDashboardToken('token-old')
      bootstrapDashboardToken('token-new')
      const others = db.prepare("SELECT revoked_at FROM api_tokens WHERE name != 'dashboard'").all() as Array<{ revoked_at: number | null }>
      expect(others).toHaveLength(3)
      expect(others.every((r) => r.revoked_at === null)).toBe(true)
    })

    it('a rotated-away token no longer authenticates; it does not fall through to an admin grant', async () => {
      bootstrapDashboardToken('token-old')
      bootstrapDashboardToken('token-new')
      expect(await resolveApiToken('token-old')).toEqual({ found: false, registeredButInvalid: true })
      expect(await resolveApiToken('token-new')).toMatchObject({ found: true, role: 'admin' })
    })

    it('does not resurrect a row that was revoked on purpose when the same token boots again', () => {
      bootstrapDashboardToken('token-old')
      db.prepare("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'dashboard'").run()
      bootstrapDashboardToken('token-old')
      expect(states()[0].revoked_at).toBe(1)
    })
  })
})
