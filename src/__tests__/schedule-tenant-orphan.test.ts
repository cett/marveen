// A scheduled task whose (tenant, agent) pair stopped holding (agent switched off for the
// tenant, tenant disabled) is not fired by the runner: the tenant-context hook would bind
// nothing for it. Its due occurrences are recorded as skipped_tenant_mismatch, it counts
// toward the mass-skip alert, and the operator is told once.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockServes = vi.fn<(agent: string, tenant: string) => boolean>()
const mockEnabledFor = vi.fn<(agent: string) => string[]>()

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))
vi.mock('../db.js', async (orig) => ({
  ...(await orig<typeof import('../db.js')>()),
  getTenantsForAgent: (a: string) => mockEnabledFor(a),
  agentServesTenant: (a: string, t: string) => mockServes(a, t),
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['agent-a', 'agent-b'],
}))

import { createPairOrphanChecker } from '../web/schedule-tenant.js'
import {
  MASS_SKIP_MIN_TASKS,
  SKIP_STATUS_TENANT_MISMATCH,
  classifyTask,
  createSkipTracker,
  type SkipLedgerDeps,
} from '../web/schedule-skip-ledger.js'
import { shouldAlertTenantMismatch } from '../web/schedule-runner.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cronPrevOccurrence } from '../web/cron.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

beforeEach(() => {
  mockServes.mockReset().mockReturnValue(true)
  mockEnabledFor.mockReset().mockReturnValue([])
})

describe('createPairOrphanChecker', () => {
  it('a pair that holds is not an orphan', () => {
    const orphan = createPairOrphanChecker()
    expect(orphan('default', 'agent-a')).toBe(false)
    expect(orphan('tenant-b', 'agent-a')).toBe(false)
  })

  it('a non-default tenant whose agent no longer serves it is an orphan', () => {
    mockServes.mockImplementation((agent, tenant) => !(agent === 'agent-a' && tenant === 'tenant-b'))
    const orphan = createPairOrphanChecker()
    expect(orphan('tenant-b', 'agent-a')).toBe(true)
    expect(orphan('tenant-b', 'agent-b')).toBe(false)
  })

  it('the fleet main agent in a non-default tenant, and "all" there, are orphans (policy, no lookup needed)', () => {
    const orphan = createPairOrphanChecker()
    expect(orphan('tenant-b', 'main-agent')).toBe(true)
    expect(orphan('tenant-b', 'all')).toBe(true)
  })

  it('an agent enabled only for other tenants no longer serves the default tenant', () => {
    mockEnabledFor.mockReturnValue(['tenant-b'])
    expect(createPairOrphanChecker()('default', 'agent-a')).toBe(true)
  })

  it('no tenant counts as the default tenant, no agent as the main agent', () => {
    const orphan = createPairOrphanChecker()
    expect(orphan(undefined, undefined)).toBe(false)
    expect(orphan(null, 'agent-a')).toBe(false)
  })

  it('answers once per distinct pair for the life of the checker (one tick)', () => {
    mockServes.mockReturnValue(true)
    const orphan = createPairOrphanChecker()
    for (let i = 0; i < 20; i++) orphan('tenant-b', 'agent-a')
    expect(mockServes).toHaveBeenCalledTimes(1)
  })

  it('a failed lookup never stops a task from firing', () => {
    mockServes.mockImplementation(() => { throw new Error('db gone') })
    expect(createPairOrphanChecker()('tenant-b', 'agent-a')).toBe(false)
  })
})

describe('classifyTask: tenant_mismatch', () => {
  it('only a runnable task can be a tenant mismatch (disabled and not-live keep their own kind)', () => {
    expect(classifyTask({ enabled: true, status: 'live' }, true)).toBe('tenant_mismatch')
    expect(classifyTask({ enabled: true, status: 'live' }, false)).toBe('runnable')
    expect(classifyTask({ enabled: false, status: 'live' }, true)).toBe('disabled')
    expect(classifyTask({ enabled: true, status: 'draft' }, true)).toBe('not_live')
  })
})

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 28, 22, 5, 0)

function task(name: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name, description: '', prompt: 'p', schedule: '*/30 * * * *', agent: 'agent-a', enabled: true,
    createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false, status: 'live', tenantId: 'tenant-b', ...over,
  } as ScheduledTask
}

function ledger(orphans: Set<string>) {
  const runs: Array<{ name: string; agent: string; status: string }> = []
  const deps: SkipLedgerDeps = {
    cronPrevOccurrence: (s, from, to) => cronPrevOccurrence(s, from, to),
    targets: t => [t.agent || 'main-agent'],
    appendTaskRun: (name, agent, status) => { runs.push({ name, agent, status }) },
    tenantMismatch: t => orphans.has(t.name),
  }
  return { runs, deps, tracker: createSkipTracker() }
}

