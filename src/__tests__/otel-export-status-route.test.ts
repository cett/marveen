// GET /api/admin/otel-export-status: the OTLP exporter state seen from outside the exporter. Real in-memory DB, the
// real exporter module and the real route handler; fetch and the settings registry are mocked like in
// otel-push-exporter-logs.test.ts. Admin only, named in the RBAC table, wired in web.ts.
//
// Privacy: neutral fixtures only (collector.local, x-key-a, secret-value-a).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb, getOtelLogCursor } from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const cfg: Record<string, string> = {
  OTEL_EXPORT_ENABLED: '0',
  OTEL_EXPORT_LOGS: '0',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_HEADERS: '',
  OTEL_EXPORT_INPUT_SUMMARY: '0',
  OTEL_SERVICE_NAME: 'marveen',
}
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn((key: string) => cfg[key]),
}))

const envFile = vi.hoisted(() => ({}) as Record<string, string>)
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>()
  return {
    ...actual,
    readEnvFile: (keys?: string[]) =>
      keys && keys.length > 0 && keys.every((k) => k.startsWith('OTEL_'))
        ? Object.fromEntries(Object.entries(envFile).filter(([k]) => keys.includes(k)))
        : actual.readEnvFile(keys),
  }
})

const { logger } = await import('../logger.js')
const { resetMetricValues } = await import('../otel-metrics.js')
const { tick, resetOtelExporterStatus } = await import('../web/otel-push-exporter.js')
const { tryHandleOtelExportStatus } = await import('../web/routes/otel-export-status.js')
const { ENDPOINT_PERMISSION_TABLE, hasPermission, resolveRequiredPermission } = await import('../web/rbac.js')
import type { Role } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

const ENDPOINT = 'http://collector.local:4318'
const PATH = '/api/admin/otel-export-status'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  cfg.OTEL_EXPORT_ENABLED = '1'
  cfg.OTEL_EXPORT_LOGS = '1'
  cfg.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT
  for (const k of Object.keys(envFile)) delete envFile[k]
  resetOtelExporterStatus()
  resetMetricValues()
  getDb().exec('DELETE FROM approval_events; DELETE FROM rbac_shadow_log; DELETE FROM config_change_log; DELETE FROM agent_audit_log; DELETE FROM hook_audit_log; DELETE FROM fleet_blackboard_history; DELETE FROM kanban_card_events; DELETE FROM otel_logs_export_state;')
  vi.restoreAllMocks()
})

function call(method: string, path: string, role = 'admin'): Promise<{ handled: boolean; status: number; raw: string; body: any }> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const out = { status: 200, raw: '' }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) out.raw = Buffer.isBuffer(b) ? b.toString('utf-8') : b },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role, tenantId: null } as unknown as RouteContext
  return tryHandleOtelExportStatus(ctx).then((handled) => ({
    handled, status: out.status, raw: out.raw, body: out.raw ? JSON.parse(out.raw) : null,
  }))
}

async function primeCursors() {
  for (const s of ['approval_events', 'rbac_shadow_log', 'config_change_log', 'agent_audit_log', 'hook_audit_log', 'fleet_blackboard_history', 'kanban_card_events'] as const) await getOtelLogCursor(s)
}
function seedConfigChange() {
  getDb().prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('SOME_SETTING', 'a', 'b', 'user-a', 1700000000)").run()
}

