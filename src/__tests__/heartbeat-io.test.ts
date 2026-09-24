// Tests for the I/O orchestration and scheduling in heartbeat.ts (backend
// coverage series, batch 39). heartbeat-unit.test.ts and
// heartbeat-worker-isolation.test.ts only exercise formatHeartbeatCardLabel
// directly plus raw-source-text "contract" assertions for
// ensureHeartbeatWorkerCwd -- none of them actually CALL the private
// functions (collectData, shouldNotify, buildAgentPrompt, executeHeartbeat,
// ensureHeartbeatWorkerCwd, initHeartbeat/stopHeartbeat/scheduleNext), so
// none of that logic ran under coverage instrumentation. This file drives
// them for real through the module's exported surface
// (collectData/shouldNotify/buildAgentPrompt/executeHeartbeat/initHeartbeat/
// stopHeartbeat), with node:fs, settings-store, db, google-api, agent,
// notify and web/agent-process mocked and prompt-safety.js left real
// (pure, deterministic string wrapping).
//
// shouldNotify/executeHeartbeat both read the real clock (`new Date()` /
// `data.timestamp`), so every test that cares about hour-of-day or
// weekday-vs-weekend uses vi.useFakeTimers()+vi.setSystemTime() with a
// helper that finds a date matching a target getDay() without hardcoding
// which calendar date happens to fall on which weekday.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const {
  mockExistsSync,
  mockMkdirSync,
  mockWriteFileSync,
  mockReadFileSync,
  mockStatSync,
  mockSymlinkSync,
  mockReaddirSync,
  mockLstatSync,
  mockRmSync,
  mockGetEffectiveSettingValue,
  mockGetHeartbeatKanbanSummary,
  mockGetActiveScheduledTaskCount,
  mockGetCalendarEvents,
  mockRunAgent,
  mockNotifyTelegram,
  mockGetMainParkedState,
  mockReadClaudeCodeOauthJson,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerDebug,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn((_p?: unknown) => false),
  mockMkdirSync: vi.fn((_p?: unknown, _opts?: unknown) => undefined),
  mockWriteFileSync: vi.fn((_p?: unknown, _data?: unknown, _opts?: unknown) => undefined),
  mockReadFileSync: vi.fn((_p?: unknown, _enc?: unknown) => ''),
  mockStatSync: vi.fn((_p?: unknown) => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  mockSymlinkSync: vi.fn((_target?: unknown, _link?: unknown) => undefined),
  mockReaddirSync: vi.fn((_p?: unknown) => [] as string[]),
  mockLstatSync: vi.fn((_p?: unknown) => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  mockRmSync: vi.fn((_p?: unknown, _opts?: unknown) => undefined),
  mockGetEffectiveSettingValue: vi.fn((key: string) => (key === 'HEARTBEAT_START_HOUR' ? 8 : 21)),
  mockGetHeartbeatKanbanSummary: vi.fn(() => ({ urgent: [] as any[], in_progress: [] as any[], waiting: [] as any[] })),
  mockGetActiveScheduledTaskCount: vi.fn(() => ({ count: 0, nextRun: null as number | null })),
  mockGetCalendarEvents: vi.fn(async (..._args: unknown[]) => [] as any[]),
  mockRunAgent: vi.fn(async (..._args: unknown[]) => ({ text: null as string | null })),
  mockNotifyTelegram: vi.fn(async (_text?: unknown) => {}),
  mockGetMainParkedState: vi.fn(() => null as { preview: string; fails: number; approxMinutes: number } | null),
  mockReadClaudeCodeOauthJson: vi.fn(() => null as string | null),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerDebug: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
  symlinkSync: mockSymlinkSync,
  readdirSync: mockReaddirSync,
  lstatSync: mockLstatSync,
  rmSync: mockRmSync,
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: mockGetEffectiveSettingValue,
}))

vi.mock('../config.js', () => ({
  HEARTBEAT_CALENDAR_ID: 'primary',
  STORE_DIR: '/store',
  DB_FILENAME: 'claudeclaw.db',
  PROJECT_ROOT: '/project',
  OWNER_NAME: 'TestOwner',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../db.js', () => ({
  getHeartbeatKanbanSummary: mockGetHeartbeatKanbanSummary,
  getActiveScheduledTaskCount: mockGetActiveScheduledTaskCount,
}))

