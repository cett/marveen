// The schedule seed from the task files (seedSchedulesFromFilesIfEmpty), as the app role, with no wrapper in the test.
// A file of its own: the task directory is fixed at import from the home folder (os.homedir()), so each cell points HOME at a
// temp folder BEFORE a fresh import of the module (vi.resetModules), with the backend booted on that same module graph.
// The reset would break the lazy imports of the other startup cells, so they live in rls-startup-seeds.pg.test.ts.
//
// Privacy: neutral fixtures only (two task directories).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const made: PgTestDb[] = []
const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs() })
afterAll(async () => {
  for (const d of made) await d.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'startup-seed-files-')); dirs.push(d); return d }
const scheduleNames = async (db: PgTestDb): Promise<string[]> =>
  (await db.pool.query('SELECT id AS name FROM schedules ORDER BY id')).rows.map((r: { name: string }) => r.name)

function taskFixture(home: string): void {
  const root = join(home, '.claude', 'scheduled-tasks')
  mkdirSync(join(root, 'task-a'), { recursive: true })
  writeFileSync(join(root, 'task-a', 'task-config.json'), JSON.stringify({ schedule: '0 9 * * *', agent: 'agent-a' }))
  writeFileSync(join(root, 'task-a', 'SKILL.md'), '---\nname: task-a\ndescription: a\n---\nbody')
  mkdirSync(join(root, 'task-b'), { recursive: true })
  writeFileSync(join(root, 'task-b', 'task-config.json'), JSON.stringify({ schedule: '0 10 * * *', agent: 'agent-a', type: 'command', command: 'true' }))
}

async function freshSeed(db: PgTestDb, home: string): Promise<{ seed: () => Promise<number>; close: () => Promise<void> }> {
  vi.stubEnv('HOME', home)
  vi.resetModules()
  const boot = await import('../../db/pg-boot.js')
  await boot.bootPgBackend({ url: db.appUrl })
  const io = await import('../../web/scheduled-tasks-io.js')
  // the directory the module read is the fixture: a cell that seeded from the real home would pass or fail by the machine
  expect(io.SCHEDULED_TASKS_DIR).toBe(join(home, '.claude', 'scheduled-tasks'))
  return { seed: io.seedSchedulesFromFilesIfEmpty, close: boot.closePgBackend }
}

describe('the schedule seed from the task files (the table is empty or not)', () => {
  it('an empty table is seeded from the files (an empty context is refused every insert)', async () => {
    const db = await createPgTestDb()
    made.push(db)
    const home = tmp()
    taskFixture(home)
    const { seed, close } = await freshSeed(db, home)
    try {
      expect(await seed()).toBe(2)
      expect(await scheduleNames(db)).toEqual(['task-a', 'task-b'])
    } finally { await close() }
  })

  it('a table that already holds a row is left alone (an empty context sees none and would seed again)', async () => {
    const db = await createPgTestDb()
    made.push(db)
    await db.pool.query("INSERT INTO schedules (id, schedule, agent, type, prompt) VALUES ('task-x', '0 8 * * *', 'agent-a', 'task', 'p')")
    const home = tmp()
    taskFixture(home)
    const { seed, close } = await freshSeed(db, home)
    try {
      expect(await seed()).toBe(0)
      expect(await scheduleNames(db)).toEqual(['task-x'])
    } finally { await close() }
  })
})