describe('the answer', () => {
  it('on a fresh process with the export off: switched off, no endpoint, every signal at zero', async () => {
    cfg.OTEL_EXPORT_ENABLED = '0'
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = ''
    const r = await call('GET', PATH)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(false)
    expect(r.body.endpointConfigured).toBe(false)
    expect(r.body.headersConfigured).toBe(false)
    expect(r.body.configProblem).toBeNull()
    expect(typeof r.body.now).toBe('number')
    for (const s of ['traces', 'metrics', 'logs']) {
      expect(r.body[s]).toEqual({ consecutiveFailures: 0, nextAttemptMs: 0, failures: 0, rejected: 0, lastError: null, lastSuccessMs: null })
    }
  })

  it('shows a collector that answers 503: the failure count, the error text and the backoff of the signal that failed', async () => {
    await primeCursors()
    seedConfigChange()
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 503 }))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.enabled).toBe(true)
    expect(r.body.endpointConfigured).toBe(true)
    expect(r.body.logs.failures).toBe(1)
    expect(r.body.logs.consecutiveFailures).toBe(1)
    expect(r.body.logs.lastError).toBe('collector answered 503')
    expect(r.body.logs.lastSuccessMs).toBeNull()
    expect(r.body.logs.nextAttemptMs).toBeGreaterThan(Date.now())
  })

  it('shows the last success and clears the error once the collector answers again', async () => {
    await primeCursors()
    seedConfigChange()
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 503 }))
    await tick()
    expect((await call('GET', PATH)).body.logs.lastError).toBe('collector answered 503')
    spy.mockResolvedValue(new Response('{}', { status: 200 }))
    // The backoff (30 s doubling to 10 min) holds the signal back: move the clock past it, only Date is faked.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await tick()
    } finally {
      vi.useRealTimers()
    }
    const r = await call('GET', PATH)
    expect(r.body.logs.lastError).toBeNull()
    expect(r.body.logs.consecutiveFailures).toBe(0)
    expect(r.body.logs.failures).toBe(1)
    expect(typeof r.body.logs.lastSuccessMs).toBe('number')
  })

  it('reports a configuration problem the exporter logged', async () => {
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = 'ftp://collector.local'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.endpointConfigured).toBe(true)
    expect(r.body.configProblem).toMatch(/must be http\(s\)/)
  })

  it('reports skipped headers without naming them; the log line still names them', async () => {
    envFile.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT
    // content-type is a reserved header, so it is skipped and its name goes into the logged problem.
    envFile.OTEL_EXPORTER_OTLP_HEADERS = 'x-key-a=value-a,content-type=secret-value-a'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.headersConfigured).toBe(true)
    expect(r.body.configProblem).toBe('OTEL_EXPORTER_OTLP_HEADERS: some entries were skipped as unusable')
    expect(r.raw).not.toContain('content-type')
    expect(r.raw).not.toContain('secret-value-a')
    // The operator log keeps the names: that is where the fix is read from.
    const logged = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.stringify(c[0]))
    expect(logged.some((l) => l.includes('content-type'))).toBe(true)
  })

  it('forgets the configuration problem when the exporter state is reset', async () => {
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = 'ftp://collector.local'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect((await call('GET', PATH)).body.configProblem).not.toBeNull()
    resetOtelExporterStatus()
    expect((await call('GET', PATH)).body.configProblem).toBeNull()
  })

  it('keeps a URL out of the error text even when the runtime puts it in the error message', async () => {
    await primeCursors()
    seedConfigChange()
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error(`connect failed ${ENDPOINT}/v1/logs?key=secret-value-a`))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.logs.lastError).toBe('connect failed [url]')
    expect(r.raw).not.toContain('collector.local')
    expect(r.raw).not.toContain('secret-value-a')
  })

  it('caps the error text of a transport failure', async () => {
    await primeCursors()
    seedConfigChange()
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('x'.repeat(500)))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.logs.lastError).toHaveLength(200)
  })

  it('never carries the endpoint URL or the headers, only the fact that they are set', async () => {
    envFile.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT
    envFile.OTEL_EXPORTER_OTLP_HEADERS = 'x-key-a=secret-value-a'
    await primeCursors()
    seedConfigChange()
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 503 }))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.endpointConfigured).toBe(true)
    expect(r.body.headersConfigured).toBe(true)
    expect(r.raw).not.toContain('collector.local')
    expect(r.raw).not.toContain('secret-value-a')
    expect(r.raw).not.toContain('x-key-a')
  })
})

describe('who may ask', () => {
  it('refuses a caller that is not an admin even when the gate let it through (shadow mode), with no state in the body', async () => {
    for (const role of ['agent', 'read_only', 'viewer', 'fleet_agent']) {
      const r = await call('GET', PATH, role)
      expect(r.handled, role).toBe(true)
      expect(r.status, role).toBe(403)
      expect(r.body.error, role).toBe('forbidden')
      expect(r.body.traces, role).toBeUndefined()
      expect(r.body.enabled, role).toBeUndefined()
    }
  })

  it('only handles GET on its own path', async () => {
    expect((await call('POST', PATH)).handled).toBe(false)
    expect((await call('GET', `${PATH}s`)).handled).toBe(false)
    expect((await call('GET', '/api/admin/otel-export')).handled).toBe(false)
  })

  it('is named in the RBAC table on both prefixes, as admin:all, and no other role holds that permission', () => {
    for (const p of [PATH, `/api/v1/admin/otel-export-status`]) {
      const hit = ENDPOINT_PERMISSION_TABLE.find((e) => 'pathPattern' in e && e.pathPattern === p && !e.prefix)
      expect(hit, p).toMatchObject({ method: 'GET', permission: 'admin:all' })
      const need = resolveRequiredPermission('GET', p)
      expect(need, p).toBe('admin:all')
      for (const r of ['agent', 'read_only', 'viewer', 'fleet_agent'] as Role[]) expect(hasPermission(r, need!), `${p} ${r}`).toBe(false)
      expect(hasPermission('admin', need!), p).toBe(true)
    }
  })
})

describe('wiring', () => {
  it('the handler is registered in web.ts', () => {
    const web = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web.ts'), 'utf-8')
    expect(web).toContain("import { tryHandleOtelExportStatus } from './web/routes/otel-export-status.js'")
    expect(web).toContain('.add(tryHandleOtelExportStatus)')
  })

  it('the route reads the exporter state: it is the exporter overview, not a stub', () => {
    const route = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/routes/otel-export-status.ts'), 'utf-8')
    expect(route).toContain('getOtelExportOverview()')
  })
})
