// The SQLite connection of the coordinator PROCESS (initProcessDatabase, db/connection.ts) next to the dashboard's initDatabase:
//   - the same pragmas (a second connection to the file is only safe in WAL mode with a busy_timeout, so the two lists must not
//     drift), and none of the dashboard's boot work (the federation prefix fold),
//   - two real processes writing the same file at the same moment: nothing is lost and nobody sees SQLITE_BUSY,
//   - a coordinator-written event is what the otel gauge counts.
//
// Privacy: neutral fixtures only.
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDb, initDatabase, initProcessDatabase } from '../db/connection.js'
import { insertIncomingEvent, setOffset } from '../channel-coordinator/ingest.js'
import { processBatch } from '../channel-coordinator-main.js'
import { countIncomingEventsBySourceStatus } from '../db/otel-gauges.js'
import { useAccessFile } from './helpers/coordinator-access.js'

useAccessFile()

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const dirs: string[] = []
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'coord-process-db-')); dirs.push(d); return d }
afterEach(() => {
  closeDatabase()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PRAGMAS = ['journal_mode', 'synchronous', 'busy_timeout', 'cache_size', 'wal_autocheckpoint', 'mmap_size', 'foreign_keys'] as const
const pragmas = (db: Database.Database): Record<string, unknown> =>
  Object.fromEntries(PRAGMAS.map((p) => [p, db.pragma(p, { simple: true })]))

describe('initProcessDatabase and initDatabase', () => {
  it('open a file with the same pragma values (journal mode, synchronous, busy timeout, cache, autocheckpoint, mmap)', () => {
    initDatabase(join(tempDir(), 'dashboard.db'))
    const dashboard = pragmas(getDb())
    closeDatabase()
    initProcessDatabase(join(tempDir(), 'coordinator.db'))
    const coordinator = pragmas(getDb())
    expect(coordinator).toEqual(dashboard)
    // the values that matter for two processes on one file, spelled out so a change of both is still a decision
    expect(coordinator).toMatchObject({ journal_mode: 'wal', busy_timeout: 5000, synchronous: 1 })
  })

  it('loads the same extension state before the migrations (sqlite-vec attempted, as in the dashboard boot)', () => {
    initProcessDatabase(join(tempDir(), 'coordinator.db'))
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM schema_version").get()).toMatchObject({ n: expect.any(Number) })
  })

  it('does NOT run the dashboard boot work: a federation prefix is left as it is (initDatabase folds it)', () => {
    const file = join(tempDir(), 'shared.db')
    initDatabase(file)
    getDb().prepare("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES ('FED-A/agent-a', 'agent-b', 'x', 'pending', 1)").run()
    closeDatabase()

    initProcessDatabase(file)
    expect(getDb().prepare('SELECT from_agent FROM agent_messages').get()).toEqual({ from_agent: 'FED-A/agent-a' })
    closeDatabase()

    // the control: the dashboard init DOES fold it, so the cell above is not green because nothing could ever change
    initDatabase(file)
    expect(getDb().prepare('SELECT from_agent FROM agent_messages').get()).toEqual({ from_agent: 'fed-a/agent-a' })
  })

  it('a second call closes the first handle (no leaked file descriptor) and ends with a working one', () => {
    const file = join(tempDir(), 'twice.db')
    initProcessDatabase(file)
    const first = getDb()
    initProcessDatabase(file)
    expect(first.open).toBe(false)
    expect(getDb().open).toBe(true)
  })
})

describe('two processes on one SQLite file', () => {
  it('the coordinator side and a second real process write at the same time: every row lands, no SQLITE_BUSY', async () => {
    const dir = tempDir()
    const file = join(dir, 'shared.db')
    const N = 40
    initProcessDatabase(file) // this process: the schema exists before the child starts

    const script = join(dir, 'child-writer.mjs')
    writeFileSync(script, `
import { initProcessDatabase } from ${JSON.stringify(join(ROOT, 'src/db/connection.ts'))}
import { insertIncomingEvent, setOffset } from ${JSON.stringify(join(ROOT, 'src/channel-coordinator/ingest.ts'))}
initProcessDatabase(process.argv[2])
for (let i = 0; i < ${N}; i++) {
  const r = await insertIncomingEvent('child', { update_id: i, kind: 'message', chat_id: 1, user_id: 1, username: 'user-a', message_id: i, content: 'c', meta: {}, tg_date: 1 })
  if (!r.inserted) throw new Error('child insert ' + i + ' was not inserted')
  await setOffset('child', i)
}
`)
    const child = spawn(process.execPath, ['--import', 'tsx', script, file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))

    for (let i = 0; i < N; i++) {
      const r = await insertIncomingEvent('parent', { update_id: i, kind: 'message', chat_id: 1, user_id: 1, username: 'user-a', message_id: i, content: 'p', meta: {}, tg_date: 1 })
      expect(r.inserted).toBe(true)
      await setOffset('parent', i)
    }
    expect(await exited, stderr).toBe(0)
    expect(stderr).not.toMatch(/SQLITE_BUSY|database is locked/)

    const rows = getDb().prepare('SELECT source, COUNT(*) AS n FROM incoming_events GROUP BY source ORDER BY source').all()
    expect(rows).toEqual([{ source: 'child', n: N }, { source: 'parent', n: N }])
    expect(getDb().prepare('SELECT source, last_update_id FROM poll_offset ORDER BY source').all())
      .toEqual([{ source: 'child', last_update_id: N - 1 }, { source: 'parent', last_update_id: N - 1 }])
  }, 60000)
})

describe('the otel gauge reads what the coordinator wrote', () => {
  it('a backfilled update is counted per source and status', async () => {
    initProcessDatabase(':memory:')
    const raw = { update_id: 1, message: { message_id: 1, date: 1, text: 'a', chat: { id: 1001 }, from: { id: 1001, username: 'user-a' } } }
    await processBatch([raw])
    // the stranded one: inserted, never handed off
    await insertIncomingEvent('telegram', { update_id: 2, kind: 'message', chat_id: 1001, user_id: 1001, username: 'user-a', message_id: 2, content: 'b', meta: {}, tg_date: 1 })
    const counts = await Promise.resolve(countIncomingEventsBySourceStatus())
    expect(counts).toEqual(expect.arrayContaining([
      { source: 'telegram', status: 'delivered', n: 1 },
      { source: 'telegram', status: 'pending', n: 1 },
    ]))
  })
})
