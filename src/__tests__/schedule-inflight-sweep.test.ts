import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TaskInflightEntry } from '../web/schedule-runner.js'

// The runner's in-flight watchdog with the durable mirror: what is written when an injection is tracked, cleared,
// lost or flagged; what a restart restores; and that a RESTORED entry is never re-queued as lost (that could run a
// task twice). The database is replaced by an in-memory system_config with the real read-modify-write semantics, so
// "restart" is: keep the stored values, reset the module (an empty map), restore.

const fakeConfig = new Map<string, string>()
let failWrites = false

const mockAppendTaskRun = vi.fn(() => Promise.resolve())
const mockClearLastRun = vi.fn(() => Promise.resolve())
const mockInsertPending = vi.fn(() => Promise.resolve())
const mockUpsertBlackboard = vi.fn(() => Promise.resolve({ status: 'done', summary: '', task_ref: null }))
const mockFindBlackboardRow = vi.fn(() => Promise.resolve(undefined as { status: string; summary: string; task_ref: string | null } | undefined))
const mockKanbanWaiting = vi.fn(() => Promise.resolve(null))
const mockAudit = vi.fn(() => Promise.resolve())
const mockCapturePane = vi.fn((_session: string, _host?: string | null): string | null => 'idle')
const mockTranscriptMtime = vi.fn((): number | null => null)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => (mockAppendTaskRun as (...x: unknown[]) => Promise<void>)(...a),
  listPendingTaskRetries: () => Promise.resolve([]),
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => Promise.resolve(true)),
  insertPendingTaskRetryIfNew: (...a: unknown[]) => (mockInsertPending as (...x: unknown[]) => Promise<void>)(...a),
  markPendingTaskRetryAlert: vi.fn(() => Promise.resolve(false)),
  markScheduledTaskKanbanWaiting: (...a: unknown[]) => (mockKanbanWaiting as (...x: unknown[]) => Promise<null>)(...a),
  upsertBlackboard: (...a: unknown[]) => (mockUpsertBlackboard as (...x: unknown[]) => Promise<unknown>)(...a),
  findActiveKanbanCardByTitle: vi.fn(() => undefined),
  findBlackboardRowByAgent: (...a: unknown[]) => (mockFindBlackboardRow as (...x: unknown[]) => Promise<unknown>)(...a),
  updateScheduleLastRun: vi.fn(),
  clearScheduleLastRunIfMatches: (...a: unknown[]) => (mockClearLastRun as (...x: unknown[]) => Promise<void>)(...a),
  writeAgentAuditLog: (...a: unknown[]) => (mockAudit as (...x: unknown[]) => Promise<void>)(...a),
  getSystemConfig: (key: string) => (fakeConfig.has(key) ? { key, value: fakeConfig.get(key)! } : undefined),
  setSystemConfig: (key: string, value: string) => {
    if (failWrites) return Promise.reject(new Error('db write failed'))
    fakeConfig.set(key, value)
    return Promise.resolve()
  },
  deleteSystemConfig: (key: string) => {
    if (failWrites) return Promise.reject(new Error('db write failed'))
    fakeConfig.delete(key)
    return Promise.resolve()
  },
  updateSystemConfig: (key: string, mutate: (current: string | undefined) => string | undefined) => {
    if (failWrites) return Promise.reject(new Error('db write failed'))
    const next = mutate(fakeConfig.get(key))
    if (next === undefined) return Promise.resolve(false)
    fakeConfig.set(key, next)
    return Promise.resolve(true)
  },
}))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => Promise.resolve(false),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: (session: string, host?: string | null) => mockCapturePane(session, host),
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(true)),
}))

// The pane "text" the tests hand out IS the state: 'idle' | 'busy' | ...
vi.mock('../pane-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pane-state.js')>()),
  detectPaneState: (pane: string) => pane,
}))

vi.mock('../web/active-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/active-model.js')>()),
  readTranscriptMtimeFromProjectDir: () => mockTranscriptMtime(),
}))

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentRemoteHost: (name: string) => (name === 'agent-b' ? 'remote-host-1' : null),
  readAgentClaudeConfigDir: () => null,
}))

