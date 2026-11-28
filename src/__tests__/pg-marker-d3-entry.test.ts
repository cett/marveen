// Decision D3 (P-E): the SQLite entry of the app refuses when the store holds the PostgreSQL install marker, with no
// configuration layer left. The refusal names the marker and the two steps (set the URL where it lives; the way back to
// SQLite is a written manual step). A marker that cannot be read counts as present (doubt is PostgreSQL).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return { STORE: mk(`${td()}/d3-marker-store-`) }
})

vi.mock('../paths.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../paths.js')>()), STORE_DIR: STORE }))

import { assertSqliteEntryAllowed, SqliteEntryRefusedError } from '../db/pg/url.js'

const marker = join(STORE, '.pg-installed')

beforeEach(() => {
  vi.stubEnv('MARVEEN_PG_URL', '')
  vi.stubEnv('MARVEEN_PG_CONFIGURED', '')
  vi.stubEnv('CLAUDECLAW_ENV_DIR', join(STORE, 'no-env-here'))
  vi.stubEnv('SECRET_MOUNT_DIR', join(STORE, 'no-secrets-here'))
  chmodSync(STORE, 0o755)
  rmSync(marker, { force: true })
})
afterEach(() => {
  chmodSync(STORE, 0o755)
  rmSync(marker, { force: true })
  vi.unstubAllEnvs()
})

describe('decision D3: the SQLite entry refuses on the install marker', () => {
  it('no marker and no configuration: the SQLite entry is allowed as before', () => {
    expect(() => assertSqliteEntryAllowed('the test entry')).not.toThrow()
  })

  it('the marker alone, with no URL and no variable: refused, and the message names the marker and both steps', () => {
    writeFileSync(marker, 'pg-installed 2026-11-28T00:00:00.000Z\n')
    let err: unknown
    try {
      assertSqliteEntryAllowed('the test entry')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SqliteEntryRefusedError)
    const message = (err as Error).message
    expect(message).toContain('store/.pg-installed')
    expect(message).toContain('Where the URLs live')
    expect(message).toContain('unset MARVEEN_PG_URL and delete store/.pg-installed by hand')
    expect(message).not.toContain('postgres://')
  })

  // root reads through a 0000 dir, so the chmod cell says nothing as root (nit 8): skipped there
  it.skipIf(process.getuid?.() === 0)('an unreadable store (the marker cannot be stat-ed) counts as present: refused', () => {
    chmodSync(STORE, 0o000)
    try {
      expect(() => assertSqliteEntryAllowed('the test entry')).toThrow(SqliteEntryRefusedError)
    } finally {
      chmodSync(STORE, 0o755)
    }
  })
})
