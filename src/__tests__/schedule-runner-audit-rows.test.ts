import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'
import { SCHEDULED_INFLIGHT_KEY } from '../web/schedule-inflight-store.js'

// The eight audit rows of the schedule-runner tick (row-level security, step S2b). Every one is written with the agent id
// `scheduler` and NO tenant argument, so the row is stamped by the writer from that agent id: the scheduler serves no tenant,
// so the stamp is `default`, whatever the tenant of the task the row is about (a tenant name that appears is a value in the
// detail text, not the stamp). A row stamped `default` written in a block of another tenant is what the policy of a
// tenant-stamped table refuses, so none of the eight can move into the block of its task: all eight stay in the job's own
// `system` context. Stamping them with the task tenant is a behaviour change (it changes whose audit view shows them) and is
// parked for a decision. The cells run the real tick on the real in-memory database with a recorder around the real writer
// (the recorder proves the WRAPPER, the table proves the STAMP); each asserts its own construction first.

type Seen = { fn: string; args: unknown[]; ctx: unknown }
const mockSeen: Seen[] = []
let mockCtx: () => unknown = () => undefined
let mockReady = false
let mockPane: string | null = null
let mockAuthorMode: 'enforce' | 'shadow' = 'enforce'
let mockAuthorVerdict: 'ok' | 'inactive' | 'unverifiable' = 'ok'
let mockOrphanTenants = new Set<string>()
let mockDbRunnable: string[] = []
type Runner = typeof import('../web/schedule-runner.js')
type Db = typeof import('../db.js')
let runnerModule: Runner | undefined
let db: Db | undefined

const mockListScheduledTasks = vi.fn<() => Promise<ScheduledTask[]>>()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))

vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  return {
    ...actual,
    writeAgentAuditLog: (...args: Parameters<typeof actual.writeAgentAuditLog>) => {
      mockSeen.push({ fn: 'writeAgentAuditLog', args, ctx: mockCtx() })
      return actual.writeAgentAuditLog(...args)
    },
  }
})

// The pairing rule and the author check are their own units; here a test decides their verdict.
vi.mock('../web/schedule-tenant.js', () => ({
  createPairOrphanChecker: () => (tenantId: string | undefined) => Promise.resolve(mockOrphanTenants.has(tenantId ?? 'default')),
}))
vi.mock('../web/schedule-author.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/schedule-author.js')>()),
  authorGateMode: () => mockAuthorMode,
  createAuthorChecker: () => () => Promise.resolve(mockAuthorVerdict),
}))

vi.mock('../web/command-task.js', () => ({ runCommandTask: vi.fn(() => Promise.resolve()) }))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  listDbRunnableTaskNames: () => Promise.resolve(mockDbRunnable),
  syncTaskConfigEnabledFromDb: vi.fn().mockResolvedValue([]),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-audit-rows-no-tasks-dir',
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

// The restore of the in-flight entries accepts only agents it knows.
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['agent-a'],
  readAgentRemoteHost: () => null,
  readAgentClaudeConfigDir: () => null,
}))

// A quiet moment of the fixture cron ('0 8 * * *'): no occurrence of it is due.
const QUIET = new Date('2026-08-14T10:30:00.000Z')
const SYSTEM_CTX = { role: 'system', name: 'schedule-runner' }

