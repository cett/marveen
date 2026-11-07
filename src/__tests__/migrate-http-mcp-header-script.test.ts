// The command line around the migration: argument checking, one outcome line per file, the exit codes, and that
// no token is ever printed. The script runs in a throwaway tree whose dist/ modules are STUBS, so no vault is
// opened (the real vault shares one Keychain master key and must not be touched from a test).
//
// Privacy: neutral fixtures only; every secret value is invented.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-http-mcp-header.mjs', import.meta.url))
const VALUE = 'fixture-secret-value-0123456789'
let tree = ''

// A stub migration: reports the status the file name says, records the options it got into the status text.
const STUB_MIGRATE = `
export class MigrateOptionsError extends Error {}
const run = (kind) => (file, o) => {
  if (file.endsWith('refuse.json')) throw new MigrateOptionsError('the vault has no secret with that id')
  if (file.endsWith('boom.json')) throw new RangeError('boom ${VALUE}')
  if (file.endsWith('show-prefix.json')) return { file, status: 'prefix=' + JSON.stringify(o.prefix) + (o.apply ? ' apply' : ' dry') }
  const status = file.endsWith('bad.json') ? 'token-mismatch' : file.endsWith('badprefix.json') ? 'bad-prefix' : file.endsWith('dangling.json') ? 'dangling-link' : (o.apply ? kind + '-applied' : kind + '-dry')
  return { file, status }
}
export const migrateHttpHeaderFile = run('migrate')
export const revertHttpHeaderFile = run('revert')
`
const STUB_VAULT = `export const getSecret = () => '${VALUE}'`

function cli(args: string[]) {
  return spawnSync(process.execPath, [join(tree, 'scripts', 'migrate-http-mcp-header.mjs'), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: tree }, encoding: 'utf-8',
  })
}
const base = ['--server', 'svc', '--header', 'Authorization', '--secret', 'fixture-secret-a']

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), 'migrate-cli-'))
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'dist', 'web'), { recursive: true })
  copyFileSync(SCRIPT, join(tree, 'scripts', 'migrate-http-mcp-header.mjs'))
  writeFileSync(join(tree, 'dist', 'web', 'http-mcp-header-migrate.js'), STUB_MIGRATE)
  writeFileSync(join(tree, 'dist', 'web', 'vault.js'), STUB_VAULT)
})
afterEach(() => { rmSync(tree, { recursive: true, force: true }) })

describe('arguments', () => {
  it.each([
    ['nothing', []],
    ['no file', base],
    ['no secret', ['--server', 'svc', '--header', 'Authorization', 'a.json']],
    ['an unknown flag', [...base, '--force', 'a.json']],
    ['a flag whose value is another flag', ['--server', '--header', 'Authorization', '--secret', 'x', 'a.json']],
  ])('%s: usage on stderr, exit 2, stdout empty', (_label, args) => {
    const r = cli(args)
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('usage:')
  })
})

describe('--prefix', () => {
  it('is handed to the migration unchanged, a trailing space and an empty value included', () => {
    expect(cli([...base, '--apply', '--revert', '--prefix', 'Basic ', 'show-prefix.json']).stdout).toBe('prefix="Basic " apply\tshow-prefix.json\n')
    expect(cli([...base, '--apply', '--revert', '--prefix', '', 'show-prefix.json']).stdout).toBe('prefix="" apply\tshow-prefix.json\n')
  })

  it('works in either position and for a migration as well', () => {
    expect(cli([...base, '--prefix', 'Basic ', '--apply', 'show-prefix.json']).stdout).toBe('prefix="Basic " apply\tshow-prefix.json\n')
    expect(cli(['--prefix', 'Basic ', ...base, 'show-prefix.json']).stdout.startsWith('prefix="Basic " dry\t')).toBe(true)
  })

  it('left out, the option is not set at all (the library default applies)', () => {
    expect(cli([...base, '--apply', '--revert', 'show-prefix.json']).stdout).toBe('prefix=undefined apply\tshow-prefix.json\n')
  })

  it.each([
    ['no value at the end', [...base, 'a.json', '--prefix']],
    ['a flag in place of the value', [...base, '--prefix', '--apply', 'a.json']],
  ])('%s: usage on stderr, exit 2', (_label, args) => {
    const r = cli(args)
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('usage:')
    expect(r.stderr).toContain('--prefix')
  })
})

