import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions, getClaudeUpdateStatus, rolloutStep, ROLLOUT_MAX_ATTEMPTS, ROLLOUT_STAGGER_MS,
  CLAUDE_UPDATE_STALE_DAYS, type ClaudeUpdatePaths, type RolloutDeps, type RolloutTarget,
} from '../web/claude-update.js'

let tmp: string
let paths: ClaudeUpdatePaths

const UPDATED_AT = 1_000_000
const write = (file: string, body: object) => writeFileSync(file, JSON.stringify(body))
const rollout = (): Record<string, unknown> => JSON.parse(readFileSync(paths.rolloutFile, 'utf-8'))

interface FakeSession { name: string; isMain?: boolean; created: number | null; idle: boolean; restartThrows?: boolean }

/** Deps over an in-memory fleet: a restart gives the session a creation time after the update. */
function makeDeps(fleet: FakeSession[], opts: { now?: number; autoRestart?: boolean } = {}) {
  const restartOrder: string[] = []
  let now = opts.now ?? 5_000_000
  const find = (t: RolloutTarget) => fleet.find(f => f.name === t.name)!
  const deps: RolloutDeps = {
    nowMs: () => now,
    autoRestartEnabled: () => opts.autoRestart ?? true,
    targets: () => fleet.map(f => ({ name: f.name, isMain: !!f.isMain })),
    sessionCreatedSec: (t) => find(t).created,
    isIdle: (t) => find(t).idle,
    restart: (t) => {
      const f = find(t)
      if (f.restartThrows) throw new Error('boom')
      f.created = UPDATED_AT + 10
      restartOrder.push(t.name)
    },
  }
  return { deps, restartOrder, advance: (ms: number) => { now += ms } }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claude-update-ts-'))
  paths = { stateFile: join(tmp, 'claude-update.json'), rolloutFile: join(tmp, 'claude-update-rollout.json'), seededFile: join(tmp, 'claude-update.seeded') }
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0)
    expect(compareVersions('2.1.300', '2.1.300')).toBe(0)
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0)
    expect(compareVersions('3', '2.9.9')).toBeGreaterThan(0)
  })
})

describe('rolloutStep', () => {
  it('does nothing before any update was recorded', async () => {
    const { deps, restartOrder } = makeDeps([{ name: 'a', created: 1, idle: true }])
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'none' })
    expect(restartOrder).toEqual([])
  })

  it('restarts only sessions older than the update, one per tick', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, restartOrder, advance } = makeDeps([
      { name: 'old1', created: UPDATED_AT - 500, idle: true },
      { name: 'fresh', created: UPDATED_AT + 50, idle: true },
      { name: 'old2', created: UPDATED_AT - 900, idle: true },
    ])
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'old1' })
    // a second tick inside the stagger window waits, it does not restart a second session
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'waiting', reason: 'stagger' })
    expect(restartOrder).toEqual(['old1'])

    advance(ROLLOUT_STAGGER_MS + 1)
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'old2' })
    advance(ROLLOUT_STAGGER_MS + 1)
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'done', incomplete: [] })
    expect(restartOrder).toEqual(['old1', 'old2'])
    expect(rollout()).toMatchObject({ doneForUpdatedAt: UPDATED_AT, restarted: ['old1', 'old2'] })
    // done is final for this update
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'none' })
  })

  it('never touches a busy session and skips it for an idle one', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, restartOrder } = makeDeps([
      { name: 'busy', created: 1, idle: false },
      { name: 'quiet', created: 1, idle: true },
    ])
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'quiet' })
    expect(restartOrder).toEqual(['quiet'])
  })

  it('waits while every stale session is busy and does not mark the rollout done', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, restartOrder } = makeDeps([{ name: 'busy', created: 1, idle: false }])
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'waiting', reason: 'busy' })
    expect(restartOrder).toEqual([])
    expect(existsSync(paths.rolloutFile)).toBe(false)
  })

  it('restarts the main session last, and not while a sub-agent is still stale', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, restartOrder, advance } = makeDeps([
      { name: 'boss', isMain: true, created: 1, idle: true },
      { name: 'sub', created: 1, idle: false },
    ])
    // the main session is idle, but a sub-agent is still waiting on the old build: main holds
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'waiting', reason: 'busy' })
    expect(restartOrder).toEqual([])

    ;(deps as { isIdle: RolloutDeps['isIdle'] }).isIdle = () => true
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'sub' })
    advance(ROLLOUT_STAGGER_MS + 1)
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'boss' })
    expect(restartOrder).toEqual(['sub', 'boss'])
  })

  it('does nothing when auto restart is switched off, and keeps the rollout pending', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, restartOrder } = makeDeps([{ name: 'a', created: 1, idle: true }], { autoRestart: false })
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'disabled' })
    expect(restartOrder).toEqual([])
    expect(getClaudeUpdateStatus(UPDATED_AT + 60, paths).rolloutPending).toBe(true)
  })

  it('finishes straight away when no session predates the update', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, restartOrder } = makeDeps([{ name: 'a', created: UPDATED_AT + 1, idle: true }, { name: 'unknown', created: null, idle: true }])
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'done', incomplete: [] })
    expect(restartOrder).toEqual([])
  })

  it('gives up on a session after repeated restart failures and finishes the rest', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, advance } = makeDeps([
      { name: 'stuck', created: 1, idle: true, restartThrows: true },
      { name: 'good', created: 1, idle: true },
    ])
    for (let i = 0; i < ROLLOUT_MAX_ATTEMPTS; i++) {
      expect(await rolloutStep(deps, paths)).toEqual({ action: 'failed', agent: 'stuck' })
      advance(ROLLOUT_STAGGER_MS + 1)
    }
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'good' })
    advance(ROLLOUT_STAGGER_MS + 1)
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'done', incomplete: ['stuck'] })
    expect(getClaudeUpdateStatus(UPDATED_AT + 60, paths)).toMatchObject({ rolloutPending: false, incomplete: ['stuck'], restarted: ['good'] })
  })

  it('a newer update starts a fresh rollout even if the previous one finished', async () => {
    write(paths.stateFile, { updatedAt: UPDATED_AT })
    const { deps, restartOrder } = makeDeps([{ name: 'a', created: 1, idle: true }])
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'a' })
    ;(deps as { nowMs: () => number }).nowMs = () => 9_000_000
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'done', incomplete: [] })

    // next week: a newer binary, the session restarted last week is older than it again
    write(paths.stateFile, { updatedAt: UPDATED_AT + 700_000 })
    expect(await rolloutStep(deps, paths)).toEqual({ action: 'restarted', agent: 'a' })
    expect(restartOrder).toEqual(['a', 'a'])
    expect(rollout()).toMatchObject({ forUpdatedAt: UPDATED_AT + 700_000, restarted: ['a'] })
  })
})

