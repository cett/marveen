// A failure injection for tests: from now on an INSERT into one table is refused by the database itself, optionally only
// for the rows where one column has one value. The point of such a test is the path AFTER a write failed (a rollback, a
// savepoint, a half-written transaction), which no mock of the facade reaches the same way.
//
// The two dialects spell it differently, so the tests do not write the DDL themselves:
//   SQLite      CREATE TRIGGER ... BEFORE INSERT ... WHEN ... BEGIN SELECT RAISE(ABORT, 'msg'); END
//   PostgreSQL  a plpgsql trigger function that RAISEs, plus CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION
// Both surface the message as the message of the rejected statement, so a test asserts on the same text on both. The
// trigger lives and dies with the test database (an in-memory database, or the clone of the baseline).
import type { Dbx } from '../../db.js'
import { dbxDialect } from '../../db/facade.js'

export interface RefuseInsertOptions {
  /** Trigger name (and, on PostgreSQL, the name of its function): lowercase letters, digits, underscore. */
  name: string
  table: string
  /** The message of the error the refused INSERT fails with. No quote, backslash or dollar sign. */
  message: string
  /** Refuse only the rows whose `column` equals `equals`; every row when omitted. */
  when?: { column: string; equals: string }
}

const IDENT = /^[a-z_][a-z0-9_]*$/
const PLAIN_TEXT = /^[^'\\$]*$/

function check(label: string, value: string, re: RegExp): void {
  if (!re.test(value)) throw new Error(`refuseInsert: ${label} ${JSON.stringify(value)} is not allowed`)
}

/** The DDL for one dialect, exposed so the helper's own test can look at it. */
export function refuseInsertSql(dialect: 'sqlite' | 'pg', o: RefuseInsertOptions): string {
  check('name', o.name, IDENT)
  check('table', o.table, IDENT)
  check('message', o.message, PLAIN_TEXT)
  if (o.when) {
    check('column', o.when.column, IDENT)
    check('value', o.when.equals, PLAIN_TEXT)
  }
  const cond = o.when ? `NEW.${o.when.column} = '${o.when.equals}'` : undefined
  if (dialect === 'sqlite') {
    return `CREATE TRIGGER ${o.name} BEFORE INSERT ON ${o.table}${cond ? ` WHEN ${cond}` : ''} BEGIN SELECT RAISE(ABORT, '${o.message}'); END`
  }
  return `CREATE FUNCTION ${o.name}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION '${o.message}'; END $fn$;
CREATE TRIGGER ${o.name} BEFORE INSERT ON ${o.table} FOR EACH ROW${cond ? ` WHEN (${cond})` : ''} EXECUTE FUNCTION ${o.name}()`
}

export async function refuseInsert(dbx: Dbx, o: RefuseInsertOptions): Promise<void> {
  await dbx.exec(refuseInsertSql(dbxDialect(), o))
}
