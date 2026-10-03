import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTenantSkillFiles, tenantSkillFilesAllRequested } from '../config.js'

// TENANT_SKILL_FILES decides which agents get a generated copy of a tenant skill:
// off = none, single (default) = only agents enabled for exactly one tenant. An agent shared by
// several tenants never receives a tenant's skill (nor its companion scripts): it is DB-only, and
// there is no mode that writes one anyway (the former `all` is read as single). Real skill-regen +
// real filesystem, only the DB is faked.

const { FAKE_HOME, FAKE_PROJECT, flag, store, files, grants, avail } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tenant-mode-'))
  return {
    FAKE_HOME: fakeHome,
    FAKE_PROJECT: path.join(fakeHome, 'project'),
    flag: { mode: 'single' as 'off' | 'single' },
    store: new Map<string, any>(),
    files: new Map<string, Array<{ rel_path: string; content: Buffer; mode: number }>>(),
    grants: new Map<string, string[]>(),
    avail: new Map<string, string[]>(),           // tenant id -> enabled agent ids
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  const cfg = { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: true }
  Object.defineProperty(cfg, 'TENANT_SKILL_FILES', { get: () => flag.mode, enumerable: true })
  return cfg
})
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'), listAgentNames: () => [] }))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', () => ({
  getSkill: vi.fn((id: string) => store.get(id)),
  listAllSkills: vi.fn(() => [...store.values()]),
  listSkillAccess: vi.fn((id: string) => (grants.get(id) ?? []).map(t => ({ skill_id: id, tenant_id: t }))),
  getEnabledAgentsForTenant: vi.fn((t: string) => avail.get(t) ?? []),
  getTenantsForAgent: vi.fn((a: string) => [...avail.entries()].filter(([, agents]) => agents.includes(a)).map(([t]) => t)),
  listSkillFiles: vi.fn((id: string) => files.get(id) ?? []),
  seedSkillFileIfAbsent: vi.fn(),
}))

import {
  regenSingleSkillFile, regenSkillFilesFromSQL, findSkillFileGaps,
  setTenantSkillAgentProbe, generateTenantSkillFilesForAgent, removeGeneratedTenantSkillFilesForAgent,
  regenTenantSkillFilesForAgentChange, regenTenantSkillFiles,
} from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const ID = 'acme-demo'
const copy = (agent: string, rel = 'SKILL.md') => join(FAKE_PROJECT, 'agents', agent, '.claude', 'skills', ID, rel)
const mkAgent = (n: string) => mkdirSync(join(FAKE_PROJECT, 'agents', n), { recursive: true })
/** Legacy state: bob holds a generated copy from when it served acme only, and has been shared with beta since. */
function legacyCopyOnSharedBob() {
  avail.set('beta', ['cy'])
  regenSingleSkillFile(ID)
  expect(existsSync(copy('bob'))).toBe(true)   // guard: the fixture really produced the stale copy
  avail.set('beta', ['bob', 'cy'])
}

beforeEach(() => {
  rmSync(FAKE_PROJECT, { recursive: true, force: true })
  store.clear(); files.clear(); grants.clear(); avail.clear()
  flag.mode = 'single'
  setTenantSkillAgentProbe(() => true)
  for (const a of ['ann', 'bob', 'cy']) mkAgent(a)
  store.set(ID, { id: ID, name: ID, description: '', content: '---\nname: demo\n---\nbody\n', tenant_id: 'acme', is_global: 0 })
  files.set(ID, [{ rel_path: 'scripts/run.sh', content: Buffer.from('#!/bin/sh\n'), mode: 0o755 }])
  // ann: acme only. bob: acme AND beta (shared). cy: beta only.
  avail.set('acme', ['ann', 'bob']); avail.set('beta', ['bob', 'cy'])
})

