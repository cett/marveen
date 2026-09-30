import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// findSkillFileGaps(): DB rows whose generated files are missing on disk (the
// state right after a restore). Real filesystem under a temp project, DB faked.

const { FAKE_HOME, FAKE_PROJECT, store, files, grants, avail } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-file-gaps-'))
  return {
    FAKE_HOME: fakeHome,
    FAKE_PROJECT: path.join(fakeHome, 'project'),
    store: new Map<string, any>(),
    files: new Map<string, Array<{ rel_path: string; content: Buffer; mode: number }>>(),
    grants: new Map<string, string[]>(),
    avail: new Map<string, string[]>(),
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: true, TENANT_SKILL_FILES: 'all' }
})
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'), listAgentNames: () => ['ann'] }))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', () => ({
  getSkill: vi.fn((id: string) => store.get(id)),
  listAllSkills: vi.fn(() => [...store.values()]),
  listSkillAccess: vi.fn((id: string) => (grants.get(id) ?? []).map(t => ({ skill_id: id, tenant_id: t }))),
  getEnabledAgentsForTenant: vi.fn((t: string) => avail.get(t) ?? []),
  listSkillFiles: vi.fn((id: string) => files.get(id) ?? []),
  seedSkillFileIfAbsent: vi.fn(),
}))

import { findSkillFileGaps, regenSkillFilesFromSQL } from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const row = (id: string, tenant = 'fleet') => store.set(id, { id, name: id, description: '', content: '---\nname: x\n---\nbody\n', tenant_id: tenant, is_global: 0 })
const globalDir = (n: string) => join(FAKE_HOME, '.claude', 'skills', n)

beforeEach(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
  mkdirSync(join(FAKE_PROJECT, 'agents', 'ann'), { recursive: true })
  store.clear(); files.clear(); grants.clear(); avail.clear()
})

describe('findSkillFileGaps', () => {
  it('is empty for an empty DB', () => {
    expect(findSkillFileGaps()).toEqual({ skillFiles: [], companionFiles: [], tenantCopies: [] })
  })

  it('reports a fleet skill, its companion file and a tenant copy that are all missing (fresh restore)', () => {
    row('global/demo')
    files.set('global/demo', [{ rel_path: 'scripts/run.sh', content: Buffer.from('x'), mode: 0o755 }])
    row('acme-t', 'acme'); avail.set('acme', ['ann'])
    expect(findSkillFileGaps()).toEqual({
      skillFiles: ['global/demo'],
      companionFiles: ['global/demo:scripts/run.sh'],
      tenantCopies: ['acme-t@ann'],
    })
  })

  it('reports only the companion file when SKILL.md is there but the companion is not', () => {
    row('global/demo')
    files.set('global/demo', [{ rel_path: 'references/a.md', content: Buffer.from('x'), mode: 0o644 }])
    mkdirSync(globalDir('demo'), { recursive: true })
    writeFileSync(join(globalDir('demo'), 'SKILL.md'), 'anything')
    expect(findSkillFileGaps()).toEqual({ skillFiles: [], companionFiles: ['global/demo:references/a.md'], tenantCopies: [] })
  })

  it('reports an unsafe companion path as missing instead of probing outside the skill dir', () => {
    row('global/demo')
    files.set('global/demo', [{ rel_path: '../escape', content: Buffer.from('x'), mode: 0o644 }])
    mkdirSync(globalDir('demo'), { recursive: true })
    writeFileSync(join(globalDir('demo'), 'SKILL.md'), 'anything')
    expect(findSkillFileGaps().companionFiles).toEqual(['global/demo:../escape'])
  })

  it('is empty again after the regen has written everything', () => {
    row('global/demo')
    files.set('global/demo', [{ rel_path: 'scripts/run.sh', content: Buffer.from('x'), mode: 0o755 }])
    row('acme-t', 'acme'); avail.set('acme', ['ann'])
    expect(regenSkillFilesFromSQL().errors).toBe(0)
    expect(findSkillFileGaps()).toEqual({ skillFiles: [], companionFiles: [], tenantCopies: [] })
  })

  it('does not count a tenant with no agent (DB-only by design)', () => {
    row('acme-t', 'acme')
    expect(findSkillFileGaps().tenantCopies).toEqual([])
  })

  it('does not write anything', () => {
    row('global/demo')
    findSkillFileGaps()
    expect(existsSync(globalDir('demo'))).toBe(false)
  })
})