describe('getClaudeUpdateStatus', () => {
  it('does not call an install stale before its first run when the task was set up recently', () => {
    expect(getClaudeUpdateStatus(2_000_000, paths)).toMatchObject({
      installed: null, checkedAt: null, checkAgeDays: null, neverChecked: true, stale: false, behind: false, rolloutPending: false,
    })
    writeFileSync(paths.seededFile as string, 'x\n')
    const seeded = Math.floor(statSync(paths.seededFile as string).mtimeMs / 1000)
    expect(getClaudeUpdateStatus(seeded + 3 * 86400, paths)).toMatchObject({ neverChecked: true, stale: false, checkAgeDays: null })
  })

  it('calls an install that never ran the task stale once it was set up longer ago than the stale limit', () => {
    writeFileSync(paths.seededFile as string, 'x\n')
    const seeded = Math.floor(statSync(paths.seededFile as string).mtimeMs / 1000)
    expect(getClaudeUpdateStatus(seeded + (CLAUDE_UPDATE_STALE_DAYS + 1) * 86400, paths)).toMatchObject({
      neverChecked: true, stale: true, checkAgeDays: null,
    })
  })

  it('flags a version behind the published one and a check older than the stale limit', () => {
    const day = 86400
    write(paths.stateFile, { installed: '2.1.300', latest: '2.1.310', status: 'up-to-date', checkedAt: 1_000_000 })
    expect(getClaudeUpdateStatus(1_000_000 + 2 * day, paths)).toMatchObject({ behind: true, stale: false, checkAgeDays: 2 })
    expect(getClaudeUpdateStatus(1_000_000 + (CLAUDE_UPDATE_STALE_DAYS + 1) * day, paths)).toMatchObject({ stale: true })
  })

  it('is not behind when the installed version equals or exceeds the published one', () => {
    write(paths.stateFile, { installed: '2.1.310', latest: '2.1.310', checkedAt: 1_000_000 })
    expect(getClaudeUpdateStatus(1_000_100, paths).behind).toBe(false)
    write(paths.stateFile, { installed: '2.1.311', latest: '2.1.310', checkedAt: 1_000_000 })
    expect(getClaudeUpdateStatus(1_000_100, paths).behind).toBe(false)
  })

  it('survives a corrupt state file', () => {
    writeFileSync(paths.stateFile, '{not json')
    expect(getClaudeUpdateStatus(1_000_100, paths)).toMatchObject({ installed: null, neverChecked: true, stale: false })
  })
})

describe('ensureClaudeUpdateTask', () => {
  let dbMod: typeof import('../db.js')
  let mod: typeof import('../web/claude-update.js')

  beforeEach(async () => {
    vi.resetModules()
    dbMod = await import('../db.js')
    dbMod.initDatabase(':memory:')
    mod = await import('../web/claude-update.js')
    mkdirSync(join(tmp, 'store'), { recursive: true })
  })

  it('inserts the weekly Monday 06:00 command task once, pointing at the install dir', async () => {
    expect(await mod.ensureClaudeUpdateTask(join(tmp, 'store'), '/opt/marveen', 'main-agent')).toBe(true)
    expect(await dbMod.getScheduleFromDb('claude-update')).toMatchObject({
      type: 'command', prompt: '', enabled: 1, agent: 'main-agent', schedule: '0 6 * * 1',
      timeout_ms: 600000, fail_threshold: 1, status: 'live', tenant_id: 'default',
      command: "bash '/opt/marveen/scripts/claude-update.sh'",
    })
    // the marker keeps a deliberate deletion from coming back at the next boot
    await dbMod.deleteSchedule('claude-update')
    expect(await mod.ensureClaudeUpdateTask(join(tmp, 'store'), '/opt/marveen', 'main-agent')).toBe(false)
    expect(await dbMod.getScheduleFromDb('claude-update')).toBeUndefined()
  })

  it('never overwrites a row the operator already has', async () => {
    await dbMod.upsertSchedule('claude-update', {
      prompt: '', description: 'mine', schedule: '30 5 * * 2', agent: 'someone', type: 'command', enabled: false,
      skip_if_busy: false, force_send: false, command: 'bash /srv/my-update.sh', timeout_ms: 1000, fail_threshold: 3,
      status: 'live', tenant_id: null,
    })
    const before = { ...await dbMod.getScheduleFromDb('claude-update') }
    expect(await mod.ensureClaudeUpdateTask(join(tmp, 'store'), '/opt/marveen', 'main-agent')).toBe(false)
    expect(await dbMod.getScheduleFromDb('claude-update')).toEqual(before)
  })
})