describe('parseTenantSkillFiles', () => {
  it('defaults to single for unset, blank and unrecognised values', () => {
    for (const v of [undefined, '', '  ', 'garbage', 'single', 'SINGLE', '1', 'true']) expect(parseTenantSkillFiles(v)).toBe('single')
  })
  it('off for the explicit off values (case and whitespace tolerant)', () => {
    for (const v of ['off', 'OFF', ' 0 ', 'false', 'no', 'none']) expect(parseTenantSkillFiles(v)).toBe('off')
  })
  it('the removed all value is read as single, and flagged so a startup warning can be raised', () => {
    expect(parseTenantSkillFiles('all')).toBe('single')
    expect(parseTenantSkillFiles(' ALL ')).toBe('single')
    expect(tenantSkillFilesAllRequested('all')).toBe(true)
    expect(tenantSkillFilesAllRequested(' ALL ')).toBe(true)
    for (const v of [undefined, '', 'single', 'off', 'garbage']) expect(tenantSkillFilesAllRequested(v)).toBe(false)
  })
})

describe('availability change follows the agent, not only the changed tenant', () => {
  it('enabling a second tenant on a single-tenant agent removes the first tenant\'s copy from it', () => {
    regenSingleSkillFile(ID)
    expect(existsSync(copy('ann'))).toBe(true)
    avail.set('beta', ['bob', 'cy', 'ann'])             // ann is now shared by acme and beta
    // the tenant-only reconcile (what the route used to do) leaves acme's skill on ann
    regenTenantSkillFiles('beta')
    expect(existsSync(copy('ann'))).toBe(true)
    const r = regenTenantSkillFilesForAgentChange('ann', 'beta')
    expect(r.errors).toBe(0)
    expect(existsSync(copy('ann'))).toBe(false)
    expect(existsSync(copy('ann', 'scripts/run.sh'))).toBe(false)
  })

  it('disabling the second tenant makes the agent single-tenant again: the remaining tenant\'s copy is written', () => {
    avail.set('beta', ['bob', 'cy', 'ann'])             // ann shared: no copy
    regenSkillFilesFromSQL()
    expect(existsSync(copy('ann'))).toBe(false)
    avail.set('beta', ['bob', 'cy'])                    // beta dropped ann
    regenTenantSkillFilesForAgentChange('ann', 'beta')
    expect(existsSync(copy('ann'))).toBe(true)
    expect(existsSync(copy('ann', 'scripts/run.sh'))).toBe(true)
  })

  it('other agents and other tenants\' skills are left alone', () => {
    regenSingleSkillFile(ID)
    avail.set('beta', ['bob', 'cy', 'ann'])
    regenTenantSkillFilesForAgentChange('ann', 'beta')
    expect(existsSync(copy('bob'))).toBe(false)
    expect(existsSync(copy('cy'))).toBe(false)
  })
})

