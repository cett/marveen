import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'
import { BACKGROUND_JOBS } from '../db/background-jobs.js'

// The writers of the schedule-runner tick that STAY in the job's own `system` context, on purpose (row-level security,
// step S2b):
//   - the `pending_task_retries` writes (class D2: no tenant column, privileged only, keyed by task and agent name);
//   - the blackboard write of the tick (class A, but the tenant stamp is derived INSIDE the writer by the agent's
//     availability, which needs the cross-tenant read: a tenant block around it would make a two-tenant agent stamp the
//     task's tenant instead of the shared sentinel).
// Two kinds of claim, two kinds of cell. A recorder around the REAL db function proves the WRAPPER (the db context of the
// call); it cannot see a wrong filter, so every claim about WHICH ROWS are touched runs on the real in-memory database.

type Seen = { fn: string; args: unknown[]; ctx: unknown }
const mockSeen: Seen[] = []
let mockCtx: () => unknown = () => undefined
let mockReady = false
let mockPane: string | null = null
type Runner = typeof import('../web/schedule-runner.js')
type Db = typeof import('../db.js')
let runnerModule: Runner | undefined
let db: Db | undefined

const mockListScheduledTasks = vi.fn<() => Promise<ScheduledTask[]>>()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))

// The real database with a recorder around the writers under test: the call is passed through, the db context of the
// call is noted.
vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  const spy = <A extends unknown[], R>(fn: string, real: (...a: A) => R) => (...args: A): R => {
    mockSeen.push({ fn, args, ctx: mockCtx() })
    return real(...args)
  }
  return {
    ...actual,
    insertPendingTaskRetryIfNew: spy('insertPendingTaskRetryIfNew', actual.insertPendingTaskRetryIfNew),
    updatePendingTaskRetry: spy('updatePendingTaskRetry', actual.updatePendingTaskRetry),
    deletePendingTaskRetry: spy('deletePendingTaskRetry', actual.deletePendingTaskRetry),
    markPendingTaskRetryAlert: spy('markPendingTaskRetryAlert', actual.markPendingTaskRetryAlert),
    upsertBlackboard: spy('upsertBlackboard', actual.upsertBlackboard),
  }
})

vi.mock('../web/schedule-tenant.js', () => ({ createPairOrphanChecker: () => () => Promise.resolve(false) }))
vi.mock('../web/command-task.js', () => ({ runCommandTask: vi.fn(() => Promise.resolve()) }))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  listDbRunnableTaskNames: () => Promise.resolve([]),
  syncTaskConfigEnabledFromDb: vi.fn().mockResolvedValue([]),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-tick-system-writers-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  isTaskLive: (task: { status?: string }) => task.status === undefined || task.status === 'live',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => Promise.resolve(mockReady),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: () => mockPane,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(false)),
}))

// The pane "text" the tests hand out IS the state: 'idle' | 'busy' | ...
vi.mock('../pane-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pane-state.js')>()),
  detectPaneState: (pane: string) => pane,
}))

const START = new Date('2026-10-26T10:30:00.000Z')
// A quiet moment of the fixture cron ('0 8 * * *'): only the retry queue and the watchdog act, no occurrence is due.
const QUIET = new Date('2026-08-14T10:30:00.000Z')

function task(name: string, over: Partial<ScheduledTask> & { status?: string } = {}): ScheduledTask {
  return {
    name, description: '', prompt: 'p', schedule: '* * * * *', agent: 'agent-a', enabled: true,
    createdAt: 0, type: 'heartbeat', skipIfBusy: false, forceSend: false, status: 'live', targetSession: 'fixture-session',
    ...over,
  } as ScheduledTask
}

async function loadRunner(): Promise<Runner> {
  vi.resetModules()
  runnerModule = await import('../web/schedule-runner.js')
  // the runner's own module graph owns the AsyncLocalStorage of the db context and the database of the cells
  mockCtx = (await import('../db/context.js')).currentDbContext
  db = await import('../db.js')
  db.initDatabase(':memory:')
  await db.createTenant('tenant-a', 'Tenant A')
  await db.createTenant('tenant-b', 'Tenant B')
  return runnerModule
}

