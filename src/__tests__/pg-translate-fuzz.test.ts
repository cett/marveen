// The translator over every SQL statement text of src/db/ (read from the source, no server): a hole in the scanner
// would turn into silently wrong SQL on the PostgreSQL side, so this is the net under the hand-written cells. The
// expected placeholder count comes from a second, independent counter (regexes that strip literals and comments),
// not from the translator itself, so a shared blind spot is less likely.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translatePlaceholders } from '../db/pg/translate.js'
import { extractSqlLiterals } from './helpers/sql-literals.js'

const dbDir = fileURLToPath(new URL('../db', import.meta.url))

// the oracle: literals and comments out (first token wins, left to right), then count
const strip = (sql: string): string => sql.replace(/--[^\n\r]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, ' ')
const countQuestion = (sql: string): number => (strip(sql).match(/\?/g) ?? []).length
const namesOf = (sql: string): string[] => [...new Set([...strip(sql).matchAll(/(?<!@)@([A-Za-z_]\w*)/g)].map((m) => m[1]!))]

function statements(): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = []
  for (const f of readdirSync(dbDir).filter((n) => n.endsWith('.ts')).sort()) {
    for (const lit of extractSqlLiterals(readFileSync(path.join(dbDir, f), 'utf-8'))) out.push({ file: f, line: lit.line, text: lit.text })
  }
  return out
}

describe('the literal extractor (so the fuzz cell does not pass by reading nothing)', () => {
  it('finds SQL in quotes, templates with interpolation, and skips comments and regex literals', () => {
    const src = [
      "const a = db.prepare('SELECT 1 FROM t WHERE a = ?')",
      '// "SELECT never FROM comment"',
      '/* "SELECT never2" */',
      "const re = /'SELECT nope/g",
      'const b = `UPDATE t SET x = ${col} WHERE id = ${id.toString()} AND y = @y`',
      "const c = x / 2; const d = 'DELETE FROM t'",
    ].join('\n')
    const got = extractSqlLiterals(src).map((l) => l.text)
    expect(got).toEqual(['SELECT 1 FROM t WHERE a = ?', 'UPDATE t SET x = x WHERE id = x AND y = @y', 'DELETE FROM t'])
  })

  it('reads the real src/db/ and finds a substantial number of statements', () => {
    const all = statements()
    expect(all.length).toBeGreaterThan(800) // 903 when this was written
    expect(all.filter((s) => s.text.includes('?')).length).toBeGreaterThan(600) // 702
    expect(all.filter((s) => /@[A-Za-z_]/.test(s.text)).length).toBeGreaterThan(5) // 8
  })
})

describe('every statement of src/db/', () => {
  it('translates with the number of placeholders an independent count finds, and leaves no ? or @name outside a literal', () => {
    const bad: string[] = []
    let positional = 0
    let named = 0
    for (const s of statements()) {
      const q = countQuestion(s.text)
      const names = namesOf(s.text)
      const where = `${s.file}:${s.line}`
      try {
        if (q > 0 && names.length > 0) {
          bad.push(`${where} mixes ? and @name (the facade surface does not allow it)`)
          continue
        }
        if (names.length > 0) {
          named++
          const params = Object.fromEntries(names.map((n) => [n, 1]))
          const r = translatePlaceholders(s.text, [params])
          check(r, names.length, where, bad)
        } else {
          positional += q > 0 ? 1 : 0
          const r = translatePlaceholders(s.text, Array(q).fill(1))
          check(r, q, where, bad)
        }
      } catch (err) {
        bad.push(`${where} threw: ${(err as Error).message}`)
      }
    }
    expect(bad).toEqual([])
    expect(positional).toBeGreaterThan(600)
    expect(named).toBeGreaterThan(5)
  })
})

function check(r: { text: string; values: unknown[] }, expected: number, where: string, bad: string[]): void {
  if (r.values.length !== expected) bad.push(`${where} ${r.values.length} values, expected ${expected}`)
  const left = strip(r.text)
  if (left.includes('?')) bad.push(`${where} a ? is left in the output`)
  if (/(?<!@)@[A-Za-z_]/.test(left)) bad.push(`${where} an @name is left in the output`)
  const used = [...new Set([...left.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
  const want = Array.from({ length: expected }, (_, i) => i + 1)
  if (JSON.stringify(used) !== JSON.stringify(want)) bad.push(`${where} the $n used are ${used.join(',')}, expected 1..${expected}`)
}
