// An API error token outside the catalog is reported through the logger. The log export sends the MESSAGE of a
// warn/error line, so the text of the violation (which names the token) must be a bound field, never the message.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))

const { json } = await import('../web/http-helpers.js')

const fakeRes = () => ({ writeHead: vi.fn(), end: vi.fn() }) as never

describe('reportViolation', () => {
  const env = process.env.NODE_ENV
  beforeEach(() => { loggerMock.error.mockClear() })
  afterEach(() => { process.env.NODE_ENV = env })

  it('logs a fixed message with the violation, the token and the status in bound fields', () => {
    process.env.NODE_ENV = 'production' // in tests it throws instead of logging
    json(fakeRes(), { error: 'token-with-a-secret-like-name' }, 400)
    expect(loggerMock.error).toHaveBeenCalledTimes(1)
    const [fields, message] = loggerMock.error.mock.calls[0]
    expect(message).toBe('api-error-catalog: invariant violation')
    expect(fields).toMatchObject({ token: 'token-with-a-secret-like-name', status: 400 })
    expect(String(fields.violation)).toContain('unknown error token')
    expect(String(message)).not.toContain('token-with-a-secret-like-name')
  })

  it('still sends the response, and still throws in the test environment', () => {
    process.env.NODE_ENV = 'production'
    const res = fakeRes() as unknown as { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    json(res as never, { error: 'unknown-one' }, 400)
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    process.env.NODE_ENV = 'test'
    expect(() => json(fakeRes(), { error: 'unknown-one' }, 400)).toThrow(/invariant violation/)
  })
})
