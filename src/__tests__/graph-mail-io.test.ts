// Test suite for graph-mail.ts's I/O-dependent surface (coverage series).
// graph-mail.test.ts already covers parseCredentials (the pure KEY=value
// parser); this file covers everything built on top of it: the credentials
// file cache (mtime invalidation), the OAuth client-credentials token cache
// (expiry + clientId-rotation invalidation), and the three Graph calls
// (listMessages, sendMail, verifyAccess) including their error paths.
//
// node:fs is mocked so no real file is touched, and global fetch is stubbed
// (mirroring channel-request-watcher.test.ts's vi.stubGlobal pattern) so no
// real network call is made. Each test resets modules and re-imports
// graph-mail.js fresh, because loadCredentials'/getToken's caches are
// module-level state (cachedCreds / cachedToken) that would otherwise leak
// between tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockStatSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockLoggerInfo = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  statSync: mockStatSync,
  readFileSync: mockReadFileSync,
}))

vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), debug: vi.fn() },
}))

const VALID_CREDS_TEXT = [
  'TENANT_ID=ten1',
  'CLIENT_ID=cli1',
  'CLIENT_SECRET=sec1',
  'MAILBOX=mbox@example.com',
].join('\n')

function armCredsFile(mtimeMs = 1000, text = VALID_CREDS_TEXT): void {
  mockStatSync.mockReturnValue({ mtimeMs })
  mockReadFileSync.mockReturnValue(text)
}

function tokenResponse(accessToken: string, expiresInSec = 3600): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ access_token: accessToken, expires_in: expiresInSec }),
  } as Response
}

function jsonResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response
}

let mockFetch: ReturnType<typeof vi.fn>

async function loadGraphMail() {
  const mod = await import('../graph-mail.js')
  return mod
}

beforeEach(() => {
  vi.resetModules()
  mockStatSync.mockReset()
  mockReadFileSync.mockReset()
  mockLoggerInfo.mockReset()
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
  armCredsFile()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('graph-mail: credentials file cache', () => {
  it('throws a clear error when the credentials file is missing', async () => {
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
    const { listMessages } = await loadGraphMail()
    await expect(listMessages()).rejects.toThrow(/credentials file not found/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('does not re-read the file on a second call within the same mtime', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages()
    await listMessages()
    expect(mockReadFileSync).toHaveBeenCalledTimes(1)
  })

  it('re-reads the file once the mtime advances (out-of-process credential rotation)', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages()
    armCredsFile(2000) // mtime advanced -> rotated secret on disk
    await listMessages()
    expect(mockReadFileSync).toHaveBeenCalledTimes(2)
  })
})

describe('graph-mail: token cache', () => {
  it('reuses the cached token across calls while it has not neared expiry', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse('tok-1', 3600))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages()
    await listMessages()
    const tokenCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/oauth2/'))
    expect(tokenCalls).toHaveLength(1)
  })

  it('refreshes the token once it is within 60s of expiry', async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(tokenResponse('tok-1', 90)) // expires in 90s
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
      .mockResolvedValueOnce(tokenResponse('tok-2', 3600))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages()
    await vi.advanceTimersByTimeAsync(35_000) // 90s - 35s = 55s left, inside the 60s refresh window
    await listMessages()
    const tokenCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/oauth2/'))
    expect(tokenCalls).toHaveLength(2)
    vi.useRealTimers()
  })

  it('invalidates the cached token when the credentials clientId changes', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse('tok-1', 3600))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
      .mockResolvedValueOnce(tokenResponse('tok-2', 3600))
      .mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages()
    armCredsFile(2000, VALID_CREDS_TEXT.replace('CLIENT_ID=cli1', 'CLIENT_ID=cli2'))
    await listMessages()
    const tokenCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/oauth2/'))
    expect(tokenCalls).toHaveLength(2)
  })

  it('throws with the status and short error code on a failed token request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_client' }))
    const { listMessages } = await loadGraphMail()
    await expect(listMessages()).rejects.toThrow(/token request failed \(400 invalid_client\)/)
  })

  it('falls back to "unknown" when a failed token response body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'gateway timeout' } as Response)
    const { listMessages } = await loadGraphMail()
    await expect(listMessages()).rejects.toThrow(/token request failed \(500 unknown\)/)
  })
})

