import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The daily RBAC shadow-log summary ships as an LLM-free command task. Guards the shipped shape
// (rendered the way the installer renders it) and that the script it runs exists, takes the
// window the seed passes, and that a fresh install picks the seed up as a command row.
const ROOT = join(__dirname, '..', '..')
const SEED = join(ROOT, 'seed-scheduled-tasks', 'rbac-shadow-monitor')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

interface SeedConfig {
  schedule: string; agent: string; enabled: boolean; type: string; command: string
  timeoutMs: number; failThreshold: number; createdAt: number; description: string
}
const cfg = JSON.parse(readFileSync(join(SEED, 'task-config.json'), 'utf-8')) as SeedConfig

function render(file: string, installDir: string): string {
  const start = UPDATE.indexOf('render_seed_template() {')
  if (start < 0) throw new Error('render_seed_template() not found in update.sh')
  const fn = UPDATE.slice(start, UPDATE.indexOf('\n}', start) + 2)
  return execFileSync('bash', ['-c', `${fn}\nrender_seed_template < "$1"`, 'render', file], {
    encoding: 'utf-8',
    env: { ...process.env, MAIN_AGENT_ID: 'main-agent', BOT_NAME: 'Bot', OWNER_NAME: 'Owner', INSTALL_DIR: installDir, WEB_PORT: '4567' },
  })
}

describe('rbac-shadow-monitor seed shape', () => {
  it('is an enabled daily command task that alerts on the first failure', () => {
    expect(cfg.type).toBe('command')
    expect(cfg.enabled).toBe(true)
    expect(cfg.schedule).toBe('30 7 * * *')
    expect(cfg.failThreshold).toBe(1)
    expect(cfg.timeoutMs).toBeGreaterThanOrEqual(30000)
  })

  it('targets the main agent via the placeholder and carries no hardcoded path or port', () => {
    expect(cfg.agent).toBe('{{MAIN_AGENT_ID}}')
    expect(cfg.command).toContain('{{INSTALL_DIR}}')
    expect(cfg.command).toContain('{{WEB_PORT}}')
    expect(cfg.command).not.toMatch(/\/Users\/|\/home\//)
    expect(cfg.command).not.toMatch(/:3420\b/)
  })

  it('ships no SKILL.md (a command task has no prompt)', () => {
    expect(readdirSync(SEED)).toEqual(['task-config.json'])
  })

  it('renders to a command that points at an existing script with the 24 h window', () => {
    const rendered = JSON.parse(render(join(SEED, 'task-config.json'), '/opt/marveen')) as SeedConfig
    expect(rendered.command).not.toContain('{{')
    expect(rendered.command).toContain("MARVEEN_DASHBOARD_BASE='http://localhost:4567'")
    expect(rendered.command).toContain("python3 '/opt/marveen/scripts/rbac-shadow-summary.py'")
    expect(rendered.command).toContain('--hours 24')
    expect(existsSync(join(ROOT, 'scripts', 'rbac-shadow-summary.py'))).toBe(true)
  })
})

describe('seeding into the schedules DB', () => {
  let tmp: string
  let prevHome: string | undefined
  let dbMod: typeof import('../db.js')
  let io: typeof import('../web/scheduled-tasks-io.js')

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-rbac-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = tmp
    process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
    vi.resetModules()
    dbMod = await import('../db.js')
    dbMod.initDatabase(':memory:')
    io = await import('../web/scheduled-tasks-io.js')
    const target = join(tmp, '.claude', 'scheduled-tasks', 'rbac-shadow-monitor')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'task-config.json'), render(join(SEED, 'task-config.json'), '/opt/marveen'))
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
    delete process.env['MARVEEN_STORE_DIR']
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a fresh install gets it as a command row in the default tenant, no prompt', () => {
    expect(io.seedSchedulesFromFilesIfEmpty()).toBe(1)
    expect(dbMod.getScheduleFromDb('rbac-shadow-monitor')).toMatchObject({
      type: 'command', prompt: '', enabled: 1, agent: 'main-agent', schedule: '30 7 * * *',
      fail_threshold: 1, status: 'live', tenant_id: 'default',
      command: expect.stringContaining("/opt/marveen/scripts/rbac-shadow-summary.py"),
    })
  })
})
