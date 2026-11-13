// A failure injection for tests: from now on an INSERT into one table (or an UPDATE, or a DELETE) is refused by the
// database itself, optionally only for the rows where one column has one value. The point of such a test is the path
// AFTER a write failed (a rollback, a savepoint, a half-written transaction), which no mock of the facade reaches the
// same way.
//
// The two dialects spell it differently, so the tests do not write the DDL themselves:
//   SQLite      CREATE TRIGGER ... BEFORE <event> ... WHEN ... BEGIN SELECT RAISE(ABORT, 'msg'); END
//   PostgreSQL  a plpgsql trigger function that RAISEs, plus CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION
// Both surface the message as the message of the rejected statement, so a test asserts on the same text on both. The
// trigger lives and dies with the test database (an in-memory database, or the clone of the baseline).
import type { Dbx } from '../../db.js'
import { dbxDialect } from '../../db/facade.js'

export interface RefuseWriteOptions {
  /** Trigger name (and, on PostgreSQL, the name of its function): lowercase letters, digits, underscore. */
  name: string
  table: string
  /** The message of the error the refused statement fails with. No quote, backslash, dollar sign or percent sign. */
  message: string
  /** The statement to refuse. INSERT when omitted. */
  event?: 'INSERT' | 'UPDATE' | 'DELETE'
  /** Refuse only the rows whose `column` equals `equals` (the NEW row: not for DELETE); every row when omitted. */
  when?: { column: string; equals: string }
}

const IDENT = /^[a-z_][a-z0-9_]*$/
const PLAIN_TEXT = /^[^'\\$]*$/
// the message of a RAISE EXCEPTION is a format string on PostgreSQL: a percent sign there is a placeholder
const MESSAGE_TEXT = /^[^'\\$%]*$/

function check(label: string, value: string, re: RegExp): void {
  if (!re.test(value)) throw new Error(`refuseWrite: ${label} ${JSON.stringify(value)} is not allowed`)
}

/** The DDL for one dialect, exposed so the helper's own test can look at it. */
export function refuseWriteSql(dialect: 'sqlite' | 'pg', o: RefuseWriteOptions): string {
  const event = o.event ?? 'INSERT'
  check('name', o.name, IDENT)
  check('table', o.table, IDENT)
  check('message', o.message, MESSAGE_TEXT)
  if (!['INSERT', 'UPDATE', 'DELETE'].includes(event)) throw new Error(`refuseWrite: event ${JSON.stringify(event)} is not allowed`)
  if (o.when) {
    if (event === 'DELETE') throw new Error('refuseWrite: a DELETE has no NEW row, so a condition on a column is not allowed')
    check('column', o.when.column, IDENT)
    check('value', o.when.equals, PLAIN_TEXT)
  }
  const cond = o.when ? `NEW.${o.when.column} = '${o.when.equals}'` : undefined
  if (dialect === 'sqlite') {
    return `CREATE TRIGGER ${o.name} BEFORE ${event} ON ${o.table}${cond ? ` WHEN ${cond}` : ''} BEGIN SELECT RAISE(ABORT, '${o.message}'); END`
  }
  return `CREATE FUNCTION ${o.name}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION '${o.message}'; END $fn$;
CREATE TRIGGER ${o.name} BEFORE ${event} ON ${o.table} FOR EACH ROW${cond ? ` WHEN (${cond})` : ''} EXECUTE FUNCTION ${o.name}()`
}

export async function refuseWrite(dbx: Dbx, o: RefuseWriteOptions): Promise<void> {
  await dbx.exec(refuseWriteSql(dbxDialect(), o))
}
