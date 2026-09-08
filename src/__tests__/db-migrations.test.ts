import Database from 'better-sqlite3'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../db-migrations.js'
import { logger } from '../logger.js'
import { initDatabase, getDb, createTenant, setTenantAgentAvailability, upsertBlackboard } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── helpers ──────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  return db
}

function tempMigrationsDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-migrations-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeMigration(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, 'utf-8')
}

function maxVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version')
    .get() as { v: number }
  return row.v
}

function appliedVersions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map(
    r => r.version,
  )
}

// ── 1. Fresh DB: baseline runs, schema_version.MAX() = 1 ────────────────────

describe('fresh DB', () => {
  it('applies the baseline migration and records version 1', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(
        dir,
        '0001_baseline.sql',
        'CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      )
      const db = freshDb()
      applyMigrations(db, dir)

      expect(maxVersion(db)).toBe(1)

      // Table created by the migration must exist.
      const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_table'")
        .get()
      expect(row).toBeTruthy()
    } finally {
      cleanup()
    }
  })
})

// ── 2. Already-migrated DB: no-op ────────────────────────────────────────────

describe('already-migrated DB', () => {
  it('does not re-apply an already recorded migration', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE idempotency_test (id INTEGER PRIMARY KEY);')
      const db = freshDb()

      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Second call must not throw and must not duplicate the version row.
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)
      expect(appliedVersions(db)).toEqual([1])
    } finally {
      cleanup()
    }
  })
})

// ── 3. Partial: only pending migrations run ───────────────────────────────────

describe('partial migration state', () => {
  it('runs only versions above the current max', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // First: apply only v1 (write just v1 file, then migrate).
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE tbl1 (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Now add v2 and v3; re-running should apply only them.
      writeMigration(dir, '0002_add_name.sql', 'ALTER TABLE tbl1 ADD COLUMN name TEXT;')
      writeMigration(dir, '0003_add_flag.sql', 'ALTER TABLE tbl1 ADD COLUMN active INTEGER DEFAULT 1;')
      applyMigrations(db, dir)

      expect(appliedVersions(db)).toEqual([1, 2, 3])

      // Columns added by v2 and v3 must be usable.
      db.prepare('INSERT INTO tbl1 (name, active) VALUES (?, ?)').run('x', 1)
    } finally {
      cleanup()
    }
  })

  it('starts from the correct version when max=K and new files exist', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE partial_test (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Add v2 migration file after the fact.
      writeMigration(dir, '0002_extend.sql', 'ALTER TABLE partial_test ADD COLUMN val TEXT;')
      applyMigrations(db, dir)

      expect(appliedVersions(db)).toEqual([1, 2])
    } finally {
      cleanup()
    }
  })
})

// ── 4. CRITICAL: bootstrap test ──────────────────────────────────────────────
// Legacy DB: otel_spans present, schema_version absent. applyMigrations must
// record v1 without running the baseline SQL (otel_spans is the sentinel for
// "full schema already applied"). Data in pre-existing tables must be intact.

