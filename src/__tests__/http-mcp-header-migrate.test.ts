// The one-time move of an http MCP header from a live token to a vault-fed placeholder. Real files in a temp
// dir; the vault is a function that returns an invented value. The point of every case is the same: the file
// is only rewritten when it holds exactly the vault's token, and no token ever shows up in a result or error.
//
// Privacy: neutral fixtures only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateHttpHeaderFile, MigrateOptionsError, type MigrateOptions } from '../web/http-mcp-header-migrate.js'

const TOKEN = 'fixture-live-token-0123456789'
const OTHER = 'fixture-live-token-0123456780' // one character different
let dir = ''

const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  server: 'svc',
  header: 'Authorization',
  varName: 'FIXTURE_TOKEN',
  secretId: 'fixture-secret-a',
  apply: false,
  secretValue: (id) => (id === 'fixture-secret-a' ? TOKEN : null),
  ...over,
})

function put(name: string, content: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return p
}
const live = (auth: string, extra: Record<string, unknown> = {}) => ({
  numStartups: 7,
  mcpServers: {
    other: { command: 'node', args: ['x'] },
    svc: { type: 'http', url: 'https://mcp.example.test/x', headers: { Authorization: auth, 'X-Keep': 'keep' }, ...extra },
  },
})
const read = (p: string) => readFileSync(p, 'utf-8')

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'http-header-migrate-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('dry run (the default)', () => {
  it('reports what would change and writes nothing', () => {
    const f = put('a.json', live(`Bearer ${TOKEN}`))
    const before = read(f)
    expect(migrateHttpHeaderFile(f, opts())).toEqual({ file: f, status: 'would-migrate' })
    expect(read(f)).toBe(before)
  })
})

describe('apply', () => {
  it('replaces the token with the placeholder, binds the variable, keeps everything else', () => {
    const f = put('a.json', live(`Bearer ${TOKEN}`))
    expect(migrateHttpHeaderFile(f, opts({ apply: true }))).toEqual({ file: f, status: 'migrated' })
    const after = JSON.parse(read(f))
    expect(after.mcpServers.svc.headers).toEqual({ Authorization: 'Bearer ${FIXTURE_TOKEN}', 'X-Keep': 'keep' })
    expect(after.mcpServers.svc.env).toEqual({ FIXTURE_TOKEN: 'vault:fixture-secret-a' })
    expect(after.mcpServers.other).toEqual({ command: 'node', args: ['x'] })
    expect(after.numStartups).toBe(7)
    expect(read(f)).not.toContain(TOKEN)
  })

  it('a header that is the bare token (no prefix) works too', () => {
    const f = put('a.json', live(TOKEN))
    expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('migrated')
    expect(JSON.parse(read(f)).mcpServers.svc.headers.Authorization).toBe('${FIXTURE_TOKEN}')
  })

  it('keeps an env block that is already there and adds to it', () => {
    const f = put('a.json', live(`Bearer ${TOKEN}`, { env: { KEEP_ME: 'x' } }))
    migrateHttpHeaderFile(f, opts({ apply: true }))
    expect(JSON.parse(read(f)).mcpServers.svc.env).toEqual({ KEEP_ME: 'x', FIXTURE_TOKEN: 'vault:fixture-secret-a' })
  })

  it('writes the file with mode 0600', () => {
    const f = put('a.json', live(`Bearer ${TOKEN}`))
    chmodSync(f, 0o644)
    migrateHttpHeaderFile(f, opts({ apply: true }))
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('is idempotent: a second run changes nothing', () => {
    const f = put('a.json', live(`Bearer ${TOKEN}`))
    migrateHttpHeaderFile(f, opts({ apply: true }))
    const once = read(f)
    expect(migrateHttpHeaderFile(f, opts({ apply: true }))).toEqual({ file: f, status: 'already-migrated' })
    expect(read(f)).toBe(once)
  })

  it('after the move no file in a set holds a token-shaped header (the at-rest check)', () => {
    const files = ['a', 'b', 'c'].map(n => put(`${n}.json`, live(`Bearer ${TOKEN}`)))
    for (const f of files) expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('migrated')
    for (const f of files) {
      expect(read(f)).not.toContain(TOKEN)
      expect(read(f)).not.toMatch(/Bearer (?!\$\{)/)
    }
  })
})

describe('a file that does not hold the vault token is left alone', () => {
  it.each([
    ['a different token', `Bearer ${OTHER}`],
    ['a token that only starts the same', `Bearer ${TOKEN}-extra`],
    ['a literal that is not a token', 'Bearer literal'],
    ['an already-placeholder header with no binding', 'Bearer ${FIXTURE_TOKEN}'],
  ])('%s', (_label, auth) => {
    const f = put('a.json', live(auth))
    const before = read(f)
    expect(migrateHttpHeaderFile(f, opts({ apply: true })).status).toBe('token-mismatch')
    expect(read(f)).toBe(before)
  })

  it('a placeholder header whose binding points at a different secret is not called migrated', () => {
    const f = put('a.json', live('Bearer ${FIXTURE_TOKEN}', { env: { FIXTURE_TOKEN: 'vault:fixture-secret-b' } }))
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
    const noHeader = put('a.json', { mcpServers: { svc: { type: 'http', url: 'https://mcp.example.test/x', headers: {} } } })
    expect(migrateHttpHeaderFile(noHeader, opts({ apply: true })).status).toBe('no-header')
    const notString = put('b.json', { mcpServers: { svc: { type: 'http', url: 'https://mcp.example.test/x', headers: { Authorization: 5 } } } })
    expect(migrateHttpHeaderFile(notString, opts({ apply: true })).status).toBe('no-header')
  })
})

describe('options that are refused before any file is read', () => {
  const f = () => put('a.json', live(`Bearer ${TOKEN}`))

  it.each([
    ['a variable name with a space', { varName: 'BAD NAME' }],
    ['a variable name that starts with a digit', { varName: '1BAD' }],
    ['a secret id with a quote', { secretId: "x';y" }],
    ['an SSH key id', { secretId: 'ssh-key-fixture' }],
    ['a secret id that is not in the vault', { secretId: 'fixture-secret-missing' }],
    ['a vault secret that is too short to match safely', { secretValue: () => 'short' }],
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

describe('no token in any result', () => {
  it('statuses name the file and the outcome only', () => {
    const f = put('a.json', live(`Bearer ${TOKEN}`))
    for (const apply of [false, true, true]) {
      expect(JSON.stringify(migrateHttpHeaderFile(f, opts({ apply })))).not.toContain(TOKEN)
    }
  })
})