function task(name: string, over: Partial<ScheduledTask> & { status?: string } = {}): ScheduledTask {
  return {
    name, description: '', prompt: 'p', schedule: '0 8 * * *', agent: 'agent-a', enabled: true,
    createdAt: 0, type: 'heartbeat', skipIfBusy: false, forceSend: false, status: 'live', targetSession: 'fixture-session',
    tenantId: 'tenant-a',
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

async function runTick(runner: Runner, ms = 5_000): Promise<void> {
  const stop = runner.startScheduleRunner()
  await vi.advanceTimersByTimeAsync(ms)
  clearInterval(stop)
}

// The audit rows of one action, as stored.
function rowsOf(action: string): Array<{ agent_id: string; entity_id: string | null; tenant_id: string | null }> {
  return db!.getDb().prepare('SELECT agent_id, entity_id, tenant_id FROM agent_audit_log WHERE action = ? ORDER BY id').all(action) as Array<{ agent_id: string; entity_id: string | null; tenant_id: string | null }>
}

// The cell of one site: the writer was called once for the action, as the system job, with no tenant argument, and the
// stored row is stamped `default` for a task of another tenant.
async function expectSystemWrite(action: string, entityId: string): Promise<void> {
  const calls = mockSeen.filter((s) => s.fn === 'writeAgentAuditLog' && (s.args[0] as { action: string }).action === action)
  expect(calls).toHaveLength(1)
  const arg = calls[0]!.args[0] as Record<string, unknown>
  expect(arg['agent_id']).toBe('scheduler')
  expect(arg['entity_id']).toBe(entityId)
  expect(arg).not.toHaveProperty('tenant_id')
  expect(calls[0]!.ctx).toEqual(SYSTEM_CTX)
  expect(rowsOf(action)).toEqual([{ agent_id: 'scheduler', entity_id: entityId, tenant_id: 'default' }])
  const { getDbContextStats } = await import('../db/context.js')
  expect(getDbContextStats().escalations).toBe(0)
}

// A queued retry row on the real table (the retry loop reads it before the cron loop).
async function seedRetry(taskName: string): Promise<void> {
  await db!.insertPendingTaskRetryIfNew(taskName, 'agent-a', Date.now() - 60_000, 'busy')
  mockSeen.length = 0
}

describe('schedule runner: the audit rows of the tick are written in the system context, stamped default (all eight sites)', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    mockSeen.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(QUIET)
    mockListScheduledTasks.mockResolvedValue([])
    mockReady = false
    mockPane = null
    mockAuthorMode = 'enforce'
    mockAuthorVerdict = 'ok'
    mockOrphanTenants = new Set()
    mockDbRunnable = []
    runnerModule = undefined
    db = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('site 1, a task whose tenant and agent pair no longer holds (skip_tenant_mismatch)', async () => {
    const runner = await loadRunner()
    mockOrphanTenants = new Set(['tenant-a'])
    const t = task('hb-a')
    mockListScheduledTasks.mockResolvedValue([t])
    expect(t.tenantId).toBe('tenant-a')
    expect(rowsOf('skip_tenant_mismatch')).toEqual([])
    await runTick(runner)
    await expectSystemWrite('skip_tenant_mismatch', 'hb-a')
    // the tenant of the task is a value in the detail, not the stamp
    const arg = mockSeen.find((s) => (s.args[0] as { action: string }).action === 'skip_tenant_mismatch')!.args[0] as { detail: { tenant: string } }
    expect(arg.detail.tenant).toBe('tenant-a')
  })

  it('site 2, a task whose author is no longer allowed, enforce mode (skip_author_inactive)', async () => {
    const runner = await loadRunner()
    mockAuthorMode = 'enforce'
    mockAuthorVerdict = 'inactive'
    // due now: the cron loop is where a blocked task raises its alert
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { schedule: '* * * * *' })])
    expect(rowsOf('skip_author_inactive')).toEqual([])
    await runTick(runner)
    await expectSystemWrite('skip_author_inactive', 'hb-a')
  })

  it('site 3, the shadow note of the author check (author_gate_shadow)', async () => {
    const runner = await loadRunner()
    mockAuthorMode = 'shadow'
    mockAuthorVerdict = 'inactive'
    mockListScheduledTasks.mockResolvedValue([task('hb-a')])
    expect(rowsOf('author_gate_shadow')).toEqual([])
    await runTick(runner)
    await expectSystemWrite('author_gate_shadow', 'hb-a')
  })

  it('site 4, most enabled tasks held back at once (mass_skip): a row about the scheduler, not about a task', async () => {
    const runner = await loadRunner()
    const names = ['hb-1', 'hb-2', 'hb-3', 'hb-4']
    // all four were runnable at the baseline, and are now disabled: a mass disable
    mockDbRunnable = names
    mockListScheduledTasks.mockResolvedValue(names.map((n) => task(n, { enabled: false, schedule: '* * * * *' })))
    expect(rowsOf('mass_skip')).toEqual([])
    await runTick(runner)
    await expectSystemWrite('mass_skip', 'scheduler')
  })

  it('site 5, a restored in-flight entry with no evidence of a turn (inflight_restored_unverified)', async () => {
    const first = await loadRunner()
    mockListScheduledTasks.mockResolvedValue([task('hb-a')])
    const entry: TaskInflightEntry = {
      taskName: 'hb-a', agentName: 'agent-a', session: 'agent-agent-a', host: null, injectedAt: Date.now() - 120_000,
      alerted: false, sawTurn: false, workingDir: '/work/agent-a', configDir: undefined, timeoutMs: 300_000,
      blackboardSnapshot: undefined, tenantId: 'tenant-a',
    }
    await first.trackInflight(entry)
    const raw = db!.getSystemConfig(SCHEDULED_INFLIGHT_KEY)?.value
    expect(raw).toBeDefined()
    const runner = await loadRunner()
    await db!.setSystemConfig(SCHEDULED_INFLIGHT_KEY, raw!)
    expect(runner.restoreInflightFromStore(Date.now())).toBe(1)
    // the pane is idle and nothing showed a turn: past the grace the decision is lost, and a restored entry is not re-queued
    mockPane = 'idle'
    expect(rowsOf('inflight_restored_unverified')).toEqual([])
    mockSeen.length = 0
    await runTick(runner)
    await expectSystemWrite('inflight_restored_unverified', 'hb-a')
  })

  it('site 6, a queued retry of a task that was disabled meanwhile (skip_not_live, retry_dropped)', async () => {
    const runner = await loadRunner()
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { enabled: false })])
    await seedRetry('hb-a')
    expect(rowsOf('skip_not_live')).toEqual([])
    await runTick(runner)
    // the retry loop writes the row; the cron loop later writes its own (not-live alert) for the same disabled task
    const retry = mockSeen.filter((s) => (s.args[0] as { detail?: { reason?: string } }).detail?.reason === 'retry_dropped')
    expect(retry).toHaveLength(1)
    expect(retry[0]!.ctx).toEqual(SYSTEM_CTX)
    expect(retry[0]!.args[0]).not.toHaveProperty('tenant_id')
    const stored = rowsOf('skip_not_live')
    expect(stored.length).toBeGreaterThanOrEqual(1)
    expect(stored.map((r) => r.tenant_id)).toEqual(stored.map(() => 'default'))
    expect((await db!.listPendingTaskRetries())).toEqual([])
  })

  it('site 7, a queued retry of a task whose author was blocked meanwhile, enforce mode (skip_not_live, author)', async () => {
    const runner = await loadRunner()
    mockAuthorMode = 'enforce'
    mockAuthorVerdict = 'inactive'
    mockListScheduledTasks.mockResolvedValue([task('hb-a')])
    await seedRetry('hb-a')
    await runTick(runner)
    const dropped = mockSeen.filter((s) => (s.args[0] as { detail?: { cause?: string } }).detail?.cause === 'author_inactive')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.ctx).toEqual(SYSTEM_CTX)
    expect(dropped[0]!.args[0]).not.toHaveProperty('tenant_id')
    expect((rowsOf('skip_not_live')).map((r) => r.tenant_id)).toEqual(['default'])
    expect((await db!.listPendingTaskRetries())).toEqual([])
  })

  it('site 8, a disabled task met by the cron loop (skip_not_live)', async () => {
    const runner = await loadRunner()
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { enabled: false })])
    expect(rowsOf('skip_not_live')).toEqual([])
    await runTick(runner)
    await expectSystemWrite('skip_not_live', 'hb-a')
  })
})
