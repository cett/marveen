// The migration and the headers helper must agree on the prefix. The migration copies the prefix out of the old
// static header into the helper command; if the helper then refuses that argument, the static header is already
// gone and the server silently loses its authentication (and a revert cannot restore a prefix it cannot build).
//
// The property: for every static header the migration turns into a helper command (status `migrated`), the
// arguments of that command are accepted by the helper's own parser. And the converse: a prefix the parser
// refuses is never migrated, the file stays as it was, and a dry run says so too.
//
// Privacy: neutral fixtures only; every secret value is invented.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../web/vault.js', () => ({ getSecret: vi.fn(() => null) }))

import { migrateHttpHeaderFile, type MigrateOptions } from '../web/http-mcp-header-migrate.js'
import { parseHelperArgs } from '../web/http-mcp-header-helper.js'
import { isValidHelperPrefix, MAX_PREFIX } from '../web/http-mcp-header-rules.js'

const TOKEN = 'fixture-live-token-0123456789'
let dir = ''

const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  server: 'svc', header: 'Authorization', secretId: 'fixture-secret-a', apply: true,
  nodePath: '/fixture/bin/node', home: '/fixture/home',
  secretValue: (id) => (id === 'fixture-secret-a' ? TOKEN : null),
  ...over,
})
const put = (prefix: string): string => {
  const p = join(dir, `f-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify({ mcpServers: { svc: { type: 'http', url: 'https://mcp.example.test/x', headers: { Authorization: `${prefix}${TOKEN}` } } } }, null, 2))
  return p
}
const server = (p: string) => JSON.parse(readFileSync(p, 'utf-8')).mcpServers.svc

// Undo the POSIX single quoting of buildHelperCommand: 'it'\''s' is the one word it's. Only words made of
// quoted runs and the escaped quote occur in the command; the unquoted words (env, -i, --secret) are plain.
function shellWords(cmd: string): string[] {
  const words: string[] = []
  let cur = ''
  let inWord = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1)
      cur += cmd.slice(i + 1, end)
      inWord = true
      i = end
    } else if (c === '\\' && cmd[i + 1] === "'") {
      cur += "'"
      inWord = true
      i++
    } else if (c === ' ') {
      if (inWord) words.push(cur)
      cur = ''
      inWord = false
    } else {
      cur += c
      inWord = true
    }
  }
  if (inWord) words.push(cur)
  return words
}
const helperArgv = (cmd: string): string[] => {
  const words = shellWords(cmd)
  return words.slice(words.findIndex(w => w.endsWith('vault-http-header-helper.mjs')) + 1)
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'http-prefix-agree-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// The expectation is written out per row, NOT derived from isValidHelperPrefix: a test that asks the validator
// what it should say would pass for any rule, however wrong.
const PREFIXES: Array<[string, string, boolean]> = [
  ['the usual bearer form', 'Bearer ', true],
  ['a bare token', '', true],
  ['another scheme', 'Token ', true],
  ['a prefix with a quote in it', "it's ", true],
  ['a prefix with a double quote and a dollar', 'a"$ ', true],
  ['exactly the longest allowed prefix (32)', 'x'.repeat(32), true],
  ['one character over the longest allowed (33)', 'x'.repeat(33), false],
  ['a long prefix, far over', 'Bearer '.repeat(10), false],
  ['a tab', 'Bearer\t', false],
  ['a newline', 'Bearer\n', false],
  ['a NUL', 'Bearer\0', false],
  ['DEL', 'Bearer\x7f', false],
  ['a non-ASCII letter', 'Bearer \u00e9', false],
  ['a non-ASCII space', 'Bearer\u00a0', false],
  ['a letter above Latin-1', 'Bearer \u0151', false],
]

describe('the migration only writes a command the helper accepts', () => {
  it.each(PREFIXES)('%s', (_label, prefix, accepted) => {
    const f = put(prefix)
    const before = readFileSync(f, 'utf-8')
    const dry = migrateHttpHeaderFile(f, opts({ apply: false }))
    const applied = migrateHttpHeaderFile(f, opts({ apply: true }))
    if (accepted) {
      expect(dry.status).toBe('would-migrate')
      expect(applied.status).toBe('migrated')
      // The property: the helper's own parser accepts what was written, and reads back the same prefix.
      const args = parseHelperArgs(helperArgv(server(f).headersHelper))
      expect(args).toEqual({ secretId: 'fixture-secret-a', header: 'Authorization', prefix })
      expect(server(f).headers).toBeUndefined()
    } else {
      // Judged in the dry run too, so the operator sees it BEFORE applying.
      expect(dry.status).toBe('bad-prefix')
      expect(applied.status).toBe('bad-prefix')
      expect(readFileSync(f, 'utf-8')).toBe(before) // nothing written, the static header is still there
    }
  })

  it('the validator and the helper parser never disagree, over every length and the whole ASCII range', () => {
    const agrees = (prefix: string) => {
      const parsed = parseHelperArgs(['--secret', 'fixture-secret-a', '--header', 'Authorization', '--prefix', prefix])
      return (parsed !== null) === isValidHelperPrefix(prefix)
    }
    for (let code = 0; code < 256; code++) expect(agrees(String.fromCharCode(code))).toBe(true)
    for (let len = 0; len <= MAX_PREFIX + 3; len++) expect(agrees('a'.repeat(len))).toBe(true)
    expect(agrees('é')).toBe(true)
    expect(agrees('\u{1F600}')).toBe(true)
  })

  it('the boundary: 32 printable characters migrate, 33 do not', () => {
    expect(migrateHttpHeaderFile(put('x'.repeat(32)), opts()).status).toBe('migrated')
    expect(migrateHttpHeaderFile(put('x'.repeat(33)), opts()).status).toBe('bad-prefix')
  })

  it('a token mismatch is still reported as a token mismatch, not as a prefix problem', () => {
    const p = join(dir, 'm.json')
    writeFileSync(p, JSON.stringify({ mcpServers: { svc: { type: 'http', url: 'u', headers: { Authorization: `${'x'.repeat(40)}other-token-0123456789` } } } }))
    expect(migrateHttpHeaderFile(p, opts()).status).toBe('token-mismatch')
  })
})
