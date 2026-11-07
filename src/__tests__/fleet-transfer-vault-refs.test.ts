// The fleet import restores `{{VAULT:<id>}}` placeholders to `vault:<id>` in the MCP files it writes. A secret with a
// grantee list (vault_secret_acl) may only be restored into a file that belongs to a listed grantee; a refused
// reference keeps its placeholder (inert text) and is reported. An empty list is open (the behaviour before the
// list existed). When the lists cannot be read, nothing is restored (fail-closed) and the import still completes.
//
// Real: the import, vault-bindings.ts (grantee resolution), the DB tables (in-memory SQLite), the file system in
// a throwaway root. Stubbed: the surroundings that are out of scope here.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase } from '../db.js'

const { ROOT, PROJECT, STORE, HOME, AGENTS, TASKS, probe } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root: string = mkdtempSync(join(tmpdir(), 'fleet-vault-refs-test-'))
  return {
    ROOT: root,
    PROJECT: join(root, 'project'),
    STORE: join(root, 'store'),
    HOME: join(root, 'home'),
    AGENTS: join(root, 'agents'),
    TASKS: join(root, 'tasks'),
    /** When set, reading the grantee lists fails with this message. */
    probe: { aclReadError: null as string | null },
  }
})

afterAll(() => {
  const { rmSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
  rmSync(ROOT, { recursive: true, force: true })
})

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: AGENTS,
  listAgentNames: () => [],
  invalidateModelProfileMapCache: () => {},
  readFileOr: (p: string, fallback: string) => {
    try { return require('node:fs').readFileSync(p, 'utf-8') } catch { return fallback }
  },
}))
vi.mock('../web/dashboard-settings.js', () => ({ getExternalProjectPaths: () => [] }))
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: TASKS }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: PROJECT,
  STORE_DIR: STORE,
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'TestBot',
  BRAND_NAME: 'TestBot',
  OWNER_NAME: 'test',
  CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => HOME }))

// The lists are real; only the "read them all" call can be made to fail.
vi.mock('../db/vault-secret-acl.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/vault-secret-acl.js')>()
  return {
    ...real,
    listAllSecretAcls: async (tenantId: string) => {
      if (probe.aclReadError !== null) throw new Error(probe.aclReadError)
      return real.listAllSecretAcls(tenantId)
    },
  }
})

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importFleet, type FleetJson, type ImportResult } from '../web/fleet-transfer.js'
import { setSecretAcl } from '../web/vault-bindings.js'
import { logger } from '../logger.js'

// A distinctive value that must never show up in a report: the vault of the target holds it for `restricted-id`.
const SECRET_VALUE = 'known-fixture-secret-value-0451'

type Servers = Record<string, { command?: string, url?: string, env?: Record<string, string>, headers?: Record<string, string> }>

function bundle(opts: { main?: Servers, agents?: Record<string, Servers> } = {}): FleetJson {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    sourceHost: 'host-a',
    mainAgent: {
      agentId: 'agent-a',
      identity: { MAIN_AGENT_ID: 'agent-a', BOT_NAME: 'Bot A', BRAND_NAME: 'Brand A', OWNER_NAME: 'Owner A', CHANNEL_PROVIDER: 'telegram' },
      claudeMd: 'claude\n',
      soulMd: 'soul\n',
      config: {},
      mcp: { mcpServers: opts.main ?? {} },
      settings: {},
      channelsAccess: {},
    },
    agents: Object.entries(opts.agents ?? {}).map(([name, servers]) => ({
      name,
      config: { model: 'model-a' },
      claudeMd: 'claude\n',
      soulMd: '',
      mcp: { mcpServers: servers },
      settings: {},
      channelsAccess: {},
      avatar: null,
      avatarExt: 'png',
      agentSkills: [],
    })),
    skills: [],
    scheduledTasks: [],
    memories: [],
    dailyLogs: [],
    kanban: { labels: [], cards: [], comments: [], cardEvents: [], cardLabels: [] },
    ideaBox: { ideas: [], comments: [], statusLog: [] },
    schedules: [],
    importSources: [],
    vaultSshKeys: [],
    vaultSshServers: [],
    dashboardSettings: {},
  } as unknown as FleetJson
}