vi.mock('../google-api.js', () => ({
  getCalendarEvents: mockGetCalendarEvents,
}))

vi.mock('../agent.js', () => ({
  runAgent: mockRunAgent,
}))

vi.mock('../notify.js', () => ({
  notifyTelegram: mockNotifyTelegram,
}))

vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: mockLoggerError, debug: mockLoggerDebug },
}))

vi.mock('../web/agent-process.js', () => ({
  getMainParkedState: mockGetMainParkedState,
}))

vi.mock('../web/claude-credentials.js', () => ({
  readClaudeCodeOauthJson: mockReadClaudeCodeOauthJson,
}))

import {
  formatMainParkedSection,
  collectData,
  shouldNotify,
  buildAgentPrompt,
  executeHeartbeat,
  initHeartbeat,
  stopHeartbeat,
} from '../heartbeat.js'

// Finds a Date in the current month matching the given getDay() (0=Sun..6=Sat)
// without assuming which real-world weekday a hardcoded date falls on.
function dateWithDow(dow: number, hour: number): Date {
  const d = new Date()
  d.setDate(1)
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  return d
}

function weekday(hour: number): Date {
  for (let dow = 1; dow <= 5; dow++) {
    const d = dateWithDow(dow, hour)
    if (d.getDay() >= 1 && d.getDay() <= 5) return d
  }
  throw new Error('unreachable')
}

function weekend(hour: number): Date {
  return dateWithDow(6, hour)
}

function baseData(overrides: Partial<{
  timestamp: Date
  calendar: any[]
  kanban: { urgent: number; in_progress: number; waiting: number; urgentLabels: string[]; waitingLabels: string[] }
  system: { dbSizeMB: number; dbWarning: boolean }
  tasks: { count: number; nextRun: number | null }
}> = {}) {
  return {
    timestamp: weekday(10),
    calendar: [],
    kanban: { urgent: 0, in_progress: 0, waiting: 0, urgentLabels: [], waitingLabels: [] },
    system: { dbSizeMB: 1, dbWarning: false },
    tasks: { count: 0, nextRun: null },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('')
  mockStatSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  mockLstatSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  mockReaddirSync.mockReturnValue([])
  mockGetEffectiveSettingValue.mockImplementation((key: string) => (key === 'HEARTBEAT_START_HOUR' ? 8 : 21))
  mockGetHeartbeatKanbanSummary.mockReturnValue({ urgent: [], in_progress: [], waiting: [] })
  mockGetActiveScheduledTaskCount.mockReturnValue({ count: 0, nextRun: null })
  mockGetCalendarEvents.mockResolvedValue([])
  mockRunAgent.mockResolvedValue({ text: null })
  mockGetMainParkedState.mockReturnValue(null)
  mockReadClaudeCodeOauthJson.mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatMainParkedSection', () => {
  it('returns empty string when there is no parked state', () => {
    expect(formatMainParkedSection(null)).toBe('')
  })

  it('renders the owner name, minutes and wrapped preview when parked', () => {
    const out = formatMainParkedSection({ preview: 'stuck line', fails: 3, approxMinutes: 45 })
    expect(out).toContain('TestOwner')
    expect(out).toContain('45 perce')
    expect(out).toContain('stuck line')
    expect(out).toMatch(/<untrusted[^>]*source="main-parked-input"/)
  })
})

