// The switch of the app-role module run (helpers/pg-app-role.ts, testPgRole): a typo in MARVEEN_TEST_PG_ROLE must not
// run the module suite quietly as the superuser, which would turn the app-role CI step green without testing anything.
import { describe, expect, it } from 'vitest'
import { TEST_PG_ROLE_ENV, testPgRole } from './helpers/pg-app-role.js'

describe('testPgRole: only "app" switches the role, a typo is an error', () => {
  it('unset, empty and "admin" are the superuser run', () => {
    expect(testPgRole({})).toBe('admin')
    expect(testPgRole({ [TEST_PG_ROLE_ENV]: '' })).toBe('admin')
    expect(testPgRole({ [TEST_PG_ROLE_ENV]: 'admin' })).toBe('admin')
  })

  it('"app" is the app-role run', () => {
    expect(testPgRole({ [TEST_PG_ROLE_ENV]: 'app' })).toBe('app')
  })

  // The match is exact: case and plural are typos, not spellings.
  for (const typo of ['APP', 'App', 'apps', ' app', 'app ', 'marveen_app', 'superuser', '0', 'true']) {
    it(`"${typo}" throws and names the variable`, () => {
      expect(() => testPgRole({ [TEST_PG_ROLE_ENV]: typo })).toThrow(new RegExp(`${TEST_PG_ROLE_ENV} must be`))
    })
  }

  it('reads process.env by default', () => {
    const before = process.env[TEST_PG_ROLE_ENV]
    try {
      process.env[TEST_PG_ROLE_ENV] = 'apps'
      expect(() => testPgRole()).toThrow(/must be/)
      process.env[TEST_PG_ROLE_ENV] = 'app'
      expect(testPgRole()).toBe('app')
    } finally {
      if (before === undefined) delete process.env[TEST_PG_ROLE_ENV]
      else process.env[TEST_PG_ROLE_ENV] = before
    }
  })
})
