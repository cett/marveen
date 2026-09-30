// A model-fallback overlay pins an agent to Y while the operator's configured
// model stays X. The dashboard's model <select> shows X, so an untouched Save
// PUTs X back: that must leave both the config and the overlay alone, while a
// different model supersedes the overlay.
//
// Unlike the mocked clearFallbackOverride assertions in
// agents-crud-routes-extended.test.ts, this drives the REAL agent-config and
// model-fallback-state modules against a temp project root / store dir.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const dirs = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  const root = mkdtempSync(join(tmpdir(), 'model-selector-fallback-'))
  return { root, store: join(root, 'store') }
})

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: dirs.root, STORE_DIR: dirs.store, MAIN_AGENT_ID: 'main-agent' }
})
vi.mock('../db/model-profile-map.js', () => ({ listModelProfileMap: vi.fn().mockReturnValue([]) }))
vi.mock('../web/routes/agents-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/routes/agents-helpers.js')>()
  return {
    ...actual,
    listAgentSummaries: vi.fn().mockReturnValue([]),
    remotePaneCache: { getOrRefresh: vi.fn().mockReturnValue(null) },
    agentRunStateCached: vi.fn().mockReturnValue('stopped'),
    getAgentDetail: vi.fn().mockReturnValue({ name: 'test-agent', model: 'claude-haiku-4-5' }),
    remoteRunStateCache: { getOrRefresh: vi.fn().mockReturnValue('stopped') },
    VALID_PROVIDERS: new Set(['telegram', 'slack', 'discord']),
    parseChannelProvider: vi.fn().mockReturnValue(null),
    validateDiscordChannelId: vi.fn().mockReturnValue({ ok: true }),
    tenantSummaryFields: vi.fn().mockReturnValue({
      primaryTenantId: 'eszter',
      tenantIds: ['default', 'eszter'],
      tenantNames: { default: 'Fleet (default)', eszter: 'Eszter tenant' },
    }),
  }
})
vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn(),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  }),
  getEnabledAgentsForTenant: vi.fn().mockReturnValue([]),
  isTenantAgentEnabled: vi.fn().mockReturnValue(true),
}))
vi.mock('../web/telegram.js', () => ({
  sendAvatarChangeMessage: vi.fn().mockResolvedValue(undefined),
  readAgentTelegramConfig: vi.fn().mockReturnValue(null),
  readAgentDiscordConfig: vi.fn().mockReturnValue(null),
  readAgentGooglechatConfig: vi.fn().mockReturnValue(null),
  readAgentTeamsConfig: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/agent-scaffold.js', () => ({
  scaffoldAgentDir: vi.fn(),
  scaffoldAgentMemoriaHeartbeat: vi.fn(),
  generateClaudeMd: vi.fn().mockResolvedValue('# Agent'),
  generateSoulMd: vi.fn().mockResolvedValue('# Soul'),
  writeAgentSettingsFromProfile: vi.fn(),
}))
vi.mock('../web/agent-bundle.js', () => ({
  exportAgentBundle: vi.fn().mockResolvedValue(undefined),
  importAgentBundle: vi.fn(),
  exportAllAgentsBundle: vi.fn().mockResolvedValue(undefined),
  importAllAgentsBundle: vi.fn(),
  peekBundleKind: vi.fn().mockReturnValue('single'),
  bundleFilename: vi.fn().mockReturnValue('bundle.tar.gz'),
  fleetBundleFilename: vi.fn().mockReturnValue('fleet.tar.gz'),
}))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: vi.fn().mockReturnValue(false),
  agentSessionName: vi.fn().mockImplementation((n: string) => `agent-${n}`),
  capturePane: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/model-suggest.js', () => ({
  suggestForAgent: vi.fn().mockReturnValue({ model: 'claude-haiku-4-5', reason: 'low-traffic' }),
}))
vi.mock('../web/token-usage.js', () => ({
  getTokenSummary: vi.fn().mockReturnValue([]),
}))
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: vi.fn().mockReturnValue([]),
}))
vi.mock('../web/federation/onboarding.js', () => ({
  ensureFederationClaudeMdSection: vi.fn(),
}))
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: vi.fn().mockReturnValue([{ id: 'plan-a', name: 'Plan A' }]),
  resolveAgentConfigDir: vi.fn().mockReturnValue('/tmp/config'),
}))
vi.mock('../web/multipart.js', () => ({
  parseMultipart: vi.fn().mockReturnValue({ file: null }),
}))
vi.mock('../web/vault.js', () => ({
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/active-model.js', () => ({
  readActiveModelFromProjectDir: vi.fn().mockReturnValue(null),
  readContextTokensFromProjectDir: vi.fn().mockReturnValue(null),
  projectsDirFor: vi.fn().mockReturnValue('/tmp/projects'),
}))
vi.mock('../pane-state.js', () => ({
  detectPaneState: vi.fn().mockReturnValue('idle'),
  detectPermissionMode: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/profiles.js', () => ({
  loadProfileTemplate: vi.fn().mockReturnValue({ id: 'default', label: 'Default', description: '', permissionMode: 'default', filesystem: { allow: [], deny: [] } }),
  resolveProfilePlaceholders: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../web/sanitize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/sanitize.js')>()
  return {
    ...actual,
    sanitizeAgentName: vi.fn().mockImplementation((s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')),
  }
})
vi.mock('../web/agent-team.js', () => ({
  readAgentTeam: vi.fn().mockReturnValue({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [], trustSources: [] }),
  writeAgentTeam: vi.fn(),
  sanitizeTeamConfig: vi.fn().mockImplementation((cfg: any) => cfg),
  cleanupTeamReferences: vi.fn(),
  reportsToCreatesCycle: vi.fn().mockReturnValue(false),
}))
vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: vi.fn().mockReturnValue(false),
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

import { tryHandleAgentsCrud } from '../web/routes/agents-crud.js'
import { getFallbackOverride, setFallbackOverride } from '../web/model-fallback-state.js'

function makeCtx(opts: { method: string; path: string; body?: string; role?: RouteContext['role']; tenantId?: RouteContext['tenantId'] }): {
  ctx: RouteContext; statusCode: () => number; responseBody: () => unknown
} {
  const { method, path, body = '', role, tenantId } = opts
  const em = new EventEmitter()
  Object.assign(em, { headers: {}, method, url: path })
  setImmediate(() => {
    if (body) em.emit('data', Buffer.from(body))
    em.emit('end')
  })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const ctx: RouteContext = {
    req: em as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://localhost${path}`),
    auth: { kind: 'token' },
    role,
    tenantId,
  }
  return { ctx, statusCode: () => code, responseBody: () => { try { return JSON.parse(resBody) } catch { return resBody } } }
}

const X = 'claude-opus-5-5'
const Y = 'claude-sonnet-5'
const OTHER = 'claude-haiku-4-5-20251001'
const AGENT = 'sub-agent'
const agentConfigPath = join(dirs.root, 'agents', AGENT, 'agent-config.json')
const configuredModel = () => JSON.parse(readFileSync(agentConfigPath, 'utf-8')).model as string

async function put(body: object) {
  const { ctx, statusCode } = makeCtx({ method: 'PUT', path: `/api/agents/${AGENT}`, body: JSON.stringify(body) })
  expect(await tryHandleAgentsCrud(ctx, '/tmp/web-test')).toBe(true)
  return statusCode()
}

beforeEach(() => {
  rmSync(join(dirs.root, 'agents'), { recursive: true, force: true })
  rmSync(dirs.store, { recursive: true, force: true })
  mkdirSync(join(dirs.root, 'agents', AGENT), { recursive: true })
  mkdirSync(dirs.store, { recursive: true })
  writeFileSync(agentConfigPath, JSON.stringify({ model: X }))
  setFallbackOverride(AGENT, { primary: X, current: Y, downgradedAt: 1_000 })
})
afterAll(() => rmSync(dirs.root, { recursive: true, force: true }))

describe('PUT /api/agents/:name while a fallback overlay pins the agent to Y (configured X)', () => {
  it('saving the selector value X unchanged keeps the config at X and the overlay at Y', async () => {
    expect(await put({ model: X })).toBe(200)
    expect(configuredModel()).toBe(X)
    expect(getFallbackOverride(AGENT)).toEqual({ primary: X, current: Y, downgradedAt: 1_000 })
  })

  it('saving Y (what the selector showed before the fix) is an operator change: config becomes Y, overlay dropped', async () => {
    expect(await put({ model: Y })).toBe(200)
    expect(configuredModel()).toBe(Y)
    expect(getFallbackOverride(AGENT)).toBeNull()
  })

  it('saving a different model writes it and removes the overlay', async () => {
    expect(await put({ model: OTHER })).toBe(200)
    expect(configuredModel()).toBe(OTHER)
    expect(getFallbackOverride(AGENT)).toBeNull()
  })

  it('a PUT without a model leaves config and overlay alone', async () => {
    expect(await put({ memoryIsolation: false })).toBe(200)
    expect(configuredModel()).toBe(X)
    expect(getFallbackOverride(AGENT)).toMatchObject({ primary: X, current: Y })
  })
})
