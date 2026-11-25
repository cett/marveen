// The boot cell of the PG process: initDatabaseAsync on PostgreSQL, then the
// startWebServer body with every background runner and the agent-worker spawn MOCKED. The cell asserts the mocks were
// called (one each), the dashboard listens, the dbx backend is PostgreSQL at the start, and the startup token collection
// logs no failure. HOME and the store are a fresh temp directory, so nothing outside the test is touched; tmux sessions
// are listed before and after (no session is created by the mocked spawn path).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const { HOME_DIR, STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-boot-home-'))
  process.env.HOME = home
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-boot-store-'))
  return { HOME_DIR: home, STORE: store }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

// Background runners and the worker spawn: mocked, each start function is a counted no-op.
const RUNNER_MOCKS: Array<[string, string]> = [
  ['../../web/schedule-runner.js', 'startScheduleRunner'],
  ['../../web/agent-worker.js', 'startWorkerSession'],
  ['../../web/worker-liveness.js', 'startWorkerLivenessMonitor'],
  ['../../web/channel-monitor.js', 'startChannelPluginMonitor'],
  ['../../web/channel-health-monitor.js', 'startChannelHealthMonitor'],
  ['../../web/stuck-input-watcher.js', 'startStuckInputWatcher'],
  ['../../web/stuck-tool-call-watcher.js', 'startStuckToolCallWatcher'],
  ['../../web/inbox-nudge-watcher.js', 'startInboxNudgeWatcher'],
  ['../../web/auto-restart-runner.js', 'startAutoRestartRunner'],
  ['../../web/claude-update-runner.js', 'startClaudeUpdateRolloutRunner'],
  ['../../web/model-fallback-runner.js', 'startModelFallbackRunner'],
  ['../../web/context-guard-runner.js', 'startContextGuardRunner'],
  ['../../web/context-restart-gate-runner.js', 'startContextRestartGateRunner'],
  ['../../web/blackboard-stale-sweeper.js', 'startBlackboardStaleSweeper'],
  ['../../web/channel-credentials.js', 'startChannelCredentialDriftSweeper'],
  ['../../web/workspace-docs-ttl-sweeper.js', 'startWorkspaceDocsTtlSweeper'],
  ['../../web/federation/poller.js', 'startFederationPoller'],
  ['../../web/federation/capability-runner.js', 'startCapabilitySummaryRunner'],
  ['../../web/routes/approvals.js', 'startApprovalTimeoutSweeper'],
  ['../../web/db-context-report.js', 'startDbContextReport'],
  ['../../web/plan-rotation-monitor.js', 'bootPlanRotationMonitor'],
]
const MOCK_FNS = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>))
vi.mock('../../web/schedule-runner.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startScheduleRunner'] = fn
  return { ...real, startScheduleRunner: fn }
})
vi.mock('../../web/agent-worker.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startWorkerSession'] = fn
  return { ...real, startWorkerSession: fn }
})
vi.mock('../../web/worker-liveness.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startWorkerLivenessMonitor'] = fn
  return { ...real, startWorkerLivenessMonitor: fn }
})
// The channel monitor resolves the claude and tmux binaries at import (src/platform.ts resolveFromPath). CI runners have no
// claude on PATH, so the cell resolves them to fixed paths; the real binaries are not needed to boot the startup path.
vi.mock('../../platform.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveFromPath: (name: string) => `/usr/bin/${name}`,
}))
vi.mock('../../web/channel-monitor.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startChannelPluginMonitor'] = fn
  return { ...real, startChannelPluginMonitor: fn }
})
vi.mock('../../web/channel-health-monitor.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startChannelHealthMonitor'] = fn
  return { ...real, startChannelHealthMonitor: fn }
})
vi.mock('../../web/stuck-input-watcher.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startStuckInputWatcher'] = fn
  return { ...real, startStuckInputWatcher: fn }
})
vi.mock('../../web/stuck-tool-call-watcher.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startStuckToolCallWatcher'] = fn
  return { ...real, startStuckToolCallWatcher: fn }
})
vi.mock('../../web/inbox-nudge-watcher.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startInboxNudgeWatcher'] = fn
  return { ...real, startInboxNudgeWatcher: fn }
})
vi.mock('../../web/auto-restart-runner.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startAutoRestartRunner'] = fn
  return { ...real, startAutoRestartRunner: fn }
})
vi.mock('../../web/claude-update-runner.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startClaudeUpdateRolloutRunner'] = fn
  return { ...real, startClaudeUpdateRolloutRunner: fn }
})
vi.mock('../../web/model-fallback-runner.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startModelFallbackRunner'] = fn
  return { ...real, startModelFallbackRunner: fn }
})
vi.mock('../../web/context-guard-runner.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startContextGuardRunner'] = fn
  return { ...real, startContextGuardRunner: fn }
})
vi.mock('../../web/context-restart-gate-runner.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startContextRestartGateRunner'] = fn
  return { ...real, startContextRestartGateRunner: fn }
})
vi.mock('../../web/blackboard-stale-sweeper.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startBlackboardStaleSweeper'] = fn
  return { ...real, startBlackboardStaleSweeper: fn }
})
vi.mock('../../web/channel-credentials.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startChannelCredentialDriftSweeper'] = fn
  return { ...real, startChannelCredentialDriftSweeper: fn }
})
vi.mock('../../web/workspace-docs-ttl-sweeper.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startWorkspaceDocsTtlSweeper'] = fn
  return { ...real, startWorkspaceDocsTtlSweeper: fn }
})
vi.mock('../../web/federation/poller.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startFederationPoller'] = fn
  return { ...real, startFederationPoller: fn }
})
vi.mock('../../web/federation/capability-runner.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startCapabilitySummaryRunner'] = fn
  return { ...real, startCapabilitySummaryRunner: fn }
})
vi.mock('../../web/routes/approvals.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startApprovalTimeoutSweeper'] = fn
  return { ...real, startApprovalTimeoutSweeper: fn }
})
vi.mock('../../web/db-context-report.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['startDbContextReport'] = fn
  return { ...real, startDbContextReport: fn }
})
vi.mock('../../web/plan-rotation-monitor.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const fn = vi.fn(() => undefined)
  MOCK_FNS['bootPlanRotationMonitor'] = fn
  return { ...real, bootPlanRotationMonitor: fn }
})

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { initDatabaseAsync, closePgBackend } from '../../db.js'
import { dbxDialect } from '../../db/facade.js'
import { logger } from '../../logger.js'
import { runAs } from '../../db/context.js'
import { latestActiveDashboardTokenAt } from '../../db/api-tokens.js'

