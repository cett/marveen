// The logger masking for THIS installation's secret forms (the upstream cases live in logger-token-redact.test.ts):
// device key, agent / dashboard / session / enrol tokens by name, bot and API keys, vault references, the OTLP capture
// still seeing the call, and a bound on the time a hostile string can cost. Neutral fixtures only: every secret below is
// a made-up string of the right SHAPE, none is a real credential.

import { describe, it, expect, vi } from 'vitest'
import { Writable } from 'node:stream'

const captured: Array<{ level: number; args: unknown[] }> = []
vi.mock('../otel-app-logs.js', () => ({
  captureLogCall: (level: number, args: unknown[]) => { captured.push({ level, args }) },
}))

const { createLogger, redactLogMessage, redactObject, SECRET_NAMES, REDACTED } = await import('../logger.js')

function capture() {
  const lines: string[] = []
  const dest = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb() } })
  return { logger: createLogger(dest), lines }
}

const HEX64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const B64URL43 = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
const DEVICE_KEY = `mvdk_${B64URL43}`
const TELEGRAM = '123456789:A' + 'b1'.repeat(17) // 35 characters after the colon, as a real bot token has
const OPENAI = 'sk-proj-' + 'A1b2C3d4'.repeat(6)
const GOOGLE = 'AIza' + 'SyFixtureFixtureFixtureFixtureFix12'
const SLACK = ['xoxb', '1234567890', '0987654321', 'FixtureFixture'].join('-') // assembled: the source holds no token shape

describe('shapes of this installation', () => {
  it.each([
    ['device key', `key ${DEVICE_KEY} used`, DEVICE_KEY],
    ['telegram bot token in a URL', `POST https://api.telegram.org/bot${TELEGRAM}/setMyCommands`, TELEGRAM],
    ['OpenAI key', `OPENAI ${OPENAI} sent`, OPENAI],
    ['Google API key in a query', `GET https://example.invalid/v1?key=${GOOGLE}&alt=json`, GOOGLE],
    ['Slack bot token', `slack ${SLACK} ok`, SLACK],
  ])('masks a %s', (_label, line, secret) => {
    const out = redactLogMessage(line)
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTED)
  })

  it('masks a vault reference but keeps the prefix readable', () => {
    expect(redactLogMessage('ref vault:s1 resolved')).toBe(`ref vault:${REDACTED} resolved`)
    expect(redactLogMessage('ref vault:abc-123_x here')).not.toContain('abc-123_x')
  })

  it('leaves look-alike prose untouched', () => {
    for (const text of ['sk-learn is a package', 'the vault: is closed', 'vault:', 'mvdk is a prefix', 'AIza is short',
      'xoxo hugs', 'a ratio of 12:34 today', 'Bearer token']) {
      expect(redactLogMessage(text)).toBe(text)
    }
  })

  it('does not mask a bare 64-hex string (indistinguishable from a SHA-256): documented limit', () => {
    expect(redactLogMessage(`content sha256 ${HEX64}`)).toContain(HEX64)
  })
})

describe('names of this installation', () => {
  it.each(SECRET_NAMES.filter((n) => n.endsWith('token') || n.includes('_key') || n.endsWith('code')))(
    'masks %s=value in text and by field name', (name) => {
      expect(redactLogMessage(`${name}=${HEX64} x`)).toBe(`${name}=${REDACTED} x`)
      expect(redactLogMessage(`${name.toUpperCase()}=${HEX64}`)).toBe(`${name.toUpperCase()}=${REDACTED}`)
      expect((redactObject({ [name]: HEX64 }) as Record<string, string>)[name]).toBe(REDACTED)
    })

  it('masks the camelCase and dashed spellings of a field name', () => {
    const out = redactObject({ agentToken: HEX64, 'device-key': DEVICE_KEY, enrollCode: B64URL43, slackBotToken: SLACK }) as Record<string, string>
    expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED])
  })

  it('does not touch names that only look similar', () => {
    for (const text of ['max_tokens=4096', 'next_page_token=abc', 'tokenizer=gpt', 'token_count=5', 'codes=7', 'secretary=ann']) {
      expect(redactLogMessage(text)).toBe(text)
    }
  })

  it('SECRET_NAMES stays [a-z0-9_] only (it goes into a regex unescaped) and has no duplicates', () => {
    for (const n of SECRET_NAMES) expect(n).toMatch(/^[a-z0-9_]+$/)
    expect(new Set(SECRET_NAMES).size).toBe(SECRET_NAMES.length)
  })
})

describe('end to end through the shipped logger', () => {
  it('masks a fleet token logged in the message, in an object, in a child binding and in an Error', () => {
    const { logger, lines } = capture()
    logger.info(`calling with agent_token=${HEX64}`)
    logger.info({ agent_token: HEX64, nested: { note: `Bearer ${HEX64}` } }, 'object form')
    logger.child({ session_token: B64URL43, who: 'agent-a' }).info('child binding')
    logger.error(new Error(`failed with device_key=${DEVICE_KEY} and ${TELEGRAM}`), 'boom')
    const all = lines.join('')
    for (const secret of [HEX64, B64URL43, DEVICE_KEY, TELEGRAM]) expect(all).not.toContain(secret)
    expect(all).toContain('agent-a')
  })

  it('a %s argument that is a secret is masked after the placeholder is filled', () => {
    const { logger, lines } = capture()
    logger.info('connect vault:%s and api_key=%s', 'ref-one', 'secret-value-fixture')
    const all = lines.join('')
    expect(all).not.toContain('ref-one')
    expect(all).not.toContain('secret-value-fixture')
  })
})

describe('the OTLP capture still sees every call', () => {
  it('gets the original arguments, once per call, at the right level', () => {
    captured.length = 0
    const { logger } = capture()
    logger.warn({ k: 1 }, 'warn template %s', 'x')
    logger.error('plain error')
    expect(captured.map((c) => c.level)).toEqual([40, 50])
    expect(captured[0]!.args).toEqual([{ k: 1 }, 'warn template %s', 'x'])
  })
})

describe('cost of a hostile string', () => {
  // A generous bound: it is there to catch a catastrophic-backtracking regex, not to benchmark.
  const budgetMs = 1500
  const hostile: Array<[string, string]> = [
    ['long token alphabet', 'A'.repeat(200_000)],
    ['Bearer then a long run', 'Bearer ' + 'a-'.repeat(100_000)],
    ['many names without values', 'token='.repeat(30_000)],
    ['digits and colons', '1234567890:'.repeat(20_000)],
    ['a long JSON-ish run', '{"token":"' + 'a\\"'.repeat(60_000)],
    ['sk- prefix repeated', 'sk-'.repeat(60_000)],
    ['vault prefix repeated', 'vault:'.repeat(60_000)],
    ['eyJ repeated', 'eyJ'.repeat(60_000)],
  ]
  it.each(hostile)('%s', (_label, text) => {
    const t0 = performance.now()
    redactLogMessage(text)
    expect(performance.now() - t0).toBeLessThan(budgetMs)
  })

  it('a 10-level nested object with a wide array stays quick and masks the leaf', () => {
    let o: Record<string, unknown> = { token: HEX64, list: Array.from({ length: 5000 }, (_, i) => `item ${i}`) }
    for (let i = 0; i < 8; i++) o = { child: o }
    const t0 = performance.now()
    const out = JSON.stringify(redactObject(o))
    expect(performance.now() - t0).toBeLessThan(budgetMs)
    expect(out).not.toContain(HEX64)
  })
})
