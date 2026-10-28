import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { seedScheduleIfAbsent } from '../db.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

// Central Claude Code update, dashboard side.
//
// scripts/claude-update.sh (the seeded `claude-update` command task) is the only
// thing that updates the binary; it records the result in claude-update.json.
// Sessions that were already running keep the OLD binary in memory, so after a
// real version change this module restarts them: idle ones only, one at a time,
// spaced apart, the main session last. A session whose tmux creation time is
// older than the recorded `updatedAt` still runs the old build.
//
// The two files are split by owner so no write can be lost: the script owns
// claude-update.json, this module owns claude-update-rollout.json.

export const CLAUDE_UPDATE_TASK = 'claude-update'
/** Monday 06:00 (the node process runs in Europe/Budapest, like every cron here). */
export const CLAUDE_UPDATE_CRON = '0 6 * * 1'
/** A check older than this means the weekly task is not running. */
export const CLAUDE_UPDATE_STALE_DAYS = 10
/** Minimum gap between two restarts of a rollout. */
export const ROLLOUT_STAGGER_MS = 45_000
/** Restart attempts per agent before the rollout leaves it for a manual restart. */
export const ROLLOUT_MAX_ATTEMPTS = 3

const STATE_FILE = 'claude-update.json'
const ROLLOUT_FILE = 'claude-update-rollout.json'
const SEEDED_MARKER = 'claude-update.seeded'

export interface ClaudeUpdateState {
  status?: string
  message?: string
  installed?: string
  latest?: string
  previous?: string
  method?: string
  /** epoch seconds of the last check */
  checkedAt?: number
  /** epoch seconds of the last real version change */
  updatedAt?: number
}

export interface RolloutState {
  /** the updatedAt this rollout belongs to */
  forUpdatedAt?: number
  /** the updatedAt for which every stale session has been dealt with */
  doneForUpdatedAt?: number
  /** epoch ms of the last restart this rollout did */
  lastRestartAt?: number
  restarted?: string[]
  attempts?: Record<string, number>
  incomplete?: string[]
}

export interface ClaudeUpdatePaths {
  stateFile: string
  rolloutFile: string
  /** the marker written when the task was seeded: the age baseline of an install that never ran it */
  seededFile?: string
}
const defaultPaths = (): ClaudeUpdatePaths => ({
  stateFile: join(STORE_DIR, STATE_FILE), rolloutFile: join(STORE_DIR, ROLLOUT_FILE), seededFile: join(STORE_DIR, SEEDED_MARKER),
})

function seededAtSec(p: ClaudeUpdatePaths): number | null {
  if (!p.seededFile) return null
  try { return Math.floor(statSync(p.seededFile).mtimeMs / 1000) } catch { return null }
}

function readJson<T extends object>(path: string): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : ({} as T)
  } catch {
    return {} as T
  }
}

export const readClaudeUpdateState = (p: ClaudeUpdatePaths = defaultPaths()): ClaudeUpdateState => readJson<ClaudeUpdateState>(p.stateFile)
export const readRolloutState = (p: ClaudeUpdatePaths = defaultPaths()): RolloutState => readJson<RolloutState>(p.rolloutFile)

function writeRolloutState(p: ClaudeUpdatePaths, next: RolloutState): void {
  try { atomicWriteFileSync(p.rolloutFile, JSON.stringify(next, null, 2) + '\n') }
  catch (err) { logger.warn({ err }, 'claude-update: failed to persist rollout state') }
}

/** Numeric dotted-version compare: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export interface ClaudeUpdateStatus {
  installed: string | null
  latest: string | null
  previous: string | null
  method: string | null
  status: string | null
  message: string | null
  checkedAt: number | null
  updatedAt: number | null
  /** whole days since the last check, null when never checked */
  checkAgeDays: number | null
  /** a newer version is published than the installed one */
  behind: boolean
  /** the weekly task has not run yet (no check recorded); not a fault by itself, its first run may still be ahead */
  neverChecked: boolean
  /**
   * the weekly task is overdue: the last check, or for an install that never ran it the moment the task was set up,
   * is older than CLAUDE_UPDATE_STALE_DAYS. False before the first run while the task is still young.
   */
  stale: boolean
  /** a version change happened and its rollout has not finished */
  rolloutPending: boolean
  restarted: string[]
  incomplete: string[]
}

