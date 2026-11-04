import { randomBytes } from 'node:crypto'
import { execSync, execFileSync } from 'node:child_process'
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
import { resolveFromPath } from '../../platform.js'
import { APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

import { runAsAgentJob } from '../../db/background-jobs.js'
const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 30 * 60 * 1000

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function bgSessionName(id: string): string {
  return `bg-${id}`
}

function isBgSessionAlive(session: string): boolean {
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { timeout: 3000, encoding: 'utf-8' })
    return out.split('\n').some(l => l.trim() === session)
  } catch {
    return false
  }
}

function captureSession(session: string): string | null {
  try {
    return execFileSync(TMUX, ['capture-pane', '-t', session, '-p', '-S', '-500'], { timeout: 5000, encoding: 'utf-8' })
  } catch {
    return null
  }
}

function killSession(session: string): void {
  try {
    execFileSync(TMUX, ['kill-session', '-t', session], { timeout: 3000 })
  } catch { /* already dead */ }
}

export async function spawnBackgroundTask(agentId: string, prompt: string): Promise<BackgroundTask | { error: string; hint?: string }> {
  const id = randomBytes(4).toString('hex').toUpperCase()
  const session = bgSessionName(id)

  const task = await createBackgroundTaskAtomic(id, agentId, prompt, session, MAX_CONCURRENT)
  if (!task) {
    return { error: 'limit_exceeded', hint: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }

  const shellCmd = [
    `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    // No in-process auto-update: updates run through the central claude-update task.
    `export DISABLE_AUTOUPDATER=1`,
    `${CLAUDE} -p "$BG_PROMPT" --output-format text 2>&1`,
  ].join(' && ')

  try {
    execFileSync(TMUX, [
      'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
      `${shellCmd}; echo '___BG_DONE___'; sleep 5`,
    ], {
      timeout: 5000,
      env: { ...process.env, BG_PROMPT: prompt },
    })
  } catch (err) {
    logger.error({ err, id, session }, 'Failed to spawn background task tmux session')
    await finishBackgroundTask(id, 'failed', '(spawn failed)')
    return { error: 'internal_error', hint: 'Nem sikerült elindítani a háttérfeladatot' }
  }

  logger.info({ id, agentId, session, prompt: prompt.slice(0, 100) }, 'Background task started')

  scheduleFinalize(id, agentId)
  pollUntilDone(id, agentId)

  return task
}

function pollUntilDone(id: string, agentId: string): void {
  // The tick is async (db facade): an interval callback cannot be awaited, so the body is its own function with its
  // own try/catch (a rejection would otherwise be an unhandled rejection), and `inFlight` keeps a slow tick from
  // overlapping the next one.
  let inFlight = false
  const interval = setInterval(() => {
    if (inFlight) return
    inFlight = true
    void runAsAgentJob('background-task', agentId, () => pollTick()).finally(() => { inFlight = false })
  }, 10_000)

  async function pollTick(): Promise<void> {
    try {
      const task = await getBackgroundTask(id)
      if (!task || task.status !== 'running') {
        clearInterval(interval)
        return
      }

      const session = task.tmux_session
      if (!session) { clearInterval(interval); return }

      if (!isBgSessionAlive(session)) {
        // finishBackgroundTask closes only a still-running task: false means the timeout sweep got there first.
        if (await finishBackgroundTask(id, 'done', '(session ended)')) logger.info({ id }, 'Background task session ended')
        clearInterval(interval)
        return
      }

      const pane = captureSession(session)
      if (pane && pane.includes('___BG_DONE___')) {
        const output = pane.replace(/___BG_DONE___[\s\S]*$/, '').trim()
        if (await finishBackgroundTask(id, 'done', output)) {
          killSession(session)
          logger.info({ id }, 'Background task completed')
        }
        clearInterval(interval)
      }
    } catch (err) {
      logger.error({ err, id }, 'Background task poll tick failed')
    }
  }
}

function scheduleFinalize(id: string, agentId: string): void {
  setTimeout(() => { void runAsAgentJob('background-task', agentId, () => checkAndFinalize(id)) }, TIMEOUT_MS)
}

async function checkAndFinalize(id: string): Promise<void> {
  try {
    const task = await getBackgroundTask(id)
    if (!task || task.status !== 'running') return

    const session = task.tmux_session
    const output = session ? captureSession(session) : null
    // The poll may finish the task between the read above and this write: only the writer that moves the row out of
    // 'running' reports the final state and kills the session.
    if (!(await finishBackgroundTask(id, 'timeout', output?.trim() || '(timeout)'))) return
    if (session) killSession(session)
    logger.warn({ id }, 'Background task timed out after 30 minutes')
  } catch (err) {
    logger.error({ err, id }, 'Background task timeout check failed')
  }
}

export async function sweepOrphanedBackgroundTasks(): Promise<void> {
  const running = await getRunningBackgroundTasks()
  let orphaned = 0
  for (const task of running) {
    if (!task.tmux_session || !isBgSessionAlive(task.tmux_session)) {
      const output = task.tmux_session ? captureSession(task.tmux_session) : null
      if (await finishBackgroundTask(task.id, 'failed', output?.trim() || '(orphaned on restart)')) orphaned++
    } else {
      scheduleFinalize(task.id, task.agent_id)
      pollUntilDone(task.id, task.agent_id)
    }
  }
  if (orphaned) logger.info({ orphaned }, 'Swept orphaned background tasks on startup')
}

const TASK_ID_RE = /^\/api\/background-tasks\/([A-F0-9]{8})$/

export async function tryHandleBackgroundTasks(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/background-tasks' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id: string; prompt: string }
    if (!data.prompt?.trim()) {
      json(res, { error: 'required', field: 'prompt', hint: 'Prompt megadása kötelező' }, 400)
      return true
    }
    if (!data.agent_id?.trim()) {
      json(res, { error: 'required', field: 'agentId', hint: 'Agent ID megadása kötelező' }, 400)
      return true
    }

    const result = await spawnBackgroundTask(data.agent_id.trim(), data.prompt.trim())
    if ('error' in result) {
      json(res, { error: result.error, ...(result.hint ? { hint: result.hint } : {}) }, result.error === 'limit_exceeded' ? 429 : 500)
      return true
    }
    json(res, result, 201)
    return true
  }

  if (path === '/api/background-tasks' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || undefined
    const all = url.searchParams.get('all') === 'true'
    const tasks = await getBackgroundTasks(agentId, all)
    const formatted = tasks.map(t => ({
      ...t,
      started_label: new Date(t.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: t.finished_at ? new Date(t.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    }))
    json(res, formatted)
    return true
  }

  const taskMatch = path.match(TASK_ID_RE)
  if (taskMatch && method === 'GET') {
    const task = await getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'not_found', hint: 'Háttérfeladat nem található' }, 404); return true }

    let liveOutput: string | null = null
    if (task.status === 'running' && task.tmux_session) {
      liveOutput = captureSession(task.tmux_session)
    }

    json(res, {
      ...task,
      liveOutput,
      started_label: new Date(task.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: task.finished_at ? new Date(task.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    })
    return true
  }

  if (taskMatch && method === 'DELETE') {
    const task = await getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'not_found', hint: 'Háttérfeladat nem található' }, 404); return true }
    const output = task.tmux_session ? captureSession(task.tmux_session) : null
    if (task.status === 'running' && task.tmux_session) {
      killSession(task.tmux_session)
    }
    await finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
    json(res, { ok: true })
    return true
  }

  return false
}
