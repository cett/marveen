// The classification of the background jobs (db/background-jobs.ts) against the source tree, the helpers that bind a job
// to a db context, and the request path: the context follows the awaits of a request and the body observer, and does
// NOT follow a response event callback (which therefore opens its own).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  BACKGROUND_JOBS, NOT_DB_TIMER_FILES, systemJob, runAsAgentJob, runAsItemTenant, runAsRequest,
  setAgentTenantResolver, resetAgentTenantResolver,
} from '../db/background-jobs.js'
import { currentDbContext, getDbContextStats, resetDbContextForTest, noteTenantResolved, runAs, SKILL_REGEN_JOB, withTrace } from '../db/context.js'
import { readBody, setRequestBodyObserver } from '../web/http-helpers.js'
import { startDbContextReport, DB_CONTEXT_REPORT_INTERVAL_MS } from '../web/db-context-report.js'
import { logger } from '../logger.js'

const SRC = join(__dirname, '..')
const ROOT = join(SRC, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'generated' || name === 'migrations') continue
      sourceFiles(full, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const files = sourceFiles(SRC).map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') }))
const code = (text: string) => text.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

beforeEach(() => resetDbContextForTest())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetAgentTenantResolver()
  setRequestBodyObserver(null)
})

describe('the registry against the source tree', () => {
  it('every file that owns an interval or a watcher is classified', () => {
    const owners = files
      .filter((f) => !f.path.startsWith('src/db/'))
      .filter((f) => /\bsetInterval\(|\bwatchFile\(|[^.\w]watch\(/.test(code(f.text)))
      .map((f) => f.path)
    const known = new Set<string>([...Object.values(BACKGROUND_JOBS).map((j) => j.file), ...Object.keys(NOT_DB_TIMER_FILES)])
    expect(owners.filter((p) => !known.has(p))).toEqual([])
  })

  it('every classified file exists, and a file is not both a job file and a no-db file', () => {
    const present = new Set(files.map((f) => f.path))
    for (const j of Object.values(BACKGROUND_JOBS)) expect(present.has(j.file), j.file).toBe(true)
    for (const f of Object.keys(NOT_DB_TIMER_FILES)) expect(present.has(f), f).toBe(true)
    const jobFiles = new Set<string>(Object.values(BACKGROUND_JOBS).map((j) => j.file))
    expect(Object.keys(NOT_DB_TIMER_FILES).filter((f) => jobFiles.has(f))).toEqual([])
  })

  it('every job is bound in its own file under its own name', () => {
    for (const [name, job] of Object.entries(BACKGROUND_JOBS)) {
      const text = code(files.find((f) => f.path === job.file)!.text)
      const bound = new RegExp(`(?:systemJob|runAsAgentJob|runAs\\.(?:system|admin|viewer|public))\\(\\s*(?:[^,()]+,\\s*)?'${name}'|runAs\\.(?:system|admin|viewer|public)\\('${name}'`)
      expect(bound.test(text), `${name} in ${job.file}`).toBe(true)
    }
  })

  it('no source file binds a system job name the registry does not know', () => {
    const known = new Set(Object.keys(BACKGROUND_JOBS))
    const unknown: string[] = []
    for (const f of files) {
      for (const m of code(f.text).matchAll(/runAs\.(?:system|admin|viewer|public)\(\s*'([^']+)'/g)) if (!known.has(m[1]!)) unknown.push(`${f.path}: ${m[1]}`)
    }
    expect(unknown).toEqual([])
  })

  it('an agent job is bound with runAsAgentJob and the registry says agent for exactly those', () => {
    const agentNames = Object.entries(BACKGROUND_JOBS).filter(([, j]) => j.role === 'agent').map(([n]) => n).sort()
    expect(agentNames).toEqual(['auto-restart', 'background-task', 'context-guard', 'context-restart-gate'])
    for (const n of agentNames) {
      const text = code(files.find((f) => f.path === BACKGROUND_JOBS[n as keyof typeof BACKGROUND_JOBS].file)!.text)
      expect(text.includes(`runAsAgentJob('${n}'`), n).toBe(true)
    }
  })
})

describe('every call of an agent job runs through runAsAgentJob', () => {
  const sites: Array<[string, RegExp]> = [
    ['src/web/context-guard-runner.ts', /\bcheckAgent\(/],
    ['src/web/context-restart-gate-runner.ts', /\bcheckAgent\(/],
    ['src/web/auto-restart-runner.ts', /\bcheckAgent\(/],
    ['src/web/routes/background-tasks.ts', /\b(?:pollTick|checkAndFinalize)\(/],
  ]
  for (const [path, call] of sites) {
    it(`${path}: no bare call`, () => {
      const lines = code(files.find((f) => f.path === path)!.text).split('\n')
      const calls = lines.filter((l) => call.test(l) && !/function /.test(l))
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.filter((l) => !l.includes('runAsAgentJob('))).toEqual([])
    })
  }
})

describe('systemJob', () => {
  it('runs the function in runAs.system(name) on every call and passes arguments and result through', () => {
    const seen: Array<string | undefined> = []
    const job = systemJob('blackboard-stale-sweeper', (a: number, b: number) => { seen.push(currentDbContext()?.name); return a + b })
    expect(job(1, 2)).toBe(3)
    expect(job(3, 4)).toBe(7)
    expect(seen).toEqual(['blackboard-stale-sweeper', 'blackboard-stale-sweeper'])
    expect(currentDbContext()).toBeUndefined()
  })

  it('gives a timer callback created outside any runAs its own context', async () => {
    vi.useFakeTimers()
    const seen: Array<string | undefined> = []
    const timer = setInterval(systemJob('rbac-mode-refresh', () => { seen.push(currentDbContext()?.name) }), 10)
    await vi.advanceTimersByTimeAsync(25)
    clearInterval(timer)
    expect(seen).toEqual(['rbac-mode-refresh', 'rbac-mode-refresh'])
  })
})

describe('runAsItemTenant', () => {
  it('opens a tenant context with no trace inherited, even inside a request that carries one', () => {
    const trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
    const inRequest = runAs.tenant('tenant-z', () => withTrace(trace, () => ({ // trace attaches to the running context
      carried: currentDbContext(),
      block: runAsItemTenant('message-router', 'tenant-a', () => currentDbContext()),
    })))
    expect(inRequest.carried?.traceId).toBe(trace.traceId)
    expect(inRequest.block).toEqual({ role: 'tenant', tenantId: 'tenant-a' })
    expect(runAsItemTenant('import-crawler', 'tenant-a', () => currentDbContext())).toEqual({ role: 'tenant', tenantId: 'tenant-a' })
  })

  it('returns the result of the block, sync and async, and restores the outer context', async () => {
    expect(runAsItemTenant('message-router', 'tenant-a', () => 42)).toBe(42)
    const outer = await runAs.system('message-router', async () => {
      const inside = await runAsItemTenant('message-router', 'tenant-a', async () => {
        await Promise.resolve()
        return currentDbContext()?.tenantId
      })
      return { inside, after: currentDbContext() }
    }, { inheritTrace: false })
    expect(outer.inside).toBe('tenant-a')
    expect(outer.after).toEqual({ role: 'system', name: 'message-router' })
  })

  it('throws on an empty or a non-string tenant id, naming the job, and runs nothing', () => {
    const body = vi.fn(() => 1)
    expect(() => runAsItemTenant('message-router', '', body)).toThrow(/message-router/)
    expect(() => runAsItemTenant('import-crawler', undefined as unknown as string, body)).toThrow(TypeError)
    expect(() => runAsItemTenant('import-crawler', null as unknown as string, body)).toThrow(TypeError)
    expect(body).not.toHaveBeenCalled()
  })

  it('a block opened from a system job is not an escalation, a system opened INSIDE the block is', () => {
    runAs.system('message-router', () => {
      runAsItemTenant('message-router', 'tenant-a', () => 1)
      runAs.system('message-router', () => 1)
    }, { inheritTrace: false })
    expect(getDbContextStats().escalations).toBe(0)
    runAs.system('message-router', () => {
      runAsItemTenant('message-router', 'tenant-a', () => runAs.system('message-router', () => 1))
    }, { inheritTrace: false })
    expect(getDbContextStats().escalations).toBe(1)
  })

  it('the sanctioned SYSTEM name (skill-regen) opened from a tenant or an agent context is not counted; any other name still is', () => {
    runAs.tenant('tenant-a', () => runAs.system(SKILL_REGEN_JOB, () => 1))
    runAs.agent('agent-a', 'tenant-a', () => runAs.system(SKILL_REGEN_JOB, () => 1))
    expect(getDbContextStats().escalations).toBe(0)
    runAs.tenant('tenant-a', () => runAs.system('skill-regen-other', () => 1))
    runAs.agent('agent-a', 'tenant-a', () => runAs.system('something-else', () => 1))
    expect(getDbContextStats().escalations).toBe(2)
  })

  it('an ADMIN context carrying the sanctioned name is still an escalation (a label does not defeat the detector)', () => {
    runAs.tenant('tenant-a', () => runAs.admin(SKILL_REGEN_JOB, () => 1))
    expect(getDbContextStats().escalations).toBe(1)
    runAs.agent('agent-a', 'tenant-a', () => runAs.admin(SKILL_REGEN_JOB, () => 1))
    expect(getDbContextStats().escalations).toBe(2)
  })

  it('the sanctioned name is exported from one place and is the one the regen opens', () => {
    expect(SKILL_REGEN_JOB).toBe('skill-regen')
  })

  it('two items of two tenants each see their own tenant', () => {
    const seen = ['tenant-a', 'tenant-b'].map((t) => runAsItemTenant('import-crawler', t, () => currentDbContext()?.tenantId))
    expect(seen).toEqual(['tenant-a', 'tenant-b'])
  })
})

describe('runAsAgentJob', () => {
  it('runs as the agent in the tenant the resolver names and caches the lookup', async () => {
    const resolver = vi.fn((agentId: string) => Promise.resolve(agentId === 'a1' ? 'acme' : 'default'))
    setAgentTenantResolver(resolver)
    const first = await runAsAgentJob('auto-restart', 'a1', () => currentDbContext())
    const second = await runAsAgentJob('auto-restart', 'a1', () => currentDbContext())
    expect(first).toEqual({ role: 'agent', agentId: 'a1', tenantId: 'acme' })
    expect(second).toEqual(first)
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('makes the tenant lookup itself a call of the job, not an unexpected one', async () => {
    const seen: Array<string | undefined> = []
    setAgentTenantResolver(() => { seen.push(currentDbContext()?.name); return Promise.resolve('default') })
    await runAsAgentJob('context-guard', 'a2', () => undefined)
    expect(seen).toEqual(['context-guard'])
  })

  it('is fail closed when the lookup fails: the body is not run, the failure is warned about and counted, nothing is cached, the next tick retries', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    let calls = 0
    setAgentTenantResolver(() => { calls += 1; return calls === 1 ? Promise.reject(new Error('db down')) : Promise.resolve('acme') })
    const body = vi.fn(() => currentDbContext()?.tenantId)
    expect(await runAsAgentJob('background-task', 'agent-a', body)).toBeUndefined()
    expect(body).not.toHaveBeenCalled() // never as `default`
    expect(getDbContextStats().tenantUnresolved).toEqual({ 'background-task': 1 })
    const logged = warn.mock.calls.find((c) => String(c[1] ?? '').includes('could not be resolved'))
    expect(logged?.[0]).toMatchObject({ job: 'background-task', agentId: 'agent-a' })
    expect(JSON.stringify(logged?.[0])).not.toContain('tenantId')
    // the failure was not cached: the next tick looks the tenant up again and runs
    expect(await runAsAgentJob('background-task', 'agent-a', body)).toBe('acme')
    expect(body).toHaveBeenCalledTimes(1)
    expect(calls).toBe(2)
    expect(getDbContextStats().tenantUnresolved).toEqual({ 'background-task': 1 })
  })

  it('a binding whose status is `default` is a real answer: the body runs as the default tenant and nothing is counted', async () => {
    setAgentTenantResolver(() => Promise.resolve('default'))
    const body = vi.fn(() => currentDbContext())
    expect(await runAsAgentJob('auto-restart', 'agent-b', body)).toEqual({ role: 'agent', agentId: 'agent-b', tenantId: 'default' })
    expect(body).toHaveBeenCalledTimes(1)
    expect(getDbContextStats().tenantUnresolved).toEqual({})
  })

  it('returns what the function returns and lets its rejection through', async () => {
    expect(await runAsAgentJob('auto-restart', 'a4', () => 42)).toBe(42)
    await expect(runAsAgentJob('auto-restart', 'a4', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })
})

describe('runAsRequest', () => {
  // who x branch: every way a request can arrive, and the context the branch opens (R3: the three http contexts are no
  // longer all `system`). `http-gate` and `http-metrics` are not request branches: they stay `system`.
  it.each([
    ['no credential', { authenticated: false, role: undefined, tenantId: null }, { role: 'public', name: 'http-public' }],
    ['no credential, default tenant', { authenticated: false, role: undefined, tenantId: 'default' }, { role: 'public', name: 'http-public' }],
    ['admin session without a tenant', { authenticated: true, role: 'admin', tenantId: null }, { role: 'admin', name: 'http-admin' }],
    ['viewer session without a tenant', { authenticated: true, role: 'viewer', tenantId: null }, { role: 'viewer', name: 'http-global-viewer' }],
    ['agent-role session without a tenant', { authenticated: true, role: 'agent', tenantId: null }, { role: 'viewer', name: 'http-global-viewer' }],
    ['session without a role and without a tenant', { authenticated: true, role: undefined, tenantId: null }, { role: 'viewer', name: 'http-global-viewer' }],
    ['admin session in a tenant', { authenticated: true, role: 'admin', tenantId: 'acme' }, { role: 'tenant', tenantId: 'acme' }],
    ['viewer session in a tenant', { authenticated: true, role: 'viewer', tenantId: 'acme' }, { role: 'tenant', tenantId: 'acme' }],
    ['agent token in a tenant', { authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: 'acme' }, { role: 'agent', agentId: 'agent-a', tenantId: 'acme' }],
    ['agent token without a tenant', { authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: null }, { role: 'agent', agentId: 'agent-a', tenantId: 'default' }],
  ] as const)('opens the right role for: %s', (_label, who, expected) => {
    expect(runAsRequest(who, () => currentDbContext())).toEqual(expected)
  })

  it('a session user id rides in the context of a session request, whatever branch opens it; a token or no id carries none', () => {
    const ctxOf = (who: Parameters<typeof runAsRequest>[0]) => runAsRequest(who, () => currentDbContext())
    expect(ctxOf({ authenticated: true, role: 'viewer', tenantId: null, userId: '7' })).toEqual({ role: 'viewer', name: 'http-global-viewer', userId: '7' })
    expect(ctxOf({ authenticated: true, role: 'admin', tenantId: null, userId: '7' })).toEqual({ role: 'admin', name: 'http-admin', userId: '7' })
    expect(ctxOf({ authenticated: true, role: 'viewer', tenantId: 'acme', userId: '7' })).toEqual({ role: 'tenant', tenantId: 'acme', userId: '7' })
    expect(ctxOf({ authenticated: true, role: 'viewer', tenantId: null })?.userId).toBeUndefined()
    expect(ctxOf({ authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: 'acme' })?.userId).toBeUndefined()
    expect(ctxOf({ authenticated: false, role: undefined, tenantId: null })?.userId).toBeUndefined()
    // the trace and the user ride together
    const trace = { traceId: 't'.repeat(32), spanId: 's'.repeat(16) }
    expect(ctxOf({ authenticated: true, role: 'viewer', tenantId: null, userId: '7', trace })).toEqual({ role: 'viewer', name: 'http-global-viewer', userId: '7', ...trace })
  })

  it('only a session-authenticated request hands its user id to runAsRequest (src/web.ts)', () => {
    const web = readFileSync(join(SRC, 'web.ts'), 'utf8')
    expect(web).toMatch(/userId: auth\.kind === 'session' && auth\.userId !== undefined \? String\(auth\.userId\) : undefined/)
  })

  it('the three request entries of the registry carry the role their context opens', () => {
    expect(BACKGROUND_JOBS['http-public'].role).toBe('public')
    expect(BACKGROUND_JOBS['http-admin'].role).toBe('admin')
    expect(BACKGROUND_JOBS['http-global-viewer'].role).toBe('viewer')
    // the gate and the metrics callback keep the system role: the gate resolves the principal before any tenant is known
    expect(BACKGROUND_JOBS['http-gate'].role).toBe('system')
    expect(BACKGROUND_JOBS['http-metrics'].role).toBe('system')
  })

  it('maps the caller to a context', () => {
    expect(runAsRequest({ authenticated: false, role: undefined, tenantId: 'default' }, () => currentDbContext())).toEqual({ role: 'public', name: 'http-public' })
    expect(runAsRequest({ authenticated: true, role: 'admin', tenantId: null }, () => currentDbContext())).toEqual({ role: 'admin', name: 'http-admin' })
    expect(runAsRequest({ authenticated: true, role: 'viewer', tenantId: 'acme' }, () => currentDbContext())).toEqual({ role: 'tenant', tenantId: 'acme' })
    expect(runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'a1', tenantId: 'acme' }, () => currentDbContext())).toEqual({ role: 'agent', agentId: 'a1', tenantId: 'acme' })
  })

  it('gives the unrestricted http-admin context to the admin role only, a global non-admin is http-global-viewer', () => {
    for (const role of ['viewer', 'agent', 'operator', undefined]) {
      expect(runAsRequest({ authenticated: true, role, tenantId: null }, () => currentDbContext()), String(role)).toEqual({ role: 'viewer', name: 'http-global-viewer' })
    }
    expect(runAsRequest({ authenticated: true, role: 'admin', tenantId: 'acme' }, () => currentDbContext())).toEqual({ role: 'tenant', tenantId: 'acme' })
  })

  it('runs an agent token without a tenant as that agent in the default tenant (today\'s fallback), never as http-admin', () => {
    expect(runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'a1', tenantId: null }, () => currentDbContext())).toEqual({ role: 'agent', agentId: 'a1', tenantId: 'default' })
  })

  it('counts a global viewer as expected, not as unexpected or anonymous', async () => {
    const { dbx, initDatabase } = await import('../db.js')
    initDatabase()
    resetDbContextForTest()
    await runAsRequest({ authenticated: true, role: 'viewer', tenantId: null }, async () => { await dbx.get('SELECT 1') })
    expect(getDbContextStats()).toMatchObject({ total: 1, unexpected: 0, anonymous: 0, byJob: { 'http-global-viewer': 1 } })
  })

  it('counts a route served without a credential as anonymous, not as unexpected', async () => {
    const { dbx } = await import('../db.js')
    const { initDatabase } = await import('../db.js')
    initDatabase()
    resetDbContextForTest()
    await runAsRequest({ authenticated: false, role: undefined, tenantId: 'default' }, async () => { await dbx.get('SELECT 1') })
    expect(getDbContextStats()).toMatchObject({ total: 1, anonymous: 1, unexpected: 0 })
  })
})

describe('the request context over a real HTTP request', () => {
  let server: http.Server

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

  function listen(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler)
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
  }

  function post(port: number, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', method: 'POST' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString()))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  it('follows the awaits, readBody and the body observer (which runs in an end event callback)', async () => {
    const seen: Record<string, unknown> = {}
    setRequestBodyObserver(async () => {
      await Promise.resolve()
      seen.observer = currentDbContext()?.tenantId
    })
    const port = await listen((req, res) => {
      void runAsRequest({ authenticated: true, role: 'viewer', tenantId: 'acme' }, async () => {
        seen.before = currentDbContext()?.tenantId
        const body = await readBody(req)
        seen.afterBody = currentDbContext()?.tenantId
        await new Promise((r) => setTimeout(r, 5))
        seen.afterTimer = currentDbContext()?.tenantId
        res.end(body)
      })
    })
    expect(await post(port, 'payload')).toBe('payload')
    expect(seen).toMatchObject({ before: 'acme', observer: 'acme', afterBody: 'acme', afterTimer: 'acme' })
  })
})

describe('the request path wiring in web.ts (source pin)', () => {
  const web = code(files.find((f) => f.path === 'src/web.ts')!.text)

  it('runs the whole request handler as http-gate and only the route dispatch as the caller', () => {
    expect(web).toContain("runAs.system('http-gate', () => handleRequest(req, res))")
    const dispatchAt = web.indexOf('dispatcher.dispatch(routeCtx)')
    // the role goes in: http-admin is for the admin role only
    expect(web).toMatch(/runAsRequest\(\{ authenticated: auth\.kind !== 'none', role, agentId:/)
    const wrapAt = web.indexOf('runAsRequest({')
    expect(wrapAt).toBeGreaterThan(-1)
    expect(wrapAt).toBeLessThan(dispatchAt)
    expect(web.match(/dispatcher\.dispatch\(/g)?.length).toBe(1)
  })

  // The token collector's rows (class B, stamped with the agent's tenant as a VALUE) and its file cursor (a global row)
  // commit in ONE transaction (recordTokenUsageCalls; the rollback cells are in observability-memory-otel-facade.test.ts), and a
  // transaction has one role: so the job stays one system context and opens no per-agent tenant block.
  // The digest runs one block of the default tenant (the owner) for its read and its write: it is a hybrid, not a loop over tenants.
  it('classifies the daily digest as hybrid (a block of the owner tenant), not a tenant loop', () => {
    expect(BACKGROUND_JOBS['daily-digest'].role).toBe('hybrid')
    expect(BACKGROUND_JOBS['daily-digest'].note).toMatch(/default tenant/)
  })

  it('classifies the token collector as system, with the reason, and opens no tenant block anywhere in its path', () => {
    expect(BACKGROUND_JOBS['token-usage-collector'].role).toBe('system')
    expect(BACKGROUND_JOBS['token-usage-collector'].note).toMatch(/ONE transaction/)
    expect(BACKGROUND_JOBS['token-usage-collector'].note).toMatch(/cursor/)
    for (const file of ['web/token-usage.ts', 'db/observability.ts']) {
      const src = readFileSync(join(SRC, file), 'utf8')
      expect(src, file).not.toMatch(/runAsItemTenant|runAs\.tenant|runAs\.system|runAs\.admin/)
    }
  })

  it('binds the token collector and the auth sweep timers, the startup collection and the shutdown flush', () => {
    expect(web).toContain("systemJob('token-usage-collector', () => {")
    expect(web).toContain("runAs.system('token-usage-collector', () => collectTokenUsage())")
    expect(web).toContain("systemJob('auth-state-sweep', () => { void sweepAuthState() })")
    expect(web).toContain("runAs.system('shutdown-flush'")
  })

  it('ends the boot phase after the dashboard listens, in both start branches of main.ts', () => {
    const index = code(files.find((f) => f.path === 'src/main.ts')!.text)
    expect(index.match(/endDbBootPhase\(\)/g)?.length).toBe(2)
    expect(index).toContain('setAgentTenantResolver(')
  })
})

describe('noteTenantResolved', () => {
  it('counts a route tenant that differs from the request context and returns its argument', () => {
    runAs.tenant('acme', () => {
      expect(noteTenantResolved('acme')).toBe('acme')
      expect(getDbContextStats().tenantMismatches).toBe(0)
      expect(noteTenantResolved('other')).toBe('other')
    })
    expect(getDbContextStats().tenantMismatches).toBe(1)
  })

  it('skips a global admin, a system job and a null scope', () => {
    runAs.system('http-admin', () => noteTenantResolved('acme'))
    runAs.tenant('acme', () => noteTenantResolved(null))
    expect(noteTenantResolved('acme')).toBe('acme')
    expect(getDbContextStats().tenantMismatches).toBe(0)
  })
})

describe('the hourly report', () => {
  it('stays quiet at info when nothing unexpected happened and warns with the sites when something did', async () => {
    vi.useFakeTimers()
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const timer = startDbContextReport()
    await vi.advanceTimersByTimeAsync(DB_CONTEXT_REPORT_INTERVAL_MS)
    expect(info.mock.calls.some((c) => String(c[1]).includes('no unexpected call'))).toBe(true)
    expect(warn.mock.calls.some((c) => String(c[1]).includes('without a context'))).toBe(false)

    const { initDatabase, dbx } = await import('../db.js')
    initDatabase()
    await dbx.get('SELECT 1')
    await vi.advanceTimersByTimeAsync(DB_CONTEXT_REPORT_INTERVAL_MS)
    const w = warn.mock.calls.find((c) => String(c[1]).includes('without a context'))
    expect(w).toBeDefined()
    expect((w![0] as { newUnexpected: number }).newUnexpected).toBeGreaterThanOrEqual(1)
    clearInterval(timer)
  })
})