const ref = (id: string) => `{{VAULT:${id}}}`
const envServer = (key: string, id: string): Servers => ({ srv: { command: 'node', env: { [key]: ref(id) } } })

async function run(fleet: FleetJson): Promise<ImportResult> {
  return await importFleet(JSON.stringify(fleet), { apply: true }) as ImportResult
}

function mcpOf(file: string): { mcpServers: Servers } {
  return JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers: Servers }
}
const projectMcp = () => mcpOf(join(PROJECT, '.mcp.json'))
const agentMcp = (name: string) => mcpOf(join(AGENTS, name, '.mcp.json'))
const refusedLines = (r: ImportResult) => (r.warnings ?? []).filter(w => w.startsWith('vault hivatkozás nem állítva vissza'))

beforeEach(async () => {
  initDatabase(':memory:')
  probe.aclReadError = null
  vi.mocked(logger.warn).mockClear()
  vi.mocked(logger.error).mockClear()
  rmSync(ROOT, { recursive: true, force: true })
  for (const d of [PROJECT, STORE, HOME, AGENTS, TASKS]) mkdirSync(d, { recursive: true })
  await setSecretAcl('restricted-id', ['agent:agent-b'])
})

describe('import: a restricted secret is restored only into a file of a listed grantee', () => {
  it('T1 the target file\'s grantee is not on the list: the placeholder stays, the report names it, no vault: reference', async () => {
    const result = await run(bundle({ agents: { 'agent-c': envServer('API_TOKEN', 'restricted-id') } }))

    const env = agentMcp('agent-c').mcpServers.srv.env!
    expect(env.API_TOKEN).toBe('{{VAULT:restricted-id}}')
    expect(JSON.stringify(agentMcp('agent-c'))).not.toContain('vault:restricted-id')
    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('fájl=agents/agent-c/.mcp.json')
    expect(lines[0]).toContain('grantee=agent:agent-c')
    expect(lines[0]).toContain('szerver=srv')
    expect(lines[0]).toContain('kulcs=API_TOKEN')
    expect(lines[0]).toContain('titok=restricted-id')
  })

  it('T2 the target file\'s grantee is on the list: restored to vault:<id> (the old behaviour), nothing reported', async () => {
    const result = await run(bundle({ agents: { 'agent-b': envServer('API_TOKEN', 'restricted-id') } }))

    expect(agentMcp('agent-b').mcpServers.srv.env!.API_TOKEN).toBe('vault:restricted-id')
    expect(refusedLines(result)).toEqual([])
  })

  it('T3 an open secret (no list) is always restored, and the report has no refusal', async () => {
    const result = await run(bundle({
      main: envServer('API_TOKEN', 'open-id'),
      agents: { 'agent-c': envServer('API_TOKEN', 'open-id') },
    }))

    expect(projectMcp().mcpServers.srv.env!.API_TOKEN).toBe('vault:open-id')
    expect(agentMcp('agent-c').mcpServers.srv.env!.API_TOKEN).toBe('vault:open-id')
    expect(refusedLines(result)).toEqual([])
    expect(result.warnings ?? []).not.toContainEqual(expect.stringContaining('engedélyezési lista'))
  })

  it('T4 the main agent\'s project file (scope:project) is refused when the list does not name scope:project', async () => {
    const result = await run(bundle({ main: envServer('API_TOKEN', 'restricted-id') }))

    expect(projectMcp().mcpServers.srv.env!.API_TOKEN).toBe('{{VAULT:restricted-id}}')
    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('fájl=.mcp.json')
    expect(lines[0]).toContain('grantee=scope:project')
  })

  it('T4b the main agent\'s project file is restored when the list names scope:project', async () => {
    await setSecretAcl('restricted-id', ['scope:project'])
    const result = await run(bundle({ main: envServer('API_TOKEN', 'restricted-id') }))

    expect(projectMcp().mcpServers.srv.env!.API_TOKEN).toBe('vault:restricted-id')
    expect(refusedLines(result)).toEqual([])
  })

  it('T5 the lists cannot be read: no reference is restored (open ones included), the import does NOT throw, the report gives the cause', async () => {
    probe.aclReadError = 'database is locked'
    const result = await run(bundle({
      main: envServer('API_TOKEN', 'open-id'),
      agents: { 'agent-b': envServer('API_TOKEN', 'restricted-id') },
    }))

    expect(result.ok).toBe(true)
    expect(projectMcp().mcpServers.srv.env!.API_TOKEN).toBe('{{VAULT:open-id}}')
    expect(agentMcp('agent-b').mcpServers.srv.env!.API_TOKEN).toBe('{{VAULT:restricted-id}}')
    const warnings = result.warnings ?? []
    expect(warnings.some(w => w.includes('nem olvasható') && w.includes('database is locked'))).toBe(true)
    expect(refusedLines(result)).toHaveLength(2)
    expect(vi.mocked(logger.error)).toHaveBeenCalled()
  })

  it('T5b the lists are not even read when the bundle carries no reference (a read failure cannot disturb such an import)', async () => {
    probe.aclReadError = 'database is locked'
    const result = await run(bundle({ agents: { 'agent-b': { srv: { command: 'node', env: { PLAIN: 'literal' } } } } }))

    expect(result.ok).toBe(true)
    expect((result.warnings ?? []).filter(w => w.startsWith('vault'))).toEqual([])
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    expect(agentMcp('agent-b').mcpServers.srv.env!.PLAIN).toBe('literal')
  })

  it('T6 a file whose grantee cannot be told (a symbolic link in its place) is refused by a non-empty list', async () => {
    // agents/agent-c/.mcp.json is a link: verifiedGranteeOfMcpFile answers null for it, whatever it points at.
    mkdirSync(join(AGENTS, 'agent-c'), { recursive: true })
    writeFileSync(join(ROOT, 'elsewhere.json'), '{}')
    symlinkSync(join(ROOT, 'elsewhere.json'), join(AGENTS, 'agent-c', '.mcp.json'))

    // The same file, listed grantee or not: even agent-c itself on the list does not help.
    await setSecretAcl('restricted-id', ['agent:agent-c'])
    const result = await run(bundle({ agents: { 'agent-c': envServer('API_TOKEN', 'restricted-id') } }))

    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('grantee=ismeretlen')
    expect(JSON.stringify(readFileSync(join(AGENTS, 'agent-c', '.mcp.json'), 'utf-8'))).not.toContain('vault:restricted-id')
  })

  it('T7 headers are judged like env: refused for an unlisted file, restored for a listed one', async () => {
    const headerServer: Servers = { srv: { url: 'https://example.invalid/mcp', headers: { Authorization: ref('restricted-id') } } }
    const result = await run(bundle({ agents: { 'agent-b': headerServer, 'agent-c': headerServer } }))

    expect(agentMcp('agent-b').mcpServers.srv.headers!.Authorization).toBe('vault:restricted-id')
    expect(agentMcp('agent-c').mcpServers.srv.headers!.Authorization).toBe('{{VAULT:restricted-id}}')
    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('fájl=agents/agent-c/.mcp.json')
    expect(lines[0]).toContain('kulcs=Authorization')
  })

  it('T8 the report carries ids and names only: no secret value, no absolute path', async () => {
    // The target vault holds a known value for the restricted id; the import must not read or print it.
    const { setSecret } = await import('../web/vault.js')
    setSecret('restricted-id', 'label', SECRET_VALUE, 'default')

    const result = await run(bundle({ agents: { 'agent-c': envServer('API_TOKEN', 'restricted-id') } }))

    const everything = JSON.stringify(result)
    expect(refusedLines(result)).toHaveLength(1)
    expect(everything).not.toContain(SECRET_VALUE)
    expect(everything).not.toContain(ROOT)
    for (const call of [...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.error).mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(SECRET_VALUE)
    }
  })

  it('T9 an id that is a name on Object.prototype reads as "no list", not as a list (open, restored)', async () => {
    const result = await run(bundle({ agents: { 'agent-c': { srv: { command: 'node', env: { A: ref('constructor'), B: ref('__proto__') } } } } }))

    const env = agentMcp('agent-c').mcpServers.srv.env!
    expect(env.A).toBe('vault:constructor')
    expect(env.B).toBe('vault:__proto__')
    expect(refusedLines(result)).toEqual([])
  })

  it('T10 only the refused references stay: a mixed file keeps each decision per key', async () => {
    const mixed: Servers = { srv: { command: 'node', env: { OPEN: ref('open-id'), LOCKED: ref('restricted-id'), LITERAL: 'plain' } } }
    const result = await run(bundle({ agents: { 'agent-c': mixed } }))

    const env = agentMcp('agent-c').mcpServers.srv.env!
    expect(env).toEqual({ OPEN: 'vault:open-id', LOCKED: '{{VAULT:restricted-id}}', LITERAL: 'plain' })
    expect(refusedLines(result)).toHaveLength(1)
  })

  it('T11 the fields of the report are bundle input: control characters are replaced', async () => {
    const result = await run(bundle({ agents: { 'agent-c': { 'srv\nname': { command: 'node', env: { 'KEY\r\nX': ref('restricted-id') } } } } }))

    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/[\r\n]/)
    expect(lines[0]).toContain('szerver=srv?name')
    expect(lines[0]).toContain('kulcs=KEY??X')
  })

  it('T11b every field of a report line is capped at 200 characters (a hostile bundle cannot inflate the report)', async () => {
    const longServer = 's'.repeat(500)
    const longKey = 'k'.repeat(500)
    const longId = 'i'.repeat(500)
    const result = await run(bundle({ agents: { 'agent-c': { [longServer]: { command: 'node', env: { [longKey]: ref(longId) } } } } }))

    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    const field = (name: string) => new RegExp(`${name}=([^,]*)`).exec(lines[0])![1]
    expect(field('szerver')).toBe('s'.repeat(200))
    expect(field('kulcs')).toBe('k'.repeat(200))
    // the id is the last field of the line: everything after "titok=" is the (capped) id
    expect(lines[0].slice(lines[0].indexOf('titok=') + 'titok='.length)).toBe('i'.repeat(200))
    expect(lines[0]).not.toContain('s'.repeat(201))
  })
})

