// The placeholder translator of the PostgreSQL adapter (src/db/pg/translate.ts). Pure, no server: every cell is a
// statement text in, the translated text and values out. The positive pair of each "left alone" cell is the same
// statement with a real placeholder after it, so a scanner that skips too much is as red as one that skips too little.
import { describe, expect, it } from 'vitest'
import { PG_MAX_PARAMS, translatePlaceholders } from '../db/pg/translate.js'

const t = (sql: string, ...params: unknown[]) => translatePlaceholders(sql, params)

describe('positional ?', () => {
  it('numbers them in order and keeps the values as given', () => {
    const buf = Buffer.from([1, 2])
    expect(t('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?', 1, 'x', buf)).toEqual({
      text: 'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3',
      values: [1, 'x', buf],
    })
    expect(t('SELECT * FROM t WHERE a = ?', null).values).toEqual([null])
  })

  it('a statement without a placeholder passes through', () => {
    expect(t('SELECT 1')).toEqual({ text: 'SELECT 1', values: [] })
    expect(t('')).toEqual({ text: '', values: [] })
  })

  it('a parameter that is itself an object or an array is one value (JSON), not a named set', () => {
    const o = { a: 1 }
    expect(t('INSERT INTO t (j) VALUES (?)', o).values).toEqual([o])
    expect(t('INSERT INTO t (j) VALUES (?)', [1, 2]).values).toEqual([[1, 2]])
  })

  it('too few, too many and a parameter with no placeholder are errors', () => {
    expect(() => t('SELECT ? , ?', 1)).toThrow(/2 placeholders but 1 parameter was given/)
    expect(() => t('SELECT ?', 1, 2)).toThrow(/1 placeholder but 2 parameters were given/)
    expect(() => t('SELECT 1', 1)).toThrow(/0 placeholders but 1 parameter was given/)
    expect(() => t('SELECT ?')).toThrow(/1 placeholder but 0 parameters were given/)
  })
})

describe('named @name', () => {
  it('maps the names to $n in order of first appearance; one name twice is one $n', () => {
    expect(t('UPDATE t SET a = @a, b = @b WHERE c = @a', { a: 1, b: 2 })).toEqual({
      text: 'UPDATE t SET a = $1, b = $2 WHERE c = $1',
      values: [1, 2],
    })
  })

  it('an extra key in the object is ignored (as the SQLite driver does), a missing one is an error', () => {
    expect(t('SELECT @a', { a: 1, unused: 2 }).values).toEqual([1])
    expect(() => t('SELECT @a, @b', { a: 1 })).toThrow(/missing named parameter @b/)
  })

  it('a key that exists with the value undefined is present (it binds NULL), not missing', () => {
    expect(t('SELECT @a', { a: undefined }).values).toEqual([undefined])
  })

  it('needs exactly one plain object', () => {
    expect(() => t('SELECT @a', 1)).toThrow(/exactly one object/)
    expect(() => t('SELECT @a')).toThrow(/exactly one object/)
    expect(() => t('SELECT @a', { a: 1 }, { a: 2 })).toThrow(/exactly one object/)
    expect(() => t('SELECT @a', [1])).toThrow(/exactly one object/)
    expect(() => t('SELECT @a', new Date())).toThrow(/exactly one object/)
    expect(() => t('SELECT @a', Buffer.from('x'))).toThrow(/exactly one object/)
    expect(t('SELECT @a', Object.assign(Object.create(null) as object, { a: 1 })).values).toEqual([1])
  })

  it('a name takes letters, digits and underscore; the placeholder ends where the name ends', () => {
    expect(t('SELECT @a_1,@b2)', { a_1: 1, b2: 2 }).text).toBe('SELECT $1,$2)')
    expect(t('WHERE id=@id', { id: 5 }).text).toBe('WHERE id=$1')
  })

  it('? and @name in one statement are refused, in either order', () => {
    expect(() => t('SELECT ?, @a', { a: 1 })).toThrow(/cannot be mixed/)
    expect(() => t('SELECT @a, ?', { a: 1 })).toThrow(/cannot be mixed/)
  })
})

