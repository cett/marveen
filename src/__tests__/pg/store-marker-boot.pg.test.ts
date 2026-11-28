// The PostgreSQL boot writes the install marker (P-E) as the application role on the test server (never the live 5432):
// written once in the store dir of the process, the boot goes on when the store dir cannot be written, a second boot keeps
// the first marker. Neutral fixtures; the store is a throwaway directory.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk, mkdirSync: mkd } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: jn } = require('node:path') as typeof import('node:path')
  const root = mk(jn(td(), 'store-marker-boot-'))
  const store = jn(root, 'store')
  mkd(store, { recursive: true })
  return { STORE: store }
})

vi.mock('../../paths.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../paths.js')>()), STORE_DIR: STORE }))

import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { resetPgCredentialCaptureForTests } from '../../db/pg/url.js'
import { PG_MARKER_FILE } from '../../db/pg/store-marker.js'

const made: PgTestDb[] = []
const markerPath = join(STORE, PG_MARKER_FILE)

beforeEach(() => {
  rmSync(markerPath, { force: true })
  chmodSync(STORE, 0o755)
})
afterEach(async () => {
  await closePgBackend()
  resetPgCredentialCaptureForTests()
  chmodSync(STORE, 0o755)
})
afterAll(async () => {
  for (const d of made) await d.close()
  rmSync(join(STORE, '..'), { recursive: true, force: true })
})

async function db(): Promise<PgTestDb> {
  const d = await createPgTestDb()
  made.push(d)
  return d
}

describe('the PostgreSQL boot writes the install marker once, and only when asked (opt-in)', () => {
  it('a boot without the option writes no marker (a test or a CLI helper never marks the checkout it runs in)', async () => {
    const d = await db()
    await bootPgBackend({ url: d.appUrl, migrateUrl: '' })
    expect((await d.pool.query('SELECT 1 AS one')).rows[0].one).toBe(1)
    expect(() => readFileSync(markerPath, 'utf-8')).toThrow()
  })

  it('the first boot with the option writes it: one line, mode 0644, no URL in it', async () => {
    const d = await db()
    await bootPgBackend({ url: d.appUrl, migrateUrl: '', writeInstallMarker: true })
    expect(readFileSync(markerPath, 'utf-8')).toMatch(/^pg-installed \d{4}-\d{2}-\d{2}T/)
    expect(statSync(markerPath).mode & 0o777).toBe(0o644)
    expect(readFileSync(markerPath, 'utf-8')).not.toContain(d.appUrl)
  })

  it('a second boot keeps the first marker unchanged', async () => {
    const d = await db()
    await bootPgBackend({ url: d.appUrl, migrateUrl: '', writeInstallMarker: true })
    const first = readFileSync(markerPath, 'utf-8')
    await closePgBackend()
    await new Promise((r) => setTimeout(r, 15))
    await bootPgBackend({ url: d.appUrl, migrateUrl: '', writeInstallMarker: true })
    expect(readFileSync(markerPath, 'utf-8')).toBe(first)
  })

  it('a store dir that cannot be written does not stop the boot: the backend is up and no marker exists', async () => {
    const d = await db()
    chmodSync(STORE, 0o555)
    await bootPgBackend({ url: d.appUrl, migrateUrl: '', writeInstallMarker: true })
    expect((await d.pool.query('SELECT 1 AS one')).rows[0].one).toBe(1)
    expect(() => readFileSync(markerPath, 'utf-8')).toThrow()
  })
})