describe('shouldNotify', () => {
  it('dbWarning always notifies, even late at night', () => {
    const data = baseData({ timestamp: weekday(23), system: { dbSizeMB: 500, dbWarning: true } })
    expect(shouldNotify(data)).toBe(true)
  })

  it('is silent after 22:00 even with urgent cards', () => {
    const data = baseData({
      timestamp: weekday(22),
      kanban: { urgent: 1, in_progress: 0, waiting: 0, urgentLabels: ['[x] y'], waitingLabels: [] },
    })
    expect(shouldNotify(data)).toBe(false)
  })

  it('21:00-22:00 window only notifies for urgent cards', () => {
    const noUrgent = baseData({ timestamp: weekday(21) })
    expect(shouldNotify(noUrgent)).toBe(false)
    const withUrgent = baseData({
      timestamp: weekday(21),
      kanban: { urgent: 1, in_progress: 0, waiting: 0, urgentLabels: [], waitingLabels: [] },
    })
    expect(shouldNotify(withUrgent)).toBe(true)
  })

  it('weekends ignore calendar and waiting, only urgent counts', () => {
    const calendarOnly = baseData({ timestamp: weekend(10), calendar: [{ summary: 'x' }] })
    expect(shouldNotify(calendarOnly)).toBe(false)
    const waitingOnly = baseData({
      timestamp: weekend(10),
      kanban: { urgent: 0, in_progress: 0, waiting: 5, urgentLabels: [], waitingLabels: [] },
    })
    expect(shouldNotify(waitingOnly)).toBe(false)
    const urgent = baseData({
      timestamp: weekend(10),
      kanban: { urgent: 1, in_progress: 0, waiting: 0, urgentLabels: [], waitingLabels: [] },
    })
    expect(shouldNotify(urgent)).toBe(true)
  })

  it('weekday daytime notifies on any calendar event', () => {
    const data = baseData({ timestamp: weekday(10), calendar: [{ summary: 'meeting' }] })
    expect(shouldNotify(data)).toBe(true)
  })

  it('weekday daytime notifies on urgent > 0', () => {
    const data = baseData({
      timestamp: weekday(10),
      kanban: { urgent: 1, in_progress: 0, waiting: 0, urgentLabels: [], waitingLabels: [] },
    })
    expect(shouldNotify(data)).toBe(true)
  })

  it('weekday daytime notifies only when waiting > 2 (boundary)', () => {
    const two = baseData({
      timestamp: weekday(10),
      kanban: { urgent: 0, in_progress: 0, waiting: 2, urgentLabels: [], waitingLabels: [] },
    })
    expect(shouldNotify(two)).toBe(false)
    const three = baseData({
      timestamp: weekday(10),
      kanban: { urgent: 0, in_progress: 0, waiting: 3, urgentLabels: [], waitingLabels: [] },
    })
    expect(shouldNotify(three)).toBe(true)
  })

  it('weekday daytime, nothing pending: silent', () => {
    expect(shouldNotify(baseData({ timestamp: weekday(10) }))).toBe(false)
  })
})