describe('output and exit codes', () => {
  it('is a dry run unless --apply, and says so', () => {
    const r = cli([...base, 'a.json', 'b.json'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('migrate-dry\ta.json\nmigrate-dry\tb.json\ndry run: nothing was written (add --apply)\n')
  })

  it('--apply reports the applied outcomes and prints no dry-run note', () => {
    const r = cli([...base, '--apply', 'a.json'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('migrate-applied\ta.json\n')
  })

  it('--revert uses the inverse', () => {
    expect(cli([...base, '--apply', '--revert', 'a.json']).stdout).toBe('revert-applied\ta.json\n')
  })

  it('a file that is not migratable makes the exit code 1, the other files are still reported', () => {
    const r = cli([...base, '--apply', 'bad.json', 'a.json'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('token-mismatch\tbad.json\nmigrate-applied\ta.json\n')
  })

  it('a prefix the helper would refuse makes the exit code 1 too, in a dry run as well', () => {
    for (const extra of [['--apply'], []]) {
      const r = cli([...base, ...extra, 'badprefix.json'])
      expect(r.status).toBe(1)
      expect(r.stdout.startsWith('bad-prefix\tbadprefix.json\n')).toBe(true)
    }
  })

  it('a dangling link makes the exit code 1', () => {
    const r = cli([...base, '--apply', 'dangling.json'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('dangling-link\tdangling.json\n')
  })

  it('two paths to the same real file are handled once, the second is reported as a duplicate (link, ./ and .. spellings)', () => {
    const realFile = join(tree, 'real.json')
    writeFileSync(realFile, '{}')
    symlinkSync(realFile, join(tree, 'link.json'))
    mkdirSync(join(tree, 'sub'))
    const spelled = join(tree, 'sub', '..', 'real.json')
    const r = cli([...base, '--apply', realFile, join(tree, 'link.json'), spelled, join(tree, 'other.json')])
    expect(r.status).toBe(0)
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      `migrate-applied\t${realFile}`,
      `duplicate\t${join(tree, 'link.json')}`,
      `duplicate\t${spelled}`,
      `migrate-applied\t${join(tree, 'other.json')}`,
    ])
  })

  it('the first spelling wins when the LINK comes first, and the dry-run note still shows', () => {
    const realFile = join(tree, 'real.json')
    writeFileSync(realFile, '{}')
    symlinkSync(realFile, join(tree, 'link.json'))
    const r = cli([...base, join(tree, 'link.json'), realFile])
    expect(r.stdout).toBe(`migrate-dry\t${join(tree, 'link.json')}\nduplicate\t${realFile}\ndry run: nothing was written (add --apply)\n`)
  })

  it('the same missing path given twice is also done once; two different missing paths are both reported', () => {
    const r = cli([...base, '--apply', 'a.json', 'a.json', 'b.json'])
    expect(r.stdout).toBe('migrate-applied\ta.json\nduplicate\ta.json\nmigrate-applied\tb.json\n')
  })

  it('refused options stop the run with exit 2 and a message that has no value', () => {
    const r = cli([...base, '--apply', 'refuse.json'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('refused: the vault has no secret with that id')
  })

  it('an unexpected error names the error type only, never its message', () => {
    const r = cli([...base, '--apply', 'boom.json'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('error\tboom.json\tRangeError')
    expect(r.stderr + r.stdout).not.toContain(VALUE)
  })
})
