// The crawler side of the blank-content guard. upsertImportMemory returns 'skipped_blank' (covered in
// memories-content-not-blank.test.ts); this drives the real crawlSource() over a local directory and pins what the
// crawler does with that answer: a source with no visible text counts as skipped (files_skipped_type, not
// files_skipped_hash), writes no memory, and leaves the memory an earlier scan produced from the same file as it was.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }))

import { crawlSource } from '../web/import-crawler.js'

const ZWSP = String.fromCodePoint(0x200b)
const SOURCE_ID = 'blank-src'

type AuditRow = {
  files_scanned: number; files_added: number; files_updated: number
  files_skipped_hash: number; files_skipped_type: number; error: string | null
}

const audit = (): AuditRow[] => getDb().prepare(
  'SELECT files_scanned, files_added, files_updated, files_skipped_hash, files_skipped_type, error FROM import_audit_log WHERE source_id = ? ORDER BY id',
).all(SOURCE_ID) as AuditRow[]

const importRows = (): { file_name: string; content: string; memory_shadow_id: number }[] => getDb().prepare(
  'SELECT file_name, content, memory_shadow_id FROM import_memories WHERE source_id = ? ORDER BY file_name',
).all(SOURCE_ID) as { file_name: string; content: string; memory_shadow_id: number }[]

describe('crawlSource with a source that has no visible text', () => {
  let dir: string

  useTestDb()
  beforeEach(() => {
    warn.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'import-blank-src-'))
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
      VALUES (?, 'local', ?, 24, 1, NULL, ?, ?, 'default')
    `).run(SOURCE_ID, dir, now, now)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('counts the blank files as skipped, imports only the real one, and logs why', async () => {
    writeFileSync(join(dir, 'real.txt'), 'notes about the coffee machine on the second floor')
    writeFileSync(join(dir, 'zero-width.txt'), `${ZWSP}${ZWSP}\n`)
    writeFileSync(join(dir, 'markup-only.html'), '<html><body><p></p><div> </div></body></html>')

    await crawlSource(SOURCE_ID)

    expect(audit()).toEqual([{
      files_scanned: 3, files_added: 1, files_updated: 0, files_skipped_hash: 0, files_skipped_type: 2, error: null,
    }])
    expect(importRows().map((r) => r.file_name)).toEqual(['real.txt'])
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sourceId: SOURCE_ID }), expect.stringContaining('no visible text'))
  })

  it('leaves the memory of an already imported file as it was when the file is emptied', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'notes about the coffee machine on the second floor')
    await crawlSource(SOURCE_ID)
    const before = importRows()
    expect(before).toHaveLength(1)
    const memoryBefore = getDb().prepare('SELECT id, content FROM memories WHERE id = ?').get(before[0].memory_shadow_id)

    writeFileSync(join(dir, 'notes.txt'), ZWSP)
    await crawlSource(SOURCE_ID)

    expect(audit()[1]).toMatchObject({ files_scanned: 1, files_added: 0, files_updated: 0, files_skipped_hash: 0, files_skipped_type: 1, error: null })
    expect(importRows()).toEqual(before)
    expect(getDb().prepare('SELECT id, content FROM memories WHERE id = ?').get(before[0].memory_shadow_id)).toEqual(memoryBefore)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sourceId: SOURCE_ID }), expect.stringContaining('no visible text'))
  })

  it('control: refilling the emptied file updates the memory again', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'first version of the notes')
    await crawlSource(SOURCE_ID)
    writeFileSync(join(dir, 'notes.txt'), ZWSP)
    await crawlSource(SOURCE_ID)
    writeFileSync(join(dir, 'notes.txt'), 'second version of the notes')
    await crawlSource(SOURCE_ID)

    expect(audit()[2]).toMatchObject({ files_added: 0, files_updated: 1, files_skipped_type: 0 })
    const row = importRows()[0]
    expect(row.content).toContain('second version')
    expect((getDb().prepare('SELECT content FROM memories WHERE id = ?').get(row.memory_shadow_id) as { content: string }).content).toContain('second version')
  })
})
