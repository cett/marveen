// A new SQLite migration needs a PostgreSQL twin: the two chains are held together without a server (file names only).
// Each "wrong" cell is a synthetic pair of directory listings; the first cell reads the real directories.
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PG_BASELINE_SQLITE_VERSION, PG_TO_SQLITE_OFFSET, twinProblems } from './helpers/pg-twins.js'

const sqliteDir = fileURLToPath(new URL('../migrations', import.meta.url))
const pgDir = fileURLToPath(new URL('../migrations-pg', import.meta.url))

// the chains as they are today: the baseline (SQLite 1..95 collapsed into PG 0001) and one twin pair
const SQLITE = ['0001_baseline.sql', '0094_skill_revision_review.sql', '0095_skill_revision_prev_state.sql', '0096_schedules_author.sql']
const PG = ['0001_baseline.sql', '0002_schedules_author.sql']

describe('the real migration directories', () => {
  it('every SQLite migration above the baseline version has its PG twin, and nothing else is there', () => {
    expect(twinProblems(readdirSync(sqliteDir), readdirSync(pgDir))).toEqual([])
  })

  it('the count of SQLite files above 95 equals the count of PG files above 0001, and the offset is 94', () => {
    const above = (names: string[], from: number) => names.filter((n) => /^\d{4,}_.+\.sql$/.test(n) && parseInt(n, 10) > from).length
    expect(above(readdirSync(sqliteDir), PG_BASELINE_SQLITE_VERSION)).toBe(above(readdirSync(pgDir), 1))
    expect(PG_TO_SQLITE_OFFSET).toBe(94)
  })
})

describe('twinProblems', () => {
  it('the matching pair is clean (positive pair for every cell below)', () => {
    expect(twinProblems(SQLITE, PG)).toEqual([])
  })

  it('a SQLite migration without a PG twin is reported, and the message says which file to add', () => {
    const problems = twinProblems([...SQLITE, '0097_new_thing.sql'], PG)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('0097_new_thing.sql has no PostgreSQL twin')
    expect(problems[0]).toContain('add src/migrations-pg/0003_new_thing.sql')
  })

  it('removing the existing twin is reported (the missing-twin mutant)', () => {
    const problems = twinProblems(SQLITE, ['0001_baseline.sql'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('0096_schedules_author.sql has no PostgreSQL twin')
    expect(problems[0]).toContain('src/migrations-pg/0002_schedules_author.sql')
  })

  it('a PG migration without a SQLite twin is reported', () => {
    const problems = twinProblems(SQLITE, [...PG, '0003_orphan.sql'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('0003_orphan.sql has no SQLite twin')
    expect(problems[0]).toContain('0097_*')
  })

  it('a twin under the wrong number is reported twice: the missing one and the stray one', () => {
    const problems = twinProblems(SQLITE, ['0001_baseline.sql', '0003_schedules_author.sql'])
    expect(problems).toHaveLength(2)
  })

  it('a SQLite migration at or below the baseline version needs no twin', () => {
    expect(twinProblems(['0095_x.sql', '0094_y.sql'], ['0001_baseline.sql'])).toEqual([])
  })

  it('a missing baseline file is reported', () => {
    expect(twinProblems(SQLITE, ['0002_schedules_author.sql'])).toEqual(['src/migrations-pg has no 0001 baseline file'])
  })

  it('files that are not migrations (a README, a .sql with no number) do not count', () => {
    expect(twinProblems([...SQLITE, 'README.md', 'notes.sql'], [...PG, 'README.md'])).toEqual([])
  })
})
