// SQL fragments for the few constructs that have no spelling shared by SQLite and PostgreSQL, chosen by the dialect of
// the current backend (dbxDialect()). Where one portable spelling exists, the module SQL uses it directly (INSERT ... ON
// CONFLICT, RETURNING); this file is the ONLY place that holds the SQLite-only spellings below, and the dialect ratchet
// (scripts/sqlite-dialect-ratchet.py) does not count them here, so the count outside this file can only go down.
//
// The fragments take SQL TEXT (a column, a placeholder such as `?` or `@nowSec`) and return SQL text. They are not for
// user input: every argument is a literal of the calling module. They must not call the database; the dialect is read
// when the fragment is built, and the backend does not change between building and running a statement in one call.
//
// Each fragment has a DIFFERENTIAL cell (src/__tests__/pg/dialect.pg.test.ts): the same inputs on SQLite and on
// PostgreSQL, the same output, including the edges named below.
import { dbxDialect, type DbxDialect } from './facade.js'

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'

/** An IANA zone name as it goes into SQL text: letters, digits, `_`, `+`, `-` and `/` segments, no empty segment, no `..`. */
const ZONE_NAME = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/

/**
 * The zone SQLite's 'localtime' modifier uses, named explicitly so PostgreSQL uses the SAME one: the zone of this
 * process (Intl, which follows TZ when it is set). The name is checked against ZONE_NAME before it can enter SQL text;
 * a name that PostgreSQL does not know fails loudly in the differential cell (pg_timezone_names), not as a wrong day.
 */
export function localTimeZone(): string {
  return checkZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone)
}

/** Returns `zone` when it is a plain IANA zone name (safe to put inside SQL quotes), throws otherwise. */
export function checkZoneName(zone: unknown): string {
  if (typeof zone !== 'string' || zone.length > 64 || !ZONE_NAME.test(zone)) {
    throw new Error(`dialect: the time zone ${JSON.stringify(zone)} is not a plain IANA zone name`)
  }
  return zone
}

function pick<T>(dialect: DbxDialect, sqlite: () => T, pg: () => T): T {
  return dialect === 'pg' ? pg() : sqlite()
}

/**
 * The local calendar day ('YYYY-MM-DD') of an epoch-seconds expression, in the process zone.
 * SQLite: date(x, 'unixepoch', 'localtime'). PostgreSQL: the instant converted to the same zone, then formatted.
 * Edges: the 23 h and 25 h days of a DST change (the day label follows the local wall clock, not 24 h blocks), an
 * instant late on the last day of a month in UTC that is already the next day locally, NULL (stays NULL).
 */
export function epochLocalDate(x: string, dialect: DbxDialect = dbxDialect()): string {
  return pick(
    dialect,
    () => `date(${x}, 'unixepoch', 'localtime')`,
    () => `to_char(to_timestamp((${x})::double precision) AT TIME ZONE '${localTimeZone()}', 'YYYY-MM-DD')`,
  )
}

/** The local month ('YYYY-MM') of an epoch-seconds expression, in the process zone. Same edges as epochLocalDate. */
export function epochLocalMonth(x: string, dialect: DbxDialect = dbxDialect()): string {
  return pick(
    dialect,
    () => `strftime('%Y-%m', ${x}, 'unixepoch', 'localtime')`,
    () => `to_char(to_timestamp((${x})::double precision) AT TIME ZONE '${localTimeZone()}', 'YYYY-MM')`,
  )
}

/** `translate()` folding A-Z to a-z and nothing else: what SQLite's NOCASE does (ASCII only), unlike PostgreSQL's lower(). */
function asciiFold(x: string): string {
  return `translate(${x}, '${UPPER}', '${LOWER}')`
}

/**
 * `a = b` ignoring ASCII case, as SQLite's `a = b COLLATE NOCASE`. PostgreSQL: both sides folded by asciiFold, so 'A' = 'a'
 * but 'Ő' <> 'ő' (lower() would fold them: the two engines would disagree on a non-ASCII value). NULL on either side is
 * unknown (not true, not false) on both. Equality only: no index use on PostgreSQL without an expression index.
 */
export function eqNoCase(a: string, b: string, dialect: DbxDialect = dbxDialect()): string {
  return pick(
    dialect,
    () => `${a} = ${b} COLLATE NOCASE`,
    () => `${asciiFold(a)} = ${asciiFold(b)}`,
  )
}

/**
 * An ORDER BY term that sorts like SQLite's `col COLLATE NOCASE`: bytes after the ASCII fold. PostgreSQL's ORDER BY uses the
 * database collation (en_US puts punctuation, '_' and accents elsewhere), so the folded value gets COLLATE "C" (byte
 * order). Names that tie after the fold (Ab and ab) need a tie-break that is byte order too: write
 * `ORDER BY ${orderNoCase('c')}, ${orderBytes('c')}, id` at the call site.
 *
 * This is true for VALUES only. NULL sorts differently by default: SQLite puts NULL first in an ascending order, PostgreSQL
 * puts it last. For a nullable column write `NULLS FIRST` (SQLite's order) or `NULLS LAST` after the term at the call
 * site; both engines accept it. A NOT NULL column (dashboard_users.username) needs nothing.
 */
export function orderNoCase(col: string, dialect: DbxDialect = dbxDialect()): string {
  return pick(
    dialect,
    () => `${col} COLLATE NOCASE`,
    () => `${asciiFold(col)} COLLATE "C"`,
  )
}

