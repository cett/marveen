// A config path that is a SYMLINK. The main agent's isolated config is one (a link to the main session's config),
// so the migration meets links on a real machine. The atomic write renames a temp file over its target; over a
// link that would replace the LINK with a plain file and leave the real file, still holding the live token,
// untouched. The migration therefore resolves the real path and writes THERE, and the link stays a link.
//
// Real files and links in a temp dir; the vault is a function that returns an invented value.
// Privacy: neutral fixtures only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readlinkSync, readdirSync,
  chmodSync, statSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateHttpHeaderFile, revertHttpHeaderFile, type MigrateOptions } from '../web/http-mcp-header-migrate.js'

const TOKEN = 'fixture-live-token-0123456789'
let dir = ''

const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  server: 'svc', header: 'Authorization', secretId: 'fixture-secret-a', apply: true,
  nodePath: '/fixture/bin/node', home: '/fixture/home',
  secretValue: (id) => (id === 'fixture-secret-a' ? TOKEN : null),
  ...over,
})
const LIVE = JSON.stringify({
  numStartups: 7,
  mcpServers: { svc: { type: 'http', url: 'https://mcp.example.test/x', headers: { Authorization: `Bearer ${TOKEN}` } } },
}, null, 2)

function real(name = 'real.json', mode = 0o644): string {
  const p = join(dir, name)
  writeFileSync(p, LIVE)
  chmodSync(p, mode)
  return p
}
const link = (to: string, name: string): string => {
  const p = join(dir, name)
  symlinkSync(to, p)
  return p
}
const isLink = (p: string) => lstatSync(p).isSymbolicLink()
const svc = (p: string) => JSON.parse(readFileSync(p, 'utf-8')).mcpServers.svc
const mode = (p: string) => statSync(p).mode & 0o777

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'http-header-symlink-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('migrating through a symlink', () => {
  it('the real file is migrated, the link is still a link to the same target, no plain file took its place', () => {
    const target = real()
    const l = link(target, 'link.json')
    const r = migrateHttpHeaderFile(l, opts())
    expect(r).toEqual({ file: l, status: 'migrated' }) // the status names the path the caller gave
    expect(isLink(l)).toBe(true)
    expect(readlinkSync(l)).toBe(target)
    expect(isLink(target)).toBe(false)
    expect(svc(target).headers).toBeUndefined()
    expect(svc(target).headersHelper).toContain('vault-http-header-helper.mjs')
    // Reading through the link shows the same migrated file.
    expect(readFileSync(l, 'utf-8')).toBe(readFileSync(target, 'utf-8'))
    expect(readFileSync(target, 'utf-8')).not.toContain(TOKEN)
  })

  it('the real file ends at mode 0600 whatever it was, and no temp file is left next to it', () => {
    const target = real('real.json', 0o644)
    const l = link(target, 'link.json')
    migrateHttpHeaderFile(l, opts())
    expect(mode(target)).toBe(0o600)
    expect(readdirSync(dir).sort()).toEqual(['link.json', 'real.json'])
  })

  it('the real file may sit in ANOTHER directory: the temp file is made there, the link directory stays clean', () => {
    mkdirSync(join(dir, 'main'))
    mkdirSync(join(dir, 'agent'))
    const target = real('main/config.json')
    const l = link(target, 'agent/config.json')
    expect(migrateHttpHeaderFile(l, opts()).status).toBe('migrated')
    expect(readdirSync(join(dir, 'agent'))).toEqual(['config.json'])
    expect(isLink(l)).toBe(true)
    expect(readdirSync(join(dir, 'main'))).toEqual(['config.json'])
    expect(svc(target).headers).toBeUndefined()
  })

  it('a chain of links, and a link to a directory that holds the config, both resolve to the real file', () => {
    const target = real()
    const l1 = link(target, 'l1.json')
    const l2 = link(l1, 'l2.json')
    expect(migrateHttpHeaderFile(l2, opts()).status).toBe('migrated')
    expect(isLink(l1)).toBe(true)
    expect(isLink(l2)).toBe(true)
    expect(svc(target).headers).toBeUndefined()

    mkdirSync(join(dir, 'cfg'))
    const inner = real('cfg/config.json')
    const dirLink = link(join(dir, 'cfg'), 'cfg-link')
    expect(migrateHttpHeaderFile(join(dirLink, 'config.json'), opts()).status).toBe('migrated')
    expect(isLink(dirLink)).toBe(true)
    expect(svc(inner).headers).toBeUndefined()
  })

  it('a dry run through a link writes nothing and says what it would do', () => {
    const target = real()
    const before = readFileSync(target, 'utf-8')
    const l = link(target, 'link.json')
    expect(migrateHttpHeaderFile(l, opts({ apply: false })).status).toBe('would-migrate')
    expect(readFileSync(target, 'utf-8')).toBe(before)
    expect(isLink(l)).toBe(true)
  })

  it('a second run through the link, or through the real path, is already-migrated', () => {
    const target = real()
    const l = link(target, 'link.json')
    migrateHttpHeaderFile(l, opts())
    const after = readFileSync(target, 'utf-8')
    expect(migrateHttpHeaderFile(l, opts()).status).toBe('already-migrated')
    expect(migrateHttpHeaderFile(target, opts()).status).toBe('already-migrated')
    expect(readFileSync(target, 'utf-8')).toBe(after)
  })

  it('a leftover static header next to our own helper is removed in the real file, the link survives', () => {
    const target = real()
    const l = link(target, 'link.json')
    migrateHttpHeaderFile(l, opts())
    const parsed = JSON.parse(readFileSync(target, 'utf-8'))
    parsed.mcpServers.svc.headers = { Authorization: `Bearer ${TOKEN}` }
    writeFileSync(target, JSON.stringify(parsed, null, 2))
    expect(migrateHttpHeaderFile(l, opts()).status).toBe('migrated')
    expect(svc(target).headers).toBeUndefined()
    expect(isLink(l)).toBe(true)
  })

  it('the token-mismatch and bad-prefix verdicts are the same through a link, and nothing is written', () => {
    const target = join(dir, 'other.json')
    writeFileSync(target, JSON.stringify({ mcpServers: { svc: { type: 'http', url: 'u', headers: { Authorization: 'Bearer something-else' } } } }))
    const before = readFileSync(target, 'utf-8')
    const l = link(target, 'link.json')
    expect(migrateHttpHeaderFile(l, opts()).status).toBe('token-mismatch')
    expect(readFileSync(target, 'utf-8')).toBe(before)
    expect(isLink(l)).toBe(true)
  })
})