async function runTick(): Promise<void> {
  const stop = (await loadRunnerIfNeeded()).startScheduleRunner()
  await vi.advanceTimersByTimeAsync(5_000)
  clearInterval(stop)
}

async function loadRunnerIfNeeded(): Promise<Runner> {
  return runnerModule ?? loadRunner()
}

// A pre-check script that answers SKIP: the operator business gate that skips a tick without the LLM.
const SCRIPT_DIR = mkdtempSync(join(tmpdir(), 'tick-system-writers-precheck-'))
const SKIP_SCRIPT = join(SCRIPT_DIR, 'skip.sh')
writeFileSync(SKIP_SCRIPT, 'echo SKIP\n')

const callsOf = (fn: string): Seen[] => mockSeen.filter((s) => s.fn === fn)
const SYSTEM_CTX = { role: 'system', name: 'schedule-runner' }

// A queued retry row on the real table, `ageMs` old, with `attempts` attempts behind it.
async function seedRetry(taskName: string, agent: string, ageMs: number, attempts: number): Promise<void> {
  const d = db!
  await d.insertPendingTaskRetryIfNew(taskName, agent, Date.now() - ageMs, 'busy')
  for (let i = 1; i < attempts; i++) await d.updatePendingTaskRetry(taskName, agent, Date.now() - 15_000, 'busy')
  mockSeen.length = 0
}

