import Database from 'better-sqlite3'
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyMigrations } from '../db-migrations.js'
import { initIngestDb, closeIngestDb } from '../channel-coordinator/ingest.js'

// The channel-coordinator is a separate process that opens the same DB file as
// the dashboard. Its tables must come from the migration runner (one source),
// and the two processes may both run the runner at the same moment.

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

function columns(db: Database.Database, table: string): Col[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Col[]
}

function indexNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name).sort()
}

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'marveen-coord-schema-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  closeIngestDb()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('coordinator tables come from the migrations', () => {
  it('a database built from migrations alone has incoming_events and poll_offset', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    expect(columns(db, 'incoming_events').map((c) => c.name)).toEqual([
      'id', 'source', 'update_id', 'chat_id', 'user_id', 'username', 'message_id', 'kind', 'content',
      'meta', 'tg_date', 'status', 'agent_message_id', 'error', 'created_at', 'delivered_at',
    ])
    expect(columns(db, 'poll_offset').map((c) => c.name)).toEqual(['source', 'last_update_id', 'updated_at'])
    expect(indexNames(db, 'incoming_events')).toEqual(
      expect.arrayContaining(['idx_incoming_events_source_update', 'idx_incoming_events_status']),
    )
    db.close()
  })

  it('a coordinator-first boot ends with the same schema as a dashboard-only boot', () => {
    const dashboard = new Database(':memory:')
    applyMigrations(dashboard)

    const file = join(tempDir(), 'coordinator-first.db')
    const coordinator = initIngestDb(file)

    for (const table of ['agent_messages', 'incoming_events', 'poll_offset']) {
      expect(columns(coordinator, table), table).toEqual(columns(dashboard, table))
    }
    const versions = (db: Database.Database) =>
      (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version)
    expect(versions(coordinator)).toEqual(versions(dashboard))
    dashboard.close()
  })

  it('the delivered_at trigger exists after migrations alone and after a coordinator-first boot', () => {
    const trigger = (db: Database.Database) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='agent_messages_delivered_needs_ts'").get()
    const dashboard = new Database(':memory:')
    applyMigrations(dashboard)
    expect(trigger(dashboard)).toBeDefined()
    dashboard.close()

    const coordinator = initIngestDb(join(tempDir(), 'coordinator-first.db'))
    expect(trigger(coordinator)).toBeDefined()
  })

  it('the dashboard runner after a coordinator-first boot is a no-op', () => {
    const file = join(tempDir(), 'coordinator-first.db')
    const coordinator = initIngestDb(file)
    const before = coordinator.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }

    const second = new Database(file)
    applyMigrations(second)
    const after = second.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }
    second.close()

    expect(after.n).toBe(before.n)
  })

  it('an existing coordinator-created table with data survives the migration', () => {
    const file = join(tempDir(), 'legacy.db')
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE incoming_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'telegram', update_id INTEGER NOT NULL,
        chat_id INTEGER, user_id INTEGER, username TEXT, message_id INTEGER, kind TEXT NOT NULL DEFAULT 'message',
        content TEXT, meta TEXT, tg_date INTEGER, status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','delivered','done','failed')),
        agent_message_id INTEGER, error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
      );
      INSERT INTO incoming_events(update_id, content, created_at) VALUES (7, 'kept', 1);
    `)
    applyMigrations(legacy)
    const row = legacy.prepare('SELECT content FROM incoming_events WHERE update_id = 7').get() as { content: string }
    legacy.close()
    expect(row.content).toBe('kept')
  })
})

describe('migration runner under a concurrent start', () => {
  it('a stale view of schema_version neither throws nor re-runs an applied migration', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '0001_baseline.sql'), 'CREATE TABLE marker (n INTEGER);\nINSERT INTO marker VALUES (1);\n')
    writeFileSync(join(dir, '0002_second.sql'), 'INSERT INTO marker VALUES (2);\n')

    const real = new Database(':memory:')
    applyMigrations(real, dir)

    // The other process finished first: this process still reads max_v = 0.
    const stale = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!sql.includes('MAX(version)')) return stmt
            return new Proxy(stmt, {
              get(s, p) {
                return p === 'get' ? () => ({ max_v: 0 }) : (s as never)[p]
              },
            })
          }
        }
        const v = (target as never)[prop]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as Database.Database

    expect(() => applyMigrations(stale, dir)).not.toThrow()
    const rows = real.prepare('SELECT n FROM marker ORDER BY n').all() as { n: number }[]
    expect(rows.map((r) => r.n)).toEqual([1, 2])
    real.close()
  })
})