describe('bootstrap legacy install', () => {
  it('bootstraps to v1 without re-running baseline SQL, preserving existing data', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // The baseline SQL creates a sessions table. On a real legacy install
      // this table already exists; IF NOT EXISTS is safe, but the key guarantee
      // is that schema_version gets recorded as v1 and the migration is not
      // treated as "pending".
      writeMigration(
        dir,
        '0001_baseline.sql',
        [
          'CREATE TABLE IF NOT EXISTS sessions (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL);',
          'CREATE TABLE IF NOT EXISTS otel_spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, agent_id TEXT NOT NULL, operation TEXT NOT NULL, start_ms INTEGER NOT NULL, PRIMARY KEY (trace_id, span_id));',
        ].join('\n'),
      )

      // Simulate legacy DB: otel_spans exists, schema_version does NOT.
      const db = freshDb()
      db.exec(`
        CREATE TABLE sessions (
          chat_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE otel_spans (
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          PRIMARY KEY (trace_id, span_id)
        )
      `)
      // Seed data that must survive the migration call.
      db.prepare('INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)').run(
        'test-chat-1',
        'sess-abc',
        1000000,
      )

      applyMigrations(db, dir)

      // schema_version must now exist and contain version 1.
      expect(maxVersion(db)).toBe(1)
      expect(appliedVersions(db)).toEqual([1])

      // Data must be intact.
      const sess = db.prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get('test-chat-1') as
        | { session_id: string }
        | undefined
      expect(sess?.session_id).toBe('sess-abc')

      // Calling applyMigrations a second time must be a no-op.
      applyMigrations(db, dir)
      expect(appliedVersions(db)).toEqual([1])
    } finally {
      cleanup()
    }
  })

  it('does NOT bootstrap when otel_spans is absent (treats as genuinely fresh)', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE new_install_check (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      // Neither schema_version nor otel_spans -- genuine fresh install.
      applyMigrations(db, dir)

      // The migration SQL must have run (table exists).
      const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='new_install_check'")
        .get()
      expect(row).toBeTruthy()
      expect(maxVersion(db)).toBe(1)
    } finally {
      cleanup()
    }
  })
})

// ── 5. Bad SQL: throws, no schema_version entry written ──────────────────────

describe('bad migration SQL', () => {
  it('throws on invalid SQL and does not record the version', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // Apply v1 first (only v1 file exists at this point).
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      applyMigrations(db, dir)
      expect(appliedVersions(db)).toEqual([1])

      // Now add the broken v2 and expect the next migration run to throw.
      writeMigration(dir, '0002_broken.sql', 'THIS IS NOT VALID SQL;')
      expect(() => applyMigrations(db, dir)).toThrow()

      // schema_version must still only have v1 -- the failed v2 was rolled back.
      expect(appliedVersions(db)).toEqual([1])
    } finally {
      cleanup()
    }
  })
})

// ── 6. memory_links table: migration 0008 creates expected schema ─────────────

describe('memory_links migration', () => {
  it('creates memory_links table with required columns and constraints', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // Baseline must exist first (schema_version + memories table for FK)
      writeMigration(
        dir,
        '0001_baseline.sql',
        `CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT, topic_key TEXT, content TEXT NOT NULL,
          sector TEXT, salience REAL, category TEXT, agent_id TEXT,
          keywords TEXT, embedding TEXT, embedding_blob BLOB,
          created_at INTEGER DEFAULT (unixepoch()),
          accessed_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER
        );`,
      )
      // 0008 migration SQL (verbatim copy of what we ship)
      const sql0008 = `CREATE TABLE IF NOT EXISTS memory_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  dst_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  link_type        TEXT    NOT NULL CHECK(link_type IN ('semantic', 'explicit', 'entity', 'cooccurrence')),
  weight           REAL    NOT NULL DEFAULT 1.0 CHECK(weight > 0 AND weight <= 1),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  last_traversed_at INTEGER,
  UNIQUE(src_id, dst_id, link_type)
);
CREATE INDEX IF NOT EXISTS idx_memory_links_src  ON memory_links(src_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_memory_links_dst  ON memory_links(dst_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_memory_links_traversed ON memory_links(last_traversed_at);`
      writeMigration(dir, '0008_memory_links.sql', sql0008)

      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(8)

      // Table exists
      const tableRow = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_links'")
        .get()
      expect(tableRow).toBeTruthy()

      // Indexes exist
      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_links'").all() as { name: string }[]
      ).map(r => r.name)
      expect(indexes).toContain('idx_memory_links_src')
      expect(indexes).toContain('idx_memory_links_dst')

      // UNIQUE constraint: duplicate (src, dst, type) must fail
      db.exec("INSERT INTO memories (id, content) VALUES (1, 'a'), (2, 'b')")
      db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.9)")
      expect(() =>
        db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.8)")
      ).toThrow()

      // CHECK constraint: invalid link_type must fail
      expect(() =>
        db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'invalid', 0.5)")
      ).toThrow()

      // CHECK constraint: weight out of range must fail
      expect(() =>
        db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'explicit', 1.5)")
      ).toThrow()
    } finally {
      cleanup()
    }
  })
})

