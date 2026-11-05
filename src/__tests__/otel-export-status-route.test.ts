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
import { initDatabase, getDb, getOtelLogCursor, upsertOtelSpan, closeOtelSpan, setOtelMetricsExportWatermark } from '../db.js'

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
const { tick, resetOtelExporterStatus, getOtelExportOverview } = await import('../web/otel-push-exporter.js')
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
  getDb().exec('DELETE FROM approval_events; DELETE FROM rbac_shadow_log; DELETE FROM config_change_log; DELETE FROM agent_audit_log; DELETE FROM hook_audit_log; DELETE FROM fleet_blackboard_history; DELETE FROM kanban_card_events; DELETE FROM otel_logs_export_state; DELETE FROM otel_spans; DELETE FROM token_usage;')
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
  const ctx = { req, res, path: url.pathname, method, url, role, tenantId: null, auth: { kind: 'token' } } as unknown as RouteContext
  return tryHandleOtelExportStatus(ctx).then((handled) => ({
    handled, status: out.status, raw: out.raw, body: out.raw ? JSON.parse(out.raw) : null,
  }))
}

async function primeCursors() {
  for (const s of ['approval_events', 'rbac_shadow_log', 'config_change_log', 'agent_audit_log', 'hook_audit_log', 'fleet_blackboard_history', 'kanban_card_events'] as const) await getOtelLogCursor(s)
}
async function seedSpan(id: string) {
  await upsertOtelSpan({ trace_id: `trace-${id}`, span_id: `span-${id}`, parent_span_id: null, agent_id: 'agent-a', operation: 'test.op', start_ms: 1000, attributes: null })
  await closeOtelSpan(`trace-${id}`, `span-${id}`, 2000, 'ok')
}
async function seedTokens() {
  // The metrics window opens at the watermark: start it at zero so the row is inside it.
  await setOtelMetricsExportWatermark(0)
  getDb().prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model, tenant_id)
    VALUES ('agent-a', 's1', ?, 50, 10, 0, 0, 0, 'model-a', 'default')
  `).run(Math.floor(Date.now() / 1000))
}
/** Data for all three signals, so each one has something to send. */
async function seedAllSignals() {
  await primeCursors()
  seedConfigChange()
  await seedSpan('a')
  await seedTokens()
}
/** A collector that refuses exactly one signal (503) and takes the rest. */
function failOnly(signal: 'traces' | 'metrics' | 'logs') {
  vi.spyOn(global, 'fetch').mockImplementation((url) =>
    Promise.resolve(String(url).endsWith(`/v1/${signal}`) ? new Response('no', { status: 503 }) : new Response('{}', { status: 200 })))
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
    expect(r.body.configProblem).toBe('OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL')
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

describe('the configuration problem is a fixed text', () => {
  it('headers set in .env with no endpoint in .env: the missing-endpoint problem, without a header name or value', async () => {
    envFile.OTEL_EXPORTER_OTLP_HEADERS = 'x-key-a=secret-value-a'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.headersConfigured).toBe(true)
    expect(r.body.configProblem).toBe('OTEL_EXPORTER_OTLP_HEADERS is set in .env, so OTEL_EXPORTER_OTLP_ENDPOINT must be set in .env too (the credential is bound to the endpoint file); nothing is exported')
    expect(r.raw).not.toContain('x-key-a')
    expect(r.raw).not.toContain('secret-value-a')
  })

  it('a mis-pasted header as the endpoint: the answer does not carry the scheme (it is the first half of the credential), the log line does', async () => {
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = 'x-key-a:secret-value-a'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.configProblem).toBe('OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL')
    expect(r.raw).not.toContain('x-key-a')
    expect(r.raw).not.toContain('secret-value-a')
    const logged = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.stringify(c[0]))
    expect(logged.some((l) => l.includes('got x-key-a:'))).toBe(true)
  })

  it('the other endpoint refusals keep their fixed texts', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = 'not a url'
    await tick()
    expect((await call('GET', PATH)).body.configProblem).toBe('OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL')
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://user-a:secret-value-a@collector.local'
    await tick()
    const creds = await call('GET', PATH)
    expect(creds.body.configProblem).toBe('OTEL_EXPORTER_OTLP_ENDPOINT must not carry credentials: use OTEL_EXPORTER_OTLP_HEADERS')
    expect(creds.raw).not.toContain('user-a')
    expect(creds.raw).not.toContain('secret-value-a')
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = ''
    envFile.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.example.org'
    envFile.OTEL_EXPORTER_OTLP_HEADERS = 'x-key-a=secret-value-a'
    await tick()
    const plain = await call('GET', PATH)
    expect(plain.body.configProblem).toBe('OTEL_EXPORTER_OTLP_HEADERS would go over plain http to a non-private host: use https')
    expect(plain.raw).not.toContain('collector.example.org')
    expect(plain.raw).not.toContain('x-key-a')
  })
})

describe('a problem of a configuration that is no longer in force', () => {
  it('is not shown once the export is switched off', async () => {
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = 'ftp://collector.local'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect((await call('GET', PATH)).body.configProblem).not.toBeNull()
    cfg.OTEL_EXPORT_ENABLED = '0'
    expect((await call('GET', PATH)).body.configProblem).toBeNull()
  })

  it('is not shown once the endpoint is emptied and no headers are set', async () => {
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = 'ftp://collector.local'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect((await call('GET', PATH)).body.configProblem).not.toBeNull()
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = ''
    expect((await call('GET', PATH)).body.configProblem).toBeNull()
  })

  it('is still shown while the export is on and only the headers are set (the missing endpoint is the problem)', async () => {
    envFile.OTEL_EXPORTER_OTLP_HEADERS = 'x-key-a=secret-value-a'
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = ''
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect((await call('GET', PATH)).body.configProblem).not.toBeNull()
  })
})

describe('the error text', () => {
  it('replaces EVERY URL in one message, not only the first', async () => {
    await primeCursors()
    seedConfigChange()
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error(`first ${ENDPOINT}/v1/logs then ${ENDPOINT}/v1/other?key=secret-value-a done`))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.logs.lastError).toBe('first [url] then [url] done')
    expect(r.raw).not.toContain('secret-value-a')
  })

  it('replaces a URL whose scheme is in capitals', async () => {
    await primeCursors()
    seedConfigChange()
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connect failed HTTPS://COLLECTOR.LOCAL/v1/logs?key=secret-value-a'))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.logs.lastError).toBe('connect failed [url]')
    expect(r.raw.toLowerCase()).not.toContain('collector.local')
    expect(r.raw).not.toContain('secret-value-a')
  })

  it('replaces the URL BEFORE the cap: one that starts near the end is not left as a fragment', async () => {
    await primeCursors()
    seedConfigChange()
    // The URL starts at character 194; cut at 200 first it would be the fragment "http:/".
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error(`${'x'.repeat(193)} ${ENDPOINT}/v1/logs?key=secret-value-a`))
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.logs.lastError).toBe(`${'x'.repeat(193)} [url]`)
    expect(r.raw).not.toContain('http')
  })
})

describe('the three signals are independent', () => {
  it('only traces fail: metrics and logs show a success and no failure', async () => {
    await seedAllSignals()
    failOnly('traces')
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.traces.failures).toBeGreaterThanOrEqual(1)
    expect(r.body.traces.lastError).toBe('collector answered 503')
    expect(r.body.traces.lastSuccessMs).toBeNull()
    for (const s of ['metrics', 'logs']) {
      expect(r.body[s].failures, s).toBe(0)
      expect(r.body[s].lastError, s).toBeNull()
      expect(typeof r.body[s].lastSuccessMs, s).toBe('number')
    }
  })

  it('only metrics fail: traces and logs show a success and no failure', async () => {
    await seedAllSignals()
    failOnly('metrics')
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.metrics.failures).toBeGreaterThanOrEqual(1)
    expect(r.body.metrics.lastError).toBe('collector answered 503')
    expect(r.body.metrics.lastSuccessMs).toBeNull()
    for (const s of ['traces', 'logs']) {
      expect(r.body[s].failures, s).toBe(0)
      expect(r.body[s].lastError, s).toBeNull()
      expect(typeof r.body[s].lastSuccessMs, s).toBe('number')
    }
  })

  it('only logs fail: traces and metrics show a success and no failure', async () => {
    await seedAllSignals()
    failOnly('logs')
    await tick()
    const r = await call('GET', PATH)
    expect(r.body.logs.failures).toBe(1)
    for (const s of ['traces', 'metrics']) {
      expect(r.body[s].failures, s).toBe(0)
      expect(typeof r.body[s].lastSuccessMs, s).toBe('number')
    }
  })
})

describe('the overview is a copy', () => {
  it('changing the returned object does not reach the exporter state', async () => {
    await primeCursors()
    seedConfigChange()
    cfg.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 503 }))
    await tick()
    const before = JSON.parse(JSON.stringify(getOtelExportOverview()))
    expect(before.logs.lastError).toBe('collector answered 503')

    const mine = getOtelExportOverview() as any
    mine.logs.lastError = 'changed by the caller'
    mine.logs.failures = 99
    delete mine.logs.nextAttemptMs
    mine.traces.failures = 99
    mine.configProblem = 'changed by the caller'
    mine.enabled = false

    expect(JSON.parse(JSON.stringify(getOtelExportOverview()))).toEqual(before)
    expect((await call('GET', PATH)).body.logs.lastError).toBe('collector answered 503')
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
