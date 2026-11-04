// crawlSource keeps one scan per source: the guard (runningScans) is taken before the first await. The source
// lookup is asynchronous (db facade), so a guard taken after it would let two overlapping calls for one source
// both pass the check and run the same crawl twice (twice the size-cap budget, twice the writes).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../db.js'
import { dbx } from '../db/facade.js'
import { useTestDb } from './helpers/with-test-db.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { crawlSource } from '../web/import-crawler.js'

useTestDb()

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'import-overlap-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function createSource(id: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
    VALUES (?, 'local', ?, 4, 1, NULL, ?, ?, 'default')
  `).run(id, dir, now, now)
}

const auditRows = (id: string): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM import_audit_log WHERE source_id = ?').get(id) as { n: number }).n

describe('crawlSource: one scan per source', () => {
  it('two overlapping calls for one source run one crawl', async () => {
    createSource('src-a')

    await Promise.all([crawlSource('src-a'), crawlSource('src-a')])

    expect(auditRows('src-a')).toBe(1)
  })

  it('different sources do not block each other', async () => {
    createSource('src-a')
    createSource('src-b')

    await Promise.all([crawlSource('src-a'), crawlSource('src-b')])

    expect(auditRows('src-a')).toBe(1)
    expect(auditRows('src-b')).toBe(1)
  })

  it('an unknown source releases the guard: the source created later can be crawled', async () => {
    await crawlSource('src-late')
    createSource('src-late')

    await crawlSource('src-late')

    expect(auditRows('src-late')).toBe(1)
  })

  it('a failing source lookup releases the guard: the next call for the same source still crawls', async () => {
    createSource('src-a')
    const lookup = vi.spyOn(dbx, 'get').mockRejectedValueOnce(new Error('db down'))

    await expect(crawlSource('src-a')).rejects.toThrow('db down')
    lookup.mockRestore()
    await crawlSource('src-a')

    expect(auditRows('src-a')).toBe(1)
  })

  it('a finished crawl releases the guard: the next call crawls again', async () => {
    createSource('src-a')

    await crawlSource('src-a')
    await crawlSource('src-a')

    expect(auditRows('src-a')).toBe(2)
  })
})
