// Recognises the UNIQUE failure of one column, so a route can answer a lost race with 409 instead of letting the raw
// driver error become a 500. Anything else (another column, another constraint kind, a non-driver error) is not matched
// and keeps propagating.
//
// `column` is written `table.column` (a composite key: `table.a, table.b`), the way SQLite names it:
//   SQLite      code SQLITE_CONSTRAINT_UNIQUE, message "UNIQUE constraint failed: table.column"
//   PostgreSQL  code 23505, `table` = the table, `detail` = "Key (column)=(value) already exists."
// The PostgreSQL side needs the English server message (lc_messages); a localized `detail` is not matched, and the error
// propagates as before, which is the safe direction. A unique index on an expression (`Key (lower(email))=...`) has no
// column name and is not matched either: name such a constraint by its own check where it matters.

const PG_UNIQUE_VIOLATION = '23505'
// lazy on purpose: the column list ends at the FIRST `)=(`, a value that contains `)=(` must not stretch it
const PG_KEY_DETAIL = /^Key \((.+?)\)=\(.*\) already exists\.$/s

function isSqliteUniqueOn(err: Error, code: unknown, column: string): boolean {
  if (code !== 'SQLITE_CONSTRAINT_UNIQUE') return false
  return err.message.includes(`UNIQUE constraint failed: ${column}`)
}

function isPgUniqueOn(err: Error, code: unknown, column: string): boolean {
  if (code !== PG_UNIQUE_VIOLATION) return false
  const { table, detail } = err as Error & { table?: unknown; detail?: unknown }
  if (typeof table !== 'string' || table === '' || typeof detail !== 'string') return false
  const m = PG_KEY_DETAIL.exec(detail)
  if (!m) return false
  const columns = m[1]!.split(', ')
  return columns.map((c) => `${table}.${c}`).join(', ') === column
}

export function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: unknown }).code
  return isSqliteUniqueOn(err, code, column) || isPgUniqueOn(err, code, column)
}
