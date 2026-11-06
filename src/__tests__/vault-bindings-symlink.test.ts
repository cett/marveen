// The grantee of an MCP file when a directory on the way is a symbolic link (vault_secret_acl, migration 0090).
//
// granteeOfMcpFile judges the path as written; the discovery (readdirSync + statSync) follows links, and the
// write lands where the link points. verifiedGranteeOfMcpFile closes that gap: it realpaths the parent
// directory, computes the grantee again from the real location against the REAL base directories, and a
// different answer is null (refused by a non-empty list). This file uses the REAL file system in a temp
// directory (no node:fs mock), which on macOS also sits behind the /var -> /private/var link, so the real
// base directories are exercised by every test here.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const dirs = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-symlink-'))
  return { root, project: path.join(root, 'project'), agents: path.join(root, 'agents'), externals: [] as string[] }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: dirs.project, STORE_DIR: dirs.root }))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: (p: string, fallback: string) => { try { return require('node:fs').readFileSync(p, 'utf-8') } catch { return fallback } },
  AGENTS_BASE_DIR: dirs.agents,
}))
vi.mock('../web/dashboard-settings.js', () => ({ getExternalProjectPaths: () => dirs.externals }))
vi.mock('../web/vault.js', () => ({ getSecret: vi.fn().mockReturnValue('the-secret-value'), listSecrets: vi.fn().mockReturnValue([]) }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const store = vi.hoisted(() => ({ bindings: [] as Array<{ vaultSecretId: string, envVar: string, targets: unknown[] }>, acl: {} as Record<string, string[]> }))
vi.mock('../db/vault-bindings.js', () => ({
  listVaultBindings: vi.fn(() => store.bindings.map(b => ({ ...b }))),
  upsertVaultBinding: vi.fn(), deleteVaultBinding: vi.fn(), deleteVaultBindingsForSecret: vi.fn(),
}))
vi.mock('../db/vault-secret-acl.js', () => ({
  listSecretAcl: vi.fn((_t: string, id: string) => [...(store.acl[id] ?? [])]),
  replaceSecretAcl: vi.fn(), deleteSecretAcl: vi.fn(), listAllSecretAcls: vi.fn(() => ({})),
}))

import { granteeOfMcpFile, verifiedGranteeOfMcpFile, partitionTargetsByAcl, syncSecret, collectAllMcpFilePaths, isCanonicalMcpPath } from '../web/vault-bindings.js'
import { listAgentNames } from '../web/agent-config.js'

const A = join(dirs.agents, 'a')
const B = join(dirs.agents, 'b')
const EXT = join(dirs.root, 'ext-proj')
const MCP = '.mcp.json'
const body = JSON.stringify({ mcpServers: { srv: { command: 'orig' } } })

function put(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const f = join(dir, MCP)
  writeFileSync(f, body)
  return f
}

beforeEach(() => {
  rmSync(dirs.agents, { recursive: true, force: true })
  rmSync(EXT, { recursive: true, force: true })
  rmSync(join(dirs.root, 'ext-link'), { force: true })
  mkdirSync(dirs.agents, { recursive: true })
  mkdirSync(dirs.project, { recursive: true })
  dirs.externals = []
  vi.mocked(listAgentNames).mockReturnValue([])
  store.bindings = []
  store.acl = {}
})

afterAll(() => { rmSync(dirs.root, { recursive: true, force: true }) })

describe('verifiedGranteeOfMcpFile', () => {
  it('an ordinary file keeps its grantee, though the temp root itself may sit behind a link (real bases)', () => {
    put(A); put(B); put(dirs.project)
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBe('agent:a')
    expect(verifiedGranteeOfMcpFile(join(B, MCP))).toBe('agent:b')
    expect(verifiedGranteeOfMcpFile(join(dirs.project, MCP))).toBe('scope:project')
    expect(verifiedGranteeOfMcpFile(join(A, 'projects', 'p', MCP))).toBe('agent:a') // parent missing: lexical stands
  })

  it('projects/x -> ../../b: the lexical answer says a, the write lands in b, the verified answer is null', () => {
    put(A); put(B)
    mkdirSync(join(A, 'projects'))
    symlinkSync(join('..', '..', 'b'), join(A, 'projects', 'x'))
    const viaLink = join(A, 'projects', 'x', MCP)
    expect(granteeOfMcpFile(viaLink)).toBe('agent:a')
    expect(verifiedGranteeOfMcpFile(viaLink)).toBeNull()
  })

  it('a link higher up (agents/c -> b) is caught too', () => {
    put(B)
    symlinkSync('b', join(dirs.agents, 'c'))
    expect(granteeOfMcpFile(join(dirs.agents, 'c', MCP))).toBe('agent:c')
    expect(verifiedGranteeOfMcpFile(join(dirs.agents, 'c', MCP))).toBeNull()
  })

  it('a link that leaves every known place is null', () => {
    put(A)
    put(EXT)
    mkdirSync(join(A, 'projects'))
    symlinkSync(EXT, join(A, 'projects', 'out'))
    expect(verifiedGranteeOfMcpFile(join(A, 'projects', 'out', MCP))).toBeNull()
  })

  it('scope:external: the project path itself may be behind a link, a project link into an agent is refused', () => {
    put(EXT); put(A)
    symlinkSync(EXT, join(dirs.root, 'ext-link'))
    dirs.externals = [join(dirs.root, 'ext-link')]
    expect(verifiedGranteeOfMcpFile(join(dirs.root, 'ext-link', MCP))).toBe('scope:external')
    // the external project directory is a link into agent a: the lexical answer is external, the real one is a
    rmSync(join(dirs.root, 'ext-link'), { force: true })
    symlinkSync(A, join(dirs.root, 'ext-link'))
    expect(granteeOfMcpFile(join(dirs.root, 'ext-link', MCP))).toBe('scope:external')
    expect(verifiedGranteeOfMcpFile(join(dirs.root, 'ext-link', MCP))).toBeNull()
  })

  it('a directory that cannot be resolved (a link loop) is null, not the lexical answer', () => {
    symlinkSync('loop2', join(dirs.agents, 'loop1'))
    symlinkSync('loop1', join(dirs.agents, 'loop2'))
    expect(granteeOfMcpFile(join(dirs.agents, 'loop1', MCP))).toBe('agent:loop1')
    expect(verifiedGranteeOfMcpFile(join(dirs.agents, 'loop1', MCP))).toBeNull()
  })

  it('a file that is itself a link is null, whatever it points at (the sync reads through it)', () => {
    put(B)
    mkdirSync(A, { recursive: true })
    symlinkSync(join('..', 'b', MCP), join(A, MCP))
    expect(granteeOfMcpFile(join(A, MCP))).toBe('agent:a')
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBeNull()
    // a dangling link is a link too
    mkdirSync(join(dirs.agents, 'd'))
    symlinkSync('nowhere.json', join(dirs.agents, 'd', MCP))
    expect(verifiedGranteeOfMcpFile(join(dirs.agents, 'd', MCP))).toBeNull()
  })

  it('a path with `..` behind a link is null: the OS follows the link first, `resolve` does not', () => {
    put(A); put(B)
    mkdirSync(join(B, 'sub'))
    symlinkSync(join('..', 'b', 'sub'), join(A, 'x')) // a/x -> b/sub, so a/x/../.mcp.json really is b/.mcp.json
    const sneaky = join(A, 'x') + '/../' + MCP
    expect(granteeOfMcpFile(sneaky)).toBe('agent:a')
    expect(readFileSync(sneaky, 'utf-8')).toBe(body) // it opens b's file
    expect(verifiedGranteeOfMcpFile(sneaky)).toBeNull()
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBe('agent:a') // the canonical spelling of a's own file is fine
  })

  it('a second name of the same file (hard link, link count 2) is null, whichever name is asked', () => {
    const victim = put(B)
    mkdirSync(A, { recursive: true })
    linkSync(victim, join(A, MCP))
    expect(statSync(victim).nlink).toBe(2)
    expect(granteeOfMcpFile(join(A, MCP))).toBe('agent:a')
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBeNull()
    expect(verifiedGranteeOfMcpFile(victim)).toBeNull() // b's own name is an alias of a's: both are refused
  })

  it('a named pipe (FIFO) is null, and the check does not open it (this test would hang if it did)', () => {
    mkdirSync(A, { recursive: true })
    execFileSync('mkfifo', [join(A, MCP)])
    expect(lstatSync(join(A, MCP)).isFIFO()).toBe(true)
    expect(granteeOfMcpFile(join(A, MCP))).toBe('agent:a')
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBeNull()
  })

  it('a directory called .mcp.json is null', () => {
    mkdirSync(join(A, MCP), { recursive: true })
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBeNull()
  })

  it('a regular file with a single name keeps its grantee', () => {
    put(A)
    expect(statSync(join(A, MCP)).nlink).toBe(1)
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBe('agent:a')
  })

  it('a file that does not exist yet keeps its grantee (nothing to follow)', () => {
    mkdirSync(A, { recursive: true })
    expect(verifiedGranteeOfMcpFile(join(A, MCP))).toBe('agent:a')
  })

  it('stays null for what the lexical function already refuses, and for a non-string', () => {
    expect(verifiedGranteeOfMcpFile(join(dirs.root, 'elsewhere', MCP))).toBeNull()
    expect(verifiedGranteeOfMcpFile(undefined)).toBeNull()
    expect(verifiedGranteeOfMcpFile(42)).toBeNull()
  })
})

describe('isCanonicalMcpPath', () => {
  it('accepts a path resolve leaves alone and refuses everything else', () => {
    expect(isCanonicalMcpPath(join(A, MCP))).toBe(true)
    expect(isCanonicalMcpPath(join(A, 'x') + '/../' + MCP)).toBe(false)
    expect(isCanonicalMcpPath(A + '/./' + MCP)).toBe(false)
    expect(isCanonicalMcpPath(join(A, MCP) + '/')).toBe(false)
    expect(isCanonicalMcpPath(A + '//' + MCP)).toBe(false)
    expect(isCanonicalMcpPath('agents/a/' + MCP)).toBe(false) // relative
    expect(isCanonicalMcpPath('')).toBe(false)
    expect(isCanonicalMcpPath('/a\0b')).toBe(false)
    expect(isCanonicalMcpPath(undefined)).toBe(false)
    expect(isCanonicalMcpPath(42)).toBe(false)
  })
})

describe('what the discovery lists is canonical, so the check never refuses a discovered file', () => {
  it('real tree: every listed path is canonical and keeps its grantee when verified (an external path given with a trailing slash or a dot segment included)', () => {
    put(A); put(B); put(join(A, 'projects', 'p')); put(dirs.project); put(EXT)
    vi.mocked(listAgentNames).mockReturnValue(['a', 'b'])
    dirs.externals = [EXT + '/', join(dirs.root, 'sub', '..', 'ext-proj')]
    // only the temp tree is judged: the user-level file of the real home may be listed too, and is not ours
    const listed = collectAllMcpFilePaths().map(l => l.path).filter(p => p.startsWith(dirs.root))
    for (const p of [join(A, MCP), join(B, MCP), join(A, 'projects', 'p', MCP), join(dirs.project, MCP), join(EXT, MCP)]) expect(listed).toContain(p)
    for (const p of listed) {
      expect(isCanonicalMcpPath(p), p).toBe(true)
      expect(verifiedGranteeOfMcpFile(p), p).toBe(granteeOfMcpFile(p)) // never null just for being spelled oddly
    }
    expect(listed.map(p => verifiedGranteeOfMcpFile(p))).toEqual(expect.arrayContaining(['agent:a', 'agent:b', 'scope:project', 'scope:external']))
  })
})

describe('the list refuses a link target, end to end', () => {
  it('a path with a dot-dot behind a link: refused with its own message, b\'s file and a\'s file untouched', async () => {
    const own = put(A)
    const victim = put(B)
    mkdirSync(join(B, 'sub'))
    symlinkSync(join('..', 'b', 'sub'), join(A, 'x'))
    const sneaky = join(A, 'x') + '/../' + MCP
    store.acl['s1'] = ['agent:a']
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: sneaky, serverName: 'srv' }, { mcpFilePath: own, serverName: 'srv' }] }]
    const result = await syncSecret('s1')
    expect(result.updated).toBe(1) // only a's own canonical path
    expect(result.errors).toEqual([`Target not allowed for secret "s1": ${sneaky} (the path must be canonical: absolute, with no "." or ".." segment and no doubled or trailing separator)`])
    expect(readFileSync(victim, 'utf-8')).toBe(body)
    expect(JSON.parse(readFileSync(own, 'utf-8')).mcpServers.srv.env.K).toBe('vault:s1')
  })

  function linkSetup() {
    const own = put(A)
    const victim = put(B)
    mkdirSync(join(A, 'projects'))
    symlinkSync(join('..', '..', 'b'), join(A, 'projects', 'x'))
    return { own, victim, viaLink: join(A, 'projects', 'x', MCP) }
  }

  it('partitionTargetsByAcl: a is allowed, the link into b is refused with no grantee', () => {
    const { own, viaLink } = linkSetup()
    const t = (mcpFilePath: string) => ({ mcpFilePath, serverName: 'srv' })
    const { allowed, refused } = partitionTargetsByAcl(['agent:a'], [t(own), t(viaLink)])
    expect(allowed).toEqual([t(own)])
    expect(refused).toEqual([{ target: t(viaLink), grantee: null }])
  })

  it('syncSecret with a list for a: b\'s file is NOT written through the link, a\'s own file is', async () => {
    const { own, victim, viaLink } = linkSetup()
    store.acl['s1'] = ['agent:a']
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: viaLink, serverName: 'srv' }, { mcpFilePath: own, serverName: 'srv' }] }]
    const result = await syncSecret('s1')
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual([`Target not allowed for secret "s1": ${viaLink} (it must be a regular file with a single name in a known place: no link, no second name, no special file)`])
    expect(readFileSync(victim, 'utf-8')).toBe(body)
    expect(JSON.parse(readFileSync(own, 'utf-8')).mcpServers.srv.env.K).toBe('vault:s1')
  })

  const NAME_HINT = '(it must be a regular file with a single name in a known place: no link, no second name, no special file)'

  it('a hard link a/.mcp.json = b/.mcp.json (link count 2): refused with a list, b unchanged, the hard link stays as it was', async () => {
    const victim = put(B)
    const alias = join(A, MCP)
    mkdirSync(A, { recursive: true })
    linkSync(victim, alias)
    const inoBefore = statSync(victim).ino
    store.acl['s1'] = ['agent:a']
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: alias, serverName: 'srv' }] }]
    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual([`Target not allowed for secret "s1": ${alias} ${NAME_HINT}`])
    expect(readFileSync(victim, 'utf-8')).toBe(body)
    expect(statSync(alias).ino).toBe(inoBefore) // still the same file under both names
    expect(statSync(alias).nlink).toBe(2)
    expect(readFileSync(alias, 'utf-8')).toBe(body)
  })

  it('a hard link with an open secret (no list): goes through as before, the atomic write gives a its own file and b stays as it was', async () => {
    const victim = put(B)
    const alias = join(A, MCP)
    mkdirSync(A, { recursive: true })
    linkSync(victim, alias)
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: alias, serverName: 'srv' }] }]
    expect(await syncSecret('s1')).toEqual({ updated: 1, errors: [] })
    expect(JSON.parse(readFileSync(alias, 'utf-8')).mcpServers.srv.env.K).toBe('vault:s1')
    expect(readFileSync(victim, 'utf-8')).toBe(body)
  })

  it('a named pipe target with a list: refused and never opened (the sync does not hang)', async () => {
    mkdirSync(A, { recursive: true })
    const pipe = join(A, MCP)
    execFileSync('mkfifo', [pipe])
    store.acl['s1'] = ['agent:a']
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: pipe, serverName: 'srv' }] }]
    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual([`Target not allowed for secret "s1": ${pipe} ${NAME_HINT}`])
    expect(lstatSync(pipe).isFIFO()).toBe(true) // still a pipe, nothing replaced it
  })

  // A/.mcp.json is a link to B/.mcp.json: the sync would READ b's file through it. With a list it is refused.
  function fileLinkSetup() {
    const victim = put(B)
    mkdirSync(A, { recursive: true })
    const link = join(A, MCP)
    symlinkSync(join('..', 'b', MCP), link)
    return { victim, link }
  }

  it('partitionTargetsByAcl: a file that is a link into b is refused with no grantee, even for a listed owner', () => {
    const { link } = fileLinkSetup()
    const t = { mcpFilePath: link, serverName: 'srv' }
    expect(partitionTargetsByAcl(['agent:a'], [t])).toEqual({ allowed: [], refused: [{ target: t, grantee: null }] })
  })

  it('syncSecret with a list: neither b\'s file nor a\'s own file changes, and the link stays a link', async () => {
    const { victim, link } = fileLinkSetup()
    store.acl['s1'] = ['agent:a']
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: link, serverName: 'srv' }] }]
    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual([`Target not allowed for secret "s1": ${link} (it must be a regular file with a single name in a known place: no link, no second name, no special file)`])
    expect(readFileSync(victim, 'utf-8')).toBe(body)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(link, 'utf-8')).toBe(body)
  })

  it('an open secret (no list) still goes through a file link: the list is what gates it', async () => {
    const { victim, link } = fileLinkSetup()
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: link, serverName: 'srv' }] }]
    const result = await syncSecret('s1')
    expect(result).toEqual({ updated: 1, errors: [] })
    expect(JSON.parse(readFileSync(link, 'utf-8')).mcpServers.srv.env.K).toBe('vault:s1')
    expect(readFileSync(victim, 'utf-8')).toBe(body) // the atomic write replaces the link, it does not write through it
  })

  it('an open secret (no list) is unchanged: it still goes through the link, the list is what gates it', async () => {
    const { victim, viaLink } = linkSetup()
    store.bindings = [{ vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: viaLink, serverName: 'srv' }] }]
    const result = await syncSecret('s1')
    expect(result).toEqual({ updated: 1, errors: [] })
    expect(JSON.parse(readFileSync(victim, 'utf-8')).mcpServers.srv.env.K).toBe('vault:s1')
  })
})
