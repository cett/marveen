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
const REASONS = new Set(['fts', 'vec', 'p2-4-concurrency', 'boot-twin', 'sqlite-only', 'sync-cache', 'raw-db', 'unported-sql'])
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

// The reason-code table of docs/db-facade.md ("The PostgreSQL test mode") is part of the contract: a hand-edited number
// drifted from the lists twice, so the table is parsed and compared with the real count of EXCLUDED, row by row, and its
// sum with EXCLUDED_BASELINE. The parse never matches vacuously: a table that is not found, a row that cannot be read, a
// duplicate or unknown code, a known code without a row are all problems.
const TABLE_HEADER = /^\|\s*Code\s*\|\s*Files\s*\|\s*Meaning\s*\|\s*$/
const TABLE_ROW = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(\d+)\s*\|/

function reasonCounts(excluded: Readonly<Record<string, string>>): Map<string, number> {
  const out = new Map<string, number>([...REASONS].map((r) => [r, 0]))
  for (const reason of Object.values(excluded)) out.set(reason, (out.get(reason) ?? 0) + 1)
  return out
}

/** Everything wrong between the table (and the "N are excluded" sentence) of `markdown` and the real counts. */
function tableProblems(markdown: string, counts: Map<string, number>, baseline: number): string[] {
  const lines = markdown.split('\n')
  const head = lines.findIndex((l) => TABLE_HEADER.test(l))
  if (head < 0) return ['the reason-code table (| Code | Files | Meaning |) is not found']
  const problems: string[] = []
  if (!/^\|[-|\s]+\|\s*$/.test(lines[head + 1] ?? '')) problems.push('the table header has no separator line')
  const rows = new Map<string, number>()
  for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const m = TABLE_ROW.exec(lines[i])
    if (!m) { problems.push(`unreadable table row: ${lines[i]}`); continue }
    if (rows.has(m[1])) problems.push(`duplicate row for ${m[1]}`)
    rows.set(m[1], Number(m[2]))
  }
  for (const [code, n] of counts) {
    if (!rows.has(code)) problems.push(`no row for ${code} (the list has ${n})`)
    else if (rows.get(code) !== n) problems.push(`${code}: the table says ${rows.get(code)}, the list has ${n}`)
  }
  for (const code of rows.keys()) if (!counts.has(code)) problems.push(`the table has a row for an unknown code ${code}`)
  const sum = [...rows.values()].reduce((a, b) => a + b, 0)
  if (sum !== baseline) problems.push(`the rows add up to ${sum}, EXCLUDED_BASELINE is ${baseline}`)
  const sentence = /(\d+) are excluded/.exec(markdown)
  if (!sentence) problems.push('the sentence "N are excluded" is not found')
  else if (Number(sentence[1]) !== baseline) problems.push(`the sentence says ${sentence[1]} are excluded, EXCLUDED_BASELINE is ${baseline}`)
  return problems
}

describe('the reason-code table of docs/db-facade.md matches the lists', () => {
  const counts = reasonCounts(EXCLUDED)
  const docs = readFileSync(path.join(ROOT, 'docs', 'db-facade.md'), 'utf8')

  it('every row is the real count of that reason code and the rows add up to EXCLUDED_BASELINE', () => {
    expect(tableProblems(docs, counts, EXCLUDED_BASELINE)).toEqual([])
  })

  describe('the check itself', () => {
    const rows = [...counts].map(([c, n]) => `| \`${c}\` | ${n} | meaning |`)
    const make = (body: string[], sentence = `${EXCLUDED_BASELINE} are excluded.`) =>
      ['text', '', '| Code | Files | Meaning |', '|---|---|---|', ...body, '', `Some files are ported, ${sentence}`].join('\n')
    const good = make(rows)

    it('accepts the table of the real counts', () => {
      expect(tableProblems(good, counts, EXCLUDED_BASELINE)).toEqual([])
    })

    it('a changed number is a problem, for the row and for the sum', () => {
      const [first] = [...counts].find(([, n]) => n > 0) ?? ['raw-db']
      const bad = good.replace(new RegExp(`(\\| \`${first}\` \\| )(\\d+)`), (_, a, n) => `${a}${Number(n) + 1}`)
      const problems = tableProblems(bad, counts, EXCLUDED_BASELINE)
      expect(problems.some((p) => p.startsWith(`${first}: the table says`))).toBe(true)
      expect(problems.some((p) => p.includes('add up'))).toBe(true)
    })

    it('a deleted row is a problem (a zero row too: fts has a row although it is empty)', () => {
      for (const [code] of counts) {
        const bad = make(rows.filter((r) => !r.startsWith(`| \`${code}\` |`)))
        expect(tableProblems(bad, counts, EXCLUDED_BASELINE).some((p) => p.startsWith(`no row for ${code}`)), code).toBe(true)
      }
    })

    it('an unknown code, a duplicate row and an unreadable row are problems', () => {
      expect(tableProblems(make([...rows, '| `new-code` | 0 | x |']), counts, EXCLUDED_BASELINE).some((p) => p.includes('unknown code new-code'))).toBe(true)
      expect(tableProblems(make([...rows, rows[0]]), counts, EXCLUDED_BASELINE).some((p) => p.startsWith('duplicate row'))).toBe(true)
      expect(tableProblems(make([...rows, '| raw-db | 3 | x |']), counts, EXCLUDED_BASELINE).some((p) => p.startsWith('unreadable table row'))).toBe(true)
    })

    it('never matches vacuously: no table, a renamed header, no separator, or no sentence is red', () => {
      expect(tableProblems('', counts, EXCLUDED_BASELINE)).toHaveLength(1)
      expect(tableProblems(good.replace('| Files |', '| Count |'), counts, EXCLUDED_BASELINE)[0]).toContain('not found')
      expect(tableProblems(good.replace('|---|---|---|\n', ''), counts, EXCLUDED_BASELINE).length).toBeGreaterThan(0)
      expect(tableProblems(good.replace(/\d+ are excluded\./, 'x.'), counts, EXCLUDED_BASELINE).some((p) => p.includes('not found'))).toBe(true)
    })

    it('a sentence with another number is a problem', () => {
      const bad = make(rows, `${EXCLUDED_BASELINE + 1} are excluded.`)
      expect(tableProblems(bad, counts, EXCLUDED_BASELINE).some((p) => p.startsWith('the sentence says'))).toBe(true)
    })
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