import { logger } from '../logger.js'

const NOW = 1_800_000_000_000
const MAX_TRACK = 6 * 60 * 60_000
const KEY = 'task-a@agent-a'

type Runner = typeof import('../web/schedule-runner.js')

async function freshRunner(): Promise<Runner> {
  vi.resetModules()
  return import('../web/schedule-runner.js')
}

function liveEntry(over: Partial<TaskInflightEntry> = {}): TaskInflightEntry {
  return {
    taskName: 'task-a',
    agentName: 'agent-a',
    session: 'agent-agent-a',
    host: null,
    injectedAt: NOW - 120_000,
    alerted: false,
    sawTurn: false,
    workingDir: '/work/agent-a',
    configDir: undefined,
    timeoutMs: 300_000,
    blackboardSnapshot: { status: 'active', summary: 'running task-a', task_ref: null },
    ...over,
  }
}

function storedAll(): Record<string, Record<string, unknown>> {
  const raw = fakeConfig.get('scheduled_inflight')
  return raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {}
}

beforeEach(() => {
  vi.clearAllMocks()
  fakeConfig.clear()
  failWrites = false
  mockCapturePane.mockReturnValue('idle')
  mockTranscriptMtime.mockReturnValue(null)
  mockFindBlackboardRow.mockResolvedValue({ status: 'active', summary: 'running task-a', task_ref: null })
})

describe('tracking is mirrored to the durable copy', () => {
  it('an injection writes its entry (without workingDir / configDir / restored)', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry())
    expect(Object.keys(storedAll())).toEqual([KEY])
    expect(Object.keys(storedAll()[KEY]!).sort()).toEqual(
      ['agentName', 'alerted', 'blackboardSnapshot', 'host', 'injectedAt', 'sawTurn', 'session', 'taskName', 'timeoutMs'])
  })

  it('two overlapping injections for two keys both stay stored', async () => {
    const r = await freshRunner()
    await Promise.all([r.trackInflight(liveEntry()), r.trackInflight(liveEntry({ taskName: 'task-b' }))])
    expect(Object.keys(storedAll()).sort()).toEqual(['task-a@agent-a', 'task-b@agent-a'])
  })

  it('a clear (idle after a turn) removes the stored entry and writes the blackboard done row', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ sawTurn: true }))
    await r.sweepInflightTasks(NOW)
    expect(storedAll()).toEqual({})
    expect(r.listInflightEntries()).toEqual([])
    expect(mockUpsertBlackboard).toHaveBeenCalledTimes(1)
  })

  it('a max-track eviction removes the stored entry', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ injectedAt: NOW - MAX_TRACK - 1 }))
    mockCapturePane.mockReturnValue('busy')
    await r.sweepInflightTasks(NOW)
    expect(storedAll()).toEqual({})
    expect(r.listInflightEntries()).toEqual([])
  })

  it('a lost injection (idle, no turn, past grace) is re-queued as before and removed from the stored copy', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry())
    await r.sweepInflightTasks(NOW)
    expect(mockAppendTaskRun).toHaveBeenCalledWith('task-a', 'agent-a', 'lost')
    expect(mockClearLastRun).toHaveBeenCalledWith('task-a', NOW - 120_000)
    expect(mockInsertPending).toHaveBeenCalledWith('task-a', 'agent-a', NOW, 'lost-injection')
    expect(mockAudit).not.toHaveBeenCalled()
    expect(storedAll()).toEqual({})
  })

  it('a pane that turns busy persists sawTurn; the entry stays tracked', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ injectedAt: NOW - 10_000 }))
    mockCapturePane.mockReturnValue('busy')
    await r.sweepInflightTasks(NOW)
    expect(storedAll()[KEY]!['sawTurn']).toBe(true)
    expect(storedAll()[KEY]!['alerted']).toBe(false)
    expect(r.listInflightEntries()).toHaveLength(1)
  })

  it('transcript evidence persists sawTurn too', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ injectedAt: NOW - 10_000 }))
    mockCapturePane.mockReturnValue('typing')
    mockTranscriptMtime.mockReturnValue(NOW - 5_000)
    await r.sweepInflightTasks(NOW)
    expect(storedAll()[KEY]!['sawTurn']).toBe(true)
  })

  it('a timeout alert persists alerted, and a second sweep does not alert again', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ injectedAt: NOW - 400_000, sawTurn: true }))
    mockCapturePane.mockReturnValue('busy')
    await r.sweepInflightTasks(NOW)
    expect(mockKanbanWaiting).toHaveBeenCalledTimes(1)
    expect(storedAll()[KEY]!['alerted']).toBe(true)
    await r.sweepInflightTasks(NOW + 15_000)
    expect(mockKanbanWaiting).toHaveBeenCalledTimes(1)
  })

  it('a sweep that changes nothing writes nothing', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ injectedAt: NOW - 10_000, sawTurn: true }))
    mockCapturePane.mockReturnValue('busy')
    const before = fakeConfig.get('scheduled_inflight')
    const setSpy = vi.spyOn(Map.prototype, 'set')
    await r.sweepInflightTasks(NOW)
    const wroteConfig = setSpy.mock.calls.some(([k]) => k === 'scheduled_inflight')
    setSpy.mockRestore()
    expect(wroteConfig).toBe(false)
    expect(fakeConfig.get('scheduled_inflight')).toBe(before)
  })
})

