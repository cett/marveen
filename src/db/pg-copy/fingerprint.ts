// The read-back fingerprint of the copy tool (P-G1, section 2.4): a count cannot see truncation, an encoding change or a
// float or bytea drift, so every row is reduced to a digest of its canonical form and the digests are folded with a sum
// modulo 2^256. The fold does not depend on the order of the rows, so the SQLite side (folded while writing) and the
// PostgreSQL side (read back in the same transaction, before COMMIT) compare without a sort.
//
// The canonical form is decided by the PostgreSQL column type, so an integer read back as a JS number and one written
// as a bigint give the same token. Every token is self-delimiting: an integer by its digits, a text by its byte length.

import { createHash } from 'node:crypto'
import type { PgValue } from './coerce.js'

const MODULUS = 1n << 256n

const INTEGER_TYPES = new Set(['bigint', 'smallint', 'integer'])

/** True for the PostgreSQL integer types: their values are read as text and folded as bigint (see copy.ts verifyTables). */
export function isIntegerPgType(pgType: string): boolean {
  return INTEGER_TYPES.has(pgType)
}

/** One value as its canonical token, decided by the PostgreSQL column type. */
export function canonicalToken(value: PgValue | Buffer | number | string | null, pgType: string): string {
  if (value === null || value === undefined) return 'N'
  if (Buffer.isBuffer(value)) return `B${value.toString('hex')};`
  if (typeof value === 'string') return `T${Buffer.byteLength(value, 'utf8')}:${value};`
  if (INTEGER_TYPES.has(pgType)) {
    // an integer column: the bigint of the SQLite side and the number the driver returns name the same integer
    return `I${BigInt(value as bigint | number).toString()};`
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    // a float column: the bit pattern, so a rounding drift is a difference
    const buf = Buffer.alloc(8)
    buf.writeDoubleBE(Number(value), 0)
    return `D${buf.toString('hex')};`
  }
  throw new Error(`no canonical token for a ${typeof value} in a ${pgType} column`)
}

/** The digest of one row: the SHA-256 of its tokens, in the order of the columns, as an integer. */
export function rowDigest(values: Array<{ value: PgValue | Buffer | number | string | null; pgType: string }>): bigint {
  const h = createHash('sha256')
  for (const v of values) h.update(canonicalToken(v.value, v.pgType))
  return BigInt(`0x${h.digest('hex')}`)
}

/** The fold of the row digests of one table: the row count and the sum of the digests modulo 2^256. */
export class Fingerprint {
  rows = 0
  private sum = 0n

  add(digest: bigint): void {
    this.rows++
    this.sum = (this.sum + digest) % MODULUS
  }

  /** the folded sum as 64 hex digits */
  get hexString(): string {
    return this.sum.toString(16).padStart(64, '0')
  }

  equals(other: Fingerprint): boolean {
    return this.rows === other.rows && this.sum === other.sum
  }
}