describe('TENANT_SKILL_FILES modes', () => {
  it('single (default): an agent of ONE tenant gets the skill and its companion script; a shared agent does not', () => {
    expect(regenSingleSkillFile(ID).written).toBe(true)
    expect(existsSync(copy('ann'))).toBe(true)
    expect(existsSync(copy('ann', 'scripts/run.sh'))).toBe(true)
    expect(existsSync(copy('bob'))).toBe(false)
    expect(existsSync(copy('bob', 'scripts/run.sh'))).toBe(false)
    expect(existsSync(copy('cy'))).toBe(false)   // beta-only agent, skill not granted to beta
  })

  it('single: a grant reaches only the grantee tenant\'s single-tenant agents', () => {
    grants.set(ID, ['beta'])
    regenSingleSkillFile(ID)
    expect(existsSync(copy('ann'))).toBe(true)
    expect(existsSync(copy('cy'))).toBe(true)
    expect(existsSync(copy('bob'))).toBe(false)   // still shared by acme and beta
  })

  it('off: tenant skills stay DB-only (no file for anyone)', () => {
    flag.mode = 'off'
    expect(regenSingleSkillFile(ID)).toEqual({ written: false, skipped: true, reason: 'not_file_backed' })
    regenSkillFilesFromSQL()
    for (const a of ['ann', 'bob', 'cy']) expect(existsSync(copy(a))).toBe(false)
  })

  it('a shared agent never gets a copy, by any path: live edit, bulk regen, agent start', () => {
    regenSingleSkillFile(ID)
    regenSkillFilesFromSQL()
    generateTenantSkillFilesForAgent('bob')
    expect(existsSync(copy('bob'))).toBe(false)
    expect(existsSync(copy('bob', 'scripts/run.sh'))).toBe(false)
    expect(existsSync(copy('ann'))).toBe(true)
  })

  it('a grant to a tenant the shared agent serves still leaves the shared agent without a copy', () => {
    grants.set(ID, ['beta'])
    regenSingleSkillFile(ID)
    generateTenantSkillFilesForAgent('bob')
    expect(existsSync(copy('bob'))).toBe(false)
  })

  it('a copy left on an agent that has since become shared is removed by the startup pass, and by off', () => {
    legacyCopyOnSharedBob()
    regenSkillFilesFromSQL()   // the startup pass
    expect(existsSync(copy('ann'))).toBe(true)
    expect(existsSync(copy('bob'))).toBe(false)
    flag.mode = 'off'
    regenSkillFilesFromSQL()
    expect(existsSync(copy('ann'))).toBe(false)
  })

  it('a stale copy on a shared agent: a hand-edited SKILL.md is kept but the generated companion script is removed', () => {
    legacyCopyOnSharedBob()
    const bobMd = copy('bob')
    writeFileSync(bobMd, readFileSync(bobMd, 'utf8') + '\nhand-written addition\n')
    expect(existsSync(copy('bob', 'scripts/run.sh'))).toBe(true)
    regenSkillFilesFromSQL()
    expect(existsSync(bobMd)).toBe(true)                            // hand edit is never deleted
    expect(existsSync(copy('bob', 'scripts/run.sh'))).toBe(false)   // generated script must not stay on the shared agent
    expect(existsSync(copy('ann', 'scripts/run.sh'))).toBe(true)    // single-tenant agent keeps its copy
  })

  it('a stale copy on a shared agent: a hand-edited companion script is left alone', () => {
    legacyCopyOnSharedBob()
    writeFileSync(copy('bob', 'scripts/run.sh'), '#!/bin/sh\necho mine\n')
    regenSkillFilesFromSQL()
    expect(existsSync(copy('bob'))).toBe(false)
    expect(readFileSync(copy('bob', 'scripts/run.sh'), 'utf8')).toContain('echo mine')
  })

  it('the gap check follows the mode: a copy the mode excludes is not a gap', () => {
    expect(findSkillFileGaps().tenantCopies).toEqual([`${ID}@ann`])   // single: only ann is expected, never the shared bob
    flag.mode = 'off'
    expect(findSkillFileGaps().tenantCopies).toEqual([])
  })
})

