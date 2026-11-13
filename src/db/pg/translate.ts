// The placeholder translator of the PostgreSQL adapter: the surface of the db facade (positional `?`, or one object
// for `@name`) becomes what the `pg` driver takes ($1, $2, ... and a values array).
//
// It is a scanner, not a text replace: a `?` or an `@name` inside a quoted text, a quoted identifier, a comment or a
// dollar-quoted body is data and stays as it is. `::` (the cast) is not a placeholder syntax of the facade (there is no
// `:name`), so it passes through untouched. What counts:
//   - `?`            a positional placeholder; the parameter count must equal the number of `?`,
//   - `@name`        a named placeholder; the parameters are exactly one plain object that has the name as a key. The
//                    same name twice is ONE $n. An `@` that follows another `@` (the `@@` operator) or is not followed
//                    by a letter or `_` (`@>`, `@ x`) is an operator. The PostgreSQL absolute-value prefix `@x` is
//                    therefore not writable without a space; use abs(x),
//   - `?` and `@name` in one statement, a native `$1` outside a literal, any count that does not match, a missing
//     name: an error (the SQLite driver throws on the same mistakes, and a silently wrong statement is worse).
//
// Not translated, on purpose: the jsonb operators `?` `?|` `?&` (use jsonb_exists / jsonb_exists_any / jsonb_exists_all;
// they read as placeholders), `@?` (use jsonb_path_exists; it is refused with an error, because `@` followed by a
// placeholder would otherwise bind a value to the wrong place), SQLite's `?NNN`, `:name` and `$name` (the facade does
// not offer them).
//
// Pure, no import: the fuzz cell runs it over every statement text of src/db/ without a server.

export interface TranslatedSql {
  text: string
  values: unknown[]
}

/** PostgreSQL's protocol limit on bind parameters. */
export const PG_MAX_PARAMS = 65535

const isIdentStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_\u0080-￿]/.test(c)
const isIdentPart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c)
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

/** The index just after the quoted run that starts at `start` (the opening quote), or the end of the text when it never closes. */
function skipQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1
  while (i < sql.length) {
    const c = sql[i]
    if (backslash && c === '\\') {
      i += 2
      continue
    }
    // a doubled quote ('' or "") needs no case of its own: it ends one quoted run and starts the next one at once
    if (c === quote) return i + 1
    i++
  }
  return sql.length
}

/** The index just after a block comment that starts at `start`; PostgreSQL block comments nest. */
function skipBlockComment(sql: string, start: number): number {
  let depth = 0
  let i = start
  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth++
      i += 2
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      depth--
      i += 2
      if (depth === 0) return i
    } else {
      i++
    }
  }
  return sql.length
}

/** The index just after a line comment that starts at `start`. */
function skipLineComment(sql: string, start: number): number {
  let i = start
  while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
  return i
}

/** `$$` or `$tag$` at `start` (not part of an identifier): the index just after the closing tag, or null when it is no dollar quote. */
function skipDollarQuoted(sql: string, start: number): number | null {
  let j = start + 1
  if (isIdentStart(sql[j])) {
    j++
    while (isIdentPart(sql[j]) && sql[j] !== '$') j++
  }
  if (sql[j] !== '$') return null
  const tag = sql.slice(start, j + 1)
  const close = sql.indexOf(tag, j + 1)
  return close === -1 ? sql.length : close + tag.length
}

/**
 * Translates one statement and its parameters. `params` is what the facade got: any number of positional values, or
 * one object for the `@name` form.
 */
export function translatePlaceholders(sql: string, params: readonly unknown[]): TranslatedSql {
  const out: string[] = []
  let positional = 0
  const named = new Map<string, number>() // name -> its $n
  const order: string[] = [] // names in $n order
  let i = 0
  let copyFrom = 0 // out gets sql.slice(copyFrom, i) lazily, so literals are copied in one piece

  const flush = (upTo: number): void => {
    if (upTo > copyFrom) out.push(sql.slice(copyFrom, upTo))
  }

  while (i < sql.length) {
    const c = sql[i]!
    if (c === "'") {
      // E'...' (and e'...') reads a backslash as an escape; the E must not be the tail of a longer word
      const escapeString = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdentPart(sql[i - 2])
      i = skipQuoted(sql, i, "'", escapeString)
    } else if (c === '"') {
      i = skipQuoted(sql, i, '"', false)
    } else if (c === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i)
    } else if (c === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i)
    } else if (c === '$' && !isIdentPart(sql[i - 1])) {
      if (isDigit(sql[i + 1])) {
        throw new Error('dbx: a native $n placeholder is not accepted, write ? or @name')
      }
      const end = skipDollarQuoted(sql, i)
      i = end ?? i + 1
    } else if (c === '@' && sql[i + 1] === '?' && sql[i - 1] !== '@') {
      // jsonb "path exists": read as an `@` operator and a placeholder it would bind a value to the wrong place
      throw new Error('dbx: the jsonb operator @? is not accepted (it would read as @ and a placeholder), use jsonb_path_exists(...)')
    } else if (c === '?') {
      if (named.size > 0) throw new Error('dbx: ? and @name placeholders cannot be mixed in one statement')
      flush(i)
      positional++
      out.push(`$${positional}`)
      i++
      copyFrom = i
    } else if (c === '@' && sql[i - 1] !== '@' && isIdentStart(sql[i + 1])) {
      if (positional > 0) throw new Error('dbx: ? and @name placeholders cannot be mixed in one statement')
      let j = i + 1
      while (isIdentPart(sql[j]) && sql[j] !== '$') j++
      const name = sql.slice(i + 1, j)
      let n = named.get(name)
      if (n === undefined) {
        n = order.length + 1
        named.set(name, n)
        order.push(name)
      }
      flush(i)
      out.push(`$${n}`)
      i = j
      copyFrom = i
    } else {
      i++
    }
  }
  flush(sql.length)

  if (order.length > 0) {
    if (params.length !== 1 || !isPlainObject(params[0])) {
      throw new Error('dbx: a statement with @name placeholders takes exactly one object of parameters')
    }
    const obj = params[0]
    const values = order.map((name) => {
      if (!Object.prototype.hasOwnProperty.call(obj, name)) throw new Error(`dbx: missing named parameter @${name}`)
      return obj[name]
    })
    checkLimit(values.length)
    return { text: out.join(''), values }
  }
  if (params.length !== positional) {
    throw new Error(`dbx: the statement has ${positional} placeholder${positional === 1 ? '' : 's'} but ${params.length} parameter${params.length === 1 ? ' was' : 's were'} given`)
  }
  checkLimit(positional)
  return { text: out.join(''), values: [...params] }
}

function checkLimit(count: number): void {
  if (count > PG_MAX_PARAMS) throw new Error(`dbx: ${count} parameters, PostgreSQL takes at most ${PG_MAX_PARAMS} in one statement`)
}