describe('schedule runner tick: the pending_task_retries writers stay in the system context (class D2, on purpose)', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    mockSeen.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(START)
    mockListScheduledTasks.mockResolvedValue([])
    mockReady = false
    mockPane = null
    runnerModule = undefined
    db = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  afterAll(() => { rmSync(SCRIPT_DIR, { recursive: true, force: true }) })

  it('the first busy hit of a due task queues its retry row: role system, no tenant, row present', async () => {
    await loadRunner()
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { tenantId: 'tenant-a' })])
    // construction: the table is empty before the tick, the task is of a tenant, the session is busy
    expect(await db!.listPendingTaskRetries()).toEqual([])
    await runTick()
    const calls = callsOf('insertPendingTaskRetryIfNew')
    expect(calls.map((c) => [c.args[0], c.args[1], c.args[3]])).toEqual([['hb-a', 'agent-a', 'busy']])
    expect(calls[0]!.ctx).toEqual(SYSTEM_CTX)
    expect(calls[0]!.ctx).not.toHaveProperty('tenantId')
    expect((await db!.listPendingTaskRetries()).map((r) => r.task_name)).toEqual(['hb-a'])
  })

  it('a retry whose pre-check now says SKIP is deleted: role system, no tenant, row gone', async () => {
    await loadRunner()
    vi.setSystemTime(QUIET)
    mockListScheduledTasks.mockResolvedValue([task('hb-b', { tenantId: 'tenant-b', schedule: '0 8 * * *', preCheck: SKIP_SCRIPT })])
    await seedRetry('hb-b', 'agent-a', 60_000, 4)
    expect((await db!.listPendingTaskRetries()).map((r) => r.task_name)).toEqual(['hb-b'])
    await runTick()
    const calls = callsOf('deletePendingTaskRetry')
    expect(calls.map((c) => [c.args[0], c.args[1]])).toEqual([['hb-b', 'agent-a']])
    expect(calls[0]!.ctx).toEqual(SYSTEM_CTX)
    expect(await db!.listPendingTaskRetries()).toEqual([])
  })

  it('a retry that is still busy is refreshed: role system, no tenant, attempt count up by one', async () => {
    await loadRunner()
    vi.setSystemTime(QUIET)
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { tenantId: 'tenant-a', schedule: '0 8 * * *' })])
    await seedRetry('hb-a', 'agent-a', 60_000, 2)
    const before = await db!.getPendingTaskRetry('hb-a', 'agent-a')
    expect(before?.attempt_count).toBe(2)
    await runTick()
    const calls = callsOf('updatePendingTaskRetry')
    expect(calls.map((c) => [c.args[0], c.args[1], c.args[3]])).toEqual([['hb-a', 'agent-a', 'busy']])
    expect(calls[0]!.ctx).toEqual(SYSTEM_CTX)
    expect((await db!.getPendingTaskRetry('hb-a', 'agent-a'))?.attempt_count).toBe(3)
  })

  it('the one-shot alert claim of a long-stuck retry: role system, no tenant, the alert stamp is set once', async () => {
    await loadRunner()
    vi.setSystemTime(QUIET)
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { tenantId: 'tenant-a', schedule: '0 8 * * *' })])
    await seedRetry('hb-a', 'agent-a', 3 * 60 * 60_000, 30)
    expect((await db!.getPendingTaskRetry('hb-a', 'agent-a'))?.alert_sent_at ?? null).toBeNull()
    await runTick()
    const calls = callsOf('markPendingTaskRetryAlert')
    expect(calls.map((c) => [c.args[0], c.args[1]])).toEqual([['hb-a', 'agent-a']])
    expect(calls[0]!.ctx).toEqual(SYSTEM_CTX)
    expect((await db!.getPendingTaskRetry('hb-a', 'agent-a'))?.alert_sent_at).not.toBeNull()
  })

  it('the lost-injection retry of the watchdog sweep: role system, no tenant, although the entry carries a tenant', async () => {
    const runner = await loadRunner()
    vi.setSystemTime(QUIET)
    // the task is defined (the retry loop of the same tick would drop the row of a task that no longer exists)
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { tenantId: 'tenant-a', schedule: '0 8 * * *' })])
    mockPane = 'idle'
    const entry: TaskInflightEntry = {
      taskName: 'hb-a', agentName: 'agent-a', session: 'agent-agent-a', host: null, injectedAt: Date.now() - 120_000,
      alerted: false, sawTurn: false, workingDir: '/work/agent-a', configDir: undefined, timeoutMs: 300_000,
      blackboardSnapshot: undefined, tenantId: 'tenant-a',
    }
    await runner.trackInflight(entry)
    // construction: the entry is tracked with a tenant, and the retry table is empty
    expect(runner.listInflightEntries().map((e) => [e.taskName, e.tenantId])).toEqual([['hb-a', 'tenant-a']])
    expect(await db!.listPendingTaskRetries()).toEqual([])
    await runTick()
    const calls = callsOf('insertPendingTaskRetryIfNew')
    expect(calls.map((c) => [c.args[0], c.args[1], c.args[3]])).toEqual([['hb-a', 'agent-a', 'lost-injection']])
    expect(calls[0]!.ctx).toEqual(SYSTEM_CTX)
    expect((await db!.listPendingTaskRetries()).map((r) => r.task_name)).toEqual(['hb-a'])
  })

  it('no retry writer of the tick opens an escalation (a system context nested in a tenant block is what S1b forbade)', async () => {
    await loadRunner()
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { tenantId: 'tenant-a' })])
    await runTick()
    expect(callsOf('insertPendingTaskRetryIfNew')).toHaveLength(1)
    const { getDbContextStats } = await import('../db/context.js')
    expect(getDbContextStats().escalations).toBe(0)
  })
})