// ── 7. Checksum mismatch: WARNING log, migration continues ───────────────────

describe('checksum mismatch', () => {
  it('emits a warning but does not abort when an applied migration file changed', () => {
    const { dir, cleanup } = tempMigrationsDir()
    // Spy on the pino logger instance exported from logger.ts.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)

    try {
      const migrationPath = join(dir, '0001_baseline.sql')
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE chk_test (id INTEGER PRIMARY KEY);')

      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Mutate the migration file after it was applied.
      writeFileSync(migrationPath, 'CREATE TABLE chk_test (id INTEGER PRIMARY KEY, extra TEXT);', 'utf-8')

      // Must not throw, must not re-apply.
      expect(() => applyMigrations(db, dir)).not.toThrow()
      expect(appliedVersions(db)).toEqual([1])

      // logger.warn must have been called with a message about checksum.
      const checksumWarnCalled = warnSpy.mock.calls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('checksum')),
      )
      expect(checksumWarnCalled).toBe(true)
    } finally {
      warnSpy.mockRestore()
      cleanup()
    }
  })

  it('emits INFO (not WARN) when the mismatch is in KNOWN_SAFE_MISMATCHES (version 4)', () => {
    const { dir, cleanup } = tempMigrationsDir()
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)

    try {
      // Version 4 is listed in KNOWN_SAFE_MISMATCHES.
      const migrationPath = join(dir, '0004_span_tracing.sql')
      writeMigration(dir, '0004_span_tracing.sql', 'CREATE TABLE safe_chk (id INTEGER PRIMARY KEY);')

      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(4)

      // Mutate the file (simulates the post-apply privacy scrub that happened in production).
      writeFileSync(migrationPath, 'CREATE TABLE safe_chk (id INTEGER PRIMARY KEY); -- comment added', 'utf-8')

      infoSpy.mockClear()
      warnSpy.mockClear()

      expect(() => applyMigrations(db, dir)).not.toThrow()
      expect(appliedVersions(db)).toEqual([4])

      // WARN must NOT have been called with a checksum message.
      const checksumWarnCalled = warnSpy.mock.calls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('checksum')),
      )
      expect(checksumWarnCalled).toBe(false)

      // INFO must have been called with a "known safe" message.
      const safeInfoCalled = infoSpy.mock.calls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('known safe')),
      )
      expect(safeInfoCalled).toBe(true)
    } finally {
      infoSpy.mockRestore()
      warnSpy.mockRestore()
      cleanup()
    }
  })
})

// ── 8. import shadow migration (0013): schema-only, safe without vec0 ─────────

describe('import shadow migration schema-only', () => {
  it('adds memory_shadow_id column without firing vec_memories_ai trigger', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      const prereqSql = `CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT,
          chat_id TEXT NOT NULL DEFAULT '',
          sector TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          category TEXT CHECK(category IN ('hot','warm','cold','shared')),
          keywords TEXT,
          embedding_blob BLOB,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE import_sources (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          label TEXT,
          interval_hours INTEGER NOT NULL DEFAULT 4,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE import_memories (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES import_sources(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          content TEXT NOT NULL,
          keywords TEXT,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(source_id, file_path)
        );`

      // Phase 1: apply baseline (0001) so that all prerequisite tables exist.
      writeMigration(dir, '0001_baseline.sql', prereqSql)
      const db = freshDb()
      applyMigrations(db, dir)

      // Phase 2: simulate the persistent vec_memories_ai trigger that exists in
      // production SQLite from previous deploys.  Its body aborts on any INSERT
      // INTO memories, mimicking what happens when vec0 is not loaded.  The
      // schema-only 0013 migration must not touch the memories table at all.
      db.exec(
        `CREATE TRIGGER vec_memories_ai
           AFTER INSERT ON memories
         BEGIN
           SELECT raise(ABORT, 'vec0 not loaded -- would crash in production');
         END`,
      )

      // Phase 3: add 0013 to the same dir and re-run.  Version 1 is already
      // recorded so only version 13 is applied.
      writeMigration(
        dir,
        '0013_import_memory_shadow.sql',
        `ALTER TABLE import_memories ADD COLUMN memory_shadow_id INTEGER REFERENCES memories(id);
         CREATE INDEX IF NOT EXISTS idx_import_shadow ON import_memories(memory_shadow_id);`,
      )
      expect(() => applyMigrations(db, dir)).not.toThrow()

      // Column was added to import_memories.
      const cols = db.prepare('PRAGMA table_info(import_memories)').all() as { name: string }[]
      expect(cols.find(c => c.name === 'memory_shadow_id')).toBeTruthy()

      // Index was created.
      const idx = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_import_shadow'")
        .get()
      expect(idx).toBeTruthy()

      // Verify the trigger is still armed -- i.e. the migration never fired it.
      expect(() =>
        db.exec("INSERT INTO memories (content, chat_id, sector) VALUES ('x', 'c', 's')"),
      ).toThrow(/vec0 not loaded/)

      expect(maxVersion(db)).toBe(13)
    } finally {
      cleanup()
    }
  })
})

