// The partition of the useTestDb test files for the PostgreSQL module run (src/__tests__/helpers/pg-modules.ts): no server.
// Every file that imports the with-test-db helper is in exactly one list, a new one in neither is red, the lists hold
// no stale entry, and the number of excluded files can only go down. Also the wiring: the mode switch of the helper,
// the script and the CI step that run the PORTED list.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { load as yamlLoad } from 'js-yaml'
import { EXCLUDED, EXCLUDED_BASELINE, PORTED, listUseTestDbFiles } from './helpers/pg-modules.js'
import { testDbMode } from './helpers/with-test-db.js'

const ROOT = path.resolve(__dirname, '..', '..')
const REASONS = new Set(['fts', 'vec', 'p2-4-concurrency', 'boot-twin', 'raw-db', 'unported-sql'])
const listed = [...PORTED, ...Object.keys(EXCLUDED)]

describe('every useTestDb file is in exactly one list', () => {
  const files = listUseTestDbFiles(ROOT)

  it('the scan finds the files at all (a broken marker would make every other cell vacuous)', () => {
    expect(files.length).toBeGreaterThan(40)
    expect(files).toContain('src/__tests__/db-facade-tx.test.ts')
    expect(files).not.toContain('src/__tests__/artifacts-db.test.ts') // names the helper in a comment only
  })

  it('no useTestDb file is missing from both lists', () => {
    expect(files.filter((f) => !listed.includes(f))).toEqual([])
  })

  it('no file is in both lists, and none twice in PORTED', () => {
    expect(PORTED.filter((f) => f in EXCLUDED)).toEqual([])
    expect(new Set(PORTED).size).toBe(PORTED.length)
  })

  it('no stale entry: every listed file exists and still uses the helper', () => {
    expect(listed.filter((f) => !files.includes(f))).toEqual([])
  })

  it('every excluded file has a known reason code', () => {
    expect(Object.entries(EXCLUDED).filter(([, r]) => !REASONS.has(r))).toEqual([])
  })

  it('the excluded count is the baseline: it never goes up, and a port lowers the baseline in the same commit', () => {
    const n = Object.keys(EXCLUDED).length
    expect(n, 'a new excluded file: port it or fix the test, do not raise EXCLUDED_BASELINE').toBeLessThanOrEqual(EXCLUDED_BASELINE)
    expect(n, 'fewer files are excluded than the baseline says: lower EXCLUDED_BASELINE to the new count').toBe(EXCLUDED_BASELINE)
  })
})

describe('the PG module run is wired', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> }

  it('npm run test:pg-modules runs vitest with its own config', () => {
    expect(pkg.scripts['test:pg-modules']).toBe('vitest run --config vitest.pg-modules.config.ts')
  })

  it('the pg-parity CI job runs it, and the default jobs do not carry it', () => {
    const doc = yamlLoad(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf-8')) as {
      jobs: Record<string, { steps?: { run?: string }[] }>
    }
    const runs = (job: string): string[] => (doc.jobs[job]?.steps ?? []).map((s) => s.run ?? '')
    expect(runs('pg-parity').some((r) => r.includes('npm run test:pg-modules'))).toBe(true)
    for (const job of Object.keys(doc.jobs)) {
      if (job !== 'pg-parity') expect(runs(job).some((r) => r.includes('test:pg-modules'))).toBe(false)
    }
  })
})

describe('the config of the module run', () => {
  interface Cfg { test: { include?: string[]; env?: Record<string, string>; globalSetup?: string[]; passWithNoTests?: boolean } }
  const load = async (): Promise<Cfg> => (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, 'vitest.pg-modules.config.ts')).href) as { default: Cfg }).default

  it('runs exactly the PORTED list, in PG mode, behind the server check (a run on SQLite would be a false green)', async () => {
    const cfg = await load()
    expect(cfg.test.include).toEqual([...PORTED])
    expect(cfg.test.env?.MARVEEN_TEST_DB).toBe('pg')
    expect(cfg.test.globalSetup).toEqual(['./src/__tests__/pg/global-setup.ts'])
  })

  it('every ported file is a plain *.test.ts, so the default suite runs it on SQLite too (the double CI)', () => {
    expect(PORTED.filter((f) => !f.endsWith('.test.ts') || f.endsWith('.pg.test.ts'))).toEqual([])
  })
})

describe('the mode switch of useTestDb', () => {
  it('unset, empty and sqlite are SQLite; pg is PG', () => {
    expect(testDbMode({})).toBe('sqlite')
    expect(testDbMode({ MARVEEN_TEST_DB: '' })).toBe('sqlite')
    expect(testDbMode({ MARVEEN_TEST_DB: 'sqlite' })).toBe('sqlite')
    expect(testDbMode({ MARVEEN_TEST_DB: 'pg' })).toBe('pg')
  })

  it('any other value is an error, so a typo does not run SQLite while claiming PG', () => {
    for (const bad of ['PG', 'postgres', 'true', '1', ' pg']) {
      expect(() => testDbMode({ MARVEEN_TEST_DB: bad })).toThrow(/must be "pg" or "sqlite"/)
    }
  })
})
