// OTel H5a: the opt-in log leg of the push loop (src/web/otel-push-exporter.ts exportLogs). Real in-memory DB,
// mocked fetch and settings registry, like otel-push-exporter.test.ts.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
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

const { resetMetricValues } = await import('../otel-metrics.js')
const { tick, getOtelExporterStatus, resetOtelExporterStatus } = await import('../web/otel-push-exporter.js')

const ENDPOINT = 'http://collector.local:4318'

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
  getDb().exec('DELETE FROM approval_events; DELETE FROM rbac_shadow_log; DELETE FROM config_change_log; DELETE FROM agent_audit_log; DELETE FROM otel_logs_export_state;')
  vi.restoreAllMocks()
})

function seedConfigChange(key = 'SOME_SETTING') {
  getDb().prepare(
    "INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES (?, 'OLD-CONTENT', 'NEW-CONTENT', 'user-a', 1700000000)",
  ).run(key)
}

function logCalls(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith('/v1/logs'))
}

function bodyOf(call: unknown[]): string {
  return String((call[1] as { body: string }).body)
}

// Starts the cursors at the current end of every table (what the first tick does), then lets the test seed.
function primeCursors() {
  for (const s of ['approval_events', 'rbac_shadow_log', 'config_change_log', 'agent_audit_log'] as const) getOtelLogCursor(s)
}

describe('log export through tick', () => {
  it('sends nothing to /v1/logs while OTEL_EXPORT_LOGS is off, however many audit rows exist', async () => {
    cfg.OTEL_EXPORT_LOGS = '0'
    primeCursors()
    seedConfigChange()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect(logCalls(fetchSpy)).toHaveLength(0)
  })

  it('sends nothing when the whole export is off even though OTEL_EXPORT_LOGS is on', async () => {
    cfg.OTEL_EXPORT_ENABLED = '0'
    primeCursors()
    seedConfigChange()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts new audit rows to /v1/logs, and the payload carries no content and no actor name', async () => {
    primeCursors()
    seedConfigChange()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const calls = logCalls(fetchSpy)
    expect(calls).toHaveLength(1)
    const body = bodyOf(calls[0])
    const parsed = JSON.parse(body)
    expect(parsed.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1)
    expect(body).toContain('SOME_SETTING')
    expect(body).not.toContain('CONTENT')
    expect(body).not.toContain('user-a')
  })

  it('does not replay the history that existed when the export was first switched on', async () => {
    seedConfigChange('OLD_ROW')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect(logCalls(fetchSpy)).toHaveLength(0)
    seedConfigChange('NEW_ROW')
    await tick()
    const calls = logCalls(fetchSpy)
    expect(calls).toHaveLength(1)
    expect(bodyOf(calls[0])).toContain('NEW_ROW')
    expect(bodyOf(calls[0])).not.toContain('OLD_ROW')
  })

  it('does not send a row twice once the collector accepted it', async () => {
    primeCursors()
    seedConfigChange()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    await tick()
    expect(logCalls(fetchSpy)).toHaveLength(1)
  })

  it('keeps the rows on a 401 (fixable), backs off, and sends them again once it works', async () => {
    primeCursors()
    seedConfigChange('KEPT_ROW')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 401 }))
    await tick()
    expect(logCalls(fetchSpy)).toHaveLength(1)
    const l = getOtelExporterStatus().logs
    expect(l.consecutiveFailures).toBe(1)
    expect(l.nextAttemptMs).toBeGreaterThan(Date.now())

    await tick() // inside the backoff window
    expect(logCalls(fetchSpy)).toHaveLength(1)

    vi.spyOn(Date, 'now').mockReturnValue(l.nextAttemptMs + 1)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const calls = logCalls(fetchSpy)
    expect(calls).toHaveLength(2)
    expect(bodyOf(calls[1])).toContain('KEPT_ROW')
    expect(getOtelExporterStatus().logs.consecutiveFailures).toBe(0)
  })

  it('discards a batch the collector refuses for good (400) so it cannot block the rows behind it', async () => {
    primeCursors()
    seedConfigChange('BAD_ROW')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }))
    await tick()
    const l = getOtelExporterStatus().logs
    expect(l.rejected).toBe(1)
    expect(l.consecutiveFailures).toBe(0)
    seedConfigChange('NEXT_ROW')
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const calls = logCalls(fetchSpy)
    expect(bodyOf(calls[calls.length - 1])).toContain('NEXT_ROW')
    expect(bodyOf(calls[calls.length - 1])).not.toContain('BAD_ROW')
  })

  it('counts a rejectedLogRecords partialSuccess and does not resend', async () => {
    primeCursors()
    seedConfigChange()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"bad"}}', { status: 200 }))
    await tick()
    expect(getOtelExporterStatus().logs.rejected).toBe(1)
    await tick()
    expect(logCalls(fetchSpy)).toHaveLength(1)
  })

  it('never throws when fetch rejects, and leaves the rows for the next attempt', async () => {
    primeCursors()
    seedConfigChange()
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connection refused'))
    await expect(tick()).resolves.toBeUndefined()
    expect(getOtelExporterStatus().logs.failures).toBe(1)
  })

  it('does not write to any audit table (read-only)', async () => {
    primeCursors()
    seedConfigChange()
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM config_change_log').get() as { n: number }
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM config_change_log').get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})
