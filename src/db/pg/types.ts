// How rows come back from PostgreSQL, so the facade code (written for better-sqlite3 values) sees the same shapes:
//   - int8 (bigint columns, count(*), sum() of smallint or integer columns) as a JS number, CHECKED: a value beyond
//     Number.MAX_SAFE_INTEGER throws instead of rounding (the driver default is a string). sum() of a bigint column and
//     avg() of an integer or numeric column return numeric, which stays a string (see below; avg() of a double precision
//     column is a float and arrives as a number): cast in the statement where a number is wanted,
//   - smallint / integer (the flag columns) are numbers in the driver already, bytea is a Buffer,
//   - everything else keeps the driver's default parser (numeric stays a string: exact decimals are not floats).
import pg from 'pg'

const INT8_OID = 20

/** bigint text -> number, refusing a value a number cannot hold exactly. */
export function parseInt8Safe(text: string): number {
  const n = /^-?\d+$/.test(text) ? Number(text) : NaN // Number('') is 0 and Number(' 7 ') is 7: not an int8 text
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`int8 value ${text} is outside the safe integer range of a JS number`)
  }
  return n
}

/** The `types` option of a pg query, Pool or Client: int8 as a checked number, everything else as the driver has it. */
export const pgTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID && format !== 'binary') return parseInt8Safe
    return pg.types.getTypeParser(oid, format as 'text')
  },
} as unknown as pg.CustomTypesConfig
