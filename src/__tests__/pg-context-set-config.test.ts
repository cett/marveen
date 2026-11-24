// G3 cell 5, the static one: the tenant context is set in ONE place and in ONE shape. The dbx header says "never put
// set_config in the same statement as the work (a CTE)"; this cell enforces it instead of leaving it written. It reads the
// source, not a server (the order on a server is the cells of pg/rls-context-order.pg.test.ts).
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PG_CONTEXT_SETTINGS, PG_SET_CONTEXT_SQL } from '../db/pg/dbx.js'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Every non-test .ts file under src, as [path relative to src, text]. */
function sourceFiles(dir: string = SRC): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__') continue
      out.push(...sourceFiles(full))
    } else if (e.name.endsWith('.ts')) {
      out.push([path.relative(SRC, full), readFileSync(full, 'utf8')])
    }
  }
  return out
}

/** The code lines of a file with the comments taken out (a header may talk about set_config). */
const code = (text: string): string => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const CONTEXT_FILE = path.join('db', 'pg', 'dbx.ts')
const MIGRATOR_FILE = 'db-migrations-pg.ts'
// The SQLite to PostgreSQL copy tool opens its own transaction as the system context and sets ONE timeout of its own in it
// (the copy: statement_timeout off for the bulk load; the trigger step: lock_timeout). Exactly these two files, exactly these
// two settings: the allowance is not a pattern, a third file or an app.* setting is still a failure.
const COPY_TIMEOUT_FILES: Readonly<Record<string, string>> = {
  [path.join('db', 'pg-copy', 'copy.ts')]: 'statement_timeout',
  [path.join('db', 'pg-copy', 'triggers.ts')]: 'lock_timeout',
}

describe('set_config in the source', () => {
  const files = sourceFiles()

  it('is called in exactly four files: the facade (the context), the migration runner and the two copy tool files (their own timeouts)', () => {
    const callers = files.filter(([, text]) => /\bset_config\s*\(/.test(code(text))).map(([f]) => f).sort()
    expect(callers).toEqual([MIGRATOR_FILE, CONTEXT_FILE, ...Object.keys(COPY_TIMEOUT_FILES)].sort())
  })

  it('each copy tool file sets only its own timeout, transaction-local', () => {
    for (const [file, setting] of Object.entries(COPY_TIMEOUT_FILES)) {
      const text = code(files.find(([f]) => f === file)![1])
      const calls = [...text.matchAll(/set_config\(\s*'([^']+)'\s*,[^)]*,\s*(true|false)\s*\)/g)]
      expect(calls.map((m) => m[1]), file).toEqual([setting])
      expect(calls.every((m) => m[2] === 'true'), `${file}: transaction-local`).toBe(true)
    }
  })

  it('names an app.* setting only in the facade, and the migration runner only sets its own timeouts', () => {
    const names = (text: string): string[] => [...code(text).matchAll(/set_config\(\s*'([^']+)'/g)].map((m) => m[1]!)
    const byFile = new Map(files.map(([f, text]) => [f, names(text)]))
    expect(byFile.get(CONTEXT_FILE)!.every((n) => n.startsWith('app.'))).toBe(true)
    expect([...new Set(byFile.get(MIGRATOR_FILE)!)].sort()).toEqual(['lock_timeout', 'statement_timeout'])
    for (const [f, n] of byFile) {
      if (f !== CONTEXT_FILE) expect(n.filter((x) => x.startsWith('app.')), f).toEqual([])
    }
  })

  it('PG_SET_CONTEXT_SQL is the one statement that sets the five settings: transaction-local, in order, and nothing else', () => {
    const calls = [...PG_SET_CONTEXT_SQL.matchAll(/set_config\('([^']+)', \$(\d), (true|false)\)/g)]
    expect(calls.map((m) => m[1])).toEqual([...PG_CONTEXT_SETTINGS])
    expect(calls.map((m) => m[2])).toEqual(['1', '2', '3', '4', '5'])
    expect(calls.every((m) => m[3] === 'true')).toBe(true) // true = transaction-local: it cannot stay on a pooled connection
    // a bare SELECT of the five calls: no second statement, no FROM, no CTE, no work
    expect(PG_SET_CONTEXT_SQL).toMatch(/^SELECT set_config\(/)
    expect(PG_SET_CONTEXT_SQL).not.toMatch(/;|\bFROM\b|\bWITH\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bSELECT\b.*\bSELECT\b/i)
    expect(PG_SET_CONTEXT_SQL.replace(/set_config\('[^']+', \$\d, true\)/g, '').replace(/^SELECT[\s,]*$/, '')).toBe('')
  })

  it('the migration runner sets the system context right after BEGIN, before the file body and the version row', () => {
    const lines = code(files.find(([f]) => f === MIGRATOR_FILE)![1]).split('\n')
    const at = (re: RegExp): number => lines.findIndex((l) => re.test(l))
    const begin = at(/client\.query\('BEGIN'\)/)
    const context = at(/text:\s*PG_SET_CONTEXT_SQL\s*,\s*values:.*role:\s*'system'/)
    const body = at(/client\.query\(file\.sql\)/)
    const version = at(/INSERT INTO schema_version/)
    expect(begin).toBeGreaterThan(-1)
    expect(context).toBeGreaterThan(begin)
    expect(body).toBeGreaterThan(context)
    expect(version).toBeGreaterThan(body)
    // nothing between BEGIN and the context but the try that guards it: no statement of the runner's own comes first
    expect(lines.slice(begin + 1, context).filter((l) => /client\.query\(/.test(l))).toEqual([])
  })

  it('PG_SET_CONTEXT_SQL is only ever sent as a statement of its own, never combined with other text', () => {
    for (const [f, text] of files) {
      for (const line of code(text).split('\n')) {
        if (!line.includes('PG_SET_CONTEXT_SQL')) continue
        if (f === CONTEXT_FILE && /^export const PG_SET_CONTEXT_SQL =\s*$/.test(line)) continue // the definition
        if (/^export \{[^}]*\bPG_SET_CONTEXT_SQL\b[^}]*\} from /.test(line)) continue // a re-export names it, it does not use it
        // the runner's lazy load names it too (the facade module pulls the driver in, see applyOne); the USE line is checked below
        if (/^\s*const \{[^}]*\bPG_SET_CONTEXT_SQL\b[^}]*\} = await import\('\.\/db\/pg\/dbx\.js'\)$/.test(line) && f === MIGRATOR_FILE) continue
        // the copy tool names it in a plain import of the facade module; the USE line is checked below. Two files only.
        if (/^import \{[^}]*\bPG_SET_CONTEXT_SQL\b[^}]*\} from '\.\.\/pg\/dbx\.js'$/.test(line) && (f === path.join('db', 'pg-copy', 'copy.ts') || f === path.join('db', 'pg-copy', 'check.ts'))) continue
        // a use is `{ text: PG_SET_CONTEXT_SQL, values: ... }`: the constant alone as the text
        expect(line, `${f}: ${line.trim()}`).toMatch(/\btext:\s*PG_SET_CONTEXT_SQL\s*,\s*values:/)
      }
    }
  })
})
