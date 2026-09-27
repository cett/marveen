import { describe, it, expect, vi } from 'vitest'
import type http from 'node:http'
import { parsePagination } from '../web/utils/pagination.js'

function makeRes(): { res: http.ServerResponse; status: () => number; body: () => unknown } {
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  return {
    res,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

describe('parsePagination', () => {
  const defaults = { defaultLimit: 25, maxLimit: 100 }

  it('returns the default limit and offset 0 when neither is given', () => {
    const { res } = makeRes()
    const result = parsePagination(new URLSearchParams(''), res, defaults)
    expect(result).toEqual({ limit: 25, offset: 0 })
  })

  it('parses an explicit limit and offset', () => {
    const { res } = makeRes()
    const result = parsePagination(new URLSearchParams('limit=10&offset=20'), res, defaults)
    expect(result).toEqual({ limit: 10, offset: 20 })
  })

  it('caps limit at maxLimit', () => {
    const { res } = makeRes()
    const result = parsePagination(new URLSearchParams('limit=9999'), res, defaults)
    expect(result).toEqual({ limit: 100, offset: 0 })
  })

  it('rejects a non-numeric limit with 400 invalid_value', () => {
    const { res, status, body } = makeRes()
    const result = parsePagination(new URLSearchParams('limit=abc'), res, defaults)
    expect(result).toBeNull()
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('invalid_value')
    expect((body() as any).field).toBe('limit')
  })

  it('rejects a zero limit with 400 invalid_value', () => {
    const { res, status } = makeRes()
    const result = parsePagination(new URLSearchParams('limit=0'), res, defaults)
    expect(result).toBeNull()
    expect(status()).toBe(400)
  })

  it('rejects a non-numeric offset with 400 invalid_value', () => {
    const { res, status, body } = makeRes()
    const result = parsePagination(new URLSearchParams('offset=abc'), res, defaults)
    expect(result).toBeNull()
    expect(status()).toBe(400)
    expect((body() as any).field).toBe('offset')
  })

  it('rejects a negative offset with 400 invalid_value', () => {
    const { res, status } = makeRes()
    const result = parsePagination(new URLSearchParams('offset=-5'), res, defaults)
    expect(result).toBeNull()
    expect(status()).toBe(400)
  })
})