describe('text the scanner leaves alone (each next to a real placeholder)', () => {
  it('single-quoted text, with a doubled quote inside', () => {
    expect(t("SELECT '?', '@x', 'it''s ?' WHERE a = ?", 1).text).toBe("SELECT '?', '@x', 'it''s ?' WHERE a = $1")
    expect(() => t("SELECT 'it''s ?'", 1)).toThrow(/0 placeholders/)
  })

  it('double-quoted identifiers, with a doubled quote inside', () => {
    expect(t('SELECT "a?b", "c""?" FROM t WHERE x = ?', 1).text).toBe('SELECT "a?b", "c""?" FROM t WHERE x = $1')
  })

  it('an escape string E\'..\' reads a backslash as an escape, so \\\' does not end it', () => {
    expect(t("SELECT E'it\\'s ?' , ?", 1).text).toBe("SELECT E'it\\'s ?' , $1")
    expect(t("SELECT e'a\\\\' , ?", 1).text).toBe("SELECT e'a\\\\' , $1") // a\\ : the backslash is escaped, the quote ends the text
  })

  it('a standard string reads a backslash as a plain character (the quote after it ends the text)', () => {
    expect(t("SELECT 'a\\', ?", 1).text).toBe("SELECT 'a\\', $1")
  })

  it('an E at the end of a longer word does not make the next quote an escape string', () => {
    expect(t("SELECT name'x\\', ?", 1).text).toBe("SELECT name'x\\', $1")
  })

  it('a line comment, up to the end of the line (LF and CR)', () => {
    expect(t('SELECT 1 -- what? @x\n, ?', 1).text).toBe('SELECT 1 -- what? @x\n, $1')
    expect(t('SELECT 1 -- what?\r, ?', 1).text).toBe('SELECT 1 -- what?\r, $1')
    expect(t('SELECT 1 -- what?', ).text).toBe('SELECT 1 -- what?')
  })

  it('a block comment, nested ones included (PostgreSQL nests them)', () => {
    expect(t('SELECT /* ? */ ?', 1).text).toBe('SELECT /* ? */ $1')
    expect(t('SELECT /* a /* ? */ still comment ? */ ?', 1).text).toBe('SELECT /* a /* ? */ still comment ? */ $1')
  })

  it('a dollar-quoted body, anonymous and tagged', () => {
    expect(t('SELECT $$ ? @x $$, ?', 1).text).toBe('SELECT $$ ? @x $$, $1')
    expect(t('SELECT $tag$ ? $$ ? $tag$, ?', 1).text).toBe('SELECT $tag$ ? $$ ? $tag$, $1')
  })

  it('a dollar sign inside an identifier is part of it, not a quote', () => {
    expect(t('SELECT a$b, c$ FROM t WHERE x = ?', 1).text).toBe('SELECT a$b, c$ FROM t WHERE x = $1')
    expect(t('SELECT a$x$ FROM t WHERE y = ?', 1).text).toBe('SELECT a$x$ FROM t WHERE y = $1') // $x$ here is no opening tag
  })

  it('the cast ::, and the operators @@ and @>', () => {
    expect(t('SELECT a::text, ?::int FROM t', 1).text).toBe('SELECT a::text, $1::int FROM t')
    expect(t('SELECT 1 WHERE d @@ to_tsquery(?)', 'x').text).toBe('SELECT 1 WHERE d @@ to_tsquery($1)')
    expect(t('SELECT 1 WHERE j @> ?', '{}').text).toBe('SELECT 1 WHERE j @> $1')
    expect(t('SELECT 1 WHERE d @@to_tsquery(?)', 'x').text).toBe('SELECT 1 WHERE d @@to_tsquery($1)')
  })

  it('an unterminated text or comment swallows the rest (the server rejects the statement), it does not invent placeholders', () => {
    expect(t("SELECT 'abc ?").text).toBe("SELECT 'abc ?")
    expect(t('SELECT /* abc ?').text).toBe('SELECT /* abc ?')
  })
})

describe('what is refused', () => {
  it('a native $n outside a literal', () => {
    expect(() => t('SELECT $1', 1)).toThrow(/native \$n placeholder/)
    expect(() => t('SELECT ?, $2', 1)).toThrow(/native \$n placeholder/)
  })

  it('more parameters than PostgreSQL takes', () => {
    const n = PG_MAX_PARAMS + 1
    expect(() => t(Array(n).fill('?').join(','), ...Array(n).fill(1))).toThrow(/at most 65535/)
    expect(t(Array(PG_MAX_PARAMS).fill('?').join(','), ...Array(PG_MAX_PARAMS).fill(1)).values).toHaveLength(PG_MAX_PARAMS)
  })
})