// Verifies migration 0032: re-resolving fleet_blackboard/history tenant_id
// against the CURRENT tenant_agent_availability state, for rows that were
// stamped BEFORE a later availability change and never re-written since.
//
// Regression scenario (found during live verification of the tenant-isolation
// migration): an existing fleet agent (0 tenant_agent_availability rows,
// implicit tenant_id=default) gets granted to a real tenant. upsertBlackboard's
// own on-write re-resolve correctly derives '_multi_' for any FUTURE write,
// but that agent's PRIOR, un-touched blackboard row keeps showing the
// single-tenant value from before the grant -- exposing default-tenant data
// under the granted tenant's view until the agent writes again. 0032 is the
// one-time catch-up.
describe('Migration 0032 -- re-resolves stale rows against current availability', () => {
  const MIGRATION_0032_PATH = join(__dirname, '../../src/migrations/0032_blackboard_tenant_id_reresolve.sql')

  function reapplyMigration0032(db: Database.Database): void {
    db.exec(readFileSync(MIGRATION_0032_PATH, 'utf-8'))
  }

  beforeEach(() => {
    initDatabase(':memory:')
    createTenant('tenant-a', 'Tenant A')
    createTenant('tenant-b', 'Tenant B')
  })

  it('a fleet agent later also granted to a tenant: stale single-tenant row becomes "_multi_"', () => {
    // Agent starts as a pure fleet agent (0 rows) and writes -- tenant_id="default".
    upsertBlackboard('agent-a', { status: 'active', summary: 'fleet work' })
    // Now granted to tenant-a WITHOUT an explicit "default" row yet (the bug's
    // starting state) -- the row is still stale at this point.
    setTenantAgentAvailability('tenant-a', 'agent-a', true)

    const db = getDb()
    const before = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(before.tenant_id).toBe('default') // stale -- not re-derived yet

    // The gap is closed by also granting the agent's original "default"
    // membership explicitly (the immediate operational fix)...
    setTenantAgentAvailability('default', 'agent-a', true)
    // ...but the existing row STILL hasn't been re-written, so it is still stale.
    const stillStale = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(stillStale.tenant_id).toBe('default')

    reapplyMigration0032(db)

    const after = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(after.tenant_id).toBe('_multi_')
  })

  it('a single-tenant agent stays correctly single-tenant after re-resolve (no false positive)', () => {
    setTenantAgentAvailability('tenant-a', 'agent-b', true)
    upsertBlackboard('agent-b', { status: 'active', summary: 'tenant work' })

    const db = getDb()
    reapplyMigration0032(db)

    const row = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-b') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('a revoked (fully disabled) agent reverts to "default" on re-resolve', () => {
    setTenantAgentAvailability('tenant-a', 'agent-c', true)
    upsertBlackboard('agent-c', { status: 'active', summary: 'tenant work' })
    setTenantAgentAvailability('tenant-a', 'agent-c', false) // revoked

    const db = getDb()
    const stale = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-c') as { tenant_id: string }
    expect(stale.tenant_id).toBe('tenant-a') // stale -- upsertBlackboard was never called again

    reapplyMigration0032(db)

    const after = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-c') as { tenant_id: string }
    expect(after.tenant_id).toBe('default')
  })

  it('re-resolves fleet_blackboard_history rows the same way', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'v1' })
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    setTenantAgentAvailability('default', 'agent-a', true)

    const db = getDb()
    reapplyMigration0032(db)

    const rows = db.prepare('SELECT tenant_id FROM fleet_blackboard_history WHERE agent_id = ?').all('agent-a') as { tenant_id: string }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.tenant_id).toBe('_multi_')
  })

  it('is idempotent -- running it twice in a row does not change the result', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'v1' })
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    setTenantAgentAvailability('default', 'agent-a', true)

    const db = getDb()
    reapplyMigration0032(db)
    reapplyMigration0032(db)

    const row = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(row.tenant_id).toBe('_multi_')
  })
})

