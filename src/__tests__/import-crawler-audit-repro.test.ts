// Reproduction probe for a reported bug: "import emlekek" run log empty --
// crawl runs (last_run_at updates) but import_audit_log never gets a row.
// Real DB (full migrations), real filesystem (a throwaway temp dir with one
// text file), real crawlSource() -- no mocking of db.js or node:fs, so any
// thrown error from writeAuditLog's INSERT surfaces for real instead of being
// swallowed by a mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { logger } from '../logger.js'
import { crawlSource } from '../web/import-crawler.js'

let tmpDir: string

beforeEach(() => {
  initDatabase(':memory:')
  tmpDir = mkdtempSync(join(tmpdir(), 'import-audit-repro-'))
  writeFileSync(join(tmpDir, 'note.txt'), 'quarterly budget notes for the team', 'utf-8')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function seedLocalSource(id: string): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
    VALUES (?, 'local', ?, 4, 1, ?, ?, 'default')
  `).run(id, tmpDir, now, now)
}

describe('crawlSource -- audit log reproduction', () => {
  it('writes an import_audit_log row on a successful crawl, matching the updated last_run_at', async () => {
    seedLocalSource('repro-1')
    await crawlSource('repro-1')

    const source = getDb().prepare('SELECT last_run_at FROM import_sources WHERE id = ?').get('repro-1') as any
    expect(source.last_run_at).not.toBeNull()

    const auditRows = getDb().prepare('SELECT * FROM import_audit_log WHERE source_id = ?').all('repro-1') as any[]
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].run_at).toBe(source.last_run_at)
    expect(auditRows[0].files_added).toBe(1)
  })

  it('writes an import_audit_log row (with error text) even when the source is unreadable', async () => {
    seedLocalSource('repro-2')
    // Point the source at a path that doesn't exist -- crawlLocalSource should
    // either throw (caught by crawlSource's outer catch) or return 0 counts;
    // either way, an audit row must exist afterward.
    getDb().prepare("UPDATE import_sources SET path = ? WHERE id = ?").run(join(tmpDir, 'does-not-exist'), 'repro-2')
    await crawlSource('repro-2')

    const auditRows = getDb().prepare('SELECT * FROM import_audit_log WHERE source_id = ?').all('repro-2') as any[]
    expect(auditRows.length).toBeGreaterThanOrEqual(1)
  })

  it('regression: a broken audit-log INSERT never breaks the crawl or the last_run_at update, and logs loudly instead of vanishing silently', async () => {
    seedLocalSource('repro-3')
    // Force writeAuditLog's INSERT to fail deterministically, simulating
    // whatever real-world condition made it fail in production without
    // needing to reproduce that exact condition.
    getDb().exec('DROP TABLE import_audit_log')

    await expect(crawlSource('repro-3')).resolves.toBeUndefined()

    const source = getDb().prepare('SELECT last_run_at FROM import_sources WHERE id = ?').get('repro-3') as any
    expect(source.last_run_at).not.toBeNull()
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'repro-3' }),
      expect.stringContaining('audit log'),
    )
  })
})