describe('a failing persist never breaks the runner', () => {
  it('tracking still registers the entry in memory and logs a warning', async () => {
    const r = await freshRunner()
    failWrites = true
    await expect(r.trackInflight(liveEntry())).resolves.toBeUndefined()
    expect(r.listInflightEntries()).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('a sweep clear still clears and writes done when the mirror cannot be written', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ sawTurn: true }))
    failWrites = true
    await expect(r.sweepInflightTasks(NOW)).resolves.toBeUndefined()
    expect(r.listInflightEntries()).toEqual([])
    expect(mockUpsertBlackboard).toHaveBeenCalledTimes(1)
  })

  it('a sweep lost still re-queues when the mirror cannot be written', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry())
    failWrites = true
    await expect(r.sweepInflightTasks(NOW)).resolves.toBeUndefined()
    expect(mockInsertPending).toHaveBeenCalledTimes(1)
    expect(r.listInflightEntries()).toEqual([])
  })

  it('an alert and a flag update survive a failing mirror', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ injectedAt: NOW - 400_000, sawTurn: true }))
    failWrites = true
    mockCapturePane.mockReturnValue('busy')
    await expect(r.sweepInflightTasks(NOW)).resolves.toBeUndefined()
    expect(mockKanbanWaiting).toHaveBeenCalledTimes(1)
    expect(r.listInflightEntries()[0]!.alerted).toBe(true)
  })
})