// Warn/error lines the boot may log. Each entry names the reason; an empty list is the goal.
const ALLOWED_LOG: Array<{ match: string; reason: string }> = [
  { match: 'Inbound prober: store/.watchdog-userbot.session missing', reason: 'isolated temp store has no userbot session; the prober is a no-op by design, nothing is sent' },
]

const PORT = 3449
let db: PgTestDb
let tmuxBefore = -1
let tmuxAfter = -1
let server: import('node:http').Server | undefined
let warnSpy: ReturnType<typeof vi.spyOn> | undefined
let errorSpy: ReturnType<typeof vi.spyOn> | undefined

function tmuxCount(): number {
  try {
    return execFileSync('tmux', ['ls'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

beforeAll(async () => {
  db = await createPgTestDb()
  process.env.MARVEEN_PG_URL = db.appUrl
  expect(await initDatabaseAsync()).toBe('pg')
  tmuxBefore = tmuxCount()
  warnSpy = vi.spyOn(logger, 'warn')
  errorSpy = vi.spyOn(logger, 'error')
}, 120000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await closePgBackend().catch(() => undefined)
  delete process.env.MARVEEN_PG_URL
  await db?.close()
  rmSync(STORE, { recursive: true, force: true })
  rmSync(HOME_DIR, { recursive: true, force: true })
})

describe('the dashboard body starts on PostgreSQL', () => {
  it('startWebServer listens, the backend is PostgreSQL, the runners are called once each, no collector failure', async () => {
    const { startWebServer } = await import('../../web.js')
    expect(dbxDialect()).toBe('pg')
    server = await startWebServer(PORT)
    expect(server.listening).toBe(true)
    expect(dbxDialect()).toBe('pg')
    // the startup token collection runs in the background: give it time to finish, then check its log line
    await new Promise((r) => setTimeout(r, 3000))
    expect(dbxDialect()).toBe('pg')
    const logged = [...(warnSpy?.mock.calls ?? []), ...(errorSpy?.mock.calls ?? [])].map((c) => String(c[1] ?? c[0]))
    const unexpected = logged.filter((m) => !ALLOWED_LOG.some((a) => m.includes(a.match)))
    expect(unexpected, 'no warn or error during the boot').toEqual([])
    expect(await runAs.system('boot-readback', () => latestActiveDashboardTokenAt()), 'dashboard token row is in api_tokens').toBeGreaterThan(0)
    for (const [, name] of RUNNER_MOCKS) {
      expect(MOCK_FNS[name], `${name} mocked`).toBeDefined()
      expect(MOCK_FNS[name].mock.calls.length, `${name} called once`).toBe(1)
    }
    tmuxAfter = tmuxCount()
    expect(tmuxAfter).toBe(tmuxBefore)
  }, 120000)
})