describe('skip ledger: skipped_tenant_mismatch', () => {
  it('records each due occurrence of an orphan task and nothing for a task whose pair holds', () => {
    const { runs, deps, tracker } = ledger(new Set(['orphan']))
    const tasks = [task('orphan'), task('fine')]
    // two ticks over a window containing one :30 occurrence each
    tracker.scan(tasks, T0 + 20 * MIN, T0 + 30 * MIN, deps)
    tracker.scan(tasks, T0 + 50 * MIN, T0 + 60 * MIN, deps)
    expect(runs).toEqual([
      { name: 'orphan', agent: 'agent-a', status: SKIP_STATUS_TENANT_MISMATCH },
      { name: 'orphan', agent: 'agent-a', status: SKIP_STATUS_TENANT_MISMATCH },
    ])
  })

  it('records nothing in a tick with no due occurrence', () => {
    const { runs, deps, tracker } = ledger(new Set(['orphan']))
    tracker.scan([task('orphan')], T0 + 1 * MIN, T0 + 2 * MIN, deps)
    expect(runs).toEqual([])
  })

  it('an orphan whose pair holds again stops being recorded', () => {
    const orphans = new Set(['orphan'])
    const { runs, deps, tracker } = ledger(orphans)
    tracker.scan([task('orphan')], T0 + 20 * MIN, T0 + 30 * MIN, deps)
    orphans.clear()
    tracker.scan([task('orphan')], T0 + 50 * MIN, T0 + 60 * MIN, deps)
    expect(runs).toHaveLength(1)
  })

  it('counts toward the mass-skip alert like a task that is not live', () => {
    const names = Array.from({ length: MASS_SKIP_MIN_TASKS }, (_, i) => `t${i}`)
    const { deps, tracker } = ledger(new Set(names.slice(0, 3)))
    const res = tracker.scan(names.map(n => task(n)), T0 + 20 * MIN, T0 + 30 * MIN, deps)
    expect(res.alert).toBe(true)
    expect(res.massHeld.sort()).toEqual(['t0', 't1', 't2'])
  })

  it('one orphan among healthy tasks is no mass event', () => {
    const names = Array.from({ length: 6 }, (_, i) => `t${i}`)
    const { deps, tracker } = ledger(new Set(['t0']))
    expect(tracker.scan(names.map(n => task(n)), T0 + 20 * MIN, T0 + 30 * MIN, deps).alert).toBe(false)
  })
})

describe('shouldAlertTenantMismatch: one notification per breakage', () => {
  it('notifies once, again only after the pair held in between', () => {
    const seen = new Set<string>()
    const broken = new Set(['x'])
    expect(shouldAlertTenantMismatch(seen, broken, 'x')).toBe(true)
    expect(shouldAlertTenantMismatch(seen, broken, 'x')).toBe(false)
    expect(shouldAlertTenantMismatch(seen, new Set(), 'y')).toBe(false) // x healthy again: forgotten
    expect(shouldAlertTenantMismatch(seen, broken, 'x')).toBe(true)
  })

  it('never notifies for a task that is not a mismatch', () => {
    expect(shouldAlertTenantMismatch(new Set(), new Set(['x']), 'y')).toBe(false)
  })
})

// The tick is one large closure with no seam to drive it from a test, so the wiring is pinned
// on the source (same approach as the other schedule-runner wiring tests).
describe('schedule-runner: the fire loop refuses an orphan task', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  const loopStart = SRC.indexOf('for (const task of tasks) {\n      if (!task.enabled || !isTaskLive(task))')

  it('the orphan set covers runnable, non-command tasks only', () => {
    expect(SRC).toMatch(/t\.enabled && isTaskLive\(t\) && t\.type !== 'command' && pairOrphan\(t\.tenantId, t\.agent\)/)
  })

  it('the ledger is told which tasks are orphans', () => {
    expect(SRC).toMatch(/tenantMismatch: t => tenantMismatch\.has\(t\.name\)/)
  })

  it('an orphan task continues before it reaches the occurrence check and any injection', () => {
    expect(loopStart).toBeGreaterThan(0)
    const loop = SRC.slice(loopStart)
    const skipIdx = loop.indexOf('if (tenantMismatch.has(task.name)) {')
    const occurrenceIdx = loop.indexOf('const occurrenceMs = cronPrevOccurrence(task.schedule, fromMs, now)')
    expect(skipIdx).toBeGreaterThan(0)
    expect(skipIdx).toBeLessThan(occurrenceIdx)
    expect(loop.slice(skipIdx, occurrenceIdx)).toMatch(/\bcontinue\b/)
    expect(loop.slice(skipIdx, occurrenceIdx)).toMatch(/sendTenantMismatchAlert\(task\)/)
  })
})
