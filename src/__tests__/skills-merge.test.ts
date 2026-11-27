// The Skills screen merges the database rows with the two file scans (web/modules/skills-merge.js, pure: no DOM, no fetch).
// The row id is the join key: global/<dir> and agent/<agentId>/<dir>. A skill never disappears because its file is gone.
// Neutral fixtures only (skill-a, agent-a, tenant-a, plugin-a).
import { describe, it, expect } from 'vitest'
// @ts-expect-error a browser ES module without type declarations
import { mergeSkills, skillFlags, classifySkillId, parseKeywords } from '../../web/modules/skills-merge.js'

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id.split('/').pop(), description: `desc ${id}`, content: '---\nname: x\nkeywords: a, b\n---\nbody', tenant_id: 'fleet',
  status: 'live', updated_at: 1700000000, file_present: true, ...extra,
})
const userFile = (name: string, extra: Record<string, unknown> = {}) => ({
  name, label: name, description: 'from file', keywords: [], agents: ['agent-a'], path: `/x/${name}`, mtime: 1800000000000, source: 'user', ...extra,
})
const pluginFile = (name: string) => ({
  name: `plugin-a/1.0/${name}`, label: `plugin-a:${name}`, description: 'plugin', keywords: [], agents: [], path: '/p', mtime: 1, source: 'plugin', pluginPackage: 'plugin-a/1.0',
})
const localFile = (agentId: string, name: string) => ({ name, label: name, agentId, description: 'local', keywords: [], mtime: 5, source: 'agent' })

describe('mergeSkills', () => {
  it('a row with no file is listed (badge file_missing), editable and deletable', () => {
    const [e] = mergeSkills({ sqlRows: [row('global/skill-a', { file_present: false })], userScan: [], localScan: [] })
    expect(e).toMatchObject({ origin: 'sql', sqlId: 'global/skill-a', name: 'skill-a', source: 'user', filePresent: false })
    expect(skillFlags(e)).toEqual({ badge: 'file_missing', canEdit: true, canDelete: true })
  })

  it('a row and its file are ONE entry, not two (the key is global/<dir>); the file adds its mtime and coverage', () => {
    const out = mergeSkills({ sqlRows: [row('global/skill-a')], userScan: [userFile('skill-a')], localScan: [] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ origin: 'sql', mtime: 1800000000000, agents: ['agent-a'], description: 'desc global/skill-a' })
    expect(skillFlags(out[0]).badge).toBeNull()
  })

  it('a file with no row is listed with the not_synced badge, read only and not deletable', () => {
    const [e] = mergeSkills({ sqlRows: [], userScan: [userFile('skill-b')], localScan: [] })
    expect(e).toMatchObject({ origin: 'file', sqlId: null, name: 'skill-b', source: 'user' })
    expect(skillFlags(e)).toEqual({ badge: 'not_synced', canEdit: false, canDelete: false })
  })

  it('a plugin skill is unchanged: listed as the scan gave it, read only, no badge, not deletable', () => {
    const [e] = mergeSkills({ sqlRows: [], userScan: [pluginFile('skill-c')], localScan: [] })
    expect(e).toMatchObject({ origin: 'plugin', source: 'plugin', label: 'plugin-a:skill-c', pluginPackage: 'plugin-a/1.0' })
    expect(skillFlags(e)).toEqual({ badge: null, canEdit: false, canDelete: false })
  })

  it('an agent-local row and its local file are one entry (key agent/<agentId>/<dir>); another agent\'s file of the same name is separate', () => {
    const out = mergeSkills({
      sqlRows: [row('agent/agent-a/skill-d')], userScan: [],
      localScan: [localFile('agent-a', 'skill-d'), localFile('agent-b', 'skill-d')],
    })
    expect(out).toHaveLength(2)
    expect(out.find((e: any) => e.agentId === 'agent-a')).toMatchObject({ origin: 'sql', source: 'agent' })
    expect(out.find((e: any) => e.agentId === 'agent-b')).toMatchObject({ origin: 'file', source: 'agent' })
  })

  it('a tenant skill (id <tenant>-<slug>) has no folder to match: listed on its own, no file badge (file state unknown)', () => {
    const [e] = mergeSkills({ sqlRows: [row('tenant-a-skill-e', { tenant_id: 'tenant-a', file_present: null, name: 'Skill E' })], userScan: [userFile('skill-e')], localScan: [] })
    expect(e).toMatchObject({ origin: 'sql', name: 'Skill E', tenantId: 'tenant-a', filePresent: null })
    expect(skillFlags(e).badge).toBeNull()
    // the scanned folder of the same short name is NOT mistaken for it
    expect(mergeSkills({ sqlRows: [row('tenant-a-skill-e', { tenant_id: 'tenant-a', file_present: null })], userScan: [userFile('skill-e')], localScan: [] })).toHaveLength(2)
  })

  it('a row that is not live gets the not_live badge, whatever its file says', () => {
    const [e] = mergeSkills({ sqlRows: [row('global/skill-f', { status: 'disabled', file_present: false })], userScan: [], localScan: [] })
    expect(skillFlags(e).badge).toBe('not_live')
  })

  it('a caller who may not scan (a tenant) gets the rows only: no file entry, no plugin entry, nothing to merge', () => {
    const out = mergeSkills({ sqlRows: [row('tenant-a-skill-g', { tenant_id: 'tenant-a', file_present: undefined })], userScan: [], localScan: [] })
    expect(out).toHaveLength(1)
    expect(out[0].filePresent).toBeNull()
  })

  it('a row whose name differs from its folder is still matched by the ID, not the name (no double listing)', () => {
    const out = mergeSkills({ sqlRows: [row('global/skill-h', { name: 'Skill H, renamed' })], userScan: [userFile('skill-h')], localScan: [] })
    expect(out).toHaveLength(1)
  })

  it('never drops a skill: every row, every unmatched file and every plugin skill is in the output', () => {
    const out = mergeSkills({
      sqlRows: [row('global/a', { file_present: false }), row('global/b'), row('agent/agent-a/c', { file_present: false })],
      userScan: [userFile('b'), userFile('only-file'), pluginFile('p')], localScan: [localFile('agent-a', 'c'), localFile('agent-a', 'only-local')],
    })
    expect(out.map((e: any) => e.key).sort()).toEqual(['agent/agent-a/c', 'agent/agent-a/only-local', 'global/a', 'global/b', 'global/only-file', 'plugin:plugin-a/1.0/p'])
  })
})

describe('classifySkillId / parseKeywords', () => {
  it('reads the id scheme', () => {
    expect(classifySkillId('global/skill-a', 'x')).toEqual({ source: 'user', name: 'skill-a', scanKey: 'global/skill-a' })
    expect(classifySkillId('agent/agent-a/skill-a', 'x')).toEqual({ source: 'agent', name: 'skill-a', agentId: 'agent-a', scanKey: 'agent/agent-a/skill-a' })
    expect(classifySkillId('tenant-a-skill', 'Skill')).toEqual({ source: 'user', name: 'Skill', scanKey: null })
  })

  it('reads the frontmatter keywords like the file scan does', () => {
    expect(parseKeywords('---\nkeywords: "a, b ,c"\n---\nx')).toEqual(['a', 'b', 'c'])
    expect(parseKeywords('no frontmatter')).toEqual([])
    expect(parseKeywords(undefined)).toEqual([])
  })
})
