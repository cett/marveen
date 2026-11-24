// The start of the web server runs a handful of one-time seeds and migrations with no request around them, as the app role
// (marveen_app, FORCE row-level security). An empty context sees ZERO rows of a tenant table and may write none, so a step
// that does not open its own system job (db/context.ts runAs.system 'boot-sequence') fails in the quiet way: the caller
// of each is a try/catch that logs "skipped", or a read that returns an empty list. Each cell seeds through the admin pool
// (the oracle that the row exists), boots the backend through the app URL and calls the step BARE: a runAs in the test
// would hide the gap (the module run under the app role gives a bare call the system context, see helpers/pg-app-role.ts).
//
// Privacy: neutral fixtures only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { dbx } from '../../db.js'
import { ensureClaudeUpdateTask, CLAUDE_UPDATE_TASK } from '../../web/claude-update.js'
import { ensureDailyLogSummaryTask, DAILY_LOG_SUMMARY_TASK } from '../../web/daily-log-summary-task.js'
import { ensureMemoryMaintenanceCommand, memoryMaintenanceCommand, MEMORY_MAINTENANCE_TASK } from '../../web/memory-maintenance-task.js'
import { backfillSkillBaselines } from '../../db/skill-revisions.js'
import { backfillQuarantineReaders } from '../../web/quarantine-backfill.js'
import { applySeedSkillRefreshMarker, SEED_REFRESH_MARKER } from '../../web/skill-seed-refresh.js'
import { restoreInflightFromStore } from '../../web/schedule-runner.js'
import { SCHEDULED_INFLIGHT_KEY } from '../../web/schedule-inflight-store.js'

const made: PgTestDb[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await closePgBackend()
})
afterAll(async () => {
  for (const d of made) await d.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function bootedDb(): Promise<PgTestDb> {
  const d = await createPgTestDb()
  made.push(d)
  await bootPgBackend({ url: d.appUrl })
  return d
}
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'startup-seeds-')); dirs.push(d); return d }
const scheduleNames = async (db: PgTestDb): Promise<string[]> =>
  (await db.pool.query('SELECT id AS name FROM schedules ORDER BY id')).rows.map((r: { name: string }) => r.name)

describe('the schedule seeds of the web server start are written by the app role', () => {
  it('the claude update task is seeded (an empty context is refused the insert and the seed is skipped with a warning)', async () => {
    const db = await bootedDb()
    expect(await ensureClaudeUpdateTask(tmp(), '/opt/install', 'agent-a')).toBe(true)
    expect(await scheduleNames(db)).toEqual([CLAUDE_UPDATE_TASK])
  })

  it('the daily log summary task is seeded', async () => {
    const db = await bootedDb()
    expect(await ensureDailyLogSummaryTask(tmp(), '/opt/install', 'agent-a', 3420)).toBe(true)
    expect(await scheduleNames(db)).toEqual([DAILY_LOG_SUMMARY_TASK])
  })

  it('a stock inline memory maintenance command is moved to the script (an empty context sees no row and leaves it)', async () => {
    const db = await bootedDb()
    const inline = "bash /opt/install/scripts/agent-api.sh --max-time 120 POST /api/memories/resort '{}' | grep -q '\"ok\":true'"
      + " && bash /opt/install/scripts/agent-api.sh --max-time 300 POST /api/memories/links/maintain '{}' | grep -q '\"ok\":true'"
    await db.pool.query("INSERT INTO schedules (id, schedule, agent, type, command) VALUES ($1, '0 3 * * *', 'agent-a', 'command', $2)", [MEMORY_MAINTENANCE_TASK, inline])
    expect(await ensureMemoryMaintenanceCommand('/opt/install', 3420)).toBe(true)
    const row = (await db.pool.query('SELECT command FROM schedules WHERE id = $1', [MEMORY_MAINTENANCE_TASK])).rows[0]
    expect(row?.command).toBe(memoryMaintenanceCommand('/opt/install', 3420, 'agent-a'))
  })
})

describe('the other start-up steps read what exists', () => {
  it('a skill without a revision gets its baseline (an empty context lists no skill and writes none, with no error)', async () => {
    const db = await bootedDb()
    await db.pool.query("INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('global/skill-a', 'skill-a', 'body', 'default', 1)")
    expect(await backfillSkillBaselines()).toEqual({ written: 1, errors: 0 })
    expect((await db.pool.query("SELECT count(*)::int AS n FROM skill_revisions WHERE skill_id = 'global/skill-a'")).rows[0]?.n).toBe(1)
  })

  it('the quarantine reader backfill reads the allowlist rows that exist (an empty list would render the agent file from nothing)', async () => {
    const db = await bootedDb()
    await db.pool.query("INSERT INTO egress_allowlist (value, type, tenant_id) VALUES ('example.test', 'domain', 'default')")
    const seen: number[] = []
    await backfillQuarantineReaders(['agent-a'], async () => {
      seen.push((await dbx.all('SELECT value FROM egress_allowlist')).length)
      return false
    })
    // the table holds the seeded domains plus the one above: the read as the boot job sees exactly what the oracle counts
    const total = (await db.pool.query('SELECT count(*)::int AS n FROM egress_allowlist')).rows[0]?.n
    expect(total).toBeGreaterThan(1)
    expect(seen).toEqual([total])
  })

  it('a corrupt persisted in-flight value is dropped by the runner start (the cleanup write is refused to an empty context and only warns)', async () => {
    const db = await bootedDb()
    // a value the restore cannot parse; the cache of the boot above holds it, the cleanup removes the row
    await db.pool.query('INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, 1)', [SCHEDULED_INFLIGHT_KEY, 'not json'])
    await closePgBackend()
    await bootPgBackend({ url: db.appUrl })
    expect(restoreInflightFromStore()).toBe(0)
    // the cleanup is fire and forget: poll the oracle for the row to go
    let left = 1
    for (let i = 0; i < 40 && left > 0; i++) {
      left = (await db.pool.query('SELECT count(*)::int AS n FROM system_config WHERE key = $1', [SCHEDULED_INFLIGHT_KEY])).rows[0]?.n
      if (left > 0) await new Promise((r) => setTimeout(r, 50))
    }
    expect(left).toBe(0)
  })
})

// The seed skill refresh marker (update.sh): the skill file is read from the home folder at call time, the marker path is a
// parameter. The row already exists with the old body; the refresh makes it equal to the file and removes the marker.
describe('the seed skill refresh marker is applied by the app role', () => {
  it('a listed skill row takes the refreshed file and the marker is removed (an empty context finds no row and the seed insert collides)', async () => {
    const db = await bootedDb()
    const home = tmp()
    vi.stubEnv('HOME', home)
    mkdirSync(join(home, '.claude', 'skills', 'skill-a'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'skill-a', 'SKILL.md'), '---\nname: skill-a\ndescription: new text\n---\nnew body\n')
    await db.pool.query("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('global/skill-a', 'skill-a', 'old text', 'old body', 'fleet', 1)")
    const marker = join(home, SEED_REFRESH_MARKER)
    writeFileSync(marker, 'skill-a\n')

    expect(await applySeedSkillRefreshMarker(marker)).toEqual({ applied: 1, unchanged: 0, errors: 0 })

    const row = (await db.pool.query("SELECT description, content FROM skills WHERE id = 'global/skill-a'")).rows[0]
    expect(row?.description).toBe('new text')
    expect(row?.content).toContain('new body')
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(home, '.claude', 'skills', 'skill-a', 'SKILL.md'), 'utf8')).toContain('new body')
  })
})