describe('graph-mail: listMessages', () => {
  it('defaults to top=10 from the inbox with no unread filter', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: '1' }] }))
    const { listMessages } = await loadGraphMail()
    const result = await listMessages()
    expect(result).toEqual([{ id: '1' }])
    const [url] = mockFetch.mock.calls[1]
    expect(String(url)).toContain('/mailFolders/inbox/messages')
    expect(String(url)).toContain('%24top=10')
    expect(String(url)).not.toContain('%24filter')
  })

  it('clamps top above 50 down to 50', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages({ top: 500 })
    const [url] = mockFetch.mock.calls[1]
    expect(String(url)).toContain('%24top=50')
  })

  it('clamps top below 1 up to 1', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages({ top: 0 })
    const [url] = mockFetch.mock.calls[1]
    expect(String(url)).toContain('%24top=1')
  })

  it('uses the requested folder and sets the unread filter', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, { value: [] }))
    const { listMessages } = await loadGraphMail()
    await listMessages({ folder: 'sentitems', unreadOnly: true })
    const [url] = mockFetch.mock.calls[1]
    expect(String(url)).toContain('/mailFolders/sentitems/messages')
    expect(String(url)).toContain('isRead+eq+false')
  })

  it('returns an empty array when the response has no value field', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, {}))
    const { listMessages } = await loadGraphMail()
    await expect(listMessages()).resolves.toEqual([])
  })

  it('throws on a non-ok response, including the response body', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden' }))
    const { listMessages } = await loadGraphMail()
    await expect(listMessages()).rejects.toThrow(/listMessages failed \(403/)
  })
})

describe('graph-mail: sendMail', () => {
  it('sends with default contentType Text and saveToSentItems true, wrapping a single "to" string', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, {}))
    const { sendMail } = await loadGraphMail()
    await sendMail({ to: 'a@b.com', subject: 'hi', body: 'hello' })
    const [url, init] = mockFetch.mock.calls[1]
    expect(String(url)).toContain('/sendMail')
    const payload = JSON.parse(init.body as string)
    expect(payload.message.body).toEqual({ contentType: 'Text', content: 'hello' })
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: 'a@b.com' } }])
    expect(payload.message.ccRecipients).toBeUndefined()
    expect(payload.saveToSentItems).toBe(true)
    expect(mockLoggerInfo).toHaveBeenCalledWith({ to: 'a@b.com', subject: 'hi' }, 'graph-mail: sent')
  })

  it('includes ccRecipients only when cc is given, trims and drops blank addresses', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, {}))
    const { sendMail } = await loadGraphMail()
    await sendMail({
      to: [' a@b.com ', '', 'c@d.com'],
      cc: 'e@f.com',
      subject: 'hi',
      body: 'hello',
      contentType: 'HTML',
      saveToSentItems: false,
    })
    const [, init] = mockFetch.mock.calls[1]
    const payload = JSON.parse(init.body as string)
    expect(payload.message.toRecipients).toEqual([
      { emailAddress: { address: 'a@b.com' } },
      { emailAddress: { address: 'c@d.com' } },
    ])
    expect(payload.message.ccRecipients).toEqual([{ emailAddress: { address: 'e@f.com' } }])
    expect(payload.message.body.contentType).toBe('HTML')
    expect(payload.saveToSentItems).toBe(false)
  })

  it('treats a 202 Accepted response as success even when res.ok is false', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce({ ok: false, status: 202, text: async () => '' } as Response)
    const { sendMail } = await loadGraphMail()
    await expect(sendMail({ to: 'a@b.com', subject: 'hi', body: 'hello' })).resolves.toBeUndefined()
  })

  it('throws on a non-ok, non-202 response', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
    const { sendMail } = await loadGraphMail()
    await expect(sendMail({ to: 'a@b.com', subject: 'hi', body: 'hello' })).rejects.toThrow(/sendMail failed \(500/)
  })
})

describe('graph-mail: verifyAccess', () => {
  it('returns the mailbox and message count on success', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, { value: [{ id: '1' }, { id: '2' }] }))
    const { verifyAccess } = await loadGraphMail()
    await expect(verifyAccess()).resolves.toEqual({ mailbox: 'mbox@example.com', messageCount: 2 })
  })

  it('reports messageCount 0 when the response has no value field', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(200, {}))
    const { verifyAccess } = await loadGraphMail()
    await expect(verifyAccess()).resolves.toEqual({ mailbox: 'mbox@example.com', messageCount: 0 })
  })

  it('throws naming the scoped mailbox on failure', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1')).mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
    const { verifyAccess } = await loadGraphMail()
    await expect(verifyAccess()).rejects.toThrow(/verifyAccess failed for mbox@example\.com \(401/)
  })
})
