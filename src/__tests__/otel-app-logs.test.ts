// OTel H6b: the application log export. What a captured line may carry (src/otel-app-logs.ts), the mapping
// (src/otel-logs.ts appLogsToRecords), the real pino logger's hook, and the exporter leg.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initDatabase } from '../db.js'

vi.mock('../logger.js', async (importOriginal) => importOriginal()) // the real logger: its hook is under test

const cfg: Record<string, string> = {
  OTEL_EXPORT_ENABLED: '1',
  OTEL_EXPORT_LOGS: '0',
  OTEL_EXPORT_APP_LOGS: '0',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.local:4318',
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

const app = await import('../otel-app-logs.js')
const { appLogsToRecords } = await import('../otel-logs.js')
const { scrubLogText } = await import('../otel-scrub.js')
const { logger, appLogHooks } = await import('../logger.js')
const pino = (await import('pino')).default
const { tick, resetOtelExporterStatus, getOtelExporterStatus } = await import('../web/otel-push-exporter.js')
const { collectRegistryMetrics, resetMetricValues } = await import('../otel-metrics.js')

beforeAll(() => initDatabase(':memory:'))
beforeEach(() => {
  app.resetAppLogs()
  resetOtelExporterStatus()
  resetMetricValues()
  cfg.OTEL_EXPORT_APP_LOGS = '0'
  cfg.OTEL_EXPORT_LOGS = '0'
  vi.restoreAllMocks()
})

const WARN = 40, ERROR = 50, FATAL = 60, INFO = 30

describe('captureLogCall', () => {
  it('notes warn, error and fatal and nothing below', () => {
    app.captureLogCall(INFO, ['fine'])
    app.captureLogCall(20, ['debug'])
    app.captureLogCall(WARN, ['careful'])
    app.captureLogCall(ERROR, ['broken'])
    app.captureLogCall(FATAL, ['dead'])
    expect(app.takeAppLogs(10).map((r) => [r.level, r.message])).toEqual([[WARN, 'careful'], [ERROR, 'broken'], [FATAL, 'dead']])
  })

  it('keeps the message TEMPLATE: pino format arguments and the bindings are never read', () => {
    app.captureLogCall(WARN, [{ agent: 'agent-secret-name', path: '/very/private/place/file', card: 'Quarterly layoffs plan' }, 'could not load %s for %s', 'Quarterly layoffs plan', 'agent-secret-name'])
    const [r] = app.takeAppLogs(10)
    expect(r.message).toBe('could not load %s for %s')
    expect(JSON.stringify(r)).not.toMatch(/secret-name|private|layoffs/)
  })

  it('scrubs what is recognisable in a message that has a value built in', () => {
    const cases: Array<[string, RegExp]> = [
      ['login failed for john.doe@example.invalid', /john\.doe|example\.invalid/],
      ['read /home/someone/work/project/file.txt failed', /someone|project|file\.txt/],
      ['bad token=abcdef123456 in request', /abcdef123456/],
      ['Authorization: Bearer abcdefghijklmnop failed', /abcdefghijklmnop/],
      ['card 5f3b9c1e2a4d6f8091a2b3c4d5e6f708 gone', /5f3b9c1e2a4d6f8091a2b3c4d5e6f708/],
      ['card f47ac10b-58cc-4372-a567-0e02b2c3d479 gone', /f47ac10b/],
      ['connect postgres://user:hunter2@db.invalid/x failed', /hunter2/],
    ]
    for (const [msg, leak] of cases) {
      app.captureLogCall(ERROR, [msg])
      const [r] = app.takeAppLogs(1)
      expect(r.message, msg).not.toMatch(leak)
    }
  })

  it('cuts the message at 160 characters, after the scrub', () => {
    app.captureLogCall(WARN, ['x'.repeat(1000)])
    expect(app.takeAppLogs(1)[0].message).toHaveLength(app.MAX_MESSAGE_CHARS)
    const secretAtTheCut = 'a '.repeat(77) + 'password=' + 'S'.repeat(40)
    app.captureLogCall(WARN, [secretAtTheCut])
    expect(app.takeAppLogs(1)[0].message).not.toContain('SSSS')
  })

  it('takes an error class and a string code from err / error, never the message or the stack', () => {
    const err = Object.assign(new TypeError('failed for john@example.invalid at /home/x/y/z'), { code: 'ECONNREFUSED' })
    app.captureLogCall(ERROR, [{ err }, 'request failed'])
    app.captureLogCall(ERROR, [{ error: new RangeError('boom') }, 'other failed'])
    const [a, b] = app.takeAppLogs(2)
    expect([a.exceptionType, a.errorCode, b.exceptionType, b.errorCode]).toEqual(['TypeError', 'ECONNREFUSED', 'RangeError', null])
    expect(JSON.stringify([a, b])).not.toMatch(/john|example\.invalid|Users/)
  })

  it('bounds an error class or code that is not an identifier', () => {
    class Weird extends Error { constructor() { super('x'); this.name = 'has spaces & /paths/here' } }
    app.captureLogCall(ERROR, [{ err: Object.assign(new Weird(), { code: 'a b c' }) }, 'm'])
    const [r] = app.takeAppLogs(1)
    expect([r.exceptionType, r.errorCode]).toEqual(['_other', '_other'])
  })

  it('handles an Error as the first argument and a missing message', () => {
    app.captureLogCall(ERROR, [new TypeError('whatever it says')])
    app.captureLogCall(ERROR, [{ x: 1 }])
    const out = app.takeAppLogs(5)
    expect(out).toHaveLength(1) // the second has neither a template nor an error: nothing to say
    expect(out[0].exceptionType).toBe('TypeError')
    expect(out[0].message).toBe('error')
  })

  it('folds identical lines into one record with a count', () => {
    for (let i = 0; i < 7; i++) app.captureLogCall(WARN, ['same thing'])
    app.captureLogCall(ERROR, ['same thing'])
    const out = app.takeAppLogs(10)
    expect(out.map((r) => [r.level, r.count])).toEqual([[WARN, 7], [ERROR, 1]])
  })

  it('holds MAX_BUFFER distinct lines, drops the oldest beyond that and counts the drops', () => {
    for (let i = 0; i < app.MAX_BUFFER + 25; i++) app.captureLogCall(WARN, [`line ${i} x`])
    expect(app.pendingAppLogCount()).toBe(app.MAX_BUFFER)
    expect(app.getAppLogDropped().overflow).toBe(25)
    expect(app.takeAppLogs(1)[0].message).toBe('line 25 x')
  })

  it('leaves out the exporter\'s own lines, so an unreachable collector cannot feed itself', () => {
    app.captureLogCall(WARN, [{ url: 'x' }, 'otel-push-exporter: export failed, will retry'])
    app.captureLogCall(WARN, ['otel-app-logs: anything'])
    expect(app.pendingAppLogCount()).toBe(0)
  })

  it('never throws, whatever it is given', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    for (const args of [[], [null], [undefined, undefined], [circular], [Symbol('s')], [{ get err() { throw new Error('getter') } }, 'm'], [42, 43], ['%s', circular]]) {
      expect(() => app.captureLogCall(WARN, args as unknown[])).not.toThrow()
    }
    expect(() => app.captureLogCall(Number.NaN, ['x'])).not.toThrow()
  })

  it('take hands records over once; restore merges them back with what came in meanwhile', () => {
    app.captureLogCall(WARN, ['a'])
    app.captureLogCall(WARN, ['a'])
    const taken = app.takeAppLogs(10)
    expect(app.takeAppLogs(10)).toEqual([])
    app.captureLogCall(WARN, ['a'])
    app.restoreAppLogs(taken)
    const [r] = app.takeAppLogs(10)
    expect(r.count).toBe(3)
  })
})

