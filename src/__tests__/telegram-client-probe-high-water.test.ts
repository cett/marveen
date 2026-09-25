// coverage batch-51: probeHighWater() (0% covered before this file) --
// the getUpdates(offset:-1, limit:1) high-water seed probe used when entering
// a backfill window. Mocked fetch, same vi.stubGlobal pattern as the sibling
// getUpdates() error-classification tests in channel-coordinator.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeHighWater, TelegramApiError } from '../channel-coordinator/telegram-client.js'

afterEach(() => { vi.unstubAllGlobals() })

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })))
}

describe('probeHighWater', () => {
  it('returns the update_id of the single returned update', async () => {
    stubFetch(200, { ok: true, result: [{ update_id: 42 }] })
    await expect(probeHighWater('tok')).resolves.toBe(42)
  })

  it('returns null when the pending queue is empty', async () => {
    stubFetch(200, { ok: true, result: [] })
    await expect(probeHighWater('tok')).resolves.toBeNull()
  })

  it('returns null when result is absent from the response', async () => {
    stubFetch(200, { ok: true })
    await expect(probeHighWater('tok')).resolves.toBeNull()
  })

  it('classifies a 401 as fatal', async () => {
    stubFetch(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    await expect(probeHighWater('tok')).rejects.toMatchObject({ kind: 'fatal' })
  })

  it('classifies a 409 as conflict', async () => {
    stubFetch(409, { ok: false, error_code: 409, description: 'Conflict' })
    await expect(probeHighWater('tok')).rejects.toMatchObject({ kind: 'conflict' })
  })

  it('classifies any other non-ok status as transient', async () => {
    stubFetch(502, { ok: false, error_code: 502, description: 'Bad Gateway' })
    await expect(probeHighWater('tok')).rejects.toMatchObject({ kind: 'transient' })
  })

  it('classifies a network error as transient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    await expect(probeHighWater('tok')).rejects.toMatchObject({ kind: 'transient' })
  })

  it('rejections are TelegramApiError instances', async () => {
    stubFetch(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    await expect(probeHighWater('tok')).rejects.toBeInstanceOf(TelegramApiError)
  })
})
