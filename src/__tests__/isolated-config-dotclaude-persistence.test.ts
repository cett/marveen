// The isolated config dir's .claude.json is the agent's OWN state. It used to be thrown away on every start:
// ~/.claude/.claude.json exists (the main session's config), so the symlink loop removed the agent's file, linked it
// to the main config, and the step-4 atomic write then replaced the link with a COPY of the main config. These tests
// pin the fix with a real temporary file system: a throwaway HOME, agent dirs and project root, nothing of the
// machine's real ~/.claude is read or written.

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, realpathSync,
  statSync, symlinkSync, chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger } from '../logger.js'

// One fixed sandbox for the whole file: PROJECT_ROOT/STORE_DIR are baked into module-level constants at import time
// (see main-agent-isolated-config.test.ts), so the sandbox is created once and its contents are reset per test.
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'dotclaude-persist-')))
const HOME = join(SANDBOX, 'home')
const PROJECT = join(SANDBOX, 'project')
const STORE = join(PROJECT, 'store')

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_ISOLATED_CONFIG' ? '1' : actual.getEffectiveSettingValue(key),
  }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: PROJECT, STORE_DIR: STORE }
})

const { ensureIsolatedChannelConfigDir, ensureMainAgentIsolatedConfigDir } = await import('../web/agent-process.js')
const { stampProjectTrustForDir } = await import('../web/agent-process-config.js')

const AGENT = 'testagent'
const APPROVED = 'hasClaudeMdExternalIncludesApproved'

const realClaude = () => join(HOME, '.claude')
const mainConfig = () => join(realClaude(), '.claude.json')
const homeConfig = () => join(HOME, '.claude.json')
const agentCfgDir = () => join(SANDBOX, 'agents', AGENT, '.claude-config')
const agentDot = () => join(agentCfgDir(), '.claude.json')
const mainAgentCfgDir = () => join(PROJECT, '.channels-config')
const mainAgentDot = () => join(mainAgentCfgDir(), '.claude.json')
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const bytes = (p: string) => readFileSync(p).toString('utf-8')
const isLink = (p: string) => lstatSync(p).isSymbolicLink()
const provision = () => ensureIsolatedChannelConfigDir(AGENT, 'telegram')

const MAIN_CONTENT = {
  hasCompletedOnboarding: true,
  mainOnly: 'main-session-state',
  numStartups: 318,
  projects: { [SANDBOX]: { hasTrustDialogAccepted: true, [APPROVED]: false } },
  mcpServers: { gmail: { command: 'npx', args: ['gmail-mcp'] } },
}
const HOME_CONTENT = {
  hasCompletedOnboarding: true,
  homeOnly: 'home-state',
  projects: { [SANDBOX]: { hasTrustDialogAccepted: true, [APPROVED]: false } },
  mcpServers: { gmail: { command: 'npx', args: ['gmail-mcp'] } },
}

