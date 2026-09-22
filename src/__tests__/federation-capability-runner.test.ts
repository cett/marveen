import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted runs before vi.mock (and before the mocked module's own static
// import is evaluated), so the factories below can reference these mocks.
const {
  runAgentMock, getEffectiveSettingValueMock, getFederationConfigMock, catalogAgentNamesMock,
  generateOneSummaryMock, pickStaleAgentsMock, pruneCapabilityCacheMock, readCapabilityCacheMock,
  readSummarySourceMock, summarySourceHashMock,
} = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  getEffectiveSettingValueMock: vi.fn(),
  getFederationConfigMock: vi.fn(),
  catalogAgentNamesMock: vi.fn(),
  generateOneSummaryMock: vi.fn(),
  pickStaleAgentsMock: vi.fn(),
  pruneCapabilityCacheMock: vi.fn(),
  readCapabilityCacheMock: vi.fn(),
  readSummarySourceMock: vi.fn(),
  summarySourceHashMock: vi.fn(),
}))

// Paths are relative to THIS test file (src/__tests__/), not to the module
// under test -- vi.mock resolves against the importing (test) file's location.
vi.mock('../agent.js', () => ({ runAgent: runAgentMock }))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: getEffectiveSettingValueMock }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/federation/config.js', () => ({ getFederationConfig: getFederationConfigMock }))
vi.mock('../web/federation/local-catalog.js', () => ({ catalogAgentNames: catalogAgentNamesMock }))
vi.mock('../web/federation/capabilities.js', () => ({
  CAPABILITY_GENERATION_TIMEOUT_MS: 300_000,
  generateOneSummary: generateOneSummaryMock,
  pickStaleAgents: pickStaleAgentsMock,
  pruneCapabilityCache: pruneCapabilityCacheMock,
  readCapabilityCache: readCapabilityCacheMock,
  readSummarySource: readSummarySourceMock,
  summarySourceHash: summarySourceHashMock,
}))

import {
  startCapabilitySummaryRunner,
  _capabilityRunnerTickForTest,
  CAPABILITY_RUNNER_INITIAL_DELAY_MS,
  CAPABILITY_RUNNER_INTERVAL_MS,
} from '../web/federation/capability-runner.js'

function resetMocks(): void {
  runAgentMock.mockReset()
  getEffectiveSettingValueMock.mockReset().mockReturnValue('hu')
  getFederationConfigMock.mockReset().mockReturnValue({ enabled: true, peers: [] })
  catalogAgentNamesMock.mockReset().mockReturnValue(['agent-a', 'agent-b'])
  generateOneSummaryMock.mockReset().mockResolvedValue('ok')
  pickStaleAgentsMock.mockReset().mockReturnValue([])
  pruneCapabilityCacheMock.mockReset()
  readCapabilityCacheMock.mockReset().mockReturnValue({})
  readSummarySourceMock.mockReset().mockImplementation((name: string) => ({
    displayName: name, model: 'claude-sonnet-5', roleHead: 'role', skills: [],
  }))
  summarySourceHashMock.mockReset().mockReturnValue('hash')
}

beforeEach(resetMocks)

