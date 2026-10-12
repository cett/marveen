// The one-time browser enrollment codes: single use, expiry, wrong code, failed-attempt throttle.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ENROLL_CODE_TTL_MS,
  _resetEnrollCodesForTest,
  consumeEnrollCode,
  enrollUrl,
  issueEnrollCode,
} from '../web/browser-enroll-codes.js'

const T0 = 1_800_000_000_000

beforeEach(() => _resetEnrollCodesForTest())

describe('issueEnrollCode', () => {
  it('returns a long random code and an expiry one TTL away', () => {
    const { code, expiresAt } = issueEnrollCode(T0)
    expect(code.length).toBeGreaterThanOrEqual(32)
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(expiresAt).toBe(T0 + ENROLL_CODE_TTL_MS)
  })

  it('never repeats a code', () => {
    const seen = new Set(Array.from({ length: 15 }, () => issueEnrollCode(T0).code))
    expect(seen.size).toBe(15)
  })

  it('keeps at most 20 live codes: the oldest is dropped first', () => {
    const first = issueEnrollCode(T0).code
    for (let i = 0; i < 20; i++) issueEnrollCode(T0)
    expect(consumeEnrollCode(first, T0)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('consumeEnrollCode', () => {
  it('accepts a fresh code exactly once', () => {
    const { code } = issueEnrollCode(T0)
    expect(consumeEnrollCode(code, T0 + 1000)).toEqual({ ok: true })
    expect(consumeEnrollCode(code, T0 + 2000)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a code at and after its expiry, accepts it just before', () => {
    const early = issueEnrollCode(T0).code
    expect(consumeEnrollCode(early, T0 + ENROLL_CODE_TTL_MS - 1)).toEqual({ ok: true })
    const late = issueEnrollCode(T0).code
    expect(consumeEnrollCode(late, T0 + ENROLL_CODE_TTL_MS)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a wrong code, an empty code and a near miss, and leaves the real code usable', () => {
    const { code } = issueEnrollCode(T0)
    expect(consumeEnrollCode('not-a-code', T0)).toEqual({ ok: false, reason: 'invalid' })
    expect(consumeEnrollCode('', T0)).toEqual({ ok: false, reason: 'invalid' })
    expect(consumeEnrollCode(code.slice(0, -1), T0)).toEqual({ ok: false, reason: 'invalid' })
    expect(consumeEnrollCode(code, T0)).toEqual({ ok: true })
  })

  it('spends one code without touching another', () => {
    const a = issueEnrollCode(T0).code
    const b = issueEnrollCode(T0).code
    expect(consumeEnrollCode(a, T0)).toEqual({ ok: true })
    expect(consumeEnrollCode(b, T0)).toEqual({ ok: true })
  })
})

describe('failed-attempt throttle', () => {
  it('throttles after 10 failures in the window, even for a correct code', () => {
    const { code } = issueEnrollCode(T0)
    for (let i = 0; i < 10; i++) expect(consumeEnrollCode(`wrong-${i}`, T0 + i)).toEqual({ ok: false, reason: 'invalid' })
    const blocked = consumeEnrollCode(code, T0 + 100)
    expect(blocked.ok).toBe(false)
    expect(blocked).toMatchObject({ reason: 'throttled' })
    expect((blocked as { retryAfterS: number }).retryAfterS).toBeGreaterThan(0)
  })

  it('9 failures do not throttle', () => {
    const { code } = issueEnrollCode(T0)
    for (let i = 0; i < 9; i++) consumeEnrollCode(`wrong-${i}`, T0 + i)
    expect(consumeEnrollCode(code, T0 + 100)).toEqual({ ok: true })
  })

  it('lets enrollment through again once the failures drain out of the window', () => {
    for (let i = 0; i < 10; i++) consumeEnrollCode(`wrong-${i}`, T0)
    const { code } = issueEnrollCode(T0 + 11 * 60 * 1000)
    expect(consumeEnrollCode(code, T0 + 11 * 60 * 1000)).toEqual({ ok: true })
  })

  it('counts a failure only for a wrong code, not for a successful one', () => {
    for (let i = 0; i < 15; i++) {
      const { code } = issueEnrollCode(T0)
      expect(consumeEnrollCode(code, T0)).toEqual({ ok: true })
    }
  })
})

describe('enrollUrl', () => {
  it('puts the code in the enroll parameter, on the given origin', () => {
    expect(enrollUrl('http://localhost:3420', 'abc_DEF-1')).toBe('http://localhost:3420/?enroll=abc_DEF-1')
    expect(enrollUrl('https://dash.example.net/', 'x')).toBe('https://dash.example.net/?enroll=x')
  })
})