describe('the real logger', () => {
  it('feeds the capture from warn and error calls and not from info, and still writes its own line', () => {
    const before = app.pendingAppLogCount()
    logger.info('only informational')
    logger.warn({ agent: 'agent-secret-name' }, 'a warning with a binding')
    logger.error({ err: new Error('inner text') }, 'an error line')
    const out = app.takeAppLogs(10)
    expect(before).toBe(0)
    expect(out.map((r) => r.message)).toEqual(['a warning with a binding', 'an error line'])
    expect(JSON.stringify(out)).not.toMatch(/secret-name|inner text/)
    expect(out[1].exceptionType).toBe('Error')
  })

  it('does not change the line pino writes: the same output with and without the hook', () => {
    const lines = (hooks: unknown) => {
      const out: string[] = []
      const l = pino({ level: 'info', base: null, timestamp: false, hooks: hooks as never }, { write: (s: string) => { out.push(s) } })
      l.info({ a: 1 }, 'info %s', 'x')
      l.warn({ err: new Error('inner') }, 'warn line')
      l.error('plain error')
      return out.map((x) => x.replace(/"stack":"[^"]*"/, '"stack":"-"'))
    }
    const plain = lines({})
    app.resetAppLogs()
    const hooked = lines(appLogHooks)
    expect(plain).toHaveLength(3)
    expect(hooked).toEqual(plain)
    expect(app.takeAppLogs(10).map((r) => r.message)).toEqual(['warn line', 'plain error'])
  })

  it('a child logger is captured too', () => {
    logger.child({ module: 'x' }).warn('from a child')
    expect(app.takeAppLogs(10).map((r) => r.message)).toEqual(['from a child'])
  })
})

describe('appLogsToRecords', () => {
  it('maps level to the OTLP severity, carries the count and the bounded error fields, and nothing else', () => {
    const recs = appLogsToRecords([
      { level: WARN, message: 'w', exceptionType: null, errorCode: null, firstMs: 1_700_000_000_123, count: 1 },
      { level: ERROR, message: 'e', exceptionType: 'TypeError', errorCode: 'ECONNREFUSED', firstMs: 1_700_000_000_456, count: 4 },
      { level: FATAL, message: '', exceptionType: 'Error', errorCode: null, firstMs: 1, count: 1 },
    ], 1_800_000_000_000)
    expect(recs.map((r) => [r.severityNumber, r.severityText])).toEqual([[13, 'WARN'], [17, 'ERROR'], [21, 'FATAL']])
    expect(recs[0].timeUnixNano).toBe('1700000000123000000')
    expect(recs[1].body.stringValue).toBe('e')
    expect(recs[2].body.stringValue).toBe('Error')
    const attrs = (r: any) => Object.fromEntries(r.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]))
    expect(attrs(recs[0])).toEqual({ 'event.name': 'marveen.app.log' })
    expect(attrs(recs[1])).toEqual({ 'event.name': 'marveen.app.log', 'exception.type': 'TypeError', 'marveen.log.error_code': 'ECONNREFUSED', 'marveen.log.count': '4' })
  })
})