export function getClaudeUpdateStatus(nowSec: number = Math.floor(Date.now() / 1000), p: ClaudeUpdatePaths = defaultPaths()): ClaudeUpdateStatus {
  const st = readClaudeUpdateState(p)
  const ro = readRolloutState(p)
  const checkedAt = typeof st.checkedAt === 'number' ? st.checkedAt : null
  const updatedAt = typeof st.updatedAt === 'number' ? st.updatedAt : null
  const checkAgeDays = checkedAt == null ? null : Math.max(0, Math.floor((nowSec - checkedAt) / 86400))
  const forThisUpdate = updatedAt != null && ro.forUpdatedAt === updatedAt
  const baselineSec = checkedAt ?? seededAtSec(p)
  const baselineAgeDays = baselineSec == null ? null : Math.max(0, Math.floor((nowSec - baselineSec) / 86400))
  return {
    installed: st.installed ?? null,
    latest: st.latest ?? null,
    previous: st.previous ?? null,
    method: st.method ?? null,
    status: st.status ?? null,
    message: st.message ?? null,
    checkedAt,
    updatedAt,
    checkAgeDays,
    behind: !!st.installed && !!st.latest && compareVersions(st.installed, st.latest) < 0,
    neverChecked: checkedAt == null,
    stale: baselineAgeDays != null && baselineAgeDays > CLAUDE_UPDATE_STALE_DAYS,
    rolloutPending: updatedAt != null && ro.doneForUpdatedAt !== updatedAt,
    restarted: forThisUpdate ? ro.restarted ?? [] : [],
    incomplete: forThisUpdate ? ro.incomplete ?? [] : [],
  }
}

// ── Rollout ────────────────────────────────────────────────────────────────

export interface RolloutTarget { name: string; isMain: boolean }

export interface RolloutDeps {
  nowMs(): number
  /** CLAUDE_UPDATE_AUTO_RESTART */
  autoRestartEnabled(): boolean
  /** Local sessions that are up right now. A remote agent runs its own install and is not listed. */
  targets(): RolloutTarget[]
  /** tmux session creation time in epoch seconds, null when unknown */
  sessionCreatedSec(t: RolloutTarget): number | null
  isIdle(t: RolloutTarget): boolean
  /** Restart one session; throws when it cannot. */
  restart(t: RolloutTarget): void | Promise<void>
}

export type RolloutResult =
  | { action: 'none' }
  | { action: 'disabled' }
  | { action: 'done'; incomplete: string[] }
  | { action: 'waiting'; reason: 'stagger' | 'busy' }
  | { action: 'restarted'; agent: string }
  | { action: 'failed'; agent: string }

/**
 * One rollout tick: restart at most ONE stale, idle session. Called every minute
 * by the runner; does nothing unless a version change is waiting to be rolled out.
 */
