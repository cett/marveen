// A header that is not the usual "Bearer " form ("Basic ", or a bare token) must come back exactly on a revert.
// The prefix lives in the helper command the migration wrote, and a revert rebuilds that command to recognise its
// own work, so it has to be told the prefix: the library takes `opts.prefix`, the command line takes --prefix.
// With no prefix given the revert assumes "Bearer " and, for another form, does not recognise the helper and
// leaves the file alone (a known limit, pinned below so it cannot turn into a silent rewrite).
//
// Privacy: neutral fixtures only; every secret value is invented.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateHttpHeaderFile, revertHttpHeaderFile, MigrateOptionsError, type MigrateOptions,
} from '../web/http-mcp-header-migrate.js'

const TOKEN = 'fixture-live-token-0123456789'
let dir = ''

const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  server: 'svc', header: 'Authorization', secretId: 'fixture-secret-a', apply: true,
  nodePath: '/fixture/bin/node', home: '/fixture/home',
  secretValue: (id) => (id === 'fixture-secret-a' ? TOKEN : null),
  ...over,
})
const doc = (value: string) => ({
  numStartups: 7,
  mcpServers: { svc: { type: 'http', url: 'https://mcp.example.test/x', headers: { Authorization: value, 'X-Keep': 'k' } } },
})
const put = (value: string): string => {
  const p = join(dir, `f-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify(doc(value), null, 2))
  return p
}
const read = (p: string) => JSON.parse(readFileSync(p, 'utf-8'))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'http-revert-prefix-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe.each([
  ['Basic ', 'Basic '],
  ['a bare token', ''],
  ['a longer scheme', 'Token scheme='],
])('a header in the form: %s', (_label, prefix) => {
  it('is restored exactly by a revert that is given the prefix', () => {
    const f = put(`${prefix}${TOKEN}`)
    expect(migrateHttpHeaderFile(f, opts()).status).toBe('migrated')
    expect(read(f).mcpServers.svc.headers).toEqual({ 'X-Keep': 'k' })
    expect(revertHttpHeaderFile(f, opts({ prefix })).status).toBe('reverted')
    expect(read(f)).toEqual(doc(`${prefix}${TOKEN}`)) // deep-equal to the original, helper gone
  })

  it('a revert dry run with the prefix says would-revert and writes nothing', () => {
    const f = put(`${prefix}${TOKEN}`)
    migrateHttpHeaderFile(f, opts())
    const before = readFileSync(f, 'utf-8')
    expect(revertHttpHeaderFile(f, opts({ apply: false, prefix })).status).toBe('would-revert')
    expect(readFileSync(f, 'utf-8')).toBe(before)
  })

  it('a second --apply on the migrated file is already-migrated when the prefix is given', () => {
    const f = put(`${prefix}${TOKEN}`)
    migrateHttpHeaderFile(f, opts())
    expect(migrateHttpHeaderFile(f, opts({ prefix })).status).toBe('already-migrated')
  })

  if (prefix !== 'Bearer ') {
    it('known limit: with NO prefix given the helper is not recognised, and the file is left alone', () => {
      const f = put(`${prefix}${TOKEN}`)
      migrateHttpHeaderFile(f, opts())
      const before = readFileSync(f, 'utf-8')
      expect(revertHttpHeaderFile(f, opts()).status).toBe('other-helper')
      expect(migrateHttpHeaderFile(f, opts()).status).toBe('other-helper')
      expect(readFileSync(f, 'utf-8')).toBe(before)
    })

    it('a WRONG prefix is not recognised either, and nothing is written', () => {
      const f = put(`${prefix}${TOKEN}`)
      migrateHttpHeaderFile(f, opts())
      const before = readFileSync(f, 'utf-8')
      expect(revertHttpHeaderFile(f, opts({ prefix: 'Other ' })).status).toBe('other-helper')
      expect(readFileSync(f, 'utf-8')).toBe(before)
    })
  }
})

describe('the usual Bearer form is unchanged', () => {
  it('a revert without a prefix restores it, with the explicit prefix too', () => {
    const f = put(`Bearer ${TOKEN}`)
    migrateHttpHeaderFile(f, opts())
    expect(revertHttpHeaderFile(f, opts()).status).toBe('reverted')
    expect(read(f)).toEqual(doc(`Bearer ${TOKEN}`))
    migrateHttpHeaderFile(f, opts())
    expect(revertHttpHeaderFile(f, opts({ prefix: 'Bearer ' })).status).toBe('reverted')
    expect(read(f)).toEqual(doc(`Bearer ${TOKEN}`))
  })
})

describe('a prefix option the helper would refuse is rejected before any file is read', () => {
  it.each([
    ['33 characters', 'x'.repeat(33)],
    ['a tab', 'Basic\t'],
    ['a newline', 'Basic\n'],
    ['a NUL', 'Basic\0'],
    ['non-ASCII', 'Basic é'],
  ])('%s', (_label, prefix) => {
    const f = put(`Bearer ${TOKEN}`)
    const before = readFileSync(f, 'utf-8')
    for (const fn of [migrateHttpHeaderFile, revertHttpHeaderFile]) {
      for (const path of [f, join(dir, 'does-not-exist.json')]) {
        expect(() => fn(path, opts({ prefix }))).toThrow(MigrateOptionsError)
      }
    }
    expect(readFileSync(f, 'utf-8')).toBe(before)
  })

  it('the error message never carries the prefix or the token', () => {
    let message = ''
    try { revertHttpHeaderFile(join(dir, 'x.json'), opts({ prefix: `secret-looking-${'y'.repeat(30)}` })) } catch (e) { message = String((e as Error).message) }
    expect(message).not.toBe('')
    expect(message).not.toContain('secret-looking')
    expect(message).not.toContain(TOKEN)
  })

  it('the longest allowed prefix (32) and the empty one are accepted', () => {
    const f = put(`${'x'.repeat(32)}${TOKEN}`)
    migrateHttpHeaderFile(f, opts())
    expect(revertHttpHeaderFile(f, opts({ prefix: 'x'.repeat(32) })).status).toBe('reverted')
    expect(() => revertHttpHeaderFile(f, opts({ prefix: '' }))).not.toThrow()
  })
})