describe('import: a reference written literally as vault:<id> gets the same decision as a placeholder', () => {
  it('T12 an env value that starts with vault: is refused for an unlisted file (written back as the placeholder), kept for a listed one', async () => {
    const literal: Servers = { srv: { command: 'node', env: { API_TOKEN: 'vault:restricted-id', OPEN: 'vault:open-id' } } }
    const result = await run(bundle({ agents: { 'agent-b': literal, 'agent-c': literal } }))

    expect(agentMcp('agent-b').mcpServers.srv.env).toEqual({ API_TOKEN: 'vault:restricted-id', OPEN: 'vault:open-id' })
    expect(agentMcp('agent-c').mcpServers.srv.env).toEqual({ API_TOKEN: '{{VAULT:restricted-id}}', OPEN: 'vault:open-id' })
    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('fájl=agents/agent-c/.mcp.json')
    expect(lines[0]).toContain('kulcs=API_TOKEN')
  })

  it('T13 a headers value with vault:<id> anywhere in it: every occurrence is decided on its own', async () => {
    const headerServer: Servers = {
      srv: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer vault:restricted-id', Multi: 'a=vault:open-id;b=vault:restricted-id' } },
    }
    const result = await run(bundle({ agents: { 'agent-b': headerServer, 'agent-c': headerServer } }))

    expect(agentMcp('agent-b').mcpServers.srv.headers).toEqual({ Authorization: 'Bearer vault:restricted-id', Multi: 'a=vault:open-id;b=vault:restricted-id' })
    expect(agentMcp('agent-c').mcpServers.srv.headers).toEqual({
      Authorization: 'Bearer {{VAULT:restricted-id}}',
      Multi: 'a=vault:open-id;b={{VAULT:restricted-id}}',
    })
    expect(refusedLines(result)).toHaveLength(2)
  })

  it('T13c an id with a dot, a hyphen, an underscore, a digit and upper case is found whole in a headers value (the whole character set counts)', async () => {
    // A finder that stops early (on the dot, say) would read "a" or "a.b", which has no list, and let the
    // restricted id through; each id below is restricted to agent-b only.
    for (const id of ['a.b-c', 'Tok_EN.1']) await setSecretAcl(id, ['agent:agent-b'])
    const headerServer: Servers = {
      srv: { url: 'https://example.invalid/mcp', headers: { H1: 'Bearer vault:a.b-c', H2: 'k=vault:Tok_EN.1;', H3: 'vault:a.b-c/vault:Tok_EN.1' } },
    }
    const result = await run(bundle({ agents: { 'agent-b': headerServer, 'agent-c': headerServer } }))

    expect(agentMcp('agent-b').mcpServers.srv.headers).toEqual({ H1: 'Bearer vault:a.b-c', H2: 'k=vault:Tok_EN.1;', H3: 'vault:a.b-c/vault:Tok_EN.1' })
    expect(agentMcp('agent-c').mcpServers.srv.headers).toEqual({
      H1: 'Bearer {{VAULT:a.b-c}}',
      H2: 'k={{VAULT:Tok_EN.1}};',
      H3: '{{VAULT:a.b-c}}/{{VAULT:Tok_EN.1}}',
    })
    expect(refusedLines(result)).toHaveLength(4)
  })

  it('T13b a vault: mention that is not a reference (no id after the colon) is left alone and reported as nothing', async () => {
    const plain: Servers = { srv: { url: 'https://example.invalid/mcp', headers: { Note: 'see vault: docs' }, env: { NOTE: 'the vault: docs' } } }
    const result = await run(bundle({ agents: { 'agent-c': plain } }))

    expect(agentMcp('agent-c').mcpServers.srv.headers!.Note).toBe('see vault: docs')
    expect(agentMcp('agent-c').mcpServers.srv.env!.NOTE).toBe('the vault: docs')
    expect(refusedLines(result)).toEqual([])
  })
})

