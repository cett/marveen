// `check` of the SQLite -> PostgreSQL copy tool (P-G1) against a real PostgreSQL 16 target. The SQLite side is a database
// built by the real SQLite migration chain (applyMigrations), so the schema agreement is the one a real install has.
// Each cell gets its own target (a clone of the baseline), so one cell's rows cannot change another's answer.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as loadSqliteVec } from 'sqlite-vec'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { runCheck } from '../../db/pg-copy/check.js'
import { orderTables } from '../../db/pg-copy/schema.js'
import { createPgTestDb, PG_TEST_BACKUP_ROLE, pgTestRoleUrl, pgTestUrl, type PgTestDb } from '../helpers/pg-test-db.js'

// The cycle cell stubs the write-order function: the baseline has no foreign-key cycle among the copied tables, and a
// test-only constraint on the target would change the schema the check reads. Every other cell runs the real function.
vi.mock('../../db/pg-copy/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/pg-copy/schema.js')>()
  return { ...actual, orderTables: vi.fn(actual.orderTables) }
})

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A SQLite database built by the migration chain; `extra` may change it before it is closed. */
function buildSqlite(extra?: (db: Database.Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-check-'))
  dirs.push(dir)
  const file = join(dir, 'source.db')
  const db = new Database(file)
  applyMigrations(db)
  extra?.(db)
  db.close()
  return file
}

let target: PgTestDb | undefined

afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

async function freshTarget(): Promise<PgTestDb> {
  target = await createPgTestDb()
  return target
}

describe('check: a live database with a vec0 index is green (c1 fixup)', () => {
  it('the index and its shadow tables are skipped by name; the check is green; no vec_* table is planned for copy', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      loadSqliteVec(db)
      db.exec('CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[4])')
      db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (1, ?)').run(Buffer.from(new Float32Array([1, 2, 3, 4]).buffer))
    })
    const report = await runCheck({ sqlitePath, pgUrl: t.ownerUrl })
    expect(report.refusals).toEqual([])
    expect(report.ok).toBe(true)
    const skipped = report.plan.skipped.map((s) => s.table)
    expect(skipped).toContain('vec_memories')
    expect(skipped.filter((n) => n.startsWith('vec_')).length).toBeGreaterThan(1)
    expect(JSON.stringify(report.plan.copied)).not.toContain('vec_')
  })

  it('an unknown virtual table (an FTS5 table not on the skip list) is a named refusal, not a crash', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      loadSqliteVec(db)
      db.exec('CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[4])')
      db.exec('CREATE VIRTUAL TABLE notes_fts USING fts5(body)')
    })
    const report = await runCheck({ sqlitePath, pgUrl: t.ownerUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'notes_fts', reason: expect.stringMatching(/not on the skip list/) }),
    ]))
    // the known index is still skipped by name, not refused
    expect(report.refusals.map((r) => r.table)).not.toContain('vec_memories')
  })
})

describe('check: a green plan on a fresh owner target', () => {
  it('every precondition passes; the report names the copied tables, the seed tables, the PostgreSQL-only side tables', async () => {
    const t = await freshTarget()
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(report.refusals).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.plan.copied.length).toBeGreaterThan(70)
    expect(report.plan.seedTables.sort()).toEqual(['autonomy_categories', 'egress_allowlist', 'model_profile_map', 'otel_metrics_export_state', 'system_config', 'tenants'])
    expect(report.plan.pgOnlyTables).toEqual(expect.arrayContaining(['artifact_embeddings', 'memory_embeddings']))
    expect(report.plan.skipped.map((s) => s.table)).toEqual(expect.arrayContaining(['schema_version', 'memories_fts']))
    expect(report.plan.writeOrder).toHaveLength(report.plan.copied.length)
  })
})

describe('check: the role', () => {
  it('the serving role is refused: it does not own the tables (the owner role is the one that copies)', async () => {
    const t = await freshTarget()
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.appUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals.some((r) => /does not own the table/.test(r.reason))).toBe(true)
  })

  it('a superuser is refused: it skips row-level security and would hide a missing system context', async () => {
    const t = await freshTarget()
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.url })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: '(role)', reason: expect.stringMatching(/superuser/) })]))
  })
})

describe('check: the schema agreement and the SQLite side', () => {
  it('a SQLite-only table is refused and named, and nothing else is', async () => {
    const t = await freshTarget()
    const report = await runCheck({
      sqlitePath: buildSqlite((db) => { db.exec('CREATE TABLE zz_only_here (id INTEGER PRIMARY KEY, note TEXT)') }),
      pgUrl: t.ownerUrl,
    })
    expect(report.refusals).toEqual([expect.objectContaining({ table: 'zz_only_here' })])
  })

  it('an older SQLite schema than the PostgreSQL chain is refused, by version, without a write', async () => {
    const t = await freshTarget()
    const report = await runCheck({
      sqlitePath: buildSqlite((db) => { db.exec('DELETE FROM schema_version WHERE version >= 96') }),
      pgUrl: t.ownerUrl,
    })
    expect(report.refusals).toEqual([expect.objectContaining({ table: '(database)', reason: expect.stringMatching(/older than the PostgreSQL chain/) })])
  })

  it('a newer SQLite schema than the loader knows is refused until the PostgreSQL chain has its twin', async () => {
    const t = await freshTarget()
    const report = await runCheck({
      sqlitePath: buildSqlite((db) => { db.exec("INSERT INTO schema_version (version, applied_at, description, checksum) VALUES (97, 0, 'future', 'x')") }),
      pgUrl: t.ownerUrl,
    })
    expect(report.refusals).toEqual([expect.objectContaining({ table: '(database)', reason: expect.stringMatching(/newer than this copy loader knows/) })])
  })
})

