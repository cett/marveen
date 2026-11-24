// The backstop of the copy tool (P-G1): the orphan scan is bypassed here (injected), so an orphan row reaches PostgreSQL. The
// row-level policy (via_parent) refuses it with SQLSTATE 42501; the copy must name the row by rowid and say what the code
// means, roll back, and write nothing. The scan is the complete list; this is the net behind it.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { runCopy } from '../../db/pg-copy/copy.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

// The scan is replaced by an empty one: the orphan row must get through to PostgreSQL, which is what the backstop is for.
vi.mock('../../db/pg-copy/orphans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/pg-copy/orphans.js')>()
  return { ...actual, scanOrphans: vi.fn(() => ({ findings: [], orphans: new Map(), problems: [] })) }
})

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

let target: PgTestDb | undefined

afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

describe('the backstop: PostgreSQL refuses an orphan the scan did not find', () => {
  it('a row-level refusal (42501) names the table and the rowid, carries the RLS hint, and writes nothing', async () => {
    target = await createPgTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'pgcopy-backstop-'))
    dirs.push(dir)
    const sqlitePath = join(dir, 'source.db')
    const db = new Database(sqlitePath)
    applyMigrations(db)
    db.pragma('foreign_keys = OFF')
    db.exec(`INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type) VALUES (999, 'VALUE-SECRET-BS-1', 'c', 1, 'agent-a', 'create')`)
    db.close()

    const report = await runCopy({ sqlitePath, pgUrl: target.ownerUrl, dryRun: false })
    expect(report.committed).toBe(false)
    expect(report.failure).toEqual(
      expect.objectContaining({
        table: 'memory_versions',
        rowid: '1',
        sqlstate: '42501',
        hint: expect.stringMatching(/row-level security refused the row: a via_parent policy found no parent row/),
      }),
    )
    expect(report.failure?.constraint).toBeUndefined()
    const rows = await target.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM memory_versions')
    expect(Number(rows.rows[0]?.n)).toBe(0)
    expect(JSON.stringify(report)).not.toMatch(/VALUE-SECRET-BS-1/)
  })
})