describe('schedule runner tick: the blackboard write stays in the system context, the stamp is the agent availability', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    mockSeen.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(QUIET)
    mockListScheduledTasks.mockResolvedValue([])
    mockReady = true
    mockPane = null
    runnerModule = undefined
    db = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  // One REAL fire through the retry queue (the quietest driver: no cron occurrence is needed), on the real database.
  async function fireOnce(taskTenant: string): Promise<void> {
    await seedRetry('hb-x', 'agent-a', 60_000, 4)
    mockListScheduledTasks.mockResolvedValue([task('hb-x', { tenantId: taskTenant, schedule: '0 8 * * *' })])
    await runTick()
  }

  it('the active write of a fire runs as role system with no tenant; a single-tenant agent is stamped with its availability tenant', async () => {
    await loadRunner()
    await db!.setTenantAgentAvailability('tenant-b', 'agent-a', true)
    // construction: the agent resolves to ONE tenant, and the task is of ANOTHER tenant: the stamp cannot be the task's
    expect(await db!.resolveAgentTenant('agent-a')).toBe('tenant-b')
    await fireOnce('tenant-a')
    const calls = callsOf('upsertBlackboard')
    expect(calls.map((c) => [c.args[0], (c.args[1] as { status: string }).status])).toEqual([['agent-a', 'active']])
    expect(calls[0]!.ctx).toEqual(SYSTEM_CTX)
    expect((await db!.findBlackboardRowByAgent('agent-a'))?.tenant_id).toBe('tenant-b')
  })

  it('a two-tenant agent still gets the shared sentinel when the task of one of its tenants fires', async () => {
    await loadRunner()
    await db!.setTenantAgentAvailability('tenant-a', 'agent-a', true)
    await db!.setTenantAgentAvailability('tenant-b', 'agent-a', true)
    expect(await db!.resolveAgentTenant('agent-a')).toBe('_multi_')
    await fireOnce('tenant-a')
    expect(callsOf('upsertBlackboard')[0]!.ctx).toEqual(SYSTEM_CTX)
    expect((await db!.findBlackboardRowByAgent('agent-a'))?.tenant_id).toBe('_multi_')
  })

  it('the done write of the watchdog (compare-and-write) runs as role system with no tenant and keeps the shared sentinel', async () => {
    const runner = await loadRunner()
    await db!.setTenantAgentAvailability('tenant-a', 'agent-a', true)
    await db!.setTenantAgentAvailability('tenant-b', 'agent-a', true)
    await seedRetry('hb-x', 'agent-a', 60_000, 4)
    mockListScheduledTasks.mockResolvedValue([task('hb-x', { tenantId: 'tenant-a', schedule: '0 8 * * *' })])
    const stop = runner.startScheduleRunner()
    // tick 1 fires the task (the active write); the pane is busy, so the watchdog records that the turn started
    mockPane = 'busy'
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runner.listInflightEntries().map((e) => [e.taskName, e.tenantId, e.sawTurn])).toEqual([['hb-x', 'tenant-a', false]])
    // the sweep of the next tick sees the busy pane
    await vi.advanceTimersByTimeAsync(15_000)
    expect(runner.listInflightEntries().map((e) => [e.taskName, e.tenantId, e.sawTurn])).toEqual([['hb-x', 'tenant-a', true]])
    expect((await db!.findBlackboardRowByAgent('agent-a'))?.status).toBe('active')
    // the turn ends: the next sweep finds the pane idle with a seen turn and writes done
    mockPane = 'idle'
    mockSeen.length = 0
    await vi.advanceTimersByTimeAsync(30_000)
    clearInterval(stop)
    const done = callsOf('upsertBlackboard')
    expect(done.map((c) => (c.args[1] as { status: string }).status)).toEqual(['done'])
    expect(done[0]!.ctx).toEqual(SYSTEM_CTX)
    expect(runner.listInflightEntries()).toEqual([])
    const row = await db!.findBlackboardRowByAgent('agent-a')
    expect([row?.status, row?.tenant_id]).toEqual(['done', '_multi_'])
  })
})

describe('the registry says why these writers are not in a tenant block', () => {
  it('the schedule-runner note names the D2 writes of the tick and the blackboard write as system by class', () => {
    const job = BACKGROUND_JOBS['schedule-runner']
    expect(job.role).toBe('hybrid')
    expect(job.note).toContain('D2 writes of the tick')
    expect(job.note).toContain('pending_task_retries')
    expect(job.note).toContain('blackboard write')
    expect(job.note).toContain('stay system by class')
  })
})