describe('collectData', () => {
  it('happy path assembles calendar, kanban, system and tasks', async () => {
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockGetHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U1', title: 'urgent card' }],
      in_progress: [{ id: 'P1' }, { id: 'P2' }],
      waiting: [{ id: 'W1', title: 'waiting card' }],
    })
    mockStatSync.mockReturnValueOnce({ size: 10 * 1024 * 1024 } as ReturnType<typeof mockStatSync>)
    mockGetActiveScheduledTaskCount.mockReturnValueOnce({ count: 4, nextRun: 123456 })

    const data = await collectData()

    expect(data.calendar).toEqual([{ summary: 'ev' }])
    expect(data.kanban.urgent).toBe(1)
    expect(data.kanban.in_progress).toBe(2)
    expect(data.kanban.waiting).toBe(1)
    expect(data.kanban.urgentLabels).toEqual(['[U1] urgent card'])
    expect(data.system.dbSizeMB).toBe(10)
    expect(data.system.dbWarning).toBe(false)
    expect(data.tasks).toEqual({ count: 4, nextRun: 123456 })
    expect(data.timestamp).toBeInstanceOf(Date)
  })

  it('calendar fetch failure degrades to an empty list', async () => {
    mockGetCalendarEvents.mockRejectedValueOnce(new Error('gcal down'))
    const data = await collectData()
    expect(data.calendar).toEqual([])
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('kanban fetch failure degrades to zeroed counts', async () => {
    mockGetHeartbeatKanbanSummary.mockImplementationOnce(() => { throw new Error('db locked') })
    const data = await collectData()
    expect(data.kanban).toEqual({ urgent: 0, in_progress: 0, waiting: 0, urgentLabels: [], waitingLabels: [] })
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('system stat failure degrades to zero size, no warning', async () => {
    mockStatSync.mockImplementationOnce(() => { throw new Error('ENOENT') })
    const data = await collectData()
    expect(data.system).toEqual({ dbSizeMB: 0, dbWarning: false })
  })

  it('db size over 100MB sets dbWarning', async () => {
    mockStatSync.mockReturnValueOnce({ size: 150 * 1024 * 1024 } as ReturnType<typeof mockStatSync>)
    const data = await collectData()
    expect(data.system.dbWarning).toBe(true)
  })
})

describe('buildAgentPrompt', () => {
  it('renders empty-calendar and system sections with no parked state', () => {
    const prompt = buildAgentPrompt(baseData())
    expect(prompt).toContain('Nincs kozelgo esemeny.')
    expect(prompt).toContain('## Rendszer')
    expect(prompt).toContain('- DB meret: 1 MB')
    expect(prompt).not.toContain('FO-AGENS INPUT-BOX PARKOLT')
    expect(prompt).not.toContain('Kovetkezo feladat:')
  })

  it('includes the main-parked section when getMainParkedState is non-null', () => {
    mockGetMainParkedState.mockReturnValueOnce({ preview: 'p', fails: 2, approxMinutes: 10 })
    const prompt = buildAgentPrompt(baseData())
    expect(prompt).toContain('FO-AGENS INPUT-BOX PARKOLT')
  })

  it('lists calendar events with wrapped summary/attendees and next-task line', () => {
    const prompt = buildAgentPrompt(baseData({
      calendar: [{
        start: { dateTime: new Date(2026, 8, 24, 14, 30).toISOString() },
        summary: 'Design review',
        attendees: [{ displayName: 'Alice' }, { email: 'bob@example.com' }],
      }],
      tasks: { count: 3, nextRun: Math.floor(Date.now() / 1000) + 3600 },
    }))
    expect(prompt).toContain('Design review')
    expect(prompt).toContain('Alice')
    expect(prompt).toContain('bob@example.com')
    expect(prompt).toContain('Kovetkezo feladat:')
  })

  it('marks db warning inline and reports kanban counts + labels', () => {
    const prompt = buildAgentPrompt(baseData({
      system: { dbSizeMB: 200, dbWarning: true },
      kanban: { urgent: 2, in_progress: 5, waiting: 1, urgentLabels: ['[A] one', '[B] two'], waitingLabels: ['[C] three'] },
    }))
    expect(prompt).toContain('WARNING >100MB!')
    expect(prompt).toContain('- In Progress: 5')
    expect(prompt).toContain('- Urgent: 2')
    expect(prompt).toContain('one')
    expect(prompt).toContain('three')
  })
})

describe('executeHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('skips entirely outside the active window', async () => {
    vi.setSystemTime(weekday(6))
    await executeHeartbeat()
    expect(mockGetCalendarEvents).not.toHaveBeenCalled()
    expect(mockLoggerDebug).toHaveBeenCalled()
  })

  it('collects data but sends nothing when shouldNotify is false', async () => {
    vi.setSystemTime(weekday(10))
    await executeHeartbeat()
    expect(mockGetCalendarEvents).toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(mockNotifyTelegram).not.toHaveBeenCalled()
  })

  it('runs the sub-agent and forwards its text to Telegram when notify-worthy', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockRunAgent.mockResolvedValueOnce({ text: 'summary text' })

    await executeHeartbeat()

    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    const [promptArg, , , allowTools, cwdArg, envArg] = mockRunAgent.mock.calls[0]
    expect(typeof promptArg).toBe('string')
    expect(allowTools).toBe(false)
    expect(cwdArg).toContain('heartbeat-worker')
    expect(envArg).toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(mockNotifyTelegram).toHaveBeenCalledWith('summary text')
  })

  it('does not notify Telegram when the sub-agent returns no text', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockRunAgent.mockResolvedValueOnce({ text: null })

    await executeHeartbeat()

    expect(mockNotifyTelegram).not.toHaveBeenCalled()
  })

  it('logs and swallows a sub-agent failure instead of throwing', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockRunAgent.mockRejectedValueOnce(new Error('spawn failed'))

    await expect(executeHeartbeat()).resolves.toBeUndefined()
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockNotifyTelegram).not.toHaveBeenCalled()
  })

  it('ensureHeartbeatWorkerCwd: fresh state creates dirs, writes mcp/settings/sentinel, symlinks config entries', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('/.claude'))
    mockReaddirSync.mockReturnValueOnce(['settings.json', '.DS_Store', 'projects', 'plugins'])
    mockReadClaudeCodeOauthJson.mockReturnValueOnce('{"token":"x"}')

    await executeHeartbeat()

    expect(mockMkdirSync).toHaveBeenCalled()
    // mcp.json for the worker cwd
    expect(mockWriteFileSync.mock.calls.some(([p]) => String(p).includes('.mcp.json'))).toBe(true)
    // symlinked real, non-skipped entries only
    const symlinked = mockSymlinkSync.mock.calls.map(([, link]) => String(link))
    expect(symlinked.some((l) => l.endsWith('projects'))).toBe(true)
    expect(symlinked.some((l) => l.endsWith('plugins'))).toBe(true)
    expect(symlinked.some((l) => l.endsWith('settings.json'))).toBe(false)
    // settings.json written with all channel plugins disabled
    const settingsCall = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('settings.json') && !String(p).includes('.mcp'))
    expect(settingsCall).toBeTruthy()
    const written = JSON.parse(String(settingsCall![1]))
    expect(Object.values(written.enabledPlugins as Record<string, boolean>).every((v) => v === false)).toBe(true)
    // credentials materialised with 0600
    const credsCall = mockWriteFileSync.mock.calls.find(([p]) => String(p).includes('.credentials.json'))
    expect(credsCall).toBeTruthy()
    expect((credsCall![2] as { mode: number }).mode).toBe(0o600)
    // dashboard-hide sentinel
    expect(mockWriteFileSync.mock.calls.some(([p]) => String(p).includes('.hidden-from-dashboard'))).toBe(true)
  })

  it('ensureHeartbeatWorkerCwd: already-correct symlinks are left alone, stale files are removed and relinked', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p).endsWith('/.claude') || String(p).endsWith('good') || String(p).endsWith('stale'))
    mockReaddirSync.mockReturnValueOnce(['good', 'stale'])
    mockLstatSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('good')) return { isSymbolicLink: () => true } as ReturnType<typeof mockLstatSync>
      if (String(p).endsWith('stale')) return { isSymbolicLink: () => false } as ReturnType<typeof mockLstatSync>
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await executeHeartbeat()

    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('stale'), expect.anything())
    const symlinked = mockSymlinkSync.mock.calls.map(([, link]) => String(link))
    expect(symlinked.some((l) => l.endsWith('good'))).toBe(false)
    expect(symlinked.some((l) => l.endsWith('stale'))).toBe(true)
  })

  it('ensureHeartbeatWorkerCwd: leaves settings.json untouched when enabledPlugins is already all-false', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    const allFalse: Record<string, boolean> = {
      'telegram@claude-plugins-official': false,
      'slack-channel@marveen-marketplace': false,
      'discord@claude-plugins-official': false,
      'googlechat@claude-channel-googlechat': false,
      'teams@marveen-marketplace': false,
    }
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('settings.json'))
    mockLstatSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('settings.json')) return { isSymbolicLink: () => false } as ReturnType<typeof mockLstatSync>
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('settings.json')) return JSON.stringify({ enabledPlugins: allFalse, hooks: { x: 1 } })
      return ''
    })

    await executeHeartbeat()

    const settingsWrites = mockWriteFileSync.mock.calls.filter(([p]) => String(p).endsWith('settings.json') && !String(p).includes('.mcp'))
    expect(settingsWrites.length).toBe(0)
  })

  it('ensureHeartbeatWorkerCwd: a symlinked settings.json is removed so the worker owns a private copy', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('settings.json'))
    mockLstatSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('settings.json')) return { isSymbolicLink: () => true } as ReturnType<typeof mockLstatSync>
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await executeHeartbeat()

    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('settings.json'), expect.anything())
  })

  it('ensureHeartbeatWorkerCwd: malformed settings.json is warned and rewritten instead of throwing', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('settings.json'))
    mockLstatSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('settings.json')) return { isSymbolicLink: () => false } as ReturnType<typeof mockLstatSync>
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('settings.json')) return '{not json'
      return ''
    })

    await expect(executeHeartbeat()).resolves.toBeUndefined()
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  it('ensureHeartbeatWorkerCwd: bridges ~/.claude.json projects[PROJECT_ROOT] into the worker cwd key', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('.claude.json') && !String(p).includes('.claude-config'))
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('.claude.json')) return JSON.stringify({ projects: { '/project': { mcpServers: { gmail: {} } } } })
      return ''
    })

    await executeHeartbeat()

    const bridged = mockWriteFileSync.mock.calls.find(([p]) => String(p).includes('.claude-config') && String(p).endsWith('.claude.json'))
    expect(bridged).toBeTruthy()
    const parsed = JSON.parse(String(bridged![1]))
    expect(parsed.projects['/project']).toEqual(parsed.projects[Object.keys(parsed.projects).find((k) => k.includes('heartbeat-worker'))!])
  })

  it('ensureHeartbeatWorkerCwd: a malformed ~/.claude.json is non-fatal', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('.claude.json') && !String(p).includes('.claude-config'))
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('.claude.json')) return '{broken'
      return ''
    })

    await expect(executeHeartbeat()).resolves.toBeUndefined()
    expect(mockLoggerWarn.mock.calls.some((c) => String(c[1] ?? '').includes('claude.json'))).toBe(true)
  })

  it('ensureHeartbeatWorkerCwd: a symlinkSync failure for one entry is warned but does not abort the rest', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('/.claude'))
    mockReaddirSync.mockReturnValueOnce(['broken-entry'])
    mockSymlinkSync.mockImplementationOnce(() => { throw new Error('EPERM') })

    await expect(executeHeartbeat()).resolves.toBeUndefined()
    expect(mockLoggerWarn.mock.calls.some((c) => String(c[1] ?? '').includes('failed to symlink config entry'))).toBe(true)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
  })

  it('ensureHeartbeatWorkerCwd: skips the dashboard-hide sentinel write when it already exists', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('.hidden-from-dashboard'))

    await executeHeartbeat()

    expect(mockWriteFileSync.mock.calls.some(([p]) => String(p).includes('.hidden-from-dashboard'))).toBe(false)
  })

  it('a top-level failure inside ensureHeartbeatWorkerCwd is caught and warned, heartbeat still completes', async () => {
    vi.setSystemTime(weekday(10))
    mockGetCalendarEvents.mockResolvedValueOnce([{ summary: 'ev' }])
    mockExistsSync.mockImplementation(() => { throw new Error('fs blew up') })

    await expect(executeHeartbeat()).resolves.toBeUndefined()
    expect(mockLoggerWarn).toHaveBeenCalled()
    // Despite the ensureHeartbeatWorkerCwd failure, the agent still runs (best-effort isolation).
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
  })
})