describe('import: a refused placeholder cannot carry a vault: reference to the header injector', () => {
  const embedded = (id: string): Servers => ({ srv: { url: 'https://example.invalid/mcp', headers: { Authorization: `{{VAULT:abc.vault:${id}}}`, Spaced: `{{VAULT:x vault:${id}}}` } } })

  it('T16 a placeholder with a non-canonical id that holds vault:<id> is neutralised for an unlisted file, and the embedded occurrence follows the list', async () => {
    const result = await run(bundle({ agents: { 'agent-b': embedded('restricted-id'), 'agent-c': embedded('restricted-id') } }))

    // agent-c is not on the list: no lowercase vault: reference is left anywhere in the file.
    expect(JSON.stringify(agentMcp('agent-c'))).not.toContain('vault:')
    expect(agentMcp('agent-c').mcpServers.srv.headers!.Authorization).toBe('{{VAULT:abc.{{VAULT:restricted-id}}}}')
    // agent-b is on the list: the placeholder itself is refused (invalid_id), the occurrence in it is allowed by the list.
    expect(agentMcp('agent-b').mcpServers.srv.headers!.Authorization).toBe('{{VAULT:abc.vault:restricted-id}}')
    const lines = refusedLines(result)
    expect(lines.filter(l => l.includes('invalid_id'))).toHaveLength(4) // both placeholders in both files
    expect(lines.filter(l => l.includes('a célfájl nincs'))).toHaveLength(2) // the two occurrences in agent-c
  })

  it('T16b an open id inside a refused placeholder is left to the open default (no list)', async () => {
    await run(bundle({ agents: { 'agent-c': embedded('open-id') } }))

    expect(agentMcp('agent-c').mcpServers.srv.headers!.Authorization).toBe('{{VAULT:abc.vault:open-id}}')
  })

  it('T16c the same text in an ENV value stays inert (the wrapper reads only a value that starts with vault:)', async () => {
    const envServer2: Servers = { srv: { command: 'node', env: { KEY: '{{VAULT:abc.vault:restricted-id}}' } } }
    const result = await run(bundle({ agents: { 'agent-c': envServer2 } }))

    const value = agentMcp('agent-c').mcpServers.srv.env!.KEY
    expect(value.startsWith('vault:')).toBe(false)
    expect(value).toBe('{{VAULT:abc.vault:restricted-id}}')
    expect(refusedLines(result)).toHaveLength(1)
  })
})