beforeEach(() => {
  for (const d of [HOME, PROJECT, join(SANDBOX, 'agents'), join(SANDBOX, '.git')]) rmSync(d, { recursive: true, force: true })
  mkdirSync(join(SANDBOX, '.git'), { recursive: true })
  mkdirSync(STORE, { recursive: true })
  mkdirSync(join(realClaude(), 'hooks'), { recursive: true })
  writeFileSync(join(realClaude(), 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
  writeFileSync(join(realClaude(), 'history.jsonl'), 'one\n')
  writeFileSync(mainConfig(), JSON.stringify(MAIN_CONTENT, null, 2) + '\n', { mode: 0o644 })
  chmodSync(mainConfig(), 0o644)
  writeFileSync(homeConfig(), JSON.stringify(HOME_CONTENT, null, 2) + '\n')
  writeFileSync(join(STORE, '.claude-oauth-token'), 'sk-ant-oat01-fake\n')
  mkdirSync(join(SANDBOX, 'agents', AGENT), { recursive: true })
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('a sub-agent restart keeps its own .claude.json', () => {
  it('an agent-only key survives the second provision, and the file is never a symlink', () => {
    provision()
    expect(isLink(agentDot())).toBe(false)
    const cur = readJson(agentDot())
    cur.zzProbe = 1
    writeFileSync(agentDot(), JSON.stringify(cur, null, 2))

    provision()
    expect(isLink(agentDot())).toBe(false)
    expect(readJson(agentDot()).zzProbe).toBe(1)
    provision()
    expect(readJson(agentDot()).zzProbe).toBe(1)
  })

  it('the main session config and the home config are byte-identical after repeated provisions', () => {
    const mainBefore = bytes(mainConfig())
    const homeBefore = bytes(homeConfig())
    const mainMode = statSync(mainConfig()).mode & 0o777
    provision()
    provision()
    provision()
    expect(bytes(mainConfig())).toBe(mainBefore)
    expect(bytes(homeConfig())).toBe(homeBefore)
    expect(statSync(mainConfig()).mode & 0o777).toBe(mainMode)
    expect(isLink(mainConfig())).toBe(false)
  })

  it('a NEW agent is seeded once from the home ~/.claude.json (not from the main session config)', () => {
    expect(existsSync(agentDot())).toBe(false)
    provision()
    const seeded = readJson(agentDot())
    expect(seeded.homeOnly).toBe('home-state')
    expect(seeded.mainOnly).toBeUndefined()
    expect(seeded.hasCompletedOnboarding).toBe(true)
    expect(isLink(agentDot())).toBe(false)
  })

  it('the other top-level entries are still symlinked and a stale real copy of one is still replaced', () => {
    mkdirSync(agentCfgDir(), { recursive: true })
    mkdirSync(join(agentCfgDir(), 'hooks'))
    writeFileSync(join(agentCfgDir(), 'hooks', 'stale'), 'x')
    provision()
    expect(isLink(join(agentCfgDir(), 'hooks'))).toBe(true)
    expect(readlinkSync(join(agentCfgDir(), 'hooks'))).toBe(join(realClaude(), 'hooks'))
    expect(isLink(join(agentCfgDir(), 'history.jsonl'))).toBe(true)
    // the main config is NOT linked into the agent dir
    expect(isLink(agentDot())).toBe(false)
  })

  it('a stale .credentials.json in the agent dir is still removed, the shared one is untouched', () => {
    writeFileSync(join(realClaude(), '.credentials.json'), '{"shared":true}')
    mkdirSync(agentCfgDir(), { recursive: true })
    writeFileSync(join(agentCfgDir(), '.credentials.json'), '{"stale":true}')
    provision()
    expect(existsSync(join(agentCfgDir(), '.credentials.json'))).toBe(false)
    expect(bytes(join(realClaude(), '.credentials.json'))).toBe('{"shared":true}')
  })
})

describe('a legacy symlinked agent .claude.json is materialized once', () => {
  it('becomes a regular owner-only file with the target content, the target stays untouched, and it stays a file', () => {
    mkdirSync(agentCfgDir(), { recursive: true })
    symlinkSync(mainConfig(), agentDot())
    const targetBefore = bytes(mainConfig())

    provision()
    expect(isLink(agentDot())).toBe(false)
    expect(readJson(agentDot()).mainOnly).toBe('main-session-state')
    expect(statSync(agentDot()).mode & 0o777).toBe(0o600)
    expect(bytes(mainConfig())).toBe(targetBefore)

    // from now on it is the agent's own: a write does not reach the main config, and a re-provision keeps it
    const cur = readJson(agentDot())
    cur.zzProbe = 2
    writeFileSync(agentDot(), JSON.stringify(cur, null, 2))
    provision()
    expect(isLink(agentDot())).toBe(false)
    expect(readJson(agentDot()).zzProbe).toBe(2)
    expect(bytes(mainConfig())).toBe(targetBefore)
  })

  it('a symlink with an unparseable target is copied byte for byte and left for Claude Code to repair', () => {
    writeFileSync(mainConfig(), '{not json')
    mkdirSync(agentCfgDir(), { recursive: true })
    symlinkSync(mainConfig(), agentDot())
    provision()
    expect(isLink(agentDot())).toBe(false)
    expect(bytes(agentDot())).toBe('{not json')
    expect(bytes(mainConfig())).toBe('{not json')
  })

  it('a DANGLING symlink is replaced by a seeded regular file', () => {
    mkdirSync(agentCfgDir(), { recursive: true })
    symlinkSync(join(SANDBOX, 'nowhere.json'), agentDot())
    provision()
    expect(isLink(agentDot())).toBe(false)
    expect(readJson(agentDot()).homeOnly).toBe('home-state')
  })
})

describe('the main agent isolated path is unchanged', () => {
  it('a legacy .channels-config/.claude.json symlink to ~/.claude/.claude.json stays a symlink, target untouched', () => {
    mkdirSync(mainAgentCfgDir(), { recursive: true })
    symlinkSync(mainConfig(), mainAgentDot())
    const before = bytes(mainConfig())
    ensureMainAgentIsolatedConfigDir(undefined, 'linux')
    ensureMainAgentIsolatedConfigDir(undefined, 'linux')
    expect(isLink(mainAgentDot())).toBe(true)
    expect(readlinkSync(mainAgentDot())).toBe(mainConfig())
    expect(bytes(mainConfig())).toBe(before)
  })

  it('the main agent does not get the HTTP header refresh (its file is not touched even when it differs from home)', () => {
    mkdirSync(mainAgentCfgDir(), { recursive: true })
    const own = { hasCompletedOnboarding: true, mcpServers: { gmail: { command: 'npx', args: ['gmail-mcp'] }, up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer old' } } } }
    writeFileSync(mainAgentDot(), JSON.stringify(own, null, 2))
    writeFileSync(homeConfig(), JSON.stringify({ ...HOME_CONTENT, mcpServers: { ...HOME_CONTENT.mcpServers, up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer new' } } } }))
    ensureMainAgentIsolatedConfigDir(undefined, 'linux')
    expect(readJson(mainAgentDot()).mcpServers.up.headers.Authorization).toBe('Bearer old')
  })
})

describe('HTTP MCP headers follow the home config at every start', () => {
  const UP_OLD = { type: 'http', url: 'https://mcp.example/up', headers: { Authorization: 'Bearer old' }, scope: 'agent-local' }
  const writeAgent = (servers: unknown, extra: Record<string, unknown> = {}) => {
    mkdirSync(agentCfgDir(), { recursive: true })
    writeFileSync(agentDot(), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers, ...extra }, null, 2))
  }
  const writeHome = (servers: unknown) => writeFileSync(homeConfig(), JSON.stringify({ ...HOME_CONTENT, mcpServers: servers }, null, 2))
  const servers = () => readJson(agentDot()).mcpServers as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

  it('a rotated header reaches the existing agent; every other field of the entry stays', () => {
    writeAgent({ up: UP_OLD })
    writeHome({ up: { type: 'http', url: 'https://mcp.example/up', headers: { Authorization: 'Bearer new', 'X-Extra': 'e' } } })
    provision()
    expect(servers().up.headers).toEqual({ Authorization: 'Bearer new', 'X-Extra': 'e' })
    expect(servers().up.scope).toBe('agent-local')
    expect(servers().up.url).toBe('https://mcp.example/up')
  })

  it('only the headers object is replaced: a changed url or command in home does not overwrite the agent entry', () => {
    writeAgent({ up: UP_OLD })
    writeHome({ up: { type: 'http', url: 'https://other.example', headers: { Authorization: 'Bearer new' } } })
    provision()
    expect(servers().up.url).toBe('https://mcp.example/up')
    expect(servers().up.headers.Authorization).toBe('Bearer new')
  })

  it('a stdio server is never touched, even when home carries different env/headers', () => {
    const stdio = { command: 'npx', args: ['a'], env: { K: 'agent' }, headers: { Authorization: 'keep' } }
    writeAgent({ s: stdio })
    writeHome({ s: { command: 'npx', args: ['a'], env: { K: 'home' }, headers: { Authorization: 'home' } } })
    provision()
    expect(servers().s).toEqual(stdio)
  })

  it('a stdio AGENT entry is never turned into a header carrier by an http home entry of the same name', () => {
    const stdio = { command: 'npx', args: ['a'] }
    writeAgent({ s: stdio })
    writeHome({ s: { type: 'http', url: 'u', headers: { Authorization: 'Bearer new' } } })
    provision()
    expect(servers().s).toEqual(stdio)
  })

  it('a home entry that is not an object is skipped without aborting the rest of the refresh and the onboarding stamp', () => {
    // 'up' comes first and its home counterpart is null: the loop must carry on to 'other' and the file must still be
    // written (hasCompletedOnboarding missing -> dirty).
    mkdirSync(agentCfgDir(), { recursive: true })
    writeFileSync(agentDot(), JSON.stringify({
      mcpServers: { up: UP_OLD, other: { type: 'http', url: 'o', headers: { A: 'old' } } },
    }, null, 2))
    writeHome({ up: null, other: { type: 'http', url: 'o', headers: { A: 'new' } } })
    provision()
    expect(servers().up).toEqual(UP_OLD)
    expect(servers().other.headers).toEqual({ A: 'new' })
    expect(readJson(agentDot()).hasCompletedOnboarding).toBe(true)
  })

  it('an http entry whose home counterpart is another transport is left alone', () => {
    writeAgent({ up: UP_OLD })
    writeHome({ up: { command: 'npx', headers: { Authorization: 'Bearer new' } } })
    provision()
    expect(servers().up).toEqual(UP_OLD)
  })

  it('a home entry without a headers object leaves the agent headers in place', () => {
    writeAgent({ up: UP_OLD })
    writeHome({ up: { type: 'http', url: 'https://mcp.example/up' } })
    provision()
    expect(servers().up).toEqual(UP_OLD)
  })

  it('a server only the home has is added by the additive reconcile, with the home headers', () => {
    writeAgent({ up: UP_OLD })
    writeHome({ up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer new' } }, extra: { type: 'http', url: 'x', headers: { A: 'b' } } })
    provision()
    expect(Object.keys(servers()).sort()).toEqual(['extra', 'up'])
    expect(servers().extra.headers).toEqual({ A: 'b' })
  })

  it('a server only the agent has keeps its headers (no deletion, no touch)', () => {
    writeAgent({ up: UP_OLD, mine: { type: 'http', url: 'm', headers: { A: 'mine' } } })
    writeHome({ up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer new' } } })
    provision()
    expect(servers().mine).toEqual({ type: 'http', url: 'm', headers: { A: 'mine' } })
  })

  it('change-only: with equal headers the agent file is not rewritten (same inode, same bytes)', () => {
    writeAgent({ up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer same' } } })
    writeHome({ up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer same' } } })
    provision() // settle: the first run may add keys other than the headers
    const ino = statSync(agentDot()).ino
    const before = bytes(agentDot())
    provision()
    expect(statSync(agentDot()).ino).toBe(ino)
    expect(bytes(agentDot())).toBe(before)
  })

  it('an unparseable home config writes nothing', () => {
    writeAgent({ up: UP_OLD })
    provision()
    const before = bytes(agentDot())
    const ino = statSync(agentDot()).ino
    writeFileSync(homeConfig(), '{broken')
    provision()
    expect(bytes(agentDot())).toBe(before)
    expect(statSync(agentDot()).ino).toBe(ino)
  })

  it('an unparseable agent config is left for Claude Code (nothing written)', () => {
    mkdirSync(agentCfgDir(), { recursive: true })
    writeFileSync(agentDot(), '{broken')
    writeHome({ up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer new' } } })
    provision()
    expect(bytes(agentDot())).toBe('{broken')
  })

  it('a non-object mcpServers on either side is not touched', () => {
    writeAgent(['not', 'an', 'object'])
    writeHome({ up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer new' } } })
    provision()
    expect(readJson(agentDot()).mcpServers).toEqual(['not', 'an', 'object'])

    writeAgent({ up: UP_OLD })
    writeFileSync(homeConfig(), JSON.stringify({ ...HOME_CONTENT, mcpServers: 'nope' }))
    provision()
    expect(servers().up).toEqual(UP_OLD)
  })

  it('the log carries server names only, never a header value', () => {
    const info = vi.spyOn(logger, 'info')
    writeAgent({ up: UP_OLD })
    writeHome({ up: { type: 'http', url: 'u', headers: { Authorization: 'Bearer SECRET-NEW-VALUE' } } })
    provision()
    const logged = JSON.stringify(info.mock.calls)
    expect(logged).toContain('up')
    expect(logged).not.toContain('SECRET-NEW-VALUE')
    expect(logged).not.toContain('Bearer old')
  })
})

describe('end to end with the git-root stamp: no write-back on restart', () => {
  it('the external-imports approval survives the restart (root key stays approved before the next stamp too)', () => {
    const agentDir = join(SANDBOX, 'agents', AGENT)
    // start 1: seed from a home config whose root key is (not approved), then the spawn-time stamp
    provision()
    expect(readJson(agentDot()).projects[SANDBOX][APPROVED]).toBe(false)
    expect(stampProjectTrustForDir(agentDot(), agentDir)).toBe(true)
    expect(readJson(agentDot()).projects[SANDBOX][APPROVED]).toBe(true)

    // restart: provisioning alone (BEFORE the stamp) must not write the main config's (false) key back
    provision()
    expect(readJson(agentDot()).projects[SANDBOX][APPROVED]).toBe(true)
    // and the stamp on the second start has nothing left to do
    expect(stampProjectTrustForDir(agentDot(), agentDir)).toBe(false)
    provision()
    expect(readJson(agentDot()).projects[SANDBOX][APPROVED]).toBe(true)
  })
})