describe('initHeartbeat / stopHeartbeat scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('schedules and fires executeHeartbeat at the next hour boundary, then reschedules', async () => {
    vi.setSystemTime(weekday(10))
    initHeartbeat()
    expect(mockLoggerInfo).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000)
    expect(mockGetCalendarEvents).toHaveBeenCalled()

    stopHeartbeat()
    expect(mockLoggerInfo.mock.calls.some((c) => String(c[0] ?? c[1] ?? '').match(/leallitva/) || String(c[1] ?? '').match(/leallitva/))).toBe(true)
  })

  it('stopHeartbeat prevents the next reschedule from firing again', async () => {
    vi.setSystemTime(weekday(10))
    initHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000)
    const callsAfterFirstFire = mockGetCalendarEvents.mock.calls.length
    expect(callsAfterFirstFire).toBeGreaterThan(0)

    stopHeartbeat()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(mockGetCalendarEvents.mock.calls.length).toBe(callsAfterFirstFire)
  })

  it('outside the active window at start, schedules for the next day', () => {
    vi.setSystemTime(weekday(23))
    initHeartbeat()
    expect(mockLoggerInfo).toHaveBeenCalled()
    stopHeartbeat()
  })

  it('before the start hour, the first schedule targets todays start hour (msUntilNextHeartbeat: currentHour < startH)', () => {
    vi.setSystemTime(weekday(5))
    initHeartbeat()
    expect(mockLoggerInfo).toHaveBeenCalled()
    stopHeartbeat()
  })

  it('exactly one hour before the end hour, the increment rolls into the next-day branch (msUntilNextHeartbeat: targetHour >= endH)', () => {
    vi.setSystemTime(weekday(20))
    initHeartbeat()
    expect(mockLoggerInfo).toHaveBeenCalled()
    stopHeartbeat()
  })
})
