// The coordinator's database boot (channel-coordinator/boot.ts) on an install: the default is the install's SQLite file, and
// on a PostgreSQL install that file must not be opened (the dashboard reads PostgreSQL, so events written there are lost).
// Cells: the default path is refused with a PostgreSQL URL set (and nothing is created in the store); a named file (':memory:')
// is still allowed, since it is not an install entry point; with no URL the default opens the SQLite file as before.
// The snapshot is set to an empty one so that config.ts can be imported with the URL set (the snapshot step is not the subject).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PG_URL = 'postgres://user:placeholder-password-c3f@db.invalid:5432/marveen'
let scratch = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zack-ingest-entry-'))
  mkdirSync(join(scratch, 'store'))
  vi.stubEnv('MARVEEN_STORE_DIR', join(scratch, 'store'))
  vi.stubEnv('CLAUDECLAW_ENV_DIR', join(scratch, 'envdir'))
  vi.stubEnv('MARVEEN_PG_URL', '')
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

async function loadConnection(): Promise<typeof import('../db/connection.js')> {
  const snapshot = await import('../config-snapshot.js')
  snapshot.setConfigSnapshot({})
  return import('../db/connection.js')
}

describe('the coordinator process database on an install', () => {
  it('with a PostgreSQL URL, the default SQLite path is refused and no file is created', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    const connection = await loadConnection()
    expect(() => connection.initProcessDatabase()).toThrow(/initProcessDatabase\(\)/)
    expect(existsSync(join(scratch, 'store', 'claudeclaw.db'))).toBe(false)
  })

  it('with a PostgreSQL URL, a named file is still allowed (it is not an install entry point)', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    const connection = await loadConnection()
    expect(() => connection.initProcessDatabase(':memory:')).not.toThrow()
    connection.closeDatabase()
  })

  it('with no URL, the default opens the SQLite file under the store directory, as before', async () => {
    const connection = await loadConnection()
    connection.initProcessDatabase()
    expect(existsSync(join(scratch, 'store', 'claudeclaw.db'))).toBe(true)
    connection.closeDatabase()
  })
})
