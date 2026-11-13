// The PG migration files are SQL, which tsc does not emit: the build script copies them next to the compiled runner.
// DEFAULT_PG_MIGRATIONS_DIR points at `migrations-pg` beside db-migrations-pg.js, so in dist/ the directory must be
// there or the runner finds nothing. No server: the cell reads the script text and the runner's default directory.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_PG_MIGRATIONS_DIR } from '../db-migrations-pg.js'

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

const buildScript = (): string => (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> }).scripts.build!

describe('the build copies the PG migration files to dist', () => {
  it('the script copies exactly the directory the runner reads by default, relative to the compiled module', () => {
    // src/db-migrations-pg.ts lives in src/, so the default directory relative to src/ is where dist/ needs it too
    const rel = path.relative(SRC, DEFAULT_PG_MIGRATIONS_DIR)
    expect(rel).toBe('migrations-pg')
    expect(buildScript()).toContain(`cp -r src/${rel} dist/${rel}`)
  })

  it('positive pair: the SQLite migration directory is still copied by the same script', () => {
    expect(buildScript()).toContain('cp -r src/migrations dist/migrations')
  })
})
