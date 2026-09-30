import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addGeneratedHeader, stripGeneratedHeader } from '../skill-header.js'

// Tenant skills (tenant_id != 'fleet') are generated under the agents of the
// owning tenant and of the tenants they are granted to. Real skill-regen + real
// filesystem under a temp project; only the DB is faked.

const { FAKE_HOME, FAKE_PROJECT, store, grants, avail } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-regen-tenant-'))
  return {
    FAKE_HOME: fakeHome,
    FAKE_PROJECT: path.join(fakeHome, 'project'),
    store: new Map<string, any>(),
    grants: new Map<string, string[]>(),          // skill id -> granted tenant ids
    avail: new Map<string, string[]>(),           // tenant id -> enabled agent ids
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: true }
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => [],
}))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', () => ({
  getSkill: vi.fn((id: string) => store.get(id)),
  listAllSkills: vi.fn(() => [...store.values()]),
  listSkillAccess: vi.fn((id: string) => (grants.get(id) ?? []).map(t => ({ skill_id: id, tenant_id: t }))),
  getEnabledAgentsForTenant: vi.fn((t: string) => avail.get(t) ?? []),
}))

import { regenSingleSkillFile, regenSkillFilesFromSQL, regenTenantSkillFiles, removeGeneratedSkillFile, tenantSkillDirName } from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const FM = '---\nname: demo\ndescription: d\n---\n'
const agentSkill = (agent: string, dir: string) => join(FAKE_PROJECT, 'agents', agent, '.claude', 'skills', dir, 'SKILL.md')
const ID = 'acme-demo'

function row(id: string, tenant: string, content = `${FM}# body\n`) {
  const r = { id, name: id, description: '', content, tenant_id: tenant, is_global: 0 }
  store.set(id, r)
  return r
}
function mkAgent(name: string) { mkdirSync(join(FAKE_PROJECT, 'agents', name), { recursive: true }) }

beforeEach(() => {
  rmSync(join(FAKE_PROJECT), { recursive: true, force: true })
  store.clear(); grants.clear(); avail.clear()
  mkAgent('ann'); mkAgent('bob'); mkAgent('cy')
})

describe('tenant skill file generation', () => {
  it('writes the skill, with a tenant header, to every enabled agent of the owning tenant', () => {
    row(ID, 'acme'); avail.set('acme', ['ann', 'bob'])
    expect(regenSingleSkillFile(ID)).toEqual({ written: true, skipped: false, reason: null })
    for (const a of ['ann', 'bob']) {
      const f = readFileSync(agentSkill(a, ID), 'utf-8')
      expect(f).toBe(addGeneratedHeader(store.get(ID).content, ID, { tenant: true }))
      expect(f).toContain(`(tenant skill ${ID})`)
    }
    expect(existsSync(agentSkill('cy', ID))).toBe(false)
  })

  it('is DB-only when the tenant has no agent (not_file_backed)', () => {
    row(ID, 'acme')
    expect(regenSingleSkillFile(ID)).toEqual({ written: false, skipped: true, reason: 'not_file_backed' })
  })

  it('ignores enabled agents that do not exist on disk and the main agent', () => {
    row(ID, 'acme'); avail.set('acme', ['ghost', 'marveen'])
    expect(regenSingleSkillFile(ID).reason).toBe('not_file_backed')
    expect(existsSync(join(FAKE_PROJECT, 'agents', 'ghost'))).toBe(false)
    expect(existsSync(join(FAKE_PROJECT, '.claude'))).toBe(false)
  })

  it('never writes to the main agent even when it is enabled for the tenant AND has a directory on disk', () => {
    // The plain "not on disk" case above is filtered by the directory check alone; this one only the
    // main-agent exclusion stops: the main agent's skills dir is project-wide, not a tenant's own.
    mkAgent('marveen')
    row(ID, 'acme'); avail.set('acme', ['marveen', 'ann'])
    expect(regenSingleSkillFile(ID)).toEqual({ written: true, skipped: false, reason: null })
    expect(existsSync(agentSkill('ann', ID))).toBe(true)
    expect(existsSync(agentSkill('marveen', ID))).toBe(false)
    expect(existsSync(join(FAKE_PROJECT, '.claude'))).toBe(false)
    // the bulk (startup) pass and the per-tenant pass agree
    regenSkillFilesFromSQL()
    regenTenantSkillFiles('acme')
    expect(existsSync(agentSkill('marveen', ID))).toBe(false)
  })

  it('a second regen with unchanged content is content_equal', () => {
    row(ID, 'acme'); avail.set('acme', ['ann'])
    regenSingleSkillFile(ID)
    expect(regenSingleSkillFile(ID)).toEqual({ written: false, skipped: true, reason: 'content_equal' })
  })

  it('a grant adds the grantee tenant agents, a revoke removes only the generated copies', () => {
    row(ID, 'acme'); avail.set('acme', ['ann']); avail.set('beta', ['bob'])
    regenSingleSkillFile(ID)
    expect(existsSync(agentSkill('bob', ID))).toBe(false)

    grants.set(ID, ['beta'])
    regenSingleSkillFile(ID)
    expect(existsSync(agentSkill('bob', ID))).toBe(true)
    expect(existsSync(agentSkill('ann', ID))).toBe(true)

    grants.set(ID, [])
    expect(regenSingleSkillFile(ID)).toEqual({ written: false, skipped: false, reason: null })
    expect(existsSync(agentSkill('bob', ID))).toBe(false)
    expect(existsSync(join(FAKE_PROJECT, 'agents', 'bob', '.claude', 'skills', ID))).toBe(false)   // empty dir cleaned up
    expect(existsSync(agentSkill('ann', ID))).toBe(true)
  })

  it('does not touch a hand-made skill that has the same directory name', () => {
    row(ID, 'acme'); avail.set('acme', ['ann'])
    mkdirSync(join(FAKE_PROJECT, 'agents', 'ann', '.claude', 'skills', ID), { recursive: true })
    writeFileSync(agentSkill('ann', ID), 'my own skill\n')
    const r = regenSingleSkillFile(ID)
    expect(readFileSync(agentSkill('ann', ID), 'utf-8')).toBe('my own skill\n')
    expect(r.written).toBe(false)
  })

  it('does not overwrite a generated FLEET-style header of another skill in that directory', () => {
    row(ID, 'acme'); avail.set('acme', ['ann'])
    mkdirSync(join(FAKE_PROJECT, 'agents', 'ann', '.claude', 'skills', ID), { recursive: true })
    const other = addGeneratedHeader('other body\n', 'agent/ann/other')
    writeFileSync(agentSkill('ann', ID), other)
    regenSingleSkillFile(ID)
    expect(readFileSync(agentSkill('ann', ID), 'utf-8')).toBe(other)
  })

  it('restores a drifted generated copy from the DB', () => {
    row(ID, 'acme'); avail.set('acme', ['ann'])
    regenSingleSkillFile(ID)
    writeFileSync(agentSkill('ann', ID), addGeneratedHeader('tampered\n', ID, { tenant: true }))
    regenSingleSkillFile(ID)
    expect(stripGeneratedHeader(readFileSync(agentSkill('ann', ID), 'utf-8'))).toBe(store.get(ID).content)
  })

  it('an availability change moves the files (regenTenantSkillFiles)', () => {
    row(ID, 'acme'); avail.set('acme', ['ann'])
    regenSingleSkillFile(ID)
    avail.set('acme', ['bob'])
    expect(regenTenantSkillFiles('acme')).toEqual({ written: 1, removed: 1, errors: 0 })
    expect(existsSync(agentSkill('ann', ID))).toBe(false)
    expect(existsSync(agentSkill('bob', ID))).toBe(true)
  })

  it('regenTenantSkillFiles leaves other tenants and fleet skills alone', () => {
    row(ID, 'acme'); row('other-skill', 'zeta'); avail.set('acme', ['ann']); avail.set('zeta', ['cy'])
    row('global/x', 'fleet')
    expect(regenTenantSkillFiles('acme').written).toBe(1)
    expect(existsSync(agentSkill('cy', 'other-skill'))).toBe(false)
  })

  it('maps a weird id to a safe directory name', () => {
    expect(tenantSkillDirName('acme-demo')).toBe('acme-demo')
    expect(tenantSkillDirName('a/b c')).toBe('a-b-c')
    expect(tenantSkillDirName('../x')).toBe('x')
    expect(tenantSkillDirName('...')).toBeNull()
  })
})