describe('every status names the path the caller gave, not the resolved one', () => {
  it('also the statuses that come from reading the real file (no server, unreadable), through a link, both directions', () => {
    const noServer = join(dir, 'no-server.json')
    writeFileSync(noServer, JSON.stringify({ mcpServers: { elsewhere: { type: 'http', url: 'u' } } }))
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    const l1 = link(noServer, 'l-no-server.json')
    const l2 = link(broken, 'l-broken.json')
    for (const fn of [migrateHttpHeaderFile, revertHttpHeaderFile]) {
      expect(fn(l1, opts())).toEqual({ file: l1, status: 'no-server' })
      expect(fn(l2, opts())).toEqual({ file: l2, status: 'unreadable' })
    }
  })
})

describe('reverting through a symlink', () => {
  it('puts the static header back in the real file; the link stays a link', () => {
    const target = real()
    const l = link(target, 'link.json')
    migrateHttpHeaderFile(l, opts())
    expect(revertHttpHeaderFile(l, opts()).status).toBe('reverted')
    expect(isLink(l)).toBe(true)
    expect(readlinkSync(l)).toBe(target)
    expect(isLink(target)).toBe(false)
    expect(svc(target).headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(svc(target).headersHelper).toBeUndefined()
    expect(mode(target)).toBe(0o600)
    expect(readdirSync(dir).sort()).toEqual(['link.json', 'real.json'])
  })

  it('a revert dry run through a link writes nothing', () => {
    const target = real()
    const l = link(target, 'link.json')
    migrateHttpHeaderFile(l, opts())
    const before = readFileSync(target, 'utf-8')
    expect(revertHttpHeaderFile(l, opts({ apply: false })).status).toBe('would-revert')
    expect(readFileSync(target, 'utf-8')).toBe(before)
  })
})

describe('a link whose target is gone', () => {
  it('is reported as dangling-link, nothing is created at the link or at its target, in both directions', () => {
    const gone = join(dir, 'gone.json')
    const l = link(gone, 'link.json')
    for (const fn of [migrateHttpHeaderFile, revertHttpHeaderFile]) {
      for (const apply of [false, true]) {
        expect(fn(l, opts({ apply })).status).toBe('dangling-link')
      }
    }
    expect(isLink(l)).toBe(true)
    expect(readlinkSync(l)).toBe(gone)
    expect(existsSync(gone)).toBe(false)
    expect(readdirSync(dir)).toEqual(['link.json'])
  })

  it('a path that does not exist at all is still no-file (unchanged)', () => {
    expect(migrateHttpHeaderFile(join(dir, 'nothing.json'), opts()).status).toBe('no-file')
  })

  it('a link loop has no target either: it is reported like a dangling link, not a crash', () => {
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    symlinkSync(b, a)
    symlinkSync(a, b)
    expect(migrateHttpHeaderFile(a, opts()).status).toBe('dangling-link')
    expect(isLink(a) && isLink(b)).toBe(true)
  })
})
