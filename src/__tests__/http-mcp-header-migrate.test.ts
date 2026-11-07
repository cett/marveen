// The one-time move of an http MCP header from a live token to a vault-fed headersHelper, and its inverse.
// Real files in a temp dir; the vault is a function that returns an invented value. The points of every case:
//   - the file is only rewritten when it holds exactly the vault's token (no lost credential),
//   - the static header is GONE afterwards (a leftover one would be the fail-open path when the helper fails),
//   - no token ever shows up in a result or an error.
//
// Privacy: neutral fixtures only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migrateHttpHeaderFile, revertHttpHeaderFile, buildHelperCommand, MigrateOptionsError, type MigrateOptions,
} from '../web/http-mcp-header-migrate.js'

const TOKEN = 'fixture-live-token-0123456789'
const OTHER = 'fixture-live-token-0123456780' // one character different
const NODE = '/fixture/bin/node'
const HOME = '/fixture/home'
let dir = ''

const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  server: 'svc',
  header: 'Authorization',
  secretId: 'fixture-secret-a',
  apply: false,
  nodePath: NODE,
  home: HOME,
  secretValue: (id) => (id === 'fixture-secret-a' ? TOKEN : null),
  ...over,
})
const cmd = (over: Partial<Parameters<typeof buildHelperCommand>[0]> = {}) =>
  buildHelperCommand({ nodePath: NODE, home: HOME, secretId: 'fixture-secret-a', header: 'Authorization', prefix: 'Bearer ', ...over })

function put(name: string, content: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return p
}
const live = (headers: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  numStartups: 7,
  mcpServers: {
    other: { command: 'node', args: ['x'] },
    svc: { type: 'http', url: 'https://mcp.example.test/x', headers, ...extra },
  },
})
const read = (p: string) => readFileSync(p, 'utf-8')
const svc = (p: string) => JSON.parse(read(p)).mcpServers.svc

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'http-header-migrate-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('buildHelperCommand', () => {
  it('runs the helper with nothing but HOME and PATH, every argument single-quoted', () => {
    const c = cmd()
    expect(c.startsWith("env -i HOME='/fixture/home' PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' '/fixture/bin/node' '")).toBe(true)
    expect(c).toMatch(/\/scripts\/vault-http-header-helper\.mjs' --secret 'fixture-secret-a' --header 'Authorization' --prefix 'Bearer '$/)
  })

  it('a quote in a path cannot end the word', () => {
    const c = cmd({ home: "/fixture/o'brien" })
    expect(c).toContain("HOME='/fixture/o'\\''brien'")
  })

  it('carries the secret id, never a value', () => {
    expect(cmd()).not.toContain(TOKEN)
  })
})

describe('dry run (the default)', () => {
  it('reports what would change and writes nothing', () => {
    const f = put('a.json', live({ Authorization: `Bearer ${TOKEN}` }))
    const before = read(f)
    expect(migrateHttpHeaderFile(f, opts())).toEqual({ file: f, status: 'would-migrate' })
    expect(read(f)).toBe(before)
  })
})

