// The value coercion of the copy tool (P-G1, copy tool): one SQLite value to the PostgreSQL column type it is written to.
// Strict and lossless: a value that does not convert exactly is an anomaly, never a silent change. There is no "set to
// NULL on a bad value" switch: a row altered at cutover cannot be found later, and the rehearsal exists to find these
// while SQLite is still the source of truth.
//
// The input is what better-sqlite3 returns with safeIntegers on (INTEGER as bigint, REAL as number, TEXT as string,
// BLOB as Buffer, NULL as null) and the SQLite typeof of the same value, which the reader selects with the value.

export const BIGINT_MIN = -(2n ** 63n)
export const BIGINT_MAX = 2n ** 63n - 1n
export const SMALLINT_MIN = -32768n
export const SMALLINT_MAX = 32767n

/** The value as PostgreSQL will hold it: bigint for every integer type, number for the float types, string, Buffer or null. */
export type PgValue = bigint | number | string | Buffer | null

export type CoerceResult = { ok: true; value: PgValue } | { ok: false; reason: string }

export interface CoerceOptions {
  /** a 0/1 flag column: smallint with CHECK (col IN (0, 1)) */
  flag?: boolean
  /**
   * For a text value that contains U+FFFD only: whether the stored bytes are valid UTF-8. better-sqlite3 decodes with
   * replacement, so a value that was not valid UTF-8 shows up as U+FFFD; the reader asks the raw bytes in that case.
   */
  utf8Valid?: () => boolean
}

// zero has no sign; "-0" and leading zeros are not the canonical form of an integer
const CANONICAL_INT = /^(0|-?[1-9][0-9]*)$/

/** Coerces one SQLite value (with its SQLite typeof) to the PostgreSQL type, or says why it cannot. */
export function coerceValue(value: unknown, sqliteType: string, pgType: string, opts: CoerceOptions = {}): CoerceResult {
  if (sqliteType === 'null' || value === null || value === undefined) return { ok: true, value: null }
  switch (pgType) {
    case 'bigint':
      return coerceInteger(value, sqliteType, BIGINT_MIN, BIGINT_MAX, 'bigint')
    case 'smallint': {
      const r = coerceInteger(value, sqliteType, SMALLINT_MIN, SMALLINT_MAX, 'smallint')
      if (!r.ok || !opts.flag) return r
      if (r.value !== 0n && r.value !== 1n) return { ok: false, reason: `the flag is ${String(r.value)}, the column accepts 0 or 1` }
      return r
    }
    case 'double precision':
    case 'real':
      return coerceFloat(value, sqliteType, pgType)
    case 'text':
      return coerceText(value, sqliteType, opts)
    case 'bytea':
      if (sqliteType !== 'blob' || !Buffer.isBuffer(value)) return { ok: false, reason: `a ${sqliteType} in a bytea column` }
      return { ok: true, value }
    default:
      return { ok: false, reason: `no coercion rule for the PostgreSQL type ${pgType}` }
  }
}

function coerceInteger(value: unknown, sqliteType: string, min: bigint, max: bigint, pgType: string): CoerceResult {
  let n: bigint
  if (sqliteType === 'integer' && typeof value === 'bigint') {
    n = value
  } else if (sqliteType === 'text' && typeof value === 'string') {
    // a canonical integer text (no sign noise, no leading zeros, no spaces) is the same integer; anything else is not
    if (!CANONICAL_INT.test(value)) return { ok: false, reason: `a text that is not a canonical integer in a ${pgType} column` }
    n = BigInt(value)
  } else {
    return { ok: false, reason: `a ${sqliteType} in a ${pgType} column` }
  }
  if (n < min || n > max) return { ok: false, reason: `the integer is outside the ${pgType} range` }
  return { ok: true, value: n }
}

function coerceFloat(value: unknown, sqliteType: string, pgType: string): CoerceResult {
  let f: number
  if (sqliteType === 'real' && typeof value === 'number') {
    if (Number.isNaN(value)) return { ok: false, reason: 'a NaN real' }
    f = value
  } else if (sqliteType === 'integer' && typeof value === 'bigint') {
    f = Number(value)
    // an integer a double cannot hold exactly is not converted: the round trip has to give back the same integer
    if (!Number.isFinite(f) || BigInt(f) !== value) return { ok: false, reason: 'an integer a double precision cannot hold exactly' }
  } else {
    return { ok: false, reason: `a ${sqliteType} in a double precision column` }
  }
  // a real column is float4: PostgreSQL would round a double it cannot hold exactly without a word, so it is an anomaly.
  // The PostgreSQL baseline has no real column today (SQLite REAL maps to double precision): this narrowing is dormant
  // until a real column is added, and the cell for it is in pg-copy-coerce.test.ts.
  if (pgType === 'real' && Math.fround(f) !== f) {
    return { ok: false, reason: 'a value a real column (float4) cannot hold exactly' }
  }
  return { ok: true, value: f }
}

function coerceText(value: unknown, sqliteType: string, opts: CoerceOptions): CoerceResult {
  if (sqliteType !== 'text' || typeof value !== 'string') return { ok: false, reason: `a ${sqliteType} in a text column` }
  if (value.includes('\u0000')) return { ok: false, reason: 'a NUL byte in a text column' }
  if (value.includes('�') && opts.utf8Valid && !opts.utf8Valid()) {
    return { ok: false, reason: 'text that is not valid UTF-8' }
  }
  return { ok: true, value }
}
