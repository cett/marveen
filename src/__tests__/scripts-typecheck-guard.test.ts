// The root tsconfig covers src/ only, so a command-line script that imports the database layer was never
// type-checked: when a db function became asynchronous, the script kept using the Promise as the row and nothing
// failed (an `await` was missing, a property was read off a Promise). tsconfig.scripts.json lists exactly the
// scripts that import src/db, and this guard has two parts:
//   1. the list is complete: a script that imports the database layer must be in it (a new one fails here);
//   2. the type-check of the list reports no error outside KNOWN_BROKEN. KNOWN_BROKEN is the warning mode: the
//      scripts that are known to be wrong today. It may only shrink: a listed script that type-checks clean
//      fails the guard until it is taken off the list.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Scripts whose type-check fails today (a Promise used as a row after the facade went asynchronous). */
const KNOWN_BROKEN: readonly string[] = ['scripts/migrate-legacy-store-docs.ts']

const DB_IMPORT = /from\s+['"]\.\.\/src\/db(?:\.js|\/[^'"]*)['"]/

function scriptsImportingTheDb(): string[] {
  return readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `scripts/${f}`)
    .filter((rel) => DB_IMPORT.test(readFileSync(join(ROOT, rel), 'utf8')))
    .sort()
}

function typecheckErrorFiles(): string[] {
  let out = ''
  try {
    out = execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.scripts.json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? '')
    if (!out) throw err // tsc itself did not run
  }
  const files = new Set<string>()
  for (const line of out.split('\n')) {
    const m = /^(\S+?)\(\d+,\d+\): error TS\d+/.exec(line)
    if (m) files.add(m[1]!)
  }
  return [...files].sort()
}

describe('scripts that import the database layer are type-checked', () => {
  it('the detector sees the real scripts (a guard over zero files passes vacuously)', () => {
    expect(scriptsImportingTheDb().length).toBeGreaterThan(4)
    expect(scriptsImportingTheDb()).toContain('scripts/dashboard-user.ts')
  })

  it('tsconfig.scripts.json lists every script that imports src/db, and nothing else', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'tsconfig.scripts.json'), 'utf8')) as { include: string[] }
    expect([...cfg.include].sort()).toEqual(scriptsImportingTheDb())
  })

  it('the type-check reports no error outside the known broken scripts, and the known list only shrinks', () => {
    const failing = typecheckErrorFiles()
    expect(failing.filter((f) => !KNOWN_BROKEN.includes(f))).toEqual([])
    expect(KNOWN_BROKEN.filter((f) => !failing.includes(f))).toEqual([])
  })

  it('the detector finds a db import and ignores other imports', () => {
    expect(DB_IMPORT.test("import { x } from '../src/db.js'")).toBe(true)
    expect(DB_IMPORT.test("import { x } from '../src/db/workspace.js'")).toBe(true)
    expect(DB_IMPORT.test("import { x } from '../src/dbx-like.js'")).toBe(false)
    expect(DB_IMPORT.test("import { x } from '../src/web/auth-sessions.js'")).toBe(false)
  })
})
