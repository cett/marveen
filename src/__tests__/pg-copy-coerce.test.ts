// The value coercion of the copy tool (src/db/pg-copy/coerce.ts): strict and lossless, every anomaly named, no silent change.
import { describe, expect, it } from 'vitest'
import { coerceValue } from '../db/pg-copy/coerce.js'

describe('integers: bigint and smallint from an integer, or a canonical integer text', () => {
  it('a bigint integer passes as bigint, the bounds included', () => {
    expect(coerceValue(7n, 'integer', 'bigint')).toEqual({ ok: true, value: 7n })
    expect(coerceValue(2n ** 63n - 1n, 'integer', 'bigint')).toEqual({ ok: true, value: 2n ** 63n - 1n })
    expect(coerceValue(-(2n ** 63n), 'integer', 'bigint')).toEqual({ ok: true, value: -(2n ** 63n) })
  })

  it('an integer beyond the bigint range is an anomaly', () => {
    expect(coerceValue(2n ** 63n, 'integer', 'bigint').ok).toBe(false)
  })

  it('a canonical integer text is the same integer; a non-canonical one is an anomaly', () => {
    expect(coerceValue('42', 'text', 'bigint')).toEqual({ ok: true, value: 42n })
    expect(coerceValue('-0', 'text', 'bigint').ok).toBe(false)
    expect(coerceValue('007', 'text', 'bigint').ok).toBe(false)
    expect(coerceValue(' 7', 'text', 'bigint').ok).toBe(false)
    expect(coerceValue('7 ', 'text', 'bigint').ok).toBe(false)
    expect(coerceValue('1e3', 'text', 'bigint').ok).toBe(false)
  })

  it('text that is not a number is an anomaly (the text in a bigint column case)', () => {
    const r = coerceValue('abc', 'text', 'bigint')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/bigint/)
  })

  it('a real in an integer column is an anomaly, never a truncation', () => {
    expect(coerceValue(1.5, 'real', 'bigint').ok).toBe(false)
  })

  it('smallint: the range is -32768..32767', () => {
    expect(coerceValue(32767n, 'integer', 'smallint')).toEqual({ ok: true, value: 32767n })
    expect(coerceValue(32768n, 'integer', 'smallint').ok).toBe(false)
  })

  it('a flag column accepts exactly 0 and 1: a flag of 2 is an anomaly', () => {
    expect(coerceValue(0n, 'integer', 'smallint', { flag: true })).toEqual({ ok: true, value: 0n })
    expect(coerceValue(1n, 'integer', 'smallint', { flag: true })).toEqual({ ok: true, value: 1n })
    const two = coerceValue(2n, 'integer', 'smallint', { flag: true })
    expect(two.ok).toBe(false)
    if (!two.ok) expect(two.reason).toMatch(/flag is 2/)
  })
})

describe('floats: double precision from a real or an exact integer', () => {
  it('a real passes; an integer passes when a double holds it exactly', () => {
    expect(coerceValue(1.25, 'real', 'double precision')).toEqual({ ok: true, value: 1.25 })
    expect(coerceValue(3n, 'integer', 'double precision')).toEqual({ ok: true, value: 3 })
  })

  it('an integer a double cannot hold exactly is an anomaly', () => {
    expect(coerceValue(2n ** 53n + 1n, 'integer', 'double precision').ok).toBe(false)
  })

  it('NaN and text are anomalies', () => {
    expect(coerceValue(Number.NaN, 'real', 'double precision').ok).toBe(false)
    expect(coerceValue('1.5', 'text', 'double precision').ok).toBe(false)
  })
})

describe('real (float4) columns: a value the float4 cannot hold exactly is an anomaly, never a silent rounding', () => {
  it('a double that float4 holds exactly (the float4 value itself, 0.5) passes unchanged', () => {
    const f4 = Math.fround(0.1)
    expect(coerceValue(f4, 'real', 'real')).toEqual({ ok: true, value: f4 })
    expect(coerceValue(0.5, 'real', 'real')).toEqual({ ok: true, value: 0.5 })
  })

  it('a double with more than 24 significant bits (0.1 as a double) is an anomaly in a real column, and the reason names it', () => {
    const r = coerceValue(0.1, 'real', 'real')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/real column \(float4\) cannot hold exactly/)
  })

  it('an integer at 2^24 is exact in float4; 2^24 + 1 is an anomaly in a real column', () => {
    expect(coerceValue(2n ** 24n, 'integer', 'real')).toEqual({ ok: true, value: 16777216 })
    expect(coerceValue(2n ** 24n + 1n, 'integer', 'real').ok).toBe(false)
  })

  it('a double beyond the float4 range is an anomaly in a real column', () => {
    expect(coerceValue(1e39, 'real', 'real').ok).toBe(false)
  })

  it('the same double passes in a double precision column: only the real column is narrowed', () => {
    expect(coerceValue(0.1, 'real', 'double precision')).toEqual({ ok: true, value: 0.1 })
  })
})

describe('text: a string, no NUL, valid UTF-8', () => {
  it('a plain string passes unchanged', () => {
    expect(coerceValue('hu: árvíztűrő', 'text', 'text')).toEqual({ ok: true, value: 'hu: árvíztűrő' })
  })

  it('a NUL byte is an anomaly', () => {
    const r = coerceValue('a\u0000b', 'text', 'text')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/NUL/)
  })

  it('a value that is not valid UTF-8 is an anomaly, decided by the raw bytes', () => {
    expect(coerceValue('bad�', 'text', 'text', { utf8Valid: () => false }).ok).toBe(false)
    expect(coerceValue('ok �', 'text', 'text', { utf8Valid: () => true }).ok).toBe(true)
  })

  it('an integer or a blob in a text column is an anomaly', () => {
    expect(coerceValue(5n, 'integer', 'text').ok).toBe(false)
    expect(coerceValue(Buffer.from('x'), 'blob', 'text').ok).toBe(false)
  })
})

describe('bytea and NULL', () => {
  it('a blob passes as a Buffer; text in a bytea column is an anomaly', () => {
    const b = Buffer.from([1, 2, 3])
    expect(coerceValue(b, 'blob', 'bytea')).toEqual({ ok: true, value: b })
    expect(coerceValue('x', 'text', 'bytea').ok).toBe(false)
  })

  it('NULL passes for any column type (NOT NULL is the database\'s check, with its constraint name)', () => {
    expect(coerceValue(null, 'null', 'bigint')).toEqual({ ok: true, value: null })
    expect(coerceValue(null, 'null', 'text')).toEqual({ ok: true, value: null })
  })

  it('an unknown PostgreSQL type is an anomaly, never a guess', () => {
    expect(coerceValue(1n, 'integer', 'numeric').ok).toBe(false)
  })
})