describe('apply', () => {
  it('names the helper, removes the static header, keeps everything else', () => {
    const f = put('a.json', live({ Authorization: `Bearer ${TOKEN}`, 'X-Keep': 'keep' }))
    expect(migrateHttpHeaderFile(f, opts({ apply: true }))).toEqual({ file: f, status: 'migrated' })
    const s = svc(f)
    expect(s.headersHelper).toBe(cmd())
    expect(s.headers).toEqual({ 'X-Keep': 'keep' })
    expect(JSON.parse(read(f)).mcpServers.other).toEqual({ command: 'node', args: ['x'] })
    expect(JSON.parse(read(f)).numStartups).toBe(7)
    expect(read(f)).not.toContain(TOKEN)
  })

  it('an emptied headers object is dropped', () => {
    const f = put('a.json', live({ Authorization: `Bearer ${TOKEN}` }))
    migrateHttpHeaderFile(f, opts({ apply: true }))
    expect(svc(f)).not.toHaveProperty('headers')
  })

  it('the prefix in the helper command is the one the file had; a bare token gets an empty prefix', () => {
    const f1 = put('a.json', live({ Authorization: `Token ${TOKEN}` }))
    migrateHttpHeaderFile(f1, opts({ apply: true }))
    expect(svc(f1).headersHelper).toBe(cmd({ prefix: 'Token ' }))
    const f2 = put('b.json', live({ Authorization: TOKEN }))
    migrateHttpHeaderFile(f2, opts({ apply: true }))
    expect(svc(f2).headersHelper).toBe(cmd({ prefix: '' }))
  })

  it('a differently-cased static header is the same header and goes too', () => {
    const f = put('a.json', live({ authorization: `Bearer ${TOKEN}` }))
    expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('migrated')
    expect(read(f)).not.toContain(TOKEN)
    expect(svc(f)).not.toHaveProperty('headers')
  })

  it('writes the file with mode 0600', () => {
    const f = put('a.json', live({ Authorization: `Bearer ${TOKEN}` }))
    chmodSync(f, 0o644)
    migrateHttpHeaderFile(f, opts({ apply: true }))
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('is idempotent: a second run changes nothing', () => {
    const f = put('a.json', live({ Authorization: `Bearer ${TOKEN}` }))
    migrateHttpHeaderFile(f, opts({ apply: true }))
    const once = read(f)
    expect(migrateHttpHeaderFile(f, opts({ apply: true }))).toEqual({ file: f, status: 'already-migrated' })
    expect(read(f)).toBe(once)
  })

  it('after the move no file in a set holds a token or a static Authorization (the at-rest check)', () => {
    const files = ['a', 'b', 'c'].map(n => put(`${n}.json`, live({ Authorization: `Bearer ${TOKEN}`, 'X-Keep': 'k' })))
    for (const f of files) expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('migrated')
    for (const f of files) {
      expect(read(f)).not.toContain(TOKEN)
      expect(read(f)).not.toMatch(/Bearer [A-Za-z0-9]/)
      expect(Object.keys(svc(f).headers ?? {}).map(k => k.toLowerCase())).not.toContain('authorization')
    }
  })
})

describe('a helper that is already there', () => {
  it('ours with a leftover static header: the header is removed (fail-open path closed)', () => {
    const f = put('a.json', live({ Authorization: 'Bearer stale-literal-value', 'X-Keep': 'k' }, { headersHelper: cmd() }))
    expect(migrateHttpHeaderFile(f, opts())).toEqual({ file: f, status: 'would-migrate' })
    expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('migrated')
    expect(svc(f).headers).toEqual({ 'X-Keep': 'k' })
    expect(svc(f).headersHelper).toBe(cmd())
    expect(read(f)).not.toContain('stale-literal-value')
  })

  it('somebody else\'s helper (another secret, another command) is left alone', () => {
    for (const helper of ['/usr/local/bin/their-helper', cmd({ secretId: 'fixture-secret-b' }), 5]) {
      const f = put('a.json', live({ Authorization: `Bearer ${TOKEN}` }, { headersHelper: helper }))
      const before = read(f)
      expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('other-helper')
      expect(read(f)).toBe(before)
    }
  })
})

describe('a file that does not hold the vault token is left alone', () => {
  it.each([
    ['a different token', `Bearer ${OTHER}`],
    ['a token that only starts the same', `Bearer ${TOKEN}-extra`],
    ['a literal that is not a token', 'Bearer literal'],
    ['an old-style placeholder', 'Bearer ${FIXTURE_TOKEN}'],
  ])('%s', (_label, auth) => {
    const f = put('a.json', live({ Authorization: auth }))
    const before = read(f)
    expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('token-mismatch')
    expect(read(f)).toBe(before)
  })
})

describe('files and servers that are not there', () => {
  it('no file / unreadable JSON', () => {
    expect(migrateHttpHeaderFile(join(dir, 'absent.json'), opts({ apply: true })).status).toBe('no-file')
    const bad = put('bad.json', '{ nope')
    expect(migrateHttpHeaderFile(bad, opts({ apply: true })).status).toBe('unreadable')
    expect(read(bad)).toBe('{ nope')
  })

  it('no such server, or a stdio server of that name', () => {
    expect(migrateHttpHeaderFile(put('a.json', { mcpServers: {} }), opts({ apply: true })).status).toBe('no-server')
    expect(migrateHttpHeaderFile(put('b.json', { mcpServers: { svc: { command: 'node' } } }), opts({ apply: true })).status).toBe('no-server')
    expect(migrateHttpHeaderFile(put('c.json', '[]'), opts({ apply: true })).status).toBe('no-server')
  })

  it('no such header, or a header that is not a string', () => {
    expect(migrateHttpHeaderFile(put('a.json', live({})), opts({ apply: true })).status).toBe('no-header')
    expect(migrateHttpHeaderFile(put('b.json', live({ Authorization: 5 })), opts({ apply: true })).status).toBe('no-header')
  })
})

describe('options that are refused before any file is read', () => {
  const f = () => put('a.json', live({ Authorization: `Bearer ${TOKEN}` }))

  it.each([
    ['a header name with a space', { header: 'Bad Name' }],
    ['an empty header name', { header: '' }],
    ['a secret id with a quote', { secretId: "x';y" }],
    ['an SSH key id', { secretId: 'ssh-key-fixture' }],
    ['a secret id that is not in the vault', { secretId: 'fixture-secret-missing' }],
    ['a vault secret that is too short to match safely', { secretValue: () => 'short' }],
    ['a relative node path', { nodePath: 'node' }],
    ['a relative home', { home: 'home' }],
  ])('%s', (_label, over) => {
    const p = f()
    const before = read(p)
    expect(() => migrateHttpHeaderFile(p, opts({ apply: true, ...over }))).toThrow(MigrateOptionsError)
    expect(read(p)).toBe(before)
  })

  it('an error message never carries the token', () => {
    try {
      migrateHttpHeaderFile(f(), opts({ apply: true, secretId: 'fixture-secret-missing' }))
      expect.unreachable()
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(TOKEN)
    }
  })
})

describe('revert: the exact inverse', () => {
  it('puts the static header back from the vault and removes the helper', () => {
    const original = live({ Authorization: `Bearer ${TOKEN}`, 'X-Keep': 'k' })
    const f = put('a.json', original)
    migrateHttpHeaderFile(f, opts({ apply: true }))
    expect(revertHttpHeaderFile(f, opts())).toEqual({ file: f, status: 'would-revert' })
    expect(revertHttpHeaderFile(f, opts({ apply: true }))).toEqual({ file: f, status: 'reverted' })
    expect(JSON.parse(read(f))).toEqual(original)
  })

  it('a file that was never migrated, or has another helper, is left alone', () => {
    const f1 = put('a.json', live({ Authorization: `Bearer ${TOKEN}` }))
    expect(revertHttpHeaderFile(f1, opts({ apply: true })).status).toBe('not-migrated')
    const f2 = put('b.json', live({}, { headersHelper: '/usr/local/bin/their-helper' }))
    const before = read(f2)
    expect(revertHttpHeaderFile(f2, opts({ apply: true })).status).toBe('other-helper')
    expect(read(f2)).toBe(before)
  })
})

describe('no token in any result', () => {
  it('statuses name the file and the outcome only', () => {
    const f = put('a.json', live({ Authorization: `Bearer ${TOKEN}` }))
    for (const apply of [false, true, true]) {
      expect(JSON.stringify(migrateHttpHeaderFile(f, opts({ apply })))).not.toContain(TOKEN)
    }
    expect(JSON.stringify(revertHttpHeaderFile(f, opts({ apply: true })))).not.toContain(TOKEN)
  })
})
