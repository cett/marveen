// Only a live skill reaches the agents: the generated files. Real skill-regen and a real filesystem under a temp
// project; only the DB is faked (the DB-level lists are covered in skill-status-lists.test.ts).
//
// Pinned: a skill that is not live is never written by the bulk regen, the single regen, the agent-start pass or the
// per-tenant pass; a live skill that turns non-live loses its generated files (SKILL.md and companion files) on the
// next regen; a file a person edited by hand is left in place and reported; the gap checks do not call a revoked
// skill's missing file a gap.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addGeneratedHeader } from '../skill-header.js'

const { FAKE_HOME, FAKE_PROJECT, store, files, avail } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-status-regen-'))
  return {
    FAKE_HOME: fakeHome,
    FAKE_PROJECT: path.join(fakeHome, 'project'),
    store: new Map<string, any>(),
    files: new Map<string, Array<{ skill_id: string; rel_path: string; content: Buffer; mode: number }>>(),
    avail: new Map<string, string[]>(),
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'main-a', SKILL_SQL_REGEN: true, TENANT_SKILL_FILES: 'single' }
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => [],
}))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', () => ({
  getSkill: vi.fn((id: string) => Promise.resolve(store.get(id))),
  listAllSkills: vi.fn(() => Promise.resolve([...store.values()])),
  listSkillAccess: vi.fn(() => Promise.resolve([])),
  listSkillFiles: vi.fn((id: string) => Promise.resolve(files.get(id) ?? [])),
  getEnabledAgentsForTenant: vi.fn((t: string) => Promise.resolve(avail.get(t) ?? [])),
  getTenantsForAgent: vi.fn((a: string) => Promise.resolve([...avail.entries()].filter(([, agents]) => agents.includes(a)).map(([t]) => t))),
  seedSkillFileIfAbsent: vi.fn(),
}))

import {
  regenSingleSkillFile, regenSkillFilesFromSQL, regenTenantSkillFiles, generateTenantSkillFilesForAgent,
  findMissingSkillFiles, findSkillFileGaps, removeGeneratedTenantSkillFilesForAgent, removeGeneratedSkillFile,
} from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const FM = '---\nname: demo\ndescription: d\n---\n'
const globalMd = (dir: string) => join(FAKE_HOME, '.claude', 'skills', dir, 'SKILL.md')
const agentMd = (agent: string, dir: string) => join(FAKE_PROJECT, 'agents', agent, '.claude', 'skills', dir, 'SKILL.md')

type Status = 'live' | 'pending_review' | 'disabled' | 'expired'
function row(id: string, tenant: string, status: Status = 'live', content = `${FM}# body of ${id}\n`) {
  const r = { id, name: id, description: '', content, tenant_id: tenant, is_global: tenant === 'fleet' ? 1 : 0, status }
  store.set(id, r)
  return r
}
const setStatus = (id: string, status: Status) => { store.get(id).status = status }
function mkAgent(name: string) { mkdirSync(join(FAKE_PROJECT, 'agents', name), { recursive: true }) }

beforeEach(() => {
  rmSync(FAKE_PROJECT, { recursive: true, force: true })
  rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true })
  store.clear(); files.clear(); avail.clear()
  mkAgent('agent-a'); mkAgent('agent-b')
})