export async function rolloutStep(deps: RolloutDeps, p: ClaudeUpdatePaths = defaultPaths()): Promise<RolloutResult> {
  const st = readClaudeUpdateState(p)
  const updatedAt = typeof st.updatedAt === 'number' ? st.updatedAt : null
  if (updatedAt == null) return { action: 'none' }

  let ro = readRolloutState(p)
  if (ro.doneForUpdatedAt === updatedAt) return { action: 'none' }
  if (!deps.autoRestartEnabled()) return { action: 'disabled' }

  if (ro.forUpdatedAt !== updatedAt) {
    ro = { ...ro, forUpdatedAt: updatedAt, restarted: [], attempts: {}, incomplete: [] }
  }
  const attempts = { ...(ro.attempts ?? {}) }
  const restarted = [...(ro.restarted ?? [])]

  const stale = deps.targets().filter(t => {
    const created = deps.sessionCreatedSec(t)
    return created != null && created < updatedAt
  })
  const workable = stale.filter(t => (attempts[t.name] ?? 0) < ROLLOUT_MAX_ATTEMPTS)
  const exhausted = stale.filter(t => (attempts[t.name] ?? 0) >= ROLLOUT_MAX_ATTEMPTS).map(t => t.name)

  if (workable.length === 0) {
    writeRolloutState(p, { ...ro, attempts, restarted, incomplete: exhausted, doneForUpdatedAt: updatedAt })
    if (exhausted.length > 0) logger.warn({ agents: exhausted }, 'claude-update: rollout finished, some sessions could not be restarted')
    else logger.info({ restarted }, 'claude-update: rollout finished, every session runs the new build')
    return { action: 'done', incomplete: exhausted }
  }

  const now = deps.nowMs()
  if (ro.lastRestartAt != null && now - ro.lastRestartAt < ROLLOUT_STAGGER_MS) {
    return { action: 'waiting', reason: 'stagger' }
  }

  // The main session goes last: only once no sub-agent is left to do.
  const subAgents = workable.filter(t => !t.isMain)
  const order = subAgents.length > 0 ? subAgents : workable
  const candidate = order.find(t => deps.isIdle(t))
  if (!candidate) return { action: 'waiting', reason: 'busy' }

  attempts[candidate.name] = (attempts[candidate.name] ?? 0) + 1
  try {
    await deps.restart(candidate)
  } catch (err) {
    logger.warn({ err, agent: candidate.name }, 'claude-update: restart failed')
    writeRolloutState(p, { ...ro, attempts, restarted, lastRestartAt: now })
    return { action: 'failed', agent: candidate.name }
  }
  restarted.push(candidate.name)
  writeRolloutState(p, { ...ro, attempts, restarted, lastRestartAt: now })
  logger.info({ agent: candidate.name, main: candidate.isMain }, 'claude-update: restarted session onto the new build')
  return { action: 'restarted', agent: candidate.name }
}

// ── Task seeding ───────────────────────────────────────────────────────────

/**
 * Make sure the weekly claude-update command task exists. The built-in updater
 * is off everywhere, so an install without this task would never update. Inserts
 * only when the row is absent and only ONCE per install (marker file): an operator
 * who deleted the row on purpose does not get it back at the next boot. Returns
 * true when a row was inserted.
 */
export function ensureClaudeUpdateTask(storeDir: string = STORE_DIR, projectRoot: string = PROJECT_ROOT, agent: string = MAIN_AGENT_ID): boolean {
  const marker = join(storeDir, SEEDED_MARKER)
  if (existsSync(marker)) return false
  const inserted = seedScheduleIfAbsent(CLAUDE_UPDATE_TASK, {
    prompt: '',
    description: 'Claude Code frissítés hetente egyszer (LLM nélkül): a scripts/claude-update.sh egyetlen, zárolt futással frissít, ellenőrzi a binárist és rögzíti az eredményt. A futó sessionök idle-only, lépcsőzve, a fő-agens utoljára újraindulnak. Hiba esetén (nem 0 exit kód) Telegram-riasztás, újraindítás nem történik.',
    schedule: CLAUDE_UPDATE_CRON,
    agent,
    type: 'command',
    enabled: true,
    tenant_id: 'default',
    skip_if_busy: false,
    force_send: false,
    command: `bash '${projectRoot}/scripts/claude-update.sh'`,
    timeout_ms: 600_000,
    fail_threshold: 1,
    status: 'live',
  })
  try { writeFileSync(marker, new Date().toISOString() + '\n') }
  catch (err) { logger.warn({ err }, 'claude-update: failed to write the seeded marker') }
  return inserted
}