describe('restart: restore from the durable copy', () => {
  async function restart(): Promise<Runner> {
    const r = await freshRunner() // the stored values stay, the module state (the map) is gone
    r.restoreInflightFromStore(NOW)
    return r
  }

  it('an in-flight entry is restored with its flags and snapshot, marked restored', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ alerted: true, sawTurn: true }))
    const r = await restart()
    const [e] = r.listInflightEntries()
    expect(e).toMatchObject({
      taskName: 'task-a', agentName: 'agent-a', session: 'agent-agent-a', host: null,
      injectedAt: NOW - 120_000, alerted: true, sawTurn: true, timeoutMs: 300_000, restored: true,
      blackboardSnapshot: { status: 'active', summary: 'running task-a', task_ref: null },
    })
  })

  it('workingDir is re-derived, not read from the stored copy', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ workingDir: '/stale/dir' }))
    const r = await restart()
    expect(r.listInflightEntries()[0]!.workingDir).not.toBe('/stale/dir')
    expect(r.listInflightEntries()[0]!.workingDir).toMatch(/agent-a$/)
  })

  it('the blackboard stale sweeper still skips an agent whose restored entry has a snapshot', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry())
    const r = await restart()
    expect(r.getInflightScheduleAgents()).toEqual(new Set(['agent-a']))
  })

  it('a restored entry without a snapshot protects no agent', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ blackboardSnapshot: undefined }))
    const r = await restart()
    expect(r.listInflightEntries()).toHaveLength(1)
    expect(r.getInflightScheduleAgents()).toEqual(new Set())
  })

  it('tracking continues: a restored busy entry past the threshold alerts once', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ injectedAt: NOW - 400_000, sawTurn: true }))
    const r = await restart()
    mockCapturePane.mockReturnValue('busy')
    await r.sweepInflightTasks(NOW)
    await r.sweepInflightTasks(NOW + 15_000)
    expect(mockKanbanWaiting).toHaveBeenCalledTimes(1)
    expect(storedAll()[KEY]!['alerted']).toBe(true)
  })

  it('an entry that was already alerted before the restart does not alert again', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ injectedAt: NOW - 400_000, sawTurn: true, alerted: true }))
    const r = await restart()
    mockCapturePane.mockReturnValue('busy')
    await r.sweepInflightTasks(NOW)
    expect(mockKanbanWaiting).not.toHaveBeenCalled()
  })

  it('a restored entry that went idle after a turn is cleared and the blackboard row is closed', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ sawTurn: true }))
    const r = await restart()
    await r.sweepInflightTasks(NOW)
    expect(mockUpsertBlackboard).toHaveBeenCalledTimes(1)
    expect(r.listInflightEntries()).toEqual([])
    expect(storedAll()).toEqual({})
    expect(mockAppendTaskRun).not.toHaveBeenCalled()
  })

  it('a restored entry with transcript evidence after the injection is cleared as done, not lost', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry())
    const r = await restart()
    mockTranscriptMtime.mockReturnValue(NOW - 30_000)
    await r.sweepInflightTasks(NOW)
    expect(mockUpsertBlackboard).toHaveBeenCalledTimes(1)
    expect(mockAppendTaskRun).not.toHaveBeenCalled()
    expect(mockInsertPending).not.toHaveBeenCalled()
  })

  it('a restored entry that is idle with no evidence is cleared with an audit row and NOT re-queued', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry())
    const r = await restart()
    await r.sweepInflightTasks(NOW)
    expect(mockAppendTaskRun).not.toHaveBeenCalled()
    expect(mockClearLastRun).not.toHaveBeenCalled()
    expect(mockInsertPending).not.toHaveBeenCalled()
    expect(mockUpsertBlackboard).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledTimes(1)
    expect(mockAudit).toHaveBeenCalledWith({
      agent_id: 'scheduler', entity: 'schedule', action: 'inflight_restored_unverified', entity_id: 'task-a',
      detail: { task: 'task-a', agent: 'agent-a', injectedAt: NOW - 120_000 },
    })
    expect(r.listInflightEntries()).toEqual([])
    expect(storedAll()).toEqual({})
    expect(logger.warn).toHaveBeenCalled()
  })

  it('the unverified clear holds when the audit write itself fails', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry())
    const r = await restart()
    mockAudit.mockRejectedValueOnce(new Error('audit down'))
    await expect(r.sweepInflightTasks(NOW)).resolves.toBeUndefined()
    expect(r.listInflightEntries()).toEqual([])
    expect(mockInsertPending).not.toHaveBeenCalled()
  })

  it('inside the grace window a restored idle entry is held, not cleared', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ injectedAt: NOW - 10_000 }))
    const r = await restart()
    await r.sweepInflightTasks(NOW)
    expect(r.listInflightEntries()).toHaveLength(1)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('a NON-restored lost still re-queues in the same process (regression guard for the original path)', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry())
    await r.sweepInflightTasks(NOW)
    expect(mockInsertPending).toHaveBeenCalledTimes(1)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('restoring twice does not overwrite a live (non-restored) entry on the same key', async () => {
    const r = await freshRunner()
    await r.trackInflight(liveEntry({ injectedAt: NOW - 20_000 }))
    r.restoreInflightFromStore(NOW)
    const [e] = r.listInflightEntries()
    expect(e!.restored).toBeUndefined()
    expect(e!.injectedAt).toBe(NOW - 20_000)
  })

  it('a remote agent entry is restored with its host', async () => {
    const before = await freshRunner()
    await before.trackInflight(liveEntry({ taskName: 'task-r', agentName: 'agent-b', session: 'agent-agent-b', host: 'remote-host-1' }))
    const r = await restart()
    expect(r.listInflightEntries()[0]).toMatchObject({ agentName: 'agent-b', host: 'remote-host-1', restored: true })
  })
})