describe('fleet skills: only a live skill is written', () => {
  it.each(['pending_review', 'disabled', 'expired'] as const)('the bulk regen writes a live skill and not a %s one', async (status) => {
    row('global/live-one', 'fleet')
    row('global/other-one', 'fleet', status)
    const r = await regenSkillFilesFromSQL()
    expect(r).toMatchObject({ enabled: true, written: 1, errors: 0 })
    expect(existsSync(globalMd('live-one'))).toBe(true)
    expect(existsSync(globalMd('other-one'))).toBe(false)
  })

  it('the single regen of a skill that is not live writes nothing and says not_live', async () => {
    row('global/gone', 'fleet', 'disabled')
    expect(await regenSingleSkillFile('global/gone')).toEqual({ written: false, skipped: true, reason: 'not_live' })
    expect(existsSync(globalMd('gone'))).toBe(false)
  })

  it('also for an agent-owned skill (the path under the agent directory)', async () => {
    row('agent/agent-a/mine', 'fleet', 'disabled')
    await regenSkillFilesFromSQL()
    expect(existsSync(agentMd('agent-a', 'mine'))).toBe(false)
  })

  it('a revoke takes the generated SKILL.md and the companion file away on the next regen, and the empty directory with them', async () => {
    row('global/rev', 'fleet')
    files.set('global/rev', [{ skill_id: 'global/rev', rel_path: 'scripts/run.sh', content: Buffer.from('echo hi\n'), mode: 0o755 }])
    expect(await regenSingleSkillFile('global/rev')).toMatchObject({ written: true })
    expect(existsSync(globalMd('rev'))).toBe(true)
    expect(existsSync(join(FAKE_HOME, '.claude', 'skills', 'rev', 'scripts', 'run.sh'))).toBe(true)

    setStatus('global/rev', 'disabled')
    expect(await regenSingleSkillFile('global/rev')).toEqual({ written: false, skipped: false, reason: null })
    expect(existsSync(globalMd('rev'))).toBe(false)
    expect(existsSync(join(FAKE_HOME, '.claude', 'skills', 'rev', 'scripts', 'run.sh'))).toBe(false)
    expect(existsSync(join(FAKE_HOME, '.claude', 'skills', 'rev'))).toBe(false)
  })

  it('the bulk regen (the startup pass) takes the file of a revoked skill away too, and a second pass is quiet', async () => {
    row('global/rev', 'fleet'); row('global/keep', 'fleet')
    await regenSkillFilesFromSQL()
    setStatus('global/rev', 'disabled')
    expect(await regenSkillFilesFromSQL()).toMatchObject({ errors: 0 })
    expect(existsSync(globalMd('rev'))).toBe(false)
    expect(existsSync(globalMd('keep'))).toBe(true)
    expect(await regenSkillFilesFromSQL()).toMatchObject({ written: 0, errors: 0 })
  })

  it('a dry run removes nothing', async () => {
    row('global/rev', 'fleet')
    await regenSkillFilesFromSQL()
    setStatus('global/rev', 'disabled')
    await regenSkillFilesFromSQL(true)
    expect(existsSync(globalMd('rev'))).toBe(true)
  })

  it('a file that differs from the row does not survive the revoke: SKILL.md is moved aside, under a name the loader does not read', async () => {
    row('global/edited', 'fleet')
    await regenSingleSkillFile('global/edited')
    writeFileSync(globalMd('edited'), `${FM}# my own change\n`)
    setStatus('global/edited', 'disabled')
    const r = await regenSingleSkillFile('global/edited')
    expect(r).toMatchObject({ written: false, skipped: false, reason: 'quarantined' })
    expect(existsSync(globalMd('edited'))).toBe(false)
    expect(r.quarantined).toHaveLength(1)
    expect(r.quarantined![0]).toMatch(/SKILL\.md\.revoked-\d+$/)
    expect(readFileSync(r.quarantined![0], 'utf-8')).toContain('my own change') // the text is kept, not destroyed
  })

  it('one changed character is enough to differ, and it does not keep the skill loadable (the evasion that was open)', async () => {
    row('global/evade', 'fleet')
    await regenSingleSkillFile('global/evade')
    writeFileSync(globalMd('evade'), readFileSync(globalMd('evade'), 'utf-8') + ' ')
    setStatus('global/evade', 'disabled')
    expect(await regenSingleSkillFile('global/evade')).toMatchObject({ reason: 'quarantined' })
    expect(existsSync(globalMd('evade'))).toBe(false)
  })

  it('the bulk regen quarantines too, and a second pass writes nothing and does not fail', async () => {
    row('global/edited', 'fleet')
    await regenSkillFilesFromSQL()
    writeFileSync(globalMd('edited'), `${FM}# my own change\n`)
    setStatus('global/edited', 'disabled')
    expect(await regenSkillFilesFromSQL()).toMatchObject({ written: 0, errors: 0 })
    expect(existsSync(globalMd('edited'))).toBe(false)
    expect(await regenSkillFilesFromSQL()).toMatchObject({ written: 0, errors: 0 })
    expect(await regenSingleSkillFile('global/edited')).toEqual({ written: false, skipped: true, reason: 'not_live' })
  })

  it('the DELETE branch is unchanged: a hand-edited file of a deleted skill stays in place', async () => {
    row('global/gone', 'fleet')
    await regenSingleSkillFile('global/gone')
    writeFileSync(globalMd('gone'), `${FM}# my own change\n`)
    const deleted = store.get('global/gone')
    expect(await removeGeneratedSkillFile('global/gone', deleted.content, 'fleet', [])).toEqual({ removed: false, reason: 'modified_on_disk' })
    expect(readFileSync(globalMd('gone'), 'utf-8')).toContain('my own change')
  })

  it('a skill that is not live and has no file on disk is a quiet no-op (not an error)', async () => {
    row('global/never', 'fleet', 'pending_review')
    expect(await regenSkillFilesFromSQL()).toMatchObject({ written: 0, errors: 0 })
  })

  it('a skill that is not live and has an id the regen cannot place is not counted as an unrecognized id (it is not written)', async () => {
    row('not-a-known-pattern', 'fleet', 'disabled')
    expect(await regenSkillFilesFromSQL()).toMatchObject({ written: 0, errors: 0 })
  })
})

