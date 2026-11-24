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

/**
 * The columns this module is asked about, with the PostgreSQL constraint (or unique index) that guards each one.
 * Two reasons it exists: (1) PostgreSQL WITHHOLDS the `detail` of a unique violation from a role that row-level security
 * applies to (the app role), `table` and `constraint` stay; (2) a unique index on an expression (dashboard_users.username is
 * UNIQUE on lower(username)) never has the column in its detail. The name is the contract: a rename of the constraint must
 * fail loudly, and the catalog cell of src/__tests__/pg/rls-unique-violation.pg.test.ts checks that every entry exists on
 * a real server under exactly this name. A column that is not here is matched on its `detail` only, as before.
 */
export const PG_UNIQUE_CONSTRAINTS: Readonly<Record<string, { table: string; constraint: string }>> = {
  'dashboard_users.username': { table: 'dashboard_users', constraint: 'dashboard_users_username_key' },
  // No production caller asks about this column today: the entry is exercised by the tests only (the app-role cell and the
  // catalog cell). It stays as the second, plain-UNIQUE example next to the expression index above; drop it if that changes.
  'device_keys.key_hash': { table: 'device_keys', constraint: 'device_keys_key_hash_key' },
}

function isPgUniqueOn(err: Error, code: unknown, column: string): boolean {
  if (code !== PG_UNIQUE_VIOLATION) return false
  const { table, detail, constraint } = err as Error & { table?: unknown; detail?: unknown; constraint?: unknown }
  const named = PG_UNIQUE_CONSTRAINTS[column]
  if (named !== undefined && table === named.table && constraint === named.constraint) return true
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
