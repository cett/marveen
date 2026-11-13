// Ratchet: in production SQL, SUM( appears only as CAST(SUM(...) AS BIGINT) (or with a ::bigint cast), or on the
// reviewed exception list below. In PostgreSQL sum() of a bigint column is numeric, which the driver hands back as a
// STRING: two rows added in JavaScript concatenate (123 + 456 = 123456) and a chart or a budget silently shows the wrong
// number. The fix is per statement (a numeric never silently becomes a number: there is no adapter-level parser), so a
// new bare SUM( is the way the bug comes back. The exception list is exact: an exception that no longer matches fails
// too, so the list cannot rot.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

export interface SumSite { file: string; line: number; text: string }

/** The bare SUM( sites of one source text: not a comment line, not inside CAST( ... ) and not followed by ::bigint. */
export function bareSumSites(file: string, source: string): SumSite[] {
  const out: SumSite[] = []
  source.split('\n').forEach((text, i) => {
    const trimmed = text.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    const code = text.replace(/\s\/\/.*$/, '')
    // inside src/db any spelling counts (SQL is written in both cases); elsewhere only the upper-case SQL spelling (a
    // python one-liner in a string is not a statement)
    for (const m of code.matchAll(file.replace(/\\/g, '/').startsWith('src/db/') ? /\bSUM\(/gi : /\bSUM\(/g)) {
      const before = code.slice(0, m.index)
      if (/CAST\(\s*$/i.test(before)) continue
      // SUM(...)::bigint: find the matching close paren and look behind the cast
      let depth = 0
      let end = -1
      for (let k = (m.index ?? 0) + 3; k < code.length; k++) {
        if (code[k] === '(') depth++
        else if (code[k] === ')') { depth--; if (depth === 0) { end = k; break } }
      }
      if (end >= 0 && /^\s*::\s*bigint\b/i.test(code.slice(end + 1))) continue
      out.push({ file, line: i + 1, text: trimmed })
    }
  })
  return out
}

interface Exception { file: string; match: RegExp; count: number; reason: string }

const EXCEPTIONS: Exception[] = [
  { file: 'src/db/audit.ts', match: /SUM\(CASE WHEN /, count: 4,
    reason: 'a sum of the integers 1 and 0: sum() of an integer column is bigint, which the driver returns as a number' },
  { file: 'src/db/audit.ts', match: /^SUM\((input|output|cache_read|cache_creation|thinking)_tokens\),$/, count: 10,
    reason: 'INSERT INTO ... SELECT inside the database: the numeric is assigned to the bigint rollup column, it never reaches JavaScript' },
  { file: 'src/db/import.ts', match: /SUM\(LENGTH\(content\)\)/, count: 1,
    reason: 'LENGTH() is an integer, so the sum is a bigint, which the driver returns as a number' },
]

function productionFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === 'generated') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...productionFiles(full))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('the scanner itself', () => {
  it('flags a bare SUM, lets a cast, a ::bigint cast and a comment through', () => {
    expect(bareSumSites('f.ts', 'SELECT SUM(x) AS t FROM a')).toHaveLength(1)
    expect(bareSumSites('f.ts', 'SELECT COALESCE(SUM(x), 0) AS t FROM a')).toHaveLength(1)
    expect(bareSumSites('src/db/f.ts', 'SELECT sum(x) AS t FROM a')).toHaveLength(1)
    expect(bareSumSites('src/web/f.ts', 'python3 -c "print(sum(1 for x in r))"')).toHaveLength(0)
    expect(bareSumSites('src/web/f.ts', 'SELECT SUM(x) FROM a')).toHaveLength(1)
    expect(bareSumSites('f.ts', 'SELECT CAST(SUM(x) AS BIGINT) AS t FROM a')).toHaveLength(0)
    expect(bareSumSites('f.ts', 'SELECT CAST( SUM(x + y) AS BIGINT) AS t FROM a')).toHaveLength(0)
    expect(bareSumSites('f.ts', 'SELECT SUM(x + COALESCE(y, 0))::bigint AS t FROM a')).toHaveLength(0)
    expect(bareSumSites('f.ts', 'SELECT SUM(x)::numeric AS t FROM a')).toHaveLength(1)
    expect(bareSumSites('f.ts', '// SUM(x) is numeric')).toHaveLength(0)
    expect(bareSumSites('f.ts', ' * every SUM(x) is cast')).toHaveLength(0)
    expect(bareSumSites('f.ts', 'const a = 1 // SUM(x) in a trailing comment')).toHaveLength(0)
  })

  it('counts two bare sums on one line twice, and a cast one next to a bare one once', () => {
    expect(bareSumSites('f.ts', 'SELECT SUM(a), SUM(b) FROM t')).toHaveLength(2)
    expect(bareSumSites('f.ts', 'SELECT CAST(SUM(a) AS BIGINT), SUM(b) FROM t')).toHaveLength(1)
  })
})

describe('production SQL: SUM( only as a cast or on the exception list', () => {
  const sites = productionFiles(SRC).flatMap((f) => bareSumSites(path.relative(path.resolve(SRC, '..'), f), readFileSync(f, 'utf8')))

  it('every bare SUM( of src/ is covered by an exception, and every exception matches exactly its count', () => {
    const unexplained: SumSite[] = []
    const used = new Map<Exception, number>()
    for (const s of sites) {
      const ex = EXCEPTIONS.find((e) => e.file === s.file && e.match.test(s.text))
      if (!ex) { unexplained.push(s); continue }
      used.set(ex, (used.get(ex) ?? 0) + 1)
    }
    expect(unexplained.map((s) => `${s.file}:${s.line}  ${s.text}`),
      'a bare SUM( in production SQL: cast it (CAST(SUM(x) AS BIGINT)) or, when the sum never reaches JavaScript as a numeric, add a reviewed exception with the reason').toEqual([])
    for (const ex of EXCEPTIONS) {
      expect(used.get(ex) ?? 0, `exception for ${ex.file} ${ex.match} (${ex.reason})`).toBe(ex.count)
    }
  })

  it('the cast form is in use (the scan finds the production files at all)', () => {
    const casted = productionFiles(SRC).filter((f) => /CAST\(SUM\(|SUM\([^\n]*\)::bigint/.test(readFileSync(f, 'utf8'))).length
    expect(casted).toBeGreaterThanOrEqual(4) // observability, tasks, token-shadow, cost-budgets
  })
})
