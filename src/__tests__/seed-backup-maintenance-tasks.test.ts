import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The nightly backup and the memory maintenance ship as LLM-free command tasks.
// Guards two things: the shipped shape (what a fresh install gets, rendered the
// way the installer renders it) and the DB-first rule that a seeded task never
// overwrites a schedule row the operator already has.
const ROOT = join(__dirname, '..', '..')
const SEED = join(ROOT, 'seed-scheduled-tasks')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

interface SeedConfig {
  schedule: string
  agent: string
  enabled: boolean
  type: string
  description: string
  command: string
  timeoutMs: number
  failThreshold: number
  createdAt: number
}

const readConfig = (name: string): SeedConfig =>
  JSON.parse(readFileSync(join(SEED, name, 'task-config.json'), 'utf-8')) as SeedConfig

function renderSeedTemplateFn(): string {
  const start = UPDATE.indexOf('render_seed_template() {')
  if (start < 0) throw new Error('render_seed_template() not found in update.sh')
  return UPDATE.slice(start, UPDATE.indexOf('\n}', start) + 2)
}

/** Render a seed file exactly like update.sh / the installers do. */
function render(file: string, installDir: string): string {
  return execFileSync(
    'bash',
    ['-c', `${renderSeedTemplateFn()}\nrender_seed_template < "$1"`, 'render', file],
    {
      encoding: 'utf-8',
      env: { ...process.env, MAIN_AGENT_ID: 'main-agent', BOT_NAME: 'Bot', OWNER_NAME: 'Owner', INSTALL_DIR: installDir, WEB_PORT: '4567' },
    },
  )
}