describe('scrubLogText', () => {
  it('keeps ordinary text, including short paths and words, readable', () => {
    expect(scrubLogText('schedule runner started (15 s tick)', 160)).toBe('schedule runner started (15 s tick)')
    expect(scrubLogText('GET /api/x failed', 160)).toBe('GET /api/x failed')
  })
})

describe('through tick', () => {
  const callsTo = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith('/v1/logs'))
  const bodyOf = (c: unknown[]) => String((c[1] as { body: string }).body)

  it('sends nothing while OTEL_EXPORT_APP_LOGS is off, then the captured lines once it is on', async () => {
    app.captureLogCall(WARN, ['something to report'])
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect(callsTo(spy)).toHaveLength(0)
    cfg.OTEL_EXPORT_APP_LOGS = '1'
    await tick()
    expect(callsTo(spy)).toHaveLength(1)
    const payload = JSON.parse(bodyOf(callsTo(spy)[0]))
    expect(payload.resourceLogs[0].scopeLogs[0].scope.name).toBe('marveen.app')
    expect(bodyOf(callsTo(spy)[0])).toContain('something to report')
    await tick()
    expect(callsTo(spy)).toHaveLength(1) // sent once
  })

  it('puts the lines back when the collector fails and sends them on the next try', async () => {
    cfg.OTEL_EXPORT_APP_LOGS = '1'
    app.captureLogCall(WARN, ['keep me'])
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 503 }))
    await tick()
    expect(callsTo(spy)).toHaveLength(1)
    // the exporter's own failure line did not feed the buffer
    expect(app.pendingAppLogCount()).toBe(1)
    const l = getOtelExporterStatus().logs
    expect(l.consecutiveFailures).toBe(1)
    vi.spyOn(Date, 'now').mockReturnValue(l.nextAttemptMs + 1)
    spy.mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect(bodyOf(callsTo(spy)[1])).toContain('keep me')
    expect(app.pendingAppLogCount()).toBe(0)
  })

  it('drops lines the collector refuses for good', async () => {
    cfg.OTEL_EXPORT_APP_LOGS = '1'
    app.captureLogCall(WARN, ['refused'])
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }))
    await tick()
    expect(app.pendingAppLogCount()).toBe(0)
    expect(getOtelExporterStatus().logs.rejected).toBe(1)
  })

  it('reports the lines it had to drop as marveen.log.dropped', () => {
    for (let i = 0; i < app.MAX_BUFFER + 3; i++) app.captureLogCall(WARN, [`distinct ${i} y`])
    const m = collectRegistryMetrics().find((x) => x.name === 'marveen.log.dropped')!
    expect((m.sum!.dataPoints as any[])[0].asInt).toBe('3')
  })
})