describe('import: an id outside the strict pattern is never restored (invalid_id)', () => {
  const awkward: Array<[string, string]> = [
    ['placeholder, trailing space', '{{VAULT:restricted-id }}'],
    ['placeholder, trailing newline', '{{VAULT:restricted-id\n}}'],
    ['placeholder, space inside', '{{VAULT:restricted id}}'],
    ['placeholder, empty id', '{{VAULT:}}'],
    ['placeholder, 129 characters', `{{VAULT:${'a'.repeat(129)}}}`],
    ['literal env, trailing space', 'vault:restricted-id '],
    ['literal env, trailing newline', 'vault:restricted-id\n'],
    ['literal env, an extra entry after a newline', 'vault:open-id\nX=restricted-id'],
  ]

  it.each(awkward)('T14 %s: refused whatever the list says (an open or a restricted secret alike), no vault: reference is written', async (_name, value) => {
    // open-id has no list at all: the pattern, not the list, is what refuses these.
    const result = await run(bundle({ agents: { 'agent-b': { srv: { command: 'node', env: { KEY: value } } } } }))

    const written = JSON.stringify(agentMcp('agent-b'))
    const env = agentMcp('agent-b').mcpServers.srv.env!
    expect(env.KEY.startsWith('vault:')).toBe(false)
    expect(written).not.toMatch(/"vault:/)
    const lines = refusedLines(result)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('invalid_id')
  })

  it('T14b the boundary: 128 characters of the allowed set are restored, 129 are not', async () => {
    const id128 = 'a'.repeat(128)
    const result = await run(bundle({ agents: { 'agent-b': { srv: { command: 'node', env: { OK: ref(id128), TOO_LONG: ref(`${id128}a`) } } } } }))

    const env = agentMcp('agent-b').mcpServers.srv.env!
    expect(env.OK).toBe(`vault:${id128}`)
    expect(env.TOO_LONG).toBe(`{{VAULT:${id128}a}}`)
    expect(refusedLines(result)).toHaveLength(1)
  })

  it('T14c every character of the allowed set is accepted in an id', async () => {
    const result = await run(bundle({ agents: { 'agent-b': { srv: { command: 'node', env: { KEY: ref('Aa09._-') } } } } }))

    expect(agentMcp('agent-b').mcpServers.srv.env!.KEY).toBe('vault:Aa09._-')
    expect(refusedLines(result)).toEqual([])
  })

  it('T15 the lists cannot be read, and the bundle only mentions vault: in plain text: no cause line, nothing held back', async () => {
    probe.aclReadError = 'database is locked'
    const result = await run(bundle({ agents: { 'agent-b': { srv: { command: 'node', env: { NOTE: 'the vault: docs' } } } } }))

    expect(result.ok).toBe(true)
    expect((result.warnings ?? []).filter(w => w.startsWith('vault'))).toEqual([])
  })
})
