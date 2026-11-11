import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// guard.gatePrivilege on updateSkill/putSkillFile (db/tasks.ts): a write that touches privilege (a new/changed
// runnable companion file, or a changed frontmatter privilege block -- including description, see
// skill-privilege.ts) is queued as a pending revision instead of landing on the live row.
let dbMod: typeof import('../db.js')
let facade: typeof import('../db/facade.js')
let storeDir: string

const HUMAN = { kind: 'human', id: 'user-a' } as const

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'skill-privilege-gate-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  facade = await import('../db/facade.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

type Rev = import('../db/skill-revisions.js').SkillRevisionRow
const revs = (id: string) => facade.dbx.all<Rev>('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY seq', id)
const PRIVILEGED = '---\nname: a\ndescription: d\nallowed-tools: Bash\n---\nbody'
const mk = (id = 'global/a', content = PRIVILEGED, description = 'd') =>
  dbMod.createSkill({ id, name: id, description, content, tenant_id: 'fleet', is_global: true }, HUMAN)

describe('updateSkill with guard.gatePrivilege', () => {
  it('a content change to a privilege frontmatter block (allowed-tools) is queued pending, the live row untouched', async () => {
    await mk()
    const result = await dbMod.updateSkill('global/a', { content: '---\nname: a\ndescription: d\nallowed-tools: Bash, Read\n---\nbody' }, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('pending')
    expect((await dbMod.getSkill('global/a'))?.content).toBe(PRIVILEGED)
    const rows = await revs('global/a')
    expect(rows.map((r) => [r.action, r.status, r.touches_privilege])).toEqual([['create', 'activated', 0], ['modify', 'pending', 1]])
  })

  it('an explicit description-column change with the SKILL.md text unchanged is queued pending too (description is a privilege key)', async () => {
    await mk()
    const result = await dbMod.updateSkill('global/a', { description: 'changed' }, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('pending')
    const row = await dbMod.getSkill('global/a')
    expect(row?.description).toBe('d')
    expect(row?.content).toBe(PRIVILEGED)
    if (result.outcome === 'pending') expect(result.revision.touches_privilege).toBe(1)
  })

  it('a plain body edit that leaves every privilege block alone writes straight through, pending or not', async () => {
    await mk()
    const result = await dbMod.updateSkill('global/a', { content: '---\nname: a\ndescription: d\nallowed-tools: Bash\n---\nnew body' }, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('updated')
    expect((await dbMod.getSkill('global/a'))?.content).toContain('new body')
  })

  it('without the guard (the default), the very same privilege-touching patch still writes straight through', async () => {
    await mk()
    const result = await dbMod.updateSkill('global/a', { content: '---\nname: a\ndescription: d\nallowed-tools: Bash, Read\n---\nbody' }, HUMAN)
    expect(result.outcome).toBe('updated')
    expect((await dbMod.getSkill('global/a'))?.content).toContain('allowed-tools: Bash, Read')
  })

  it('a name or is_global change cannot be combined with a gated change: rejected_combo, nothing written', async () => {
    await mk()
    const byName = await dbMod.updateSkill('global/a', { name: 'renamed', description: 'changed' }, HUMAN, {}, { gatePrivilege: true })
    expect(byName.outcome).toBe('rejected_combo')
    const byGlobal = await dbMod.updateSkill('global/a', { is_global: false, description: 'changed' }, HUMAN, {}, { gatePrivilege: true })
    expect(byGlobal.outcome).toBe('rejected_combo')
    const row = await dbMod.getSkill('global/a')
    expect(row?.name).toBe('global/a')
    expect(row?.is_global).toBe(1)
    expect(row?.description).toBe('d')
    expect(await revs('global/a')).toHaveLength(1)
  })

  it('a name change with no gated field present is unaffected by the guard', async () => {
    await mk()
    const result = await dbMod.updateSkill('global/a', { name: 'renamed' }, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('updated')
    expect((await dbMod.getSkill('global/a'))?.name).toBe('renamed')
  })

  it('requireLive is still decided first: a not-live row is not_found before the privilege check ever runs', async () => {
    await mk()
    await facade.dbx.run("UPDATE skills SET status = 'disabled' WHERE id = 'global/a'")
    const result = await dbMod.updateSkill('global/a', { description: 'changed' }, HUMAN, {}, { requireLive: true, gatePrivilege: true })
    expect(result.outcome).toBe('not_found')
    expect(await revs('global/a')).toHaveLength(1)
  })
})

describe('putSkillFile with guard.gatePrivilege', () => {
  it('a new runnable file (scripts/) is queued pending; skill_files stays empty', async () => {
    await mk()
    const result = await dbMod.putSkillFile('global/a', 'scripts/run.sh', Buffer.from('echo hi'), 0o755, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('pending')
    expect(await dbMod.listSkillFiles('global/a')).toEqual([])
    const rows = await revs('global/a')
    expect(rows.map((r) => [r.action, r.status, r.has_scripts, r.touches_privilege])).toEqual([['create', 'activated', 0, 0], ['modify', 'pending', 1, 1]])
  })

  it('a file made executable by its mode bits (not under scripts/) is gated the same way', async () => {
    await mk()
    const result = await dbMod.putSkillFile('global/a', 'bin/tool', Buffer.from('#!/bin/sh'), 0o755, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('pending')
    expect(await dbMod.listSkillFiles('global/a')).toEqual([])
  })

  it('a non-runnable companion file (references/) writes straight through even with the guard on', async () => {
    await mk()
    const result = await dbMod.putSkillFile('global/a', 'references/notes.md', Buffer.from('notes'), 0o644, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('written')
    const files = await dbMod.listSkillFiles('global/a')
    expect(files.map((f) => f.rel_path)).toEqual(['references/notes.md'])
  })

  it('replacing an existing runnable file with different bytes is gated; the old one survives on disk until a decision', async () => {
    await mk()
    await dbMod.putSkillFile('global/a', 'scripts/run.sh', Buffer.from('v1'), 0o755, HUMAN)   // ungated baseline write
    const result = await dbMod.putSkillFile('global/a', 'scripts/run.sh', Buffer.from('v2'), 0o755, HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('pending')
    const files = await dbMod.listSkillFiles('global/a')
    expect(files).toHaveLength(1)
    expect(files[0]?.content.toString()).toBe('v1')
  })

  it('without the guard (the default), the very same runnable file writes straight through as file_put', async () => {
    await mk()
    const result = await dbMod.putSkillFile('global/a', 'scripts/run.sh', Buffer.from('echo hi'), 0o755, HUMAN)
    expect(result.outcome).toBe('written')
    expect((await dbMod.listSkillFiles('global/a')).map((f) => f.rel_path)).toEqual(['scripts/run.sh'])
  })
})

describe('createSkill with guard.gatePrivilege', () => {
  it('a brand-new skill with a privilege frontmatter block is queued pending_review, not live', async () => {
    const result = await dbMod.createSkill(
      { id: 'global/b', name: 'global/b', description: 'd', content: PRIVILEGED, tenant_id: 'fleet', is_global: true },
      HUMAN, {}, { gatePrivilege: true },
    )
    expect(result.outcome).toBe('pending')
    const row = await dbMod.getSkill('global/b')
    expect(row?.status).toBe('pending_review')
    expect(row?.content).toBe(PRIVILEGED)
    const rows = await revs('global/b')
    expect(rows.map((r) => [r.action, r.status, r.touches_privilege])).toEqual([['create', 'pending', 1]])
  })

  it('a brand-new skill with no privilege block writes straight through as live', async () => {
    const result = await dbMod.createSkill(
      { id: 'global/c', name: 'global/c', description: 'd', content: 'body, no frontmatter', tenant_id: 'fleet', is_global: true },
      HUMAN, {}, { gatePrivilege: true },
    )
    expect(result.outcome).toBe('created')
    const row = await dbMod.getSkill('global/c')
    expect(row?.status).toBe('live')
    expect(row?.content).toBe('body, no frontmatter')
  })
})

describe('setSkillContent with guard.gatePrivilege', () => {
  it('a write-back that introduces a privilege block on an existing live skill is queued pending, the live content untouched', async () => {
    await dbMod.createSkill({ id: 'global/d', name: 'global/d', description: 'd', content: 'plain body', tenant_id: 'fleet', is_global: true }, HUMAN)
    const result = await dbMod.setSkillContent('global/d', PRIVILEGED, Math.floor(Date.now() / 1000), HUMAN, {}, { gatePrivilege: true })
    expect(result.outcome).toBe('pending')
    const row = await dbMod.getSkill('global/d')
    expect(row?.status).toBe('live')
    expect(row?.content).toBe('plain body')
  })
})

describe('insertFleetSkillFromFile with guard.gatePrivilege', () => {
  it('a file-backed skill with no DB row yet, carrying a privilege block, is created pending_review instead of live', async () => {
    const result = await dbMod.insertFleetSkillFromFile(
      'global/e', 'global/e', PRIVILEGED, true, Math.floor(Date.now() / 1000), HUMAN, {}, { gatePrivilege: true },
    )
    expect(result.outcome).toBe('pending')
    const row = await dbMod.getSkill('global/e')
    expect(row?.status).toBe('pending_review')
    expect(row?.content).toBe(PRIVILEGED)
    const rows = await revs('global/e')
    expect(rows.map((r) => [r.action, r.status, r.touches_privilege])).toEqual([['create', 'pending', 1]])
  })
})
