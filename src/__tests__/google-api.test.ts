// Unit tests for src/google-api.ts: the Calendar API wrapper's token
// cache/refresh logic and the getCalendarEvents 401-retry path. 'node:https'
// is mocked with a minimal request/response double (queued per call so each
// test controls the exact exchange), 'node:fs' is mocked so no real
// tokens.json / oauth keys file is touched.
//
// The module keeps its token cache in module-level variables, so every test
// resets the module registry and re-imports getCalendarEvents fresh.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Exchange = { status: number; data: string } | { networkError: Error }

let pendingExchanges: Exchange[] = []
function queueJson(status: number, body: unknown) {
  pendingExchanges.push({ status, data: JSON.stringify(body) })
}
function queueNetworkError(err: Error) {
  pendingExchanges.push({ networkError: err })
}

const mockHttpsRequest = vi.fn((url: string, options: Record<string, unknown>, callback: (res: unknown) => void) => {
  const exchange = pendingExchanges.shift()
  if (!exchange) throw new Error(`no queued https exchange for ${url}`)
  const errorHandlers: ((err: Error) => void)[] = []
  const req = {
    on: (event: string, cb: (err: Error) => void) => {
      if (event === 'error') errorHandlers.push(cb)
      return req
    },
    setTimeout: () => req,
    write: () => {},
    end: () => {
      if ('networkError' in exchange) {
        errorHandlers.forEach(cb => cb(exchange.networkError))
        return
      }
      const dataHandlers: ((chunk: Buffer) => void)[] = []
      const endHandlers: (() => void)[] = []
      const res = {
        statusCode: exchange.status,
        on: (event: string, cb: unknown) => {
          if (event === 'data') dataHandlers.push(cb as (chunk: Buffer) => void)
          if (event === 'end') endHandlers.push(cb as () => void)
          return res
        },
      }
      callback(res)
      dataHandlers.forEach(cb => cb(Buffer.from(exchange.data)))
      endHandlers.forEach(cb => cb())
    },
  }
  requestLog.push({ url, options })
  return req
})

const requestLog: { url: string, options: Record<string, unknown> }[] = []

vi.mock('node:https', () => ({
  default: { request: (...a: [string, Record<string, unknown>, (res: unknown) => void]) => mockHttpsRequest(...a) },
}))

const mockStatSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
vi.mock('node:fs', () => ({
  readFileSync: (...a: [string]) => mockReadFileSync(...a),
  writeFileSync: (...a: [string, string]) => mockWriteFileSync(...a),
  statSync: (...a: [string]) => mockStatSync(...a),
}))

const mockLoggerError = vi.fn()
const mockLoggerInfo = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { error: (...a: unknown[]) => mockLoggerError(...a), info: (...a: unknown[]) => mockLoggerInfo(...a), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../tool-timeouts.js', () => ({ TOOL_TIMEOUTS: { 'google-calendar': 10_000 } }))

const CLIENT_CREDS = JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csecret', token_uri: 'https://oauth2.googleapis.com/token' } })

function tokensJson(expiryOffsetMs: number, extra: Partial<{ access_token: string, refresh_token: string }> = {}) {
  return JSON.stringify({
    normal: {
      access_token: extra.access_token ?? 'access-token-1',
      refresh_token: extra.refresh_token ?? 'refresh-1',
      expiry_date: Date.now() + expiryOffsetMs,
      token_type: 'Bearer',
      scope: 'calendar',
    },
  })
}

let getCalendarEvents: typeof import('../google-api.js')['getCalendarEvents']

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  pendingExchanges = []
  requestLog.length = 0
  mockStatSync.mockReturnValue({ mtimeMs: 1000 })
  mockReadFileSync.mockImplementation((path: string) => {
    if (path.includes('tokens.json')) return tokensJson(3_600_000) // valid for an hour by default
    if (path.includes('gcp-oauth.keys.json')) return CLIENT_CREDS
    throw new Error(`unexpected readFileSync path: ${path}`)
  })
  const mod = await import('../google-api.js')
  getCalendarEvents = mod.getCalendarEvents
})