// Tenant skill files belong to RUNNING agents: written at agent start, deleted at stop.
describe('tenant skill files follow the agent lifecycle', () => {
  const md = (a: string) => copy(a)
  const script = (a: string) => copy(a, 'scripts/run.sh')

  it('the bulk regen writes copies for running agents only and prunes the generated copies of stopped ones', () => {
    regenSingleSkillFile(ID)
    expect(existsSync(md('ann'))).toBe(true)
    setTenantSkillAgentProbe(a => a !== 'ann')   // ann is now stopped
    regenSkillFilesFromSQL()
    expect(existsSync(md('ann'))).toBe(false)
    expect(existsSync(script('ann'))).toBe(false)
    setTenantSkillAgentProbe(() => true)
    regenSkillFilesFromSQL()
    expect(existsSync(md('ann'))).toBe(true)
  })

  it('a live skill edit writes to running agents only', () => {
    setTenantSkillAgentProbe(() => false)
    expect(regenSingleSkillFile(ID).written).toBe(false)
    expect(existsSync(md('ann'))).toBe(false)
  })

  it('a probe that throws counts as running (files are kept, the use-time gate still applies)', () => {
    regenSingleSkillFile(ID)
    setTenantSkillAgentProbe(() => { throw new Error('tmux gone') })
    regenSkillFilesFromSQL()
    expect(existsSync(md('ann'))).toBe(true)
  })

  it('agent start: generateTenantSkillFilesForAgent writes SKILL.md and scripts even though the agent is not running yet', () => {
    setTenantSkillAgentProbe(() => false)
    const r = generateTenantSkillFilesForAgent('ann')
    expect(r.errors).toBe(0)
    expect(existsSync(md('ann'))).toBe(true)
    expect(existsSync(script('ann'))).toBe(true)
  })

  it('agent start follows the mode: a shared agent gets nothing in single, off gets nothing at all', () => {
    generateTenantSkillFilesForAgent('bob')
    expect(existsSync(md('bob'))).toBe(false)
    flag.mode = 'off'
    generateTenantSkillFilesForAgent('ann')
    expect(existsSync(md('ann'))).toBe(false)
  })

  it('agent start never overwrites a hand-made skill of the same name', () => {
    mkdirSync(join(FAKE_PROJECT, 'agents', 'ann', '.claude', 'skills', ID), { recursive: true })
    writeFileSync(md('ann'), 'my own skill\n')
    generateTenantSkillFilesForAgent('ann')
    expect(readFileSync(md('ann'), 'utf8')).toBe('my own skill\n')
  })

  it('agent stop: removes the generated SKILL.md and companion script, leaves other agents alone', () => {
    legacyCopyOnSharedBob()
    const r = removeGeneratedTenantSkillFilesForAgent('ann')
    expect(r).toEqual({ removed: 1, kept: 0, errors: 0 })
    expect(existsSync(md('ann'))).toBe(false)
    expect(existsSync(script('ann'))).toBe(false)
    expect(existsSync(md('bob'))).toBe(true)
    expect(existsSync(script('bob'))).toBe(true)
  })

  it('agent stop keeps a hand-edited SKILL.md (and a hand-edited script) but removes what is still generated', () => {
    regenSingleSkillFile(ID)
    writeFileSync(md('ann'), readFileSync(md('ann'), 'utf8') + '\nhand-written addition\n')
    const r = removeGeneratedTenantSkillFilesForAgent('ann')
    expect(r.kept).toBe(1)
    expect(existsSync(md('ann'))).toBe(true)
    expect(existsSync(script('ann'))).toBe(false)   // generated script goes
    generateTenantSkillFilesForAgent('cy')          // no-op (cy not enabled for acme), keeps the test honest
    rmSync(join(FAKE_PROJECT, 'agents', 'ann', '.claude'), { recursive: true, force: true })
    regenSingleSkillFile(ID)
    writeFileSync(script('ann'), '#!/bin/sh\necho mine\n')
    removeGeneratedTenantSkillFilesForAgent('ann')
    expect(existsSync(md('ann'))).toBe(false)
    expect(readFileSync(script('ann'), 'utf8')).toContain('echo mine')
  })

  it('agent stop removes a generated copy whose skill row is gone and never touches a hand-made skill', () => {
    regenSingleSkillFile(ID)
    store.delete(ID)
    files.delete(ID)
    const handMade = join(FAKE_PROJECT, 'agents', 'ann', '.claude', 'skills', 'mine', 'SKILL.md')
    mkdirSync(join(FAKE_PROJECT, 'agents', 'ann', '.claude', 'skills', 'mine'), { recursive: true })
    writeFileSync(handMade, '---\nname: mine\n---\nhand made\n')
    removeGeneratedTenantSkillFilesForAgent('ann')
    expect(existsSync(md('ann'))).toBe(false)
    expect(readFileSync(handMade, 'utf8')).toContain('hand made')
  })

  it('stop and start are no-ops for an agent with no skills directory, and respect the kill switch input', () => {
    expect(removeGeneratedTenantSkillFilesForAgent('cy')).toEqual({ removed: 0, kept: 0, errors: 0 })
    expect(removeGeneratedTenantSkillFilesForAgent('../etc')).toEqual({ removed: 0, kept: 0, errors: 0 })
  })
})