describe('check: the target', () => {
  it('a target that already holds a row in a copied table is refused, by table name; the row is not touched', async () => {
    const t = await freshTarget()
    await t.pool.query("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'entity-a', 'action-a')")
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(report.refusals).toEqual([expect.objectContaining({ table: 'agent_audit_log', reason: expect.stringMatching(/not empty \(1 row/) })])
    const after = await t.pool.query('SELECT count(*)::int AS n FROM agent_audit_log')
    expect(after.rows[0].n).toBe(1)
  })

  it('a refusal names no value: the report carries table names, columns and counts only', async () => {
    const t = await freshTarget()
    await t.pool.query("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('secret-marker-7731', 'e', 'a')")
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(JSON.stringify(report)).not.toContain('secret-marker-7731')
  })
})

describe('check: the role, beyond the superuser refusal', () => {
  it('a role that bypasses row-level security is refused as such (not as a superuser): it would read past the policies', async () => {
    const t = await freshTarget()
    // the counts run as this role, so it needs SELECT; BYPASSRLS is what the check must refuse it for
    await t.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PG_TEST_BACKUP_ROLE}`)
    const backupUrl = pgTestRoleUrl(pgTestUrl(), t.name, PG_TEST_BACKUP_ROLE)
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: backupUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: '(role)', reason: expect.stringMatching(/bypasses row-level security/) })]))
    expect(report.refusals.some((r) => /superuser/.test(r.reason))).toBe(false)
  })
})

describe('check: the SQLite side, beyond the schema version', () => {
  it('a SQLite file that fails PRAGMA integrity_check is refused as a whole database', async () => {
    const t = await freshTarget()
    const report = await runCheck({
      sqlitePath: buildSqlite((db) => {
        // An index whose pages no longer belong to any schema object: integrity_check reports the pages as never used.
        // unsafeMode lifts better-sqlite3's defensive mode, which otherwise refuses any write to sqlite_master.
        db.unsafeMode(true)
        const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name LIMIT 1").get() as { name: string }
        db.pragma('writable_schema = ON')
        db.prepare('DELETE FROM sqlite_master WHERE type = ? AND name = ?').run('index', index.name)
        db.pragma('writable_schema = OFF')
      }),
      pgUrl: t.ownerUrl,
    })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: '(database)', reason: expect.stringMatching(/integrity_check reports \d+ problem/) })]))
  })
})

describe('check: the PostgreSQL schema and the write order', () => {
  it('a target whose schema is behind the migration files is refused, by the schema message', async () => {
    const t = await freshTarget()
    await t.pool.query('DELETE FROM schema_version WHERE version = (SELECT max(version) FROM schema_version)')
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: '(database)', reason: expect.stringMatching(/the schema is behind/) })]))
  })

  it('a foreign-key cycle is refused in the report: the copy has no write order for those tables', async () => {
    const t = await freshTarget()
    vi.mocked(orderTables).mockReturnValueOnce({ cycle: ['agent_audit_log', 'tenants'] })
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'agent_audit_log', reason: expect.stringMatching(/foreign-key cycle between 2 tables/) })]))
    expect(report.plan.writeOrder).toBeUndefined()
  })
})

describe('the write order follows the row-level policies (no foreign key needed)', () => {
  it('a child policy that refers to another table is written after that table: agent_audit_log refers to kanban_cards, and the name order would put it first', async () => {
    const t = await freshTarget()
    await t.pool.query('CREATE POLICY parent_exists ON agent_audit_log AS RESTRICTIVE FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM kanban_cards k WHERE k.id = agent_audit_log.entity))')
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    const order = report.plan.writeOrder ?? []
    expect(order.indexOf('kanban_cards')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('kanban_cards')).toBeLessThan(order.indexOf('agent_audit_log'))
  })

  it('a FOR ALL policy with only a USING clause still orders the parent first: PostgreSQL applies USING as WITH CHECK for ALL', async () => {
    const t = await freshTarget()
    // no WITH CHECK: the USING of an ALL policy is the check of an insert, so the parent is a write-order edge all the same
    await t.pool.query('CREATE POLICY parent_all ON agent_audit_log FOR ALL USING (EXISTS (SELECT 1 FROM kanban_cards k WHERE k.id = agent_audit_log.entity))')
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    const order = report.plan.writeOrder ?? []
    expect(order.indexOf('kanban_cards')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('kanban_cards')).toBeLessThan(order.indexOf('agent_audit_log'))
  })

  it('a policy cycle (two tables that refer to each other by policy) is refused by name: no write order, the report is not ok', async () => {
    const t = await freshTarget()
    await t.pool.query('CREATE POLICY parent_exists ON agent_audit_log AS RESTRICTIVE FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM kanban_cards k WHERE k.id = agent_audit_log.entity))')
    await t.pool.query('CREATE POLICY back_ref ON kanban_cards AS RESTRICTIVE FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM agent_audit_log a WHERE a.entity = kanban_cards.id))')
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(report.ok).toBe(false)
    // the count is every table the order could not place (the two tables of the cycle and the tables that depend on them)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'agent_audit_log', reason: expect.stringMatching(/foreign-key cycle between \d+ tables/) })]))
    expect(report.plan.writeOrder).toBeUndefined()
  })
})

describe('check: a role that cannot read the copied tables', () => {
  it('is refused by table name and the report still comes back: no raw permission error from the row counts', async () => {
    const t = await freshTarget()
    // no GRANT: the backup role has BYPASSRLS but no SELECT on the tables
    const backupUrl = pgTestRoleUrl(pgTestUrl(), t.name, PG_TEST_BACKUP_ROLE)
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: backupUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'agent_audit_log', reason: expect.stringMatching(/cannot read the table/) })]))
  })

  it('a role that can INSERT but not SELECT is refused by name too: the privilege the check reads is SELECT', async () => {
    const t = await freshTarget()
    await t.pool.query(`GRANT INSERT ON ALL TABLES IN SCHEMA public TO ${PG_TEST_BACKUP_ROLE}`)
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: pgTestRoleUrl(pgTestUrl(), t.name, PG_TEST_BACKUP_ROLE) })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'agent_audit_log', reason: expect.stringMatching(/cannot read the table/) })]))
  })
})

// The orphan rows (P-G1, decision of 2026-11-24). Seven row-level policy edges of the baseline have no foreign key on their
// pair; the orphan catalog pins them (orphans.ts PINNED_POLICY_EDGES), so the scan sees them and none is refused. The catalog
// cells (pg-copy-catalog.pg.test.ts) pin the exact set; these two keep the check's verdict on the baseline and on a key.
describe('check: orphan rows and the policy edges, on the PostgreSQL catalog', () => {
  it('the baseline: every policy edge no foreign key backs is pinned in the catalog, so none is refused and none is left over', async () => {
    const t = await freshTarget()
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(report.plan.uncoveredPolicyEdges).toEqual([])
    expect(report.refusals.filter((r) => /orphan catalog|row-level policy/.test(r.reason))).toEqual([])
  })

  it('a foreign key on a pinned pair does not change the verdict: the pair is backed by the key, the check stays green', async () => {
    const t = await freshTarget()
    await t.pool.query('ALTER TABLE kanban_comments ADD CONSTRAINT kanban_comments_card_fk FOREIGN KEY (card_id) REFERENCES kanban_cards (id)')
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl })
    expect(report.plan.uncoveredPolicyEdges).toEqual([])
    expect(report.refusals.filter((r) => /orphan catalog|row-level policy/.test(r.reason))).toEqual([])
  })

  it('the orphans of the keyed pairs: one finding per key with its exact count and the first rowids; no value is named', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      // SQLite has no foreign keys: these rows are the live shape (the parent is not there)
      db.pragma('foreign_keys = OFF')
      db.exec(`
        INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type)
          VALUES (999, 'VALUE-SECRET-MV-1', 'c', 1, 'agent-a', 'create'), (998, 'VALUE-SECRET-MV-2', 'c', 1, 'agent-a', 'create');
        INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, parent_id) VALUES
          ('kanban-root', 'root', 'planned', 'normal', 0, 1, 1, NULL),
          ('kanban-ok', 'fine child', 'planned', 'normal', 0, 1, 1, 'kanban-root'),
          ('kanban-gone', 'VALUE-SECRET-KC-1', 'planned', 'normal', 0, 1, 1, 'kanban-missing'),
          ('kanban-below', 'below the gone one', 'planned', 'normal', 0, 1, 1, 'kanban-gone');
      `)
    })
    const report = await runCheck({ sqlitePath, pgUrl: t.ownerUrl })
    const findings = report.plan.orphans.map((f) => [f.table, f.constraint, f.count, f.rowids])
    expect(findings).toEqual([
      ['kanban_cards', expect.stringMatching(/kanban_cards_parent_id_fkey/), 2, ['3', '4']],
      ['memory_versions', expect.stringMatching(/memory_versions_memory_id_fkey/), 2, ['1', '2']],
    ])
    const orphanRefusals = report.refusals.filter((r) => /orphan row/.test(r.reason))
    expect(orphanRefusals.map((r) => r.table).sort()).toEqual(['kanban_cards', 'memory_versions'])
    expect(orphanRefusals.find((r) => r.table === 'kanban_cards')!.reason).toMatch(/2 orphan row\(s\)/)
    expect(JSON.stringify(report)).not.toMatch(/VALUE-SECRET/)
  })
})