// Verifies migration 0033: backfilling token_usage.tenant_id from
// tenant_agent_availability (the deny-by-default opt-in matrix), the same
// architecture as 0031/0032 (fleet_blackboard tenant isolation, kanban #735)
// applied to the Overview "Token ma" card's data source.
//
//   0 enabled availability rows for the agent -> tenant_id = 'default'
//   1 enabled row                             -> tenant_id = that tenant
//   2+ enabled rows                           -> tenant_id = '_multi_'
describe('Migration 0033 -- backfills token_usage.tenant_id from tenant_agent_availability', () => {
  const MIGRATION_0033_PATH = join(__dirname, '../../src/migrations/0033_token_usage_tenant_id.sql')

  function reapplyMigration0033(db: Database.Database): void {
    // The migration's own ALTER TABLE only runs once (0033 is already applied
    // by initDatabase's normal migration pass), so re-apply just the backfill
    // UPDATE statements -- skip the ALTER TABLE line to avoid "duplicate column".
    const sql = readFileSync(MIGRATION_0033_PATH, 'utf-8')
    const withoutAlter = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('ALTER TABLE'))
      .join('\n')
    db.exec(withoutAlter)
  }

  function insertTokenUsageRow(db: Database.Database, agent: string, sessionId: string, timestamp: number): void {
    db.prepare(
      `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model)
       VALUES (?, ?, ?, 100, 50, 'claude-sonnet-5')`
    ).run(agent, sessionId, timestamp)
  }

  beforeEach(() => {
    initDatabase(':memory:')
    createTenant('tenant-a', 'Tenant A')
    createTenant('tenant-b', 'Tenant B')
  })

  it('a fleet agent (0 enabled rows) defaults to "default"', () => {
    const db = getDb()
    insertTokenUsageRow(db, 'fleet-agent', 'sess-1', 1000)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('fleet-agent') as { tenant_id: string }
    expect(row.tenant_id).toBe('default')
  })

  it('a single-tenant agent backfills to that tenant', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-b', true)
    insertTokenUsageRow(db, 'agent-b', 'sess-1', 1000)
    // Row was inserted with the column DEFAULT ('default') -- simulate a
    // pre-existing row from before the agent was granted, needing backfill.
    reapplyMigration0033(db)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-b') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('a multi-tenant agent (2+ enabled rows) backfills to "_multi_"', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-c', true)
    setTenantAgentAvailability('tenant-b', 'agent-c', true)
    insertTokenUsageRow(db, 'agent-c', 'sess-1', 1000)
    reapplyMigration0033(db)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-c') as { tenant_id: string }
    expect(row.tenant_id).toBe('_multi_')
  })

  it('a revoked (fully disabled) agent reverts to "default" on re-resolve', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-d', true)
    insertTokenUsageRow(db, 'agent-d', 'sess-1', 1000)
    reapplyMigration0033(db)
    const midway = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-d') as { tenant_id: string }
    expect(midway.tenant_id).toBe('tenant-a')

    setTenantAgentAvailability('tenant-a', 'agent-d', false)
    reapplyMigration0033(db)

    const after = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-d') as { tenant_id: string }
    expect(after.tenant_id).toBe('default')
  })

  it('is idempotent -- running the backfill twice in a row does not change the result', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-e', true)
    setTenantAgentAvailability('tenant-b', 'agent-e', true)
    insertTokenUsageRow(db, 'agent-e', 'sess-1', 1000)

    reapplyMigration0033(db)
    reapplyMigration0033(db)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-e') as { tenant_id: string }
    expect(row.tenant_id).toBe('_multi_')
  })
})