describe('_capabilityRunnerTickForTest -- runOnce logic', () => {
  it('is a no-op when federation is disabled', async () => {
    getFederationConfigMock.mockReturnValue({ enabled: false, peers: [] })
    await _capabilityRunnerTickForTest()
    expect(pruneCapabilityCacheMock).not.toHaveBeenCalled()
    expect(generateOneSummaryMock).not.toHaveBeenCalled()
  })

  it('prunes the cache against the current catalog and reads sources for every candidate', async () => {
    pickStaleAgentsMock.mockReturnValue([])
    await _capabilityRunnerTickForTest()
    expect(pruneCapabilityCacheMock).toHaveBeenCalledWith(new Set(['agent-a', 'agent-b']))
    expect(readSummarySourceMock).toHaveBeenCalledWith('agent-a')
    expect(readSummarySourceMock).toHaveBeenCalledWith('agent-b')
  })

  it('uses the cold-start batch size when the cache is empty', async () => {
    readCapabilityCacheMock.mockReturnValue({})
    await _capabilityRunnerTickForTest()
    expect(pickStaleAgentsMock).toHaveBeenCalledWith(expect.any(Array), {}, expect.any(Number), 3)
  })

  it('uses a batch of one once the cache has entries', async () => {
    readCapabilityCacheMock.mockReturnValue({ 'agent-a': { sourceHash: 'hash' } })
    await _capabilityRunnerTickForTest()
    expect(pickStaleAgentsMock).toHaveBeenCalledWith(expect.any(Array), { 'agent-a': { sourceHash: 'hash' } }, expect.any(Number), 1)
  })

  it('generates a summary for every stale agent in the picked batch', async () => {
    pickStaleAgentsMock.mockReturnValue(['agent-a', 'agent-b'])
    await _capabilityRunnerTickForTest()
    expect(generateOneSummaryMock).toHaveBeenCalledTimes(2)
    expect(generateOneSummaryMock.mock.calls[0]![0]).toBe('agent-a')
    expect(generateOneSummaryMock.mock.calls[0]![1]).toBe('hu')
  })

  it('isolates a failing generation: one throw does not abort the batch', async () => {
    pickStaleAgentsMock.mockReturnValue(['agent-a', 'agent-b'])
    generateOneSummaryMock.mockImplementationOnce(() => { throw new Error('boom') })
    generateOneSummaryMock.mockResolvedValueOnce('ok')
    await _capabilityRunnerTickForTest()
    expect(generateOneSummaryMock).toHaveBeenCalledTimes(2)
  })

  it('resolves language from the dashboard setting', async () => {
    getEffectiveSettingValueMock.mockReturnValue('en')
    pickStaleAgentsMock.mockReturnValue(['agent-a'])
    await _capabilityRunnerTickForTest()
    expect(generateOneSummaryMock).toHaveBeenCalledWith('agent-a', 'en', expect.any(Function))
  })

  it('falls back to hu when reading the language setting throws', async () => {
    getEffectiveSettingValueMock.mockImplementation(() => { throw new Error('no settings store') })
    pickStaleAgentsMock.mockReturnValue(['agent-a'])
    await _capabilityRunnerTickForTest()
    expect(generateOneSummaryMock).toHaveBeenCalledWith('agent-a', 'hu', expect.any(Function))
  })

  it('wires the runLLM callback to runAgent with the generation timeout', async () => {
    pickStaleAgentsMock.mockReturnValue(['agent-a'])
    runAgentMock.mockResolvedValue({ text: 'a summary', error: undefined })
    generateOneSummaryMock.mockImplementationOnce(async (_name, _lang, runLLM) => {
      const r = await runLLM('some prompt')
      expect(r).toEqual({ text: 'a summary', error: undefined })
      return 'ok'
    })
    await _capabilityRunnerTickForTest()
    expect(runAgentMock).toHaveBeenCalledWith(
      'some prompt', undefined, undefined, false, undefined, undefined,
      { timeoutMs: 300_000, timeoutAsError: true },
    )
  })

  it('is single-flight: overlapping ticks collapse into one run', async () => {
    let resolveGen!: (v: string) => void
    generateOneSummaryMock.mockImplementation(() => new Promise((resolve) => { resolveGen = resolve }))
    pickStaleAgentsMock.mockReturnValue(['agent-a'])
    const p1 = _capabilityRunnerTickForTest()
    const p2 = _capabilityRunnerTickForTest()
    resolveGen('ok')
    await Promise.all([p1, p2])
    expect(pruneCapabilityCacheMock).toHaveBeenCalledTimes(1)
  })
})

describe('startCapabilitySummaryRunner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('schedules an initial tick and then a periodic interval', async () => {
    pickStaleAgentsMock.mockReturnValue([])
    const handle = startCapabilitySummaryRunner()
    expect(pruneCapabilityCacheMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CAPABILITY_RUNNER_INITIAL_DELAY_MS)
    expect(pruneCapabilityCacheMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(CAPABILITY_RUNNER_INTERVAL_MS)
    expect(pruneCapabilityCacheMock).toHaveBeenCalledTimes(2)

    clearInterval(handle)
  })
})
