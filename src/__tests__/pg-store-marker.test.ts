// The PostgreSQL install marker (src/db/pg/store-marker.ts, P-E): written once, mode 0644, the content names no URL, a second
// call does not rewrite it, a failed write returns false and does not throw (the boot goes on).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PG_MARKER_FILE, writePgInstalledMarker } from '../db/pg/store-marker.js'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-marker-')) })
afterEach(() => {
  chmodSync(dir, 0o755)
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('writePgInstalledMarker', () => {
  it('writes one line with the boot time, mode 0644, and no URL or secret', () => {
    const now = new Date('2026-11-28T10:00:00.000Z')
    expect(writePgInstalledMarker(dir, now)).toBe(true)
    const path = join(dir, PG_MARKER_FILE)
    expect(readFileSync(path, 'utf-8')).toBe('pg-installed 2026-11-28T10:00:00.000Z\n')
    expect(statSync(path).mode & 0o777).toBe(0o644)
    expect(readFileSync(path, 'utf-8')).not.toMatch(/postgres|password|@/i)
  })

  it('never rewrites an existing marker: the first boot time stays', () => {
    writePgInstalledMarker(dir, new Date('2026-11-28T10:00:00.000Z'))
    expect(writePgInstalledMarker(dir, new Date('2026-12-01T00:00:00.000Z'))).toBe(false)
    expect(readFileSync(join(dir, PG_MARKER_FILE), 'utf-8')).toBe('pg-installed 2026-11-28T10:00:00.000Z\n')
  })

  // root writes through a 0555 dir, so the chmod cell says nothing as root (nit 8): skipped there
  it.skipIf(process.getuid?.() === 0)('a store dir that cannot be written: false, no throw, and nothing is left behind', () => {
    const store = join(dir, 'store')
    mkdirSync(store)
    chmodSync(store, 0o555)
    expect(() => writePgInstalledMarker(store)).not.toThrow()
    expect(writePgInstalledMarker(store)).toBe(false)
    chmodSync(store, 0o755)
    expect(() => readFileSync(join(store, PG_MARKER_FILE), 'utf-8')).toThrow()
  })

  it('an isolated store dir gets its own marker and the live one is not touched', () => {
    const live = join(dir, 'live')
    const isolated = join(dir, 'isolated')
    mkdirSync(live)
    mkdirSync(isolated)
    writeFileSync(join(live, PG_MARKER_FILE), 'pg-installed 2026-11-01T00:00:00.000Z\n')
    expect(writePgInstalledMarker(isolated)).toBe(true)
    expect(readFileSync(join(live, PG_MARKER_FILE), 'utf-8')).toBe('pg-installed 2026-11-01T00:00:00.000Z\n')
  })
})