describe('tenant skills: only a live skill is written to the agents', () => {
  const ID = 'acme-demo'

  it('the single regen writes a live skill and, once it is revoked, removes the generated copies from every agent', async () => {
    row(ID, 'acme'); avail.set('acme', ['agent-a', 'agent-b'])
    expect(await regenSingleSkillFile(ID)).toMatchObject({ written: true })
    expect(existsSync(agentMd('agent-a', ID))).toBe(true)
    expect(existsSync(agentMd('agent-b', ID))).toBe(true)

    setStatus(ID, 'disabled')
    expect(await regenSingleSkillFile(ID)).toEqual({ written: false, skipped: false, reason: null })
    expect(existsSync(agentMd('agent-a', ID))).toBe(false)
    expect(existsSync(agentMd('agent-b', ID))).toBe(false)
    expect(await regenSingleSkillFile(ID)).toEqual({ written: false, skipped: true, reason: 'not_live' })
  })

  it('a hand-edited copy of a revoked skill is moved aside, not left loadable', async () => {
    row(ID, 'acme'); avail.set('acme', ['agent-a'])
    await regenSingleSkillFile(ID)
    // Edited by hand: still carries the generated header, but the body no longer equals the DB row.
    writeFileSync(agentMd('agent-a', ID), addGeneratedHeader(`${FM}# hand made change\n`, ID, { tenant: true }))
    setStatus(ID, 'disabled')
    const r = await regenSingleSkillFile(ID)
    expect(r).toMatchObject({ written: false, skipped: false, reason: 'quarantined' })
    expect(existsSync(agentMd('agent-a', ID))).toBe(false)
    expect(r.quarantined).toHaveLength(1)
    expect(readFileSync(r.quarantined![0], 'utf-8')).toContain('hand made change')
    // A second regen is quiet.
    expect(await regenSingleSkillFile(ID)).toEqual({ written: false, skipped: true, reason: 'not_live' })
    expect(await regenTenantSkillFiles('acme')).toMatchObject({ written: 0, errors: 0 })
  })

  it('a stale hand-edited copy of a LIVE skill (the agent no longer qualifies) is still left in place: only the not-live branch quarantines', async () => {
    row(ID, 'acme'); avail.set('acme', ['agent-a'])
    await regenSingleSkillFile(ID)
    writeFileSync(agentMd('agent-a', ID), addGeneratedHeader(`${FM}# hand made change\n`, ID, { tenant: true }))
    avail.set('acme', [])
    await regenTenantSkillFiles('acme')
    expect(readFileSync(agentMd('agent-a', ID), 'utf-8')).toContain('hand made change')
  })

  it.each(['pending_review', 'disabled', 'expired'] as const)('the bulk regen, the per-tenant pass and the agent-start pass write no copy of a %s skill', async (status) => {
    row(ID, 'acme', status); avail.set('acme', ['agent-a'])
    await regenSkillFilesFromSQL()
    await regenTenantSkillFiles('acme')
    await generateTenantSkillFilesForAgent('agent-a')
    expect(existsSync(agentMd('agent-a', ID))).toBe(false)
  })

  it('the agent-start pass writes the live skills only', async () => {
    row('acme-live', 'acme'); row('acme-off', 'acme', 'disabled'); avail.set('acme', ['agent-a'])
    expect(await generateTenantSkillFilesForAgent('agent-a')).toMatchObject({ written: 1, errors: 0 })
    expect(existsSync(agentMd('agent-a', 'acme-live'))).toBe(true)
    expect(existsSync(agentMd('agent-a', 'acme-off'))).toBe(false)
  })

  it('the per-tenant pass (availability change) removes the copy of a skill that was revoked meanwhile', async () => {
    row(ID, 'acme'); avail.set('acme', ['agent-a'])
    await regenTenantSkillFiles('acme')
    expect(existsSync(agentMd('agent-a', ID))).toBe(true)
    setStatus(ID, 'disabled')
    expect(await regenTenantSkillFiles('acme')).toMatchObject({ removed: 1, errors: 0 })
    expect(existsSync(agentMd('agent-a', ID))).toBe(false)
  })

  it('the agent-stop pass still finds the row of a skill that is not live and clears its generated copy', async () => {
    row(ID, 'acme'); avail.set('acme', ['agent-a'])
    await generateTenantSkillFilesForAgent('agent-a')
    setStatus(ID, 'disabled')
    expect(await removeGeneratedTenantSkillFilesForAgent('agent-a')).toMatchObject({ removed: 1, errors: 0 })
    expect(existsSync(agentMd('agent-a', ID))).toBe(false)
  })

  it('the copy written from the DB carries the generated header (the live path is unchanged)', async () => {
    const r = row(ID, 'acme'); avail.set('acme', ['agent-a'])
    await regenSingleSkillFile(ID)
    expect(readFileSync(agentMd('agent-a', ID), 'utf-8')).toBe(addGeneratedHeader(r.content, ID, { tenant: true }))
  })
})

describe('the gap checks do not ask for the file of a skill that is not live', () => {
  it('findMissingSkillFiles lists a live skill without a file and not a revoked one', async () => {
    row('global/live-x', 'fleet'); row('global/off-x', 'fleet', 'disabled')
    expect(await findMissingSkillFiles()).toEqual(['global/live-x'])
  })

  it('findSkillFileGaps: skill file, companion file and tenant copy are gaps only for live skills', async () => {
    row('global/off-y', 'fleet', 'disabled')
    files.set('global/off-y', [{ skill_id: 'global/off-y', rel_path: 'ref/a.md', content: Buffer.from('x'), mode: 0o644 }])
    row('acme-off', 'acme', 'disabled'); avail.set('acme', ['agent-a'])
    expect(await findSkillFileGaps()).toEqual({ skillFiles: [], companionFiles: [], tenantCopies: [] })
    setStatus('global/off-y', 'live'); setStatus('acme-off', 'live')
    const g = await findSkillFileGaps()
    expect(g.skillFiles).toEqual(['global/off-y'])
    expect(g.companionFiles).toEqual(['global/off-y:ref/a.md'])
    expect(g.tenantCopies).toEqual(['acme-off@agent-a'])
  })
})
