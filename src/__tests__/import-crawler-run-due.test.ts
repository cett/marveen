// runDueImports() (0% covered before this test): the scheduler-tick entry
// point that decides WHICH enabled sources are overdue for a scan, and fires
// crawlSource() for each (non-blocking, fire-and-forget with a .catch()).
//
// crawlSource is a same-module internal call, not a call through the export
// namespace -- ESM module mocking cannot intercept it here. So this drives
// the real crawlSource() end-to-end for `type: 'local'` sources pointed at an
// empty temp directory: collectLocalFiles() finds nothing, the scan finishes
// in a handful of milliseconds with zero added/updated, and the only
// observable side effect worth asserting is the one runDueImports() itself
// is responsible for -- whether a source's `last_run_at` gets bumped at all,
// which is the tell for "was a crawl attempted".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { runDueImports } from '../web/import-crawler.js'

function createSource(
  db: ReturnType<typeof getDb>,
  id: string,
  opts: { intervalHours: number; lastRunAt: number | null; enabled?: number; path: string },
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
    VALUES (?, 'local', ?, ?, ?, ?, ?, ?, 'default')
  `).run(id, opts.path, opts.intervalHours, opts.enabled ?? 1, opts.lastRunAt, now, now)
}

function lastRunAt(db: ReturnType<typeof getDb>, id: string): number | null {
  const row = db.prepare('SELECT last_run_at FROM import_sources WHERE id = ?').get(id) as { last_run_at: number | null }
  return row.last_run_at
}

// crawlSource is fire-and-forget from runDueImports(); poll for its DB
// write (last_run_at changing away from the seeded value) instead of a
// fixed sleep, so the test is not a timing gamble.
async function waitForCrawl(db: ReturnType<typeof getDb>, id: string, seeded: number | null): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (lastRunAt(db, id) !== seeded) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`crawlSource never completed for source ${id}`)
}

describe('runDueImports', () => {
  let emptyDir: string

  beforeEach(() => {
    initDatabase(':memory:')
    emptyDir = mkdtempSync(join(tmpdir(), 'import-run-due-'))
  })

  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true })
  })

  it('crawls a source whose interval has elapsed since last_run_at', async () => {
    const db = getDb()
    const seeded = Math.floor(Date.now() / 1000) - 7200 // 2h ago
    createSource(db, 'due-src', { intervalHours: 1, lastRunAt: seeded, path: emptyDir })

    await runDueImports()
    await waitForCrawl(db, 'due-src', seeded)

    expect(lastRunAt(db, 'due-src')).not.toBe(seeded)
  })

  it('treats a never-run source (last_run_at null) as due', async () => {
    const db = getDb()
    createSource(db, 'never-run-src', { intervalHours: 24, lastRunAt: null, path: emptyDir })

    await runDueImports()
    await waitForCrawl(db, 'never-run-src', null)

    expect(lastRunAt(db, 'never-run-src')).not.toBeNull()
  })

  it('leaves a source alone when its interval has not elapsed yet', async () => {
    const db = getDb()
    const seeded = Math.floor(Date.now() / 1000) - 60 // 1 minute ago
    createSource(db, 'not-due-src', { intervalHours: 24, lastRunAt: seeded, path: emptyDir })

    await runDueImports()
    // No crawl should fire: give any errant async work a moment, then assert
    // the seeded value never moved.
    await new Promise((r) => setTimeout(r, 100))

    expect(lastRunAt(db, 'not-due-src')).toBe(seeded)
  })

  it('skips a disabled source even if its interval has elapsed', async () => {
    const db = getDb()
    const seeded = Math.floor(Date.now() / 1000) - 7200
    createSource(db, 'disabled-src', { intervalHours: 1, lastRunAt: seeded, path: emptyDir, enabled: 0 })

    await runDueImports()
    await new Promise((r) => setTimeout(r, 100))

    expect(lastRunAt(db, 'disabled-src')).toBe(seeded)
  })

  it('no enabled sources: resolves without throwing', async () => {
    await expect(runDueImports()).resolves.toBeUndefined()
  })
})