/** An ORDER BY term in byte order: SQLite's default BINARY collation; PostgreSQL needs COLLATE "C" for the same order. */
export function orderBytes(col: string, dialect: DbxDialect = dbxDialect()): string {
  return pick(
    dialect,
    () => col,
    () => `${col} COLLATE "C"`,
  )
}

/**
 * `col LIKE param ESCAPE '\'` ignoring ASCII case, as SQLite's LIKE does. PostgreSQL's LIKE is case sensitive, and ILIKE is
 * no answer (it folds with lower(), so it also folds non-ASCII: 'Ő' would match 'ő' there and not on SQLite). So on
 * PostgreSQL BOTH sides go through asciiFold: the parameter may be any pattern (no pre-folding in JS), and the fold touches
 * letters only, so the wildcards (% and _) and the backslash escape stay intact. The fragment returns the LIKE and its
 * ESCAPE clause together: an ESCAPE-less shape cannot be written, so a user text always goes through likeContains /
 * likePrefix (db/like.ts) and a "%" or "_" in it stays a literal. NULL on either side is unknown on both engines.
 * No index use on PostgreSQL without an expression index (same as eqNoCase).
 */
export function likeNoCase(col: string, param: string, dialect: DbxDialect = dbxDialect()): string {
  return pick(
    dialect,
    () => `${col} LIKE ${param} ESCAPE '\\'`,
    () => `${asciiFold(col)} LIKE ${asciiFold(param)} ESCAPE '\\'`,
  )
}

/**
 * The distinct values of `col` within a group as one comma separated text (an aggregate: use it in a GROUP BY query).
 * SQLite: GROUP_CONCAT(DISTINCT col), which cannot take a separator together with DISTINCT, so the default ',' it is.
 * PostgreSQL: string_agg(DISTINCT (col)::text, ','). NULLs are skipped on both and a group with no value is NULL on both;
 * an integer column comes out as its decimal text on both; an empty string is a value and counts. The ORDER of the
 * values is NOT portable (SQLite: the engine's choice, PostgreSQL: sorted, because DISTINCT sorts): a caller that
 * needs an order splits and sorts, and a value that contains a comma is indistinguishable from two values on both.
 */
export function groupConcatDistinct(col: string, dialect: DbxDialect = dbxDialect()): string {
  return pick(
    dialect,
    () => `GROUP_CONCAT(DISTINCT ${col})`,
    () => `string_agg(DISTINCT (${col})::text, ',')`,
  )
}

/**
 * The row lock of a SELECT: `FOR UPDATE` on PostgreSQL, '' on SQLite (one connection, the transaction itself is the lock).
 * It is the LAST clause of the statement (after ORDER BY and LIMIT). Inside a transaction body only: a lock taken outside
 * one is released at once.
 */
export function forUpdate(dialect: DbxDialect = dbxDialect()): string {
  return pick(dialect, () => '', () => 'FOR UPDATE')
}

const ADVISORY_KEY = /^[a-z0-9:_-]+$/

/**
 * A transaction-scoped advisory lock, as the SQL text of ONE statement the caller runs first in the transaction: the lock is
 * held until COMMIT or ROLLBACK and another transaction on the same key waits for it. PostgreSQL:
 * `SELECT pg_advisory_xact_lock(hashtext('key'))`. SQLite: '' (the one connection already serializes the transactions); the
 * caller skips an empty statement. The key is a literal of the calling module (lower-case letters, digits, ':', '_', '-'),
 * checked here, never user input.
 */
export function advisoryLockSql(key: string, dialect: DbxDialect = dbxDialect()): string {
  if (!ADVISORY_KEY.test(key)) throw new Error(`dialect: the advisory lock key ${JSON.stringify(key)} is not a plain key`)
  return pick(dialect, () => '', () => `SELECT pg_advisory_xact_lock(hashtext('${key}'))`)
}

/**
 * The advisory key prefixes of the keyed locks. A keyed lock's key is the prefix plus the caller's id, so the modules that
 * lock on their own ids (one module, one prefix) cannot collide with each other. The list is checked: a prefix that is not
 * on it is refused, so no caller can invent a key space by accident.
 */
export const ADVISORY_PREFIXES = ['bgtask:', 'approval:', 'channel:', 'skill-usage:'] as const
export type AdvisoryPrefix = (typeof ADVISORY_PREFIXES)[number]

/**
 * A transaction-scoped advisory lock on a keyed value, as ONE statement the caller runs first in the transaction:
 * `SELECT pg_advisory_xact_lock(hashtext(?))`, bound to the prefix plus the id. The id is a bound parameter, never part of the
 * statement text, so no id can change the SQL. On SQLite it returns null (the one connection already serializes the
 * transactions); the caller skips a null.
 */
export function advisoryLockKeyed(
  prefix: AdvisoryPrefix,
  id: string,
  dialect: DbxDialect = dbxDialect(),
): { sql: string; params: string[] } | null {
  if (!(ADVISORY_PREFIXES as readonly string[]).includes(prefix)) {
    throw new Error(`dialect: the advisory key prefix ${JSON.stringify(prefix)} is not a known prefix`)
  }
  return pick(dialect, () => null, () => ({ sql: 'SELECT pg_advisory_xact_lock(hashtext(?))', params: [prefix + id] }))
}

/**
 * The id of a keyed lock built from several parts (an agent and a tenant and a category, an agent and a skill). The parts are
 * joined as a JSON array, so the separator cannot be part of a value: ['a:b', 'c'] and ['a', 'b:c'] are different ids. Every
 * composite keyed lock uses this helper, never its own join.
 */
export function advisoryKeyOf(...parts: string[]): string {
  return JSON.stringify(parts)
}
