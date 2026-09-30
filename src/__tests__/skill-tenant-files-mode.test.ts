import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTenantSkillFiles } from '../config.js'

// TENANT_SKILL_FILES decides which agents get a generated copy of a tenant skill:
// off = none, single (default) = only agents enabled for exactly one tenant, all = every
// enabled agent. An agent shared by several tenants must not receive a tenant's skill (nor its
// companion scripts) in single mode. Real skill-regen + real filesystem, only the DB is faked.

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
    flag: { mode: 'single' as 'off' | 'single' | 'all' },
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

import { regenSingleSkillFile, regenSkillFilesFromSQL, findSkillFileGaps } from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const ID = 'acme-demo'
const copy = (agent: string, rel = 'SKILL.md') => join(FAKE_PROJECT, 'agents', agent, '.claude', 'skills', ID, rel)
const mkAgent = (n: string) => mkdirSync(join(FAKE_PROJECT, 'agents', n), { recursive: true })

beforeEach(() => {
  rmSync(FAKE_PROJECT, { recursive: true, force: true })
  store.clear(); files.clear(); grants.clear(); avail.clear()
  flag.mode = 'single'
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
  it('all only for the explicit all', () => {
    expect(parseTenantSkillFiles('all')).toBe('all')
    expect(parseTenantSkillFiles(' ALL ')).toBe('all')
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

  it('all: every enabled agent of the tenant, shared ones included', () => {
    flag.mode = 'all'
    regenSingleSkillFile(ID)
    expect(existsSync(copy('ann'))).toBe(true)
    expect(existsSync(copy('bob'))).toBe(true)
    expect(existsSync(copy('bob', 'scripts/run.sh'))).toBe(true)
  })

  it('tightening the mode removes the generated copies that are no longer allowed (all -> single -> off)', () => {
    flag.mode = 'all'
    regenSingleSkillFile(ID)
    flag.mode = 'single'
    regenSkillFilesFromSQL()   // the startup pass
    expect(existsSync(copy('ann'))).toBe(true)
    expect(existsSync(copy('bob'))).toBe(false)
    flag.mode = 'off'
    regenSkillFilesFromSQL()
    expect(existsSync(copy('ann'))).toBe(false)
  })

  it('tightening keeps a hand-edited SKILL.md but still removes the generated companion script', () => {
    flag.mode = 'all'
    regenSingleSkillFile(ID)
    const bobMd = copy('bob')
    writeFileSync(bobMd, readFileSync(bobMd, 'utf8') + '\nhand-written addition\n')
    expect(existsSync(copy('bob', 'scripts/run.sh'))).toBe(true)
    flag.mode = 'single'
    regenSkillFilesFromSQL()
    expect(existsSync(bobMd)).toBe(true)                            // hand edit is never deleted
    expect(existsSync(copy('bob', 'scripts/run.sh'))).toBe(false)   // generated script must not stay on the shared agent
    expect(existsSync(copy('ann', 'scripts/run.sh'))).toBe(true)    // single-tenant agent keeps its copy
  })

  it('tightening leaves a hand-edited companion script alone', () => {
    flag.mode = 'all'
    regenSingleSkillFile(ID)
    writeFileSync(copy('bob', 'scripts/run.sh'), '#!/bin/sh\necho mine\n')
    flag.mode = 'single'
    regenSkillFilesFromSQL()
    expect(existsSync(copy('bob'))).toBe(false)
    expect(readFileSync(copy('bob', 'scripts/run.sh'), 'utf8')).toContain('echo mine')
  })

  it('the gap check follows the mode: a copy the mode excludes is not a gap', () => {
    expect(findSkillFileGaps().tenantCopies).toEqual([`${ID}@ann`])   // single: only ann is expected
    flag.mode = 'all'
    expect(findSkillFileGaps().tenantCopies.sort()).toEqual([`${ID}@ann`, `${ID}@bob`])
    flag.mode = 'off'
    expect(findSkillFileGaps().tenantCopies).toEqual([])
  })
})
