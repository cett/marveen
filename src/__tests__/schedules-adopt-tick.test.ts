// End to end: a task whose author may no longer write schedules is skipped by the REAL tick, a signed-in admin adopts it
// through the REAL route, and the next tick runs it. Real database, real route, real runner; only the edges are
// mocked (the agent session, the command runner, Telegram, the tenant orphan check). The positive pair is the same
// task with an active author, so a gate that never fires would not be green here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  TELEGRAM_BOT_TOKEN: 'test-token',
  ALLOWED_CHAT_ID: '1',
  MAIN_AGENT_ID: 'main-agent',
  currentBotName: () => 'Main',
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(() => Promise.resolve()),
  sendTelegramPhoto: vi.fn(() => Promise.resolve()),
}))
vi.mock('../web/command-task.js', () => ({ runCommandTask: vi.fn() }))
vi.mock('../web/schedule-tenant.js', async (orig) => ({
  ...(await orig<typeof import('../web/schedule-tenant.js')>()),
  createPairOrphanChecker: () => () => Promise.resolve(false),
}))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: vi.fn(() => Promise.resolve(true)),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(true)),
}))

let tmp: string
let prevHome: string | undefined
let dbMod: typeof import('../db.js')
let route: typeof import('../web/routes/schedules.js')
let runner: typeof import('../web/schedule-runner.js')
let procMock: typeof import('../web/agent-process.js')
let cmdMock: typeof import('../web/command-task.js')
let ownerId: number
let departedId: number

const FIRST = new Date('2026-10-26T10:30:00.000Z')
const SECOND = new Date('2026-10-26T11:00:00.000Z')
const human = { role: 'admin', tenantId: null, auth: { kind: 'session', user: 'owner' } }

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-adopt-tick-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')
  runner = await import('../web/schedule-runner.js')
  procMock = await import('../web/agent-process.js')
  cmdMock = await import('../web/command-task.js')

  ownerId = (await dbMod.createDashboardUser('owner', 'hash-a')).id
  departedId = (await dbMod.createDashboardUser('departed-admin', 'hash-b')).id
  dbMod.getDb().prepare("UPDATE dashboard_users SET role = 'admin' WHERE id IN (?, ?)").run(ownerId, departedId)

  const base = { description: 'Half-hourly', prompt: 'Do the thing', schedule: '*/30 * * * *', enabled: true, skip_if_busy: false, force_send: false, tenant_id: 'default', status: 'live' as const }
  await dbMod.upsertSchedule('e2e-task', { ...base, agent: 'agent-a', type: 'task', author: { userId: departedId, label: 'departed-admin' }, activation: { by: 'owner', at: 1000 } })
  await dbMod.upsertSchedule('e2e-cmd', { ...base, agent: 'agent-a', type: 'command', command: 'echo hi', author: { userId: departedId, label: 'departed-admin' }, activation: { by: 'owner', at: 1000 } })

  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(FIRST)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function tickAt(when: Date): Promise<void> {
  vi.setSystemTime(when)
  const stop = runner.startScheduleRunner()
  await vi.advanceTimersByTimeAsync(5_000)
  clearInterval(stop)
}

async function adopt(name: string, who: object = human): Promise<{ status: number }> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
  req.method = 'POST'
  req.headers = {}
  req.destroy = () => {}
  setImmediate(() => { req.emit('data', Buffer.alloc(0)); req.emit('end') })
  const out = { status: 200 }
  const res = { writeHead(s: number) { out.status = s }, setHeader() {}, end() {} }
  const url = new URL(`http://localhost:3420/api/schedules/${name}/adopt`)
  await route.tryHandleSchedules({ req, res, path: url.pathname, method: 'POST', url, ...who } as unknown as RouteContext)
  return out
}

const taskRuns = (name: string): string[] => (dbMod.getDb()
  .prepare('SELECT status FROM task_runs WHERE name = ? ORDER BY id').all(name) as Array<{ status: string }>).map(r => r.status)
const injections = (): number => vi.mocked(procMock.sendPromptToSession).mock.calls.length
const commandRuns = (): string[] => vi.mocked(cmdMock.runCommandTask).mock.calls.map(c => (c[0] as { name: string }).name)
const disable = (id: number): void => { dbMod.getDb().prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = ?').run(id) }

describe('a departed author, an adopt and the next tick', () => {
  it('positive pair first: while the author is active the same tasks run', async () => {
    await tickAt(FIRST)
    expect(injections()).toBe(1)
    expect(commandRuns()).toEqual(['e2e-cmd'])
    expect(taskRuns('e2e-task').filter(s => s.startsWith('skipped_author_'))).toEqual([])
    expect(taskRuns('e2e-cmd').filter(s => s.startsWith('skipped_author_'))).toEqual([])
  })

  it('inactive author: skipped; adopt; the next tick runs it, for the prompt task and the command task alike', async () => {
    disable(departedId)
    await tickAt(FIRST)
    expect(injections()).toBe(0)
    expect(commandRuns()).toEqual([])
    expect(taskRuns('e2e-task')).toContain('skipped_author_inactive')
    expect(taskRuns('e2e-cmd')).toContain('skipped_author_inactive')

    // the screen shows the state, the admin takes the tasks over
    expect((await adopt('e2e-task')).status).toBe(200)
    expect((await adopt('e2e-cmd')).status).toBe(200)
    expect((await dbMod.getScheduleFromDb('e2e-task'))!.author_user_id).toBe(ownerId)

    vi.clearAllMocks()
    await tickAt(SECOND)
    expect(injections()).toBe(1)
    expect(commandRuns()).toEqual(['e2e-cmd'])
    expect(taskRuns('e2e-task').filter(s => s === 'skipped_author_inactive')).toHaveLength(1)
  })

  it('adopting one task does not release the other task of the same departed author', async () => {
    disable(departedId)
    await tickAt(FIRST)
    expect((await adopt('e2e-task')).status).toBe(200)
    vi.clearAllMocks()
    await tickAt(SECOND)
    expect(injections()).toBe(1)
    expect(commandRuns()).toEqual([])
    expect(taskRuns('e2e-cmd').filter(s => s === 'skipped_author_inactive')).toHaveLength(2)
  })

  it('a refused adopt (a token) changes nothing: the next tick still skips', async () => {
    disable(departedId)
    await tickAt(FIRST)
    expect((await adopt('e2e-task', { role: 'admin', tenantId: null, auth: { kind: 'token' } })).status).toBe(403)
    vi.clearAllMocks()
    await tickAt(SECOND)
    expect(injections()).toBe(0)
    expect(taskRuns('e2e-task').filter(s => s === 'skipped_author_inactive')).toHaveLength(2)
  })
})