// The cells above drive the writer sites the tick reaches in a test (the busy and lost-injection inserts, the retry refresh,
// the pre-check delete, the alert claim, the active and the done blackboard write). The other call sites of the same
// writers (the give-up, lane-busy, starting, refused, first-run and mcp-missing inserts, the orphan, not-live, author and
// fired deletes) are not driven by a cell, so this source tripwire covers every site of the file: no call of a writer of
// class D2 or of the blackboard write sits inside the argument list of a tenant block call.
const SYSTEM_WRITERS = [
  'insertPendingTaskRetryIfNew', 'updatePendingTaskRetry', 'deletePendingTaskRetry', 'markPendingTaskRetryAlert',
  'clearPendingTaskRetryAlert', 'upsertPendingTaskRetry', 'upsertBlackboard',
]
const BLOCK_OPENERS = ['inTaskTenant', 'runAsItemTenant']

// Blank the comments, the string literals and the template literals (keeping the length and the newlines), so a name or a
// parenthesis inside text is never read as code.
function blankTextAndComments(src: string): string {
  const out = src.split('')
  let i = 0
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end }
    else if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end }
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j); i = j + 1
    } else i++
  }
  return out.join('')
}

// The writers named inside the argument list of any block opener call.
function writersInsideBlocks(src: string): string[] {
  const code = blankTextAndComments(src)
  const found: string[] = []
  for (const opener of BLOCK_OPENERS) {
    const re = new RegExp(`\\b${opener}\\s*\\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      let depth = 1
      let j = m.index + m[0].length
      const start = j
      while (j < code.length && depth > 0) { if (code[j] === '(') depth++; else if (code[j] === ')') depth--; j++ }
      const body = code.slice(start, j)
      for (const w of SYSTEM_WRITERS) if (new RegExp(`\\b${w}\\b`).test(body)) found.push(w)
    }
  }
  return found
}

describe('source tripwire: no D2 retry writer and no blackboard write inside a tenant block call', () => {
  it('the tripwire sees a writer inside an inTaskTenant or runAsItemTenant call, in the shapes a change would take', () => {
    expect(writersInsideBlocks("await inTaskTenant(t, () => insertPendingTaskRetryIfNew(a, b, now, 'busy'))")).toEqual(['insertPendingTaskRetryIfNew'])
    expect(writersInsideBlocks("await runAsItemTenant('schedule-runner', t, async () => {\n  await deletePendingTaskRetry(a, b)\n  return 1\n})")).toEqual(['deletePendingTaskRetry'])
    expect(writersInsideBlocks('x = inTaskTenant(id, () => withLock(agent, () => upsertBlackboard(agent, { status: "active" })))')).toEqual(['upsertBlackboard'])
    expect(writersInsideBlocks('inTaskTenant(t, () => (markPendingTaskRetryAlert(a, b, n), 1))')).toEqual(['markPendingTaskRetryAlert'])
  })

  it('the tripwire ignores the same names in comments and strings, and a writer outside a block call', () => {
    expect(writersInsideBlocks("// inTaskTenant(t, () => insertPendingTaskRetryIfNew(a))\nawait insertPendingTaskRetryIfNew(a, b, now, 'busy')")).toEqual([])
    expect(writersInsideBlocks('inTaskTenant(t, () => log("deletePendingTaskRetry(a, b) ) ("))')).toEqual([])
    expect(writersInsideBlocks('await inTaskTenant(t, () => appendTaskRun(n, a, "fired", t))\nawait deletePendingTaskRetry(n, a)')).toEqual([])
  })

  it('the tripwire is not vacuous: the real file has block calls, and writer calls outside them', () => {
    const src = readFileSync(fileURLToPath(new URL('../web/schedule-runner.ts', import.meta.url)), 'utf8')
    const code = blankTextAndComments(src)
    // at least one block call must be there for the scan to have looked at something (the number of them grows with the steps)
    expect((code.match(/\binTaskTenant\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(1)
    for (const w of SYSTEM_WRITERS.filter((x) => x !== 'upsertPendingTaskRetry' && x !== 'clearPendingTaskRetryAlert')) {
      expect((code.match(new RegExp(`\\b${w}\\s*\\(`, 'g')) ?? []).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('schedule-runner.ts has no such call', () => {
    const src = readFileSync(fileURLToPath(new URL('../web/schedule-runner.ts', import.meta.url)), 'utf8')
    expect(writersInsideBlocks(src)).toEqual([])
  })
})
