// The agent summary must report BOTH models while a fallback overlay is active:
// `model` stays the operator's configured X (what the dashboard selector shows),
// `fallback` / `effectiveModel` carry the downgraded Y the agent really runs on.
// Uses the REAL model-fallback-state module over a temp store dir.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

const store = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  return { dir: mkdtempSync(join(tmpdir(), 'summary-fallback-')) as string }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: store.dir }
})

vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    channelStateDir: vi.fn().mockReturnValue('/tmp/channel-state'),
    readChannelToken: vi.fn().mockReturnValue(null),
  }
})
vi.mock('../vault.js', () => ({
  getSecret: vi.fn().mockReturnValue(null),
}))
vi.mock('../telegram.js', () => ({
  readAgentTelegramConfig: vi.fn().mockReturnValue({ hasTelegram: false }),
  readAgentDiscordConfig: vi.fn().mockReturnValue({ hasDiscord: false }),
  readAgentGooglechatConfig: vi.fn().mockReturnValue({ hasGooglechat: false }),
  readAgentTeamsConfig: vi.fn().mockReturnValue({ hasTeams: false }),
}))
vi.mock('../agent-process.js', () => ({
  agentRunState: vi.fn().mockReturnValue('stopped'),
  getAgentRunningSince: vi.fn().mockReturnValue(null),
  agentSessionName: vi.fn().mockImplementation((n: string) => `agent-${n}`),
  capturePane: vi.fn().mockReturnValue(null),
}))
vi.mock('../reauth-detect.js', () => ({
  detectReauthNeeded: vi.fn().mockReturnValue({ needsReauth: false }),
}))
// readAutoRestartConfig is DB-backed; this test has no database.
vi.mock('../web/auto-restart-store.js', () => ({
  readAutoRestartConfig: vi.fn().mockReturnValue({ enabled: false, maxRestarts: 5 }),
}))
vi.mock('../web/context-guard-store.js', () => ({
  readContextGuardConfig: vi.fn().mockReturnValue({ enabled: false }),
}))
vi.mock('../active-model.js', () => ({
  readActiveModelFromProjectDir: vi.fn().mockReturnValue(null),
  readContextTokensFromProjectDir: vi.fn().mockReturnValue(null),
}))
vi.mock('../claude-plans.js', () => ({
  resolveAgentConfigDir: vi.fn().mockReturnValue({ configDir: null }),
}))
vi.mock('../agent-team.js', () => ({
  readAgentTeam: vi.fn().mockReturnValue({ members: [], reportsTo: null }),
}))
vi.mock('../db/observability.js', () => ({
  getTenantForMainAgent: vi.fn().mockReturnValue(undefined),
  getTenant: vi.fn().mockReturnValue(undefined),
}))
vi.mock('../db/agents.js', () => ({
  getTenantsForAgent: vi.fn().mockReturnValue([]),
}))
vi.mock('../web/remote-status-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/remote-status-cache.js')>()
  return actual
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockReturnValue('/tmp/fake-agent'),
    agentConfigRoot: vi.fn().mockReturnValue('/tmp/fake-agent-config'),
    readFileOr: vi.fn().mockReturnValue(''),
    readAgentModel: vi.fn().mockReturnValue('claude-opus-5-5'),
    resolveAgentModelDetailed: vi.fn().mockReturnValue({ model: 'claude-opus-5-5', source: 'explicit_model' }),
    readAgentDisplayName: vi.fn().mockReturnValue('Test Agent'),
    readAgentAuthMode: vi.fn().mockReturnValue('oauth'),
    readAgentSecurityProfile: vi.fn().mockReturnValue('default'),
    readAgentClaudePlan: vi.fn().mockReturnValue(null),
    readAgentMemoryIsolation: vi.fn().mockReturnValue(false),
    readAgentRemoteConfig: vi.fn().mockReturnValue({ host: null, workdir: null }),
    readAgentRemoteHost: vi.fn().mockReturnValue(null),
    findAvatarForAgent: vi.fn().mockReturnValue(null),
    extractDescriptionFromClaudeMd: vi.fn().mockReturnValue('A test agent'),
    listAgentNames: vi.fn().mockReturnValue(['agent-d', 'agent-f']),
    isKnownAgent: vi.fn().mockReturnValue(true),
  }
})

import { getAgentSummary } from '../web/routes/agents-helpers.js'
import { clearFallbackOverride, setFallbackOverride } from '../web/model-fallback-state.js'

const X = 'claude-opus-5-5'
const Y = 'claude-sonnet-5'

beforeEach(() => clearFallbackOverride('agent-d'))
afterAll(() => rmSync(store.dir, { recursive: true, force: true }))

describe('getAgentSummary with a model-fallback overlay', () => {
  it('reports the configured X as model AND the downgraded Y as fallback / effectiveModel', () => {
    setFallbackOverride('agent-d', { primary: X, current: Y, downgradedAt: 5_000 })
    const summary = getAgentSummary('agent-d')
    expect(summary.model).toBe(X)
    expect(summary.fallback).toEqual({ primary: X, current: Y, downgradedAt: 5_000 })
    expect(summary.effectiveModel).toBe(Y)
  })

  it('without an overlay: no fallback, effectiveModel equals model', () => {
    const summary = getAgentSummary('agent-d')
    expect(summary.fallback).toBeNull()
    expect(summary.effectiveModel).toBe(X)
    expect(summary.model).toBe(X)
  })

  it('a cleared overlay stops being reported', () => {
    setFallbackOverride('agent-d', { primary: X, current: Y, downgradedAt: 5_000 })
    clearFallbackOverride('agent-d')
    expect(getAgentSummary('agent-d').fallback).toBeNull()
  })
})