describe('seed task shape', () => {
  const TASKS = [
    { name: 'nightly-backup', schedule: '0 3 * * *', timeoutMs: 120000 },
    { name: 'memory-maintenance', schedule: '15 3 * * *', timeoutMs: 480000 },
  ]

  for (const t of TASKS) {
    describe(t.name, () => {
      const cfg = readConfig(t.name)

      it('is an enabled command task on its nightly cron, alerting on the first failure', () => {
        expect(cfg.type).toBe('command')
        expect(cfg.enabled).toBe(true)
        expect(cfg.schedule).toBe(t.schedule)
        expect(cfg.timeoutMs).toBe(t.timeoutMs)
        expect(cfg.failThreshold).toBe(1)
      })

      it('targets the main agent via the placeholder and carries no hardcoded path or port', () => {
        expect(cfg.agent).toBe('{{MAIN_AGENT_ID}}')
        expect(cfg.command).toContain('{{INSTALL_DIR}}')
        expect(cfg.command).not.toMatch(/\/Users\/|\/home\//)
        expect(cfg.command).not.toMatch(/:3420\b/)
      })

      it('ships no SKILL.md (a command task has no prompt)', () => {
        expect(readdirSync(join(SEED, t.name))).toEqual(['task-config.json'])
      })
    })
  }

  it('the backup runs scripts/backup.sh from the install dir', () => {
    expect(readConfig('nightly-backup').command).toBe("bash '{{INSTALL_DIR}}/scripts/backup.sh'")
  })

  it('the maintenance resorts memories, then maintains links, and fails if either call fails', () => {
    const { command } = readConfig('memory-maintenance')
    const resort = command.indexOf('/api/memories/resort')
    const links = command.indexOf('/api/memories/links/maintain')
    expect(resort).toBeGreaterThan(-1)
    expect(links).toBeGreaterThan(resort)
    expect(command).toContain('{{WEB_PORT}}')
    // Each step must be gated on `"ok":true` (an HTTP error body has none) and chained with &&
    // so a failed resort skips (and fails) the whole task.
    expect(command.match(/bash "\$API" /g)).toHaveLength(2)
    expect(command.match(/grep -q '"ok":true'/g)).toHaveLength(2)
    expect(command).toContain("| grep -q '\"ok\":true' && bash")
  })
})

describe('seeding into the schedules DB', () => {
  let tmp: string
  let prevHome: string | undefined
  let dbMod: typeof import('../db.js')
  let io: typeof import('../web/scheduled-tasks-io.js')

  /** Install the two seed dirs into the tmp HOME the way update.sh does. */
  function installSeeds(): void {
    for (const name of ['nightly-backup', 'memory-maintenance']) {
      const target = join(tmp, '.claude', 'scheduled-tasks', name)
      mkdirSync(target, { recursive: true })
      for (const f of readdirSync(join(SEED, name))) {
        writeFileSync(join(target, f), render(join(SEED, name, f), '/opt/marveen'))
      }
    }
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-bm-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = tmp
    process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
    vi.resetModules()
    dbMod = await import('../db.js')
    dbMod.initDatabase(':memory:')
    io = await import('../web/scheduled-tasks-io.js')
    installSeeds()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
    delete process.env['MARVEEN_STORE_DIR']
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a fresh install gets both as command rows with no prompt and the rendered command', () => {
    expect(io.seedSchedulesFromFilesIfEmpty()).toBe(2)

    const backup = dbMod.getScheduleFromDb('nightly-backup')
    expect(backup).toMatchObject({
      type: 'command', prompt: '', enabled: 1, agent: 'main-agent',
      schedule: '0 3 * * *', timeout_ms: 120000, fail_threshold: 1, status: 'live', tenant_id: 'default',
      command: "bash '/opt/marveen/scripts/backup.sh'",
    })

    const maint = dbMod.getScheduleFromDb('memory-maintenance')
    expect(maint).toMatchObject({
      type: 'command', prompt: '', enabled: 1, agent: 'main-agent',
      schedule: '15 3 * * *', timeout_ms: 480000, fail_threshold: 1, status: 'live',
    })
    // The calls go through the API wrapper (own token resolved there, never on the command line).
    expect(maint?.command).toContain("'/opt/marveen/scripts/agent-api.sh'")
    expect(maint?.command).toContain("DASHBOARD_BASE_URL='http://localhost:4567'")
    expect(maint?.command).toContain('--agent main-agent')
    expect(maint?.command).not.toMatch(/dashboard-token|Bearer/)
    expect(maint?.command).toContain('/api/memories/resort')
    expect(maint?.command).toContain('/api/memories/links/maintain')
    expect(maint?.command).not.toContain('{{')
    expect(backup?.command).not.toContain('{{')
  })

  it('an existing install keeps its own rows untouched and gains nothing from the files', () => {
    const custom = dbMod.upsertSchedule('nightly-backup', {
      prompt: 'operator prompt', description: 'my backup', schedule: '30 1 * * *', agent: 'someone',
      type: 'command', enabled: false, skip_if_busy: false, force_send: false,
      command: 'bash /srv/my-backup.sh', timeout_ms: 900000, fail_threshold: 3,
      status: 'live', tenant_id: null,
    })
    const before = { ...dbMod.getScheduleFromDb('nightly-backup') }

    expect(io.seedSchedulesFromFilesIfEmpty()).toBe(0)

    expect(dbMod.getScheduleFromDb('nightly-backup')).toEqual(before)
    expect(dbMod.getScheduleFromDb('nightly-backup')).toMatchObject({ command: 'bash /srv/my-backup.sh', schedule: '30 1 * * *', enabled: 0 })
    expect(custom.id).toBe('nightly-backup')
    // The table was not empty, so the memory-maintenance file is not imported either.
    expect(dbMod.getScheduleFromDb('memory-maintenance')).toBeUndefined()
  })

  it('a row for one seeded task survives even when the other is absent (insert-or-ignore)', () => {
    const seedIfAbsent = dbMod.seedScheduleIfAbsent
    dbMod.upsertSchedule('memory-maintenance', {
      prompt: 'kept', description: 'mine', schedule: '45 4 * * *', agent: 'someone',
      type: 'task', enabled: true, skip_if_busy: true, force_send: false,
      status: 'live', tenant_id: null,
    })
    const before = { ...dbMod.getScheduleFromDb('memory-maintenance') }

    const task = io.listScheduledTasksFromFiles().find(t => t.name === 'memory-maintenance')
    expect(task).toBeDefined()
    expect(seedIfAbsent('memory-maintenance', {
      prompt: task!.prompt, description: task!.description, schedule: task!.schedule, agent: task!.agent,
      type: task!.type ?? 'task', enabled: task!.enabled, tenant_id: null,
      skip_if_busy: false, force_send: false,
      command: task!.command ?? null, timeout_ms: task!.timeoutMs ?? null, fail_threshold: task!.failThreshold ?? null,
    })).toBe(false)

    expect(dbMod.getScheduleFromDb('memory-maintenance')).toEqual(before)
  })
})
