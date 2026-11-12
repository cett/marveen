// PostgreSQL error codes (SQLSTATE) as the callers need them. The driver puts the 5-character code on `err.code`;
// a Node system error also has a `code` (ECONNRESET, EPIPE), so a code only counts when it has the SQLSTATE shape.

export const PG_ERROR = {
  uniqueViolation: '23505',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  /** "current transaction is aborted, commands ignored until end of transaction block". */
  inFailedSqlTransaction: '25P02',
  idleInTransactionTimeout: '25P03',
  lockNotAvailable: '55P03',
  queryCanceled: '57014',
} as const

// SQLSTATE classes are two digits, or one of the few lettered classes (F0 config file, HV foreign data, P0 PL/pgSQL, XX
// internal). No class starts with E, so ECONNRESET and EPIPE are not mistaken for one.
const SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/

/** The SQLSTATE of a PostgreSQL error, or undefined (not an error, no code, a Node system error). */
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined
}

/** A retry may succeed: the other side of a serialization conflict or a deadlock was rolled back, not this one's data. */
export function isPgRetryable(err: unknown): boolean {
  const code = pgErrorCode(err)
  return code === PG_ERROR.serializationFailure || code === PG_ERROR.deadlockDetected
}

/** The 23505 error of a unique constraint or index. */
export function isPgUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_ERROR.uniqueViolation
}
