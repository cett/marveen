import { describe, it, expect } from 'vitest'
import {
  parseOtlpHeaders, checkEndpoint, isPrivateHost, isPermanentStatus, parsePartialSuccess,
  backoffDelayMs, parseRetryAfterMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
} from '../otel-transport.js'

describe('parseOtlpHeaders', () => {
  it('parses name=value pairs and percent-decodes the value', () => {
    const { headers, rejected } = parseOtlpHeaders('Authorization=Bearer%20abc, X-Org = org%2C1')
    expect(headers).toEqual({ Authorization: 'Bearer abc', 'X-Org': 'org,1' })
    expect(rejected).toEqual([])
  })

  it('keeps an = inside the value', () => {
    expect(parseOtlpHeaders('Authorization=Basic%20YWJj==').headers).toEqual({ Authorization: 'Basic YWJj==' })
  })

  it('skips an unusable pair and reports the NAME only, never the value', () => {
    const { headers, rejected } = parseOtlpHeaders('good=1,noequals,bad name=secret-value,x=%ZZ')
    expect(headers).toEqual({ good: '1' })
    expect(rejected).toEqual(['(missing =)', '(unreadable)', 'x'])
    expect(JSON.stringify(rejected)).not.toContain('secret-value')
    expect(JSON.stringify(rejected)).not.toContain('noequals')
  })

  it('refuses the headers the exporter owns', () => {
    const { headers, rejected } = parseOtlpHeaders('Content-Type=text/plain,host=evil,Content-Length=1,ok=1')
    expect(headers).toEqual({ ok: '1' })
    expect(rejected).toEqual(['Content-Type', 'host', 'Content-Length'])
  })

  it('refuses a value that decodes to a line break (header injection)', () => {
    const { headers, rejected } = parseOtlpHeaders('x=a%0D%0Ainjected:1')
    expect(headers).toEqual({})
    expect(rejected).toEqual(['x'])
  })

  it('an empty string is no headers', () => {
    expect(parseOtlpHeaders('')).toEqual({ headers: {}, rejected: [] })
  })
})

describe('isPrivateHost', () => {
  it.each([
    'localhost', 'a.localhost', 'collector.local', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1',
    '192.168.50.190', '169.254.1.1', '::1', '[::1]', 'fd12::1', 'fe80::1', 'collector',
  ])('%s is private', (host) => expect(isPrivateHost(host)).toBe(true))

  it.each(['example.com', 'otel.example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:db8::1'])(
    '%s is not private', (host) => expect(isPrivateHost(host)).toBe(false))
})

describe('checkEndpoint', () => {
  it('accepts http and https and strips trailing slashes', () => {
    expect(checkEndpoint('http://localhost:4318/', false)).toEqual({ ok: true, base: 'http://localhost:4318' })
    expect(checkEndpoint('https://otel.example.com//', true)).toEqual({ ok: true, base: 'https://otel.example.com' })
  })

  it('refuses an unparseable URL and any other scheme', () => {
    expect(checkEndpoint('not a url', false).ok).toBe(false)
    expect(checkEndpoint('grpc://collector:4317', false).ok).toBe(false)
    expect(checkEndpoint('file:///etc/passwd', false).ok).toBe(false)
  })

  it('refuses credentials in the URL', () => {
    const r = checkEndpoint('https://user:pw@otel.example.com', false)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('pw@')
  })

  it('sends headers over https, and over plain http only inside a private network', () => {
    expect(checkEndpoint('https://otel.example.com', true).ok).toBe(true)
    expect(checkEndpoint('http://192.168.50.190:4318', true).ok).toBe(true)
    const open = checkEndpoint('http://otel.example.com:4318', true)
    expect(open.ok).toBe(false)
    // no headers: plain http to a public host is the operator's call, as before
    expect(checkEndpoint('http://otel.example.com:4318', false).ok).toBe(true)
  })
})

describe('statuses and partialSuccess', () => {
  it('only the "payload is wrong" statuses are permanent', () => {
    for (const s of [400, 413, 415, 422]) expect(isPermanentStatus(s)).toBe(true)
    for (const s of [401, 403, 404, 408, 429, 500, 502, 503, 504]) expect(isPermanentStatus(s)).toBe(false)
  })

  it('reads rejectedSpans and rejectedDataPoints (string or number) with the message', () => {
    expect(parsePartialSuccess('{"partialSuccess":{"rejectedSpans":"3","errorMessage":"bad ids"}}'))
      .toEqual({ rejected: 3, message: 'bad ids' })
    expect(parsePartialSuccess('{"partialSuccess":{"rejectedDataPoints":2}}')).toEqual({ rejected: 2, message: '' })
  })

  it('treats nothing rejected, an empty body and junk as no partial success', () => {
    expect(parsePartialSuccess('{}')).toBeNull()
    expect(parsePartialSuccess('{"partialSuccess":{}}')).toBeNull()
    expect(parsePartialSuccess('{"partialSuccess":{"rejectedSpans":"0"}}')).toBeNull()
    expect(parsePartialSuccess('')).toBeNull()
    expect(parsePartialSuccess('<html>')).toBeNull()
  })
})

describe('backoff', () => {
  it('doubles from 30 s and caps at 10 min', () => {
    const mid = () => 0.5 // jitter factor 1.0
    expect(backoffDelayMs(1, mid)).toBe(BACKOFF_BASE_MS)
    expect(backoffDelayMs(2, mid)).toBe(BACKOFF_BASE_MS * 2)
    expect(backoffDelayMs(3, mid)).toBe(BACKOFF_BASE_MS * 4)
    expect(backoffDelayMs(50, mid)).toBe(BACKOFF_MAX_MS)
  })

  it('jitters by at most 20 percent either way', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(BACKOFF_BASE_MS * 0.8)
    expect(backoffDelayMs(1, () => 0.999999)).toBeLessThanOrEqual(BACKOFF_BASE_MS * 1.2)
  })

  it('reads Retry-After as seconds or a date, ignores junk, caps at an hour', () => {
    const now = 1_000_000
    expect(parseRetryAfterMs('30', now)).toBe(30_000)
    expect(parseRetryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBeGreaterThan(80_000)
    expect(parseRetryAfterMs('soon', now)).toBeUndefined()
    expect(parseRetryAfterMs(null, now)).toBeUndefined()
    expect(parseRetryAfterMs('999999', now)).toBe(60 * 60_000)
  })
})