describe('getCalendarEvents', () => {
  it('uses the cached access token directly when it is not near expiry', async () => {
    queueJson(200, { items: [{ id: 'e1', summary: 'Standup' }] })

    const events = await getCalendarEvents('primary', new Date(), new Date())

    expect(events).toEqual([{ id: 'e1', summary: 'Standup' }])
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1) // no refresh call needed
    expect(requestLog[0].options).toMatchObject({ headers: { Authorization: 'Bearer access-token-1' } })
  })

  it('refreshes the token when it is within the 5-minute expiry window, then uses the new token', async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('tokens.json')) return tokensJson(60_000) // 1 min left, inside the 5-min guard
      return CLIENT_CREDS
    })
    queueJson(200, { access_token: 'fresh-token', expires_in: 3600 }) // refresh POST
    queueJson(200, { items: [{ id: 'e2' }] }) // GET with the fresh token

    const events = await getCalendarEvents('primary', new Date(), new Date())

    expect(events).toEqual([{ id: 'e2' }])
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2)
    expect(requestLog[1].options).toMatchObject({ headers: { Authorization: 'Bearer fresh-token' } })
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1) // saveTokens persisted the refreshed token
  })

  it('retries once with a refreshed token when the GET responds 401 mid-flight', async () => {
    queueJson(401, {}) // first GET: token invalidated server-side
    queueJson(200, { access_token: 'fresh-token-2', expires_in: 3600 }) // refresh
    queueJson(200, { items: [{ id: 'e3' }] }) // retried GET

    const events = await getCalendarEvents('primary', new Date(), new Date())

    expect(events).toEqual([{ id: 'e3' }])
    expect(mockHttpsRequest).toHaveBeenCalledTimes(3)
    expect(requestLog[2].options).toMatchObject({ headers: { Authorization: 'Bearer fresh-token-2' } })
  })

  it('gives up and returns an empty list when the retry after a 401 also fails', async () => {
    queueJson(401, {})
    queueJson(200, { access_token: 'fresh-token-3', expires_in: 3600 })
    queueJson(500, { error: 'still broken' })

    const events = await getCalendarEvents('primary', new Date(), new Date())

    expect(events).toEqual([])
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }), expect.stringContaining('after refresh'))
  })

  it('returns an empty list and logs on a non-401 non-200 response', async () => {
    queueJson(503, { error: 'unavailable' })

    const events = await getCalendarEvents('primary', new Date(), new Date())

    expect(events).toEqual([])
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1)
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }), 'Google Calendar API error')
  })

  it('returns an empty list when the events payload has no items field', async () => {
    queueJson(200, {})

    const events = await getCalendarEvents('primary', new Date(), new Date())

    expect(events).toEqual([])
  })

  it('propagates a rejection when the token refresh endpoint itself fails', async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('tokens.json')) return tokensJson(60_000)
      return CLIENT_CREDS
    })
    queueJson(400, { error: 'invalid_grant' })

    await expect(getCalendarEvents('primary', new Date(), new Date())).rejects.toThrow('Token refresh failed: 400')
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }), 'Google token refresh failed')
  })

  it('caches the parsed tokens file across calls and only re-reads it when the file mtime changes', async () => {
    queueJson(200, { items: [] })
    queueJson(200, { items: [] })
    queueJson(200, { items: [] })

    await getCalendarEvents('primary', new Date(), new Date())
    const tokenReadsAfterFirst = mockReadFileSync.mock.calls.filter(c => (c[0] as string).includes('tokens.json')).length
    expect(tokenReadsAfterFirst).toBe(1)

    await getCalendarEvents('primary', new Date(), new Date()) // same mtime -> cache hit, no re-read
    const tokenReadsAfterSecond = mockReadFileSync.mock.calls.filter(c => (c[0] as string).includes('tokens.json')).length
    expect(tokenReadsAfterSecond).toBe(1)

    mockStatSync.mockReturnValue({ mtimeMs: 2000 }) // simulate an out-of-process re-auth
    await getCalendarEvents('primary', new Date(), new Date())
    const tokenReadsAfterThird = mockReadFileSync.mock.calls.filter(c => (c[0] as string).includes('tokens.json')).length
    expect(tokenReadsAfterThird).toBe(2)
  })
})
