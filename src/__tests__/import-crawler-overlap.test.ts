// crawlSource keeps one scan per source: the guard (runningScans) is taken before the first await. The source
// lookup is asynchronous (db facade), so a guard taken after it would let two overlapping calls for one source
// both pass the check and run the same crawl twice (twice the size-cap budget, twice the writes).
// The overlap is a holder, not a timing: the first call is parked inside its source lookup, and the second call starts
// while the first one is still in that window. The guard is in-process, so this is the same on both engines.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbx } from '../db/facade.js'
import { useTestDb } from './helpers/with-test-db.js'
import { interleave } from './helpers/interleave.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { crawlSource } from '../web/import-crawler.js'

useTestDb()

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'import-overlap-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

async function createSource(id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
    VALUES (?, 'local', ?, 4, 1, NULL, ?, ?, 'default')
  `, id, dir, now, now)
}

const auditRows = async (id: string): Promise<number> =>
  (await dbx.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM import_audit_log WHERE source_id = ?', id))?.n as number

// Parks the first source lookup (the first call that reads import_sources) until the test opens it.
function parkFirstLookup(il: ReturnType<typeof interleave>): void {
  const real = dbx.get.bind(dbx) as (...a: unknown[]) => Promise<unknown>
  let parked = false
  vi.spyOn(dbx, 'get').mockImplementation((async (sql: string, ...a: unknown[]) => {
    if (!parked && /FROM import_sources/.test(sql)) {
      parked = true
      await il.pass('lookup-parked')
    }
    return real(sql, ...a)
  }) as never)
}

describe('crawlSource: one scan per source', () => {
  it('two overlapping calls for one source run one crawl', async () => {
    await createSource('src-a')
    const il = interleave()
    il.hold('lookup-parked')
    parkFirstLookup(il)
    const first = crawlSource('src-a')
    await il.reached('lookup-parked')
    // the second call starts inside the first one's lookup: the guard is already taken, so it returns at once
    await crawlSource('src-a')
    il.open('lookup-parked')
    await first
    expect(await auditRows('src-a')).toBe(1)
  })

  it('different sources do not block each other', async () => {
    await createSource('src-a')
    await createSource('src-b')
    const il = interleave()
    il.hold('lookup-parked')
    parkFirstLookup(il)
    const first = crawlSource('src-a')
    await il.reached('lookup-parked')
    // src-a is parked in its lookup; src-b is not blocked by it
    await crawlSource('src-b')
    il.open('lookup-parked')
    await first
    expect(await auditRows('src-a')).toBe(1)
    expect(await auditRows('src-b')).toBe(1)
  })

  it('an unknown source releases the guard: the source created later can be crawled', async () => {
    await crawlSource('src-late')
    await createSource('src-late')

    await crawlSource('src-late')

    expect(await auditRows('src-late')).toBe(1)
  })

  it('a failing source lookup releases the guard: the next call for the same source still crawls', async () => {
    await createSource('src-a')
    const lookup = vi.spyOn(dbx, 'get').mockRejectedValueOnce(new Error('db down'))

    await expect(crawlSource('src-a')).rejects.toThrow('db down')
    lookup.mockRestore()
    await crawlSource('src-a')

    expect(await auditRows('src-a')).toBe(1)
  })

  it('a finished crawl releases the guard: the next call crawls again', async () => {
    await createSource('src-a')

    await crawlSource('src-a')
    await crawlSource('src-a')

    expect(await auditRows('src-a')).toBe(2)
  })
})