// Verifies migration 0034: tenant isolation for import_sources / import_audit_log.
//
// Unlike 0031/0033 (derived from tenant_agent_availability), import_sources
// has no per-agent signal to derive tenant_id from -- existing rows simply
// default to 'default'. import_audit_log inherits its tenant_id from the
// parent source via source_id.
describe('Migration 0034 -- import_sources / import_audit_log tenant_id', () => {
  const MIGRATION_0034_PATH = join(__dirname, '../../src/migrations/0034_import_sources_tenant.sql')

  function reapplyBackfill0034(db: Database.Database): void {
    // The ALTER TABLE lines only run once (0034 is already applied by
    // initDatabase's normal migration pass) -- skip them and re-run just the
    // backfill UPDATE + index creation to simulate rows that predate the
    // migration.
    const sql = readFileSync(MIGRATION_0034_PATH, 'utf-8')
    const withoutAlter = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('ALTER TABLE'))
      .join('\n')
    db.exec(withoutAlter)
  }

  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('a new import_sources row defaults to tenant_id "default"', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('mig-src-1', 'local', '/tmp/mig', 4, 1, ?, ?)
    `).run(now, now)

    const row = db.prepare("SELECT tenant_id FROM import_sources WHERE id = 'mig-src-1'").get() as { tenant_id: string }
    expect(row.tenant_id).toBe('default')
  })

  it('backfills import_audit_log.tenant_id from its parent source', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
      VALUES ('mig-src-2', 'local', '/tmp/mig2', 4, 1, ?, ?, 'tenant-mig')
    `).run(now, now)

    // Simulate a pre-migration audit row: tenant_id lands on the column
    // DEFAULT ('default') since the insert below doesn't set it explicitly.
    db.prepare(`
      INSERT INTO import_audit_log (source_id, run_at, files_scanned, files_added, files_updated,
        files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type)
      VALUES ('mig-src-2', ?, 3, 1, 0, 0, 0, 0, 0)
    `).run(now)

    const before = db.prepare("SELECT tenant_id FROM import_audit_log WHERE source_id = 'mig-src-2'").get() as { tenant_id: string }
    expect(before.tenant_id).toBe('default')

    reapplyBackfill0034(db)

    const after = db.prepare("SELECT tenant_id FROM import_audit_log WHERE source_id = 'mig-src-2'").get() as { tenant_id: string }
    expect(after.tenant_id).toBe('tenant-mig')
  })

  it('is idempotent -- running the backfill twice in a row does not change the result', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
      VALUES ('mig-src-3', 'local', '/tmp/mig3', 4, 1, ?, ?, 'tenant-idem')
    `).run(now, now)
    db.prepare(`
      INSERT INTO import_audit_log (source_id, run_at, files_scanned, files_added, files_updated,
        files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type)
      VALUES ('mig-src-3', ?, 1, 0, 0, 0, 0, 0, 0)
    `).run(now)

    reapplyBackfill0034(db)
    reapplyBackfill0034(db)

    const row = db.prepare("SELECT tenant_id FROM import_audit_log WHERE source_id = 'mig-src-3'").get() as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-idem')
  })

  it('creates the tenant indexes on import_sources and import_audit_log', () => {
    const db = getDb()
    const sourceIndexes = db.prepare("PRAGMA index_list(import_sources)").all() as { name: string }[]
    const auditIndexes = db.prepare("PRAGMA index_list(import_audit_log)").all() as { name: string }[]
    expect(sourceIndexes.some(i => i.name === 'idx_import_sources_tenant')).toBe(true)
    expect(auditIndexes.some(i => i.name === 'idx_import_audit_tenant')).toBe(true)
  })
})
