// The classification of the background jobs (db/background-jobs.ts) against the source tree, the helpers that bind a job
// to a db context, and the request path: the context follows the awaits of a request and the body observer, and does
// NOT follow a response event callback (which therefore opens its own).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  BACKGROUND_JOBS, NOT_DB_TIMER_FILES, systemJob, runAsAgentJob, runAsRequest,
  setAgentTenantResolver, resetAgentTenantResolver,
} from '../db/background-jobs.js'
import { currentDbContext, getDbContextStats, resetDbContextForTest, noteTenantResolved, runAs } from '../db/context.js'
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
      const bound = new RegExp(`(?:systemJob|runAsAgentJob|runAs\\.system)\\(\\s*(?:[^,()]+,\\s*)?'${name}'|runAs\\.system\\('${name}'`)
      expect(bound.test(text), `${name} in ${job.file}`).toBe(true)
    }
  })

  it('no source file binds a system job name the registry does not know', () => {
    const known = new Set(Object.keys(BACKGROUND_JOBS))
    const unknown: string[] = []
    for (const f of files) {
      for (const m of code(f.text).matchAll(/runAs\.system\(\s*'([^']+)'/g)) if (!known.has(m[1]!)) unknown.push(`${f.path}: ${m[1]}`)
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

  it('falls back to the default tenant when the lookup fails, and does not cache the failure', async () => {
    let calls = 0
    setAgentTenantResolver(() => { calls += 1; return calls === 1 ? Promise.reject(new Error('db down')) : Promise.resolve('acme') })
    expect(await runAsAgentJob('background-task', 'a3', () => currentDbContext()?.tenantId)).toBe('default')
    expect(await runAsAgentJob('background-task', 'a3', () => currentDbContext()?.tenantId)).toBe('acme')
  })

  it('returns what the function returns and lets its rejection through', async () => {
    expect(await runAsAgentJob('auto-restart', 'a4', () => 42)).toBe(42)
    await expect(runAsAgentJob('auto-restart', 'a4', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })
})

describe('runAsRequest', () => {
  it('maps the caller to a context', () => {
    expect(runAsRequest({ authenticated: false, role: undefined, tenantId: 'default' }, () => currentDbContext())).toEqual({ role: 'system', name: 'http-public' })
    expect(runAsRequest({ authenticated: true, role: 'admin', tenantId: null }, () => currentDbContext())).toEqual({ role: 'system', name: 'http-admin' })
    expect(runAsRequest({ authenticated: true, role: 'viewer', tenantId: 'acme' }, () => currentDbContext())).toEqual({ role: 'tenant', tenantId: 'acme' })
    expect(runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'a1', tenantId: 'acme' }, () => currentDbContext())).toEqual({ role: 'agent', agentId: 'a1', tenantId: 'acme' })
  })

  it('gives the unrestricted http-admin context to the admin role only, a global non-admin is http-global-viewer', () => {
    for (const role of ['viewer', 'agent', 'operator', undefined]) {
      expect(runAsRequest({ authenticated: true, role, tenantId: null }, () => currentDbContext()), String(role)).toEqual({ role: 'system', name: 'http-global-viewer' })
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

  it('binds the token collector and the auth sweep timers, the startup collection and the shutdown flush', () => {
    expect(web).toContain("systemJob('token-usage-collector', () => {")
    expect(web).toContain("runAs.system('token-usage-collector', () => collectTokenUsage())")
    expect(web).toContain("systemJob('auth-state-sweep', () => { void sweepAuthState() })")
    expect(web).toContain("runAs.system('shutdown-flush'")
  })

  it('ends the boot phase after the dashboard listens, in both start branches of index.ts', () => {
    const index = code(files.find((f) => f.path === 'src/index.ts')!.text)
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