describe('delete and bulk regen', () => {
  it('delete removes the generated copy from every agent, keeps a hand-edited one', () => {
    row(ID, 'acme'); avail.set('acme', ['ann', 'bob'])
    regenSingleSkillFile(ID)
    const content = store.get(ID).content
    writeFileSync(agentSkill('bob', ID), addGeneratedHeader('hand edited\n', ID, { tenant: true }))
    store.delete(ID)
    expect(removeGeneratedSkillFile(ID, content, 'acme')).toEqual({ removed: true, reason: null })
    expect(existsSync(agentSkill('ann', ID))).toBe(false)
    expect(existsSync(agentSkill('bob', ID))).toBe(true)
  })

  it('delete of a DB-only tenant skill reports absent', () => {
    expect(removeGeneratedSkillFile(ID, 'x', 'acme')).toEqual({ removed: false, reason: 'absent' })
  })

  it('bulk regen generates tenant files and sweeps generated copies whose row is gone', () => {
    row(ID, 'acme'); avail.set('acme', ['ann'])
    mkdirSync(join(FAKE_PROJECT, 'agents', 'bob', '.claude', 'skills', 'gone-skill'), { recursive: true })
    writeFileSync(agentSkill('bob', 'gone-skill'), addGeneratedHeader(FM, 'acme-gone-skill', { tenant: true }))
    mkdirSync(join(FAKE_PROJECT, 'agents', 'bob', '.claude', 'skills', 'mine'), { recursive: true })
    writeFileSync(agentSkill('bob', 'mine'), 'hand made\n')

    const res = regenSkillFilesFromSQL()
    expect(res.errors).toBe(0)
    expect(existsSync(agentSkill('ann', ID))).toBe(true)
    expect(existsSync(agentSkill('bob', 'gone-skill'))).toBe(false)
    expect(readFileSync(agentSkill('bob', 'mine'), 'utf-8')).toBe('hand made\n')
  })

  it('bulk regen never removes a fleet-style header copy while sweeping', () => {
    row(ID, 'acme')
    mkdirSync(join(FAKE_PROJECT, 'agents', 'bob', '.claude', 'skills', 'fleetish'), { recursive: true })
    const f = addGeneratedHeader(FM, 'agent/bob/fleetish')
    writeFileSync(agentSkill('bob', 'fleetish'), f)
    regenSkillFilesFromSQL()
    expect(readFileSync(agentSkill('bob', 'fleetish'), 'utf-8')).toBe(f)
  })
})