describe('restart: hostile or damaged stored content', () => {
  const good = {
    taskName: 'task-a', agentName: 'agent-a', session: 'agent-agent-a', host: null, injectedAt: NOW - 120_000,
    alerted: false, sawTurn: true, timeoutMs: 300_000, blackboardSnapshot: null,
  }

  async function restoreFrom(value: string): Promise<Runner> {
    fakeConfig.set('scheduled_inflight', value)
    const r = await freshRunner()
    r.restoreInflightFromStore(NOW)
    return r
  }

  it('invalid JSON: nothing is restored, nothing throws, the key is removed', async () => {
    const r = await restoreFrom('{not json')
    expect(r.listInflightEntries()).toEqual([])
    await vi.waitFor(() => expect(fakeConfig.has('scheduled_inflight')).toBe(false))
  })

  it('a hostile session or host is never used as a pane target', async () => {
    const r = await restoreFrom(JSON.stringify({
      'task-a@agent-a': { ...good, session: 'agent-agent-a; touch /tmp/x' },
      'task-h@agent-a': { ...good, taskName: 'task-h', host: 'evil-host' },
    }))
    await r.sweepInflightTasks(NOW)
    expect(r.listInflightEntries()).toEqual([])
    expect(mockCapturePane).not.toHaveBeenCalled()
  })

  it('an injectedAt older than the max-track age is not loaded', async () => {
    const r = await restoreFrom(JSON.stringify({ 'task-a@agent-a': { ...good, injectedAt: NOW - MAX_TRACK - 1 } }))
    expect(r.listInflightEntries()).toEqual([])
  })

  it('one bad entry does not stop the valid ones, and the stored copy is rewritten without it', async () => {
    const r = await restoreFrom(JSON.stringify({
      'bad@agent-a': { ...good, taskName: 'bad', session: 'agent-x' },
      'task-a@agent-a': good,
    }))
    expect(r.listInflightEntries().map((e) => e.taskName)).toEqual(['task-a'])
    await vi.waitFor(() => expect(Object.keys(storedAll())).toEqual(['task-a@agent-a']))
  })

  it('an unknown agent is dropped (its session cannot be tracked)', async () => {
    const r = await restoreFrom(JSON.stringify({ 'task-a@agent-z': { ...good, agentName: 'agent-z', session: 'agent-agent-z' } }))
    expect(r.listInflightEntries()).toEqual([])
  })

  it('no stored value restores nothing and writes nothing', async () => {
    const r = await freshRunner()
    expect(r.restoreInflightFromStore(NOW)).toBe(0)
    expect(fakeConfig.has('scheduled_inflight')).toBe(false)
  })

  it('the runner start restores BEFORE its first tick (startScheduleRunner calls the restore)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      fakeConfig.set('scheduled_inflight', JSON.stringify({ 'task-a@agent-a': { ...good, injectedAt: NOW - 60_000 } }))
      const r = await freshRunner()
      const timer = r.startScheduleRunner()
      clearInterval(timer)
      // No tick has run yet (fake timers, nothing advanced): the entry is there because start restored it.
      expect(r.listInflightEntries().map((e) => e.taskName)).toEqual(['task-a'])
    } finally {
      vi.useRealTimers()
    }
  })
})
