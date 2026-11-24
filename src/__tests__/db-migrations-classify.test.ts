// classifyPgSchema (db-migrations-pg.ts): the four outcomes of the schema check, on fixtures only (no database).
// The G3 cutover rules: NEWER is the case a rolled-back build meets, DIVERGED is never overridable, BEHIND is the normal
// deploy-then-migrate state.
import { describe, it, expect } from 'vitest'
import { classifyPgSchema, type AppliedRow, type PgMigrationFile } from '../db-migrations-pg.js'

const file = (version: number, sql = `-- ${version}`): PgMigrationFile => ({
  version,
  description: `m${version}`,
  path: `/fixtures/${String(version).padStart(4, '0')}_m.sql`,
  sql,
  checksum: `sum-${version}`,
})

const row = (version: number, checksum: string | null = `sum-${version}`): [number, AppliedRow] => [version, { version, checksum }]

describe('classifyPgSchema', () => {
  it('CURRENT: every shipped file applied, nothing else', () => {
    const c = classifyPgSchema([file(1), file(2)], new Map([row(1), row(2)]))
    expect(c.state).toBe('CURRENT')
    expect(c.problem).toBeUndefined()
  })

  it('CURRENT: an empty build on an empty database', () => {
    expect(classifyPgSchema([], new Map()).state).toBe('CURRENT')
  })

  it('BEHIND: shipped files not applied yet, nothing unknown in the database', () => {
    const c = classifyPgSchema([file(1), file(2)], new Map([row(1)]))
    expect(c.state).toBe('BEHIND')
    expect(c.missing).toEqual([2])
  })

  it('BEHIND: an empty database under a build that ships files', () => {
    expect(classifyPgSchema([file(1)], new Map()).state).toBe('BEHIND')
  })

  it('NEWER: every shipped file applied, and the database has a migration this build does not ship; the refusal names both versions', () => {
    const c = classifyPgSchema([file(1)], new Map([row(1), row(2)]))
    expect(c.state).toBe('NEWER')
    expect(c.orphans).toEqual([2])
    expect(c.problem).toMatch(/PG migration 2 is applied but its file is gone/)
    expect(c.problem).toMatch(/the database is at migration 2, this build ships up to 1/)
  })

  it('DIVERGED: a checksum changed after the migration was applied', () => {
    const c = classifyPgSchema([file(1), file(2)], new Map([row(1, 'other'), row(2)]))
    expect(c.state).toBe('DIVERGED')
    expect(c.problem).toMatch(/PG migration 1 .* changed after it was applied/)
  })

  it('DIVERGED: a shipped file missing below an applied one (merged out of order)', () => {
    const c = classifyPgSchema([file(1), file(2), file(3)], new Map([row(1), row(3)]))
    expect(c.state).toBe('DIVERGED')
    expect(c.problem).toMatch(/PG migration 2 .*not applied but 3 is/)
  })

  it('DIVERGED: unknown migrations AND missing shipped ones: no override can apply, the state is not NEWER', () => {
    const c = classifyPgSchema([file(1), file(2)], new Map([row(3)]))
    expect(c.state).toBe('DIVERGED')
    expect(c.problem).toMatch(/PG migration 3 is applied but its file is gone/)
    expect(c.problem).toMatch(/shipped migration 1 is not applied/)
  })

  it('a checksum change wins over NEWER: a known file that changed is always DIVERGED', () => {
    const c = classifyPgSchema([file(1)], new Map([row(1, 'other'), row(2)]))
    expect(c.state).toBe('DIVERGED')
  })
})
