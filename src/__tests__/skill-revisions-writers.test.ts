import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Real SQLite: every skill writer in db/tasks.ts leaves exactly the trail the brief asks for, in the same transaction.
let dbMod: typeof import('../db.js')
let facade: typeof import('../db/facade.js')
let storeDir: string

const HUMAN = { kind: 'human', id: 'user-a' } as const
const AGENT = { kind: 'agent', id: 'agent-a' } as const
const SYSTEM = { kind: 'system', id: null } as const
const IMPORT = { kind: 'import', id: 'user-a' } as const
const HEADER = '<!-- GENERATED from the skills DB (skill global/a). Edit through the dashboard. -->\n'

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'skill-revisions-writers-test-'))
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
const actions = async (id: string) => (await revs(id)).map((r) => r.action)
const audits = () => facade.dbx.all<{ agent_id: string; entity: string; action: string; entity_id: string; detail: string | null; tenant_id: string }>(
  "SELECT agent_id, entity, action, entity_id, detail, tenant_id FROM agent_audit_log WHERE entity = 'skill' ORDER BY id")
const mk = (id = 'global/a', content = 'v1') => dbMod.createSkill({ id, name: id, description: 'd', content, tenant_id: 'fleet', is_global: true }, HUMAN)
/** A skill row from before the trail existed: written straight, with no revision. */
const rawSkill = (id: string, content: string) => facade.dbx.run(
  "INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_at, updated_at) VALUES (?, ?, '', ?, 'fleet', 1, 1, 1)", id, id, content)
/** Makes every insert of the given action into skill_revisions fail, standing in for any failure of the trail write. */
const breakTrail = (action: string) => facade.dbx.exec(
  `CREATE TRIGGER break_trail BEFORE INSERT ON skill_revisions WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'simulated trail failure'); END`)

describe('createSkill', () => {
  it('writes one create row with the actor, and hashes the stored text (the generated header is stripped first)', async () => {
    await dbMod.createSkill({ id: 'global/a', name: 'a', content: HEADER + 'body', tenant_id: 'fleet', is_global: true }, HUMAN, { sourceRef: 'api', reason: 'new skill' })
    const rows = await revs('global/a')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      seq: 1, action: 'create', author_kind: 'human', author_id: 'user-a', source_ref: 'api', reason: 'new skill',
      content: 'body', content_sha256: dbMod.sha256Hex('body'), prev_sha256: null,
    })
    expect((await dbMod.getSkill('global/a'))?.content).toBe('body')
  })

  it('a duplicate id fails and leaves no trail row for the attempt', async () => {
    await mk()
    await expect(mk()).rejects.toThrow()
    expect(await actions('global/a')).toEqual(['create'])
  })
})

describe('setSkillContent / updateSkill', () => {
  it('a content change is a modify row chained to the previous hash, with the writer as author', async () => {
    await mk()
    await dbMod.setSkillContent('global/a', 'v2', 5, AGENT, { sourceRef: 'skill-sync' })
    const rows = await revs('global/a')
    expect(rows.map((r) => r.action)).toEqual(['create', 'modify'])
    expect(rows[1]).toMatchObject({ author_kind: 'agent', author_id: 'agent-a', source_ref: 'skill-sync', prev_sha256: dbMod.sha256Hex('v1'), content_sha256: dbMod.sha256Hex('v2'), content: 'v2' })
  })

  it('the same text again writes no row (a repeated sync or seed refresh stays quiet)', async () => {
    await mk()
    await dbMod.setSkillContent('global/a', 'v1', 5, AGENT)
    await dbMod.updateSkill('global/a', { content: 'v1' }, HUMAN)
    expect(await actions('global/a')).toEqual(['create'])
  })

  it('updateSkill hashes the text after the generated header is stripped, not the text it was given', async () => {
    await mk()
    await dbMod.updateSkill('global/a', { content: HEADER + 'v2' }, HUMAN)
    const rows = await revs('global/a')
    expect(rows[1]?.content_sha256).toBe(dbMod.sha256Hex('v2'))
    expect(rows[1]?.content).toBe('v2')
  })

  it('a patch that leaves the text alone (description only) still applies and writes no row', async () => {
    await mk()
    const row = await dbMod.updateSkill('global/a', { description: 'new description' }, HUMAN)
    expect(row?.description).toBe('new description')
    expect(await actions('global/a')).toEqual(['create'])
  })

  it('a real is_global flip is recorded even though the hashes did not move, with the direction as the reason', async () => {
    await mk()   // created global
    await dbMod.updateSkill('global/a', { is_global: false }, HUMAN)
    await dbMod.updateSkill('global/a', { is_global: true }, AGENT)
    const rows = await revs('global/a')
    expect(rows.map((r) => [r.action, r.author_kind, r.reason])).toEqual([['create', 'human', null], ['modify', 'human', 'is_global:1->0'], ['modify', 'agent', 'is_global:0->1']])
    expect(rows[1]?.content_sha256).toBe(rows[1]?.prev_sha256)   // same text: only the flag moved
    expect((await dbMod.getSkill('global/a'))?.is_global).toBe(1)
    expect((await audits()).map((r) => r.action)).toEqual(['create', 'update', 'update'])
  })

  it('setting is_global to the value it already has is not a flip and writes no row', async () => {
    await mk()
    await dbMod.updateSkill('global/a', { is_global: true }, HUMAN)
    await dbMod.updateSkill('global/a', { is_global: true, description: 'other' }, HUMAN)
    expect(await actions('global/a')).toEqual(['create'])
  })

  it('a rename or a description stays untraced next to an unchanged flag', async () => {
    await mk()
    await dbMod.updateSkill('global/a', { name: 'renamed', description: 'new', is_global: true }, HUMAN)
    expect(await actions('global/a')).toEqual(['create'])
    expect(await dbMod.getSkill('global/a')).toMatchObject({ name: 'renamed', description: 'new' })
  })

  it('a flip together with a text change is one row that carries both, and the caller\'s reason stays', async () => {
    await mk()
    await dbMod.updateSkill('global/a', { content: 'v2', is_global: false }, HUMAN, { reason: 'moved to one agent' })
    const rows = await revs('global/a')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ content_sha256: dbMod.sha256Hex('v2'), reason: 'moved to one agent; is_global:1->0' })
  })

  it('a flip on a skill from before the trail leaves baseline + modify', async () => {
    await rawSkill('global/old', 'text')
    await dbMod.updateSkill('global/old', { is_global: false }, HUMAN)
    const rows = await revs('global/old')
    expect(rows.map((r) => [r.action, r.reason])).toEqual([['baseline', null], ['modify', 'is_global:1->0']])
  })

  it('updating a skill that does not exist returns undefined and writes nothing', async () => {
    expect(await dbMod.updateSkill('global/none', { content: 'x' }, HUMAN)).toBeUndefined()
    await dbMod.setSkillContent('global/none', 'x', 1, HUMAN)
    expect(await revs('global/none')).toEqual([])
  })

  it('a skill from before the trail gets its baseline first, so the state before the write is on record', async () => {
    await rawSkill('global/old', 'before')
    await dbMod.updateSkill('global/old', { content: 'after' }, HUMAN)
    const rows = await revs('global/old')
    expect(rows.map((r) => [r.seq, r.action, r.author_kind])).toEqual([[1, 'baseline', 'system'], [2, 'modify', 'human']])
    expect(rows[0]).toMatchObject({ content: 'before', content_sha256: dbMod.sha256Hex('before') })
    expect(rows[1]?.prev_sha256).toBe(dbMod.sha256Hex('before'))
  })
})

describe('insertFleetSkillFromFile', () => {
  it('writes a create row', async () => {
    await dbMod.insertFleetSkillFromFile('agent/agent-a/s', 's', 'text', false, 1, AGENT, { sourceRef: 'skill-sync' })
    expect((await revs('agent/agent-a/s'))[0]).toMatchObject({ action: 'create', author_kind: 'agent', author_id: 'agent-a', source_ref: 'skill-sync', tenant_id: 'fleet' })
  })
})

describe('seedSkillIfAbsent', () => {
  const seed = (content = 'v1') => dbMod.seedSkillIfAbsent({ id: 'global/a', name: 'a', description: '', content, tenant_id: 'fleet', is_global: true }, IMPORT, { sourceRef: 'bundle-a' })

  it('a new skill is a seed row; one that already exists writes nothing and returns false', async () => {
    expect(await seed()).toBe(true)
    expect(await seed('changed')).toBe(false)
    const rows = await revs('global/a')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'seed', author_kind: 'import', author_id: 'user-a', source_ref: 'bundle-a', content: 'v1' })
    expect((await dbMod.getSkill('global/a'))?.content).toBe('v1')
  })

  it('a row the table would reject is skipped without a trail', async () => {
    expect(await dbMod.seedSkillIfAbsent({ id: 'global/x', name: null as never, description: '', content: 'c', tenant_id: 'fleet', is_global: true }, SYSTEM)).toBe(false)
    expect(await revs('global/x')).toEqual([])
  })
})

describe('deleteSkill', () => {
  it('keeps the last text and the file-set hash in a delete row, and the trail outlives the skill', async () => {
    await mk('global/a', 'last words')
    await dbMod.putSkillFile('global/a', 'scripts/run.sh', Buffer.from('echo'), 0o755, HUMAN)
    expect(await dbMod.deleteSkill('global/a', HUMAN, { reason: 'obsolete' })).toBe(true)
    expect(await dbMod.getSkill('global/a')).toBeUndefined()
    expect(await dbMod.countSkillFiles('global/a')).toBe(0)
    const rows = await revs('global/a')
    expect(rows.map((r) => r.action)).toEqual(['create', 'file_put', 'delete'])
    expect(rows[2]).toMatchObject({ content: 'last words', content_sha256: dbMod.sha256Hex('last words'), has_scripts: 1, reason: 'obsolete' })
    expect(rows[2]?.files_sha256).toBe(rows[1]?.files_sha256)
  })

  it('deleting a skill that is not there returns false and writes nothing', async () => {
    expect(await dbMod.deleteSkill('global/none', HUMAN)).toBe(false)
    expect(await revs('global/none')).toEqual([])
  })

  it('a skill from before the trail leaves baseline + delete', async () => {
    await rawSkill('global/old', 'before')
    await dbMod.deleteSkill('global/old', HUMAN)
    expect(await actions('global/old')).toEqual(['baseline', 'delete'])
  })

  it('a re-created skill carries on the numbering of the trail', async () => {
    await mk()
    await dbMod.deleteSkill('global/a', HUMAN)
    await mk()
    expect((await revs('global/a')).map((r) => [r.seq, r.action])).toEqual([[1, 'create'], [2, 'delete'], [3, 'create']])
  })
})

describe('companion files', () => {
  it('putSkillFile: a file_put row with no text copied, the scripts flag and the file-set hash', async () => {
    await mk()
    await dbMod.putSkillFile('global/a', 'scripts/run.sh', Buffer.from('echo hi'), 0o755, AGENT)
    const row = (await revs('global/a'))[1]!
    expect(row).toMatchObject({ action: 'file_put', author_kind: 'agent', has_scripts: 1, content: null, content_sha256: dbMod.sha256Hex('v1') })
    expect(row.files_sha256).toBe(dbMod.hashFileSet([{ rel_path: 'scripts/run.sh', mode: 0o755, content: Buffer.from('echo hi') }]))
  })

  it('the same bytes and mode again write no row; a changed byte or mode does', async () => {
    await mk()
    await dbMod.putSkillFile('global/a', 'references/a.md', Buffer.from('one'), undefined, HUMAN)
    await dbMod.putSkillFile('global/a', 'references/a.md', Buffer.from('one'), undefined, HUMAN)
    expect(await actions('global/a')).toEqual(['create', 'file_put'])
    await dbMod.putSkillFile('global/a', 'references/a.md', Buffer.from('two'), undefined, HUMAN)
    await dbMod.putSkillFile('global/a', 'references/a.md', Buffer.from('two'), 0o755, HUMAN)
    expect(await actions('global/a')).toEqual(['create', 'file_put', 'file_put', 'file_put'])
  })

  it('seedSkillFileIfAbsent: a new file is a file_seed row, an existing one writes nothing', async () => {
    await mk()
    expect(await dbMod.seedSkillFileIfAbsent('global/a', 'x.txt', Buffer.from('first'), undefined, SYSTEM, { sourceRef: 'boot-companion-import' })).toBe(true)
    expect(await dbMod.seedSkillFileIfAbsent('global/a', 'x.txt', Buffer.from('second'), undefined, SYSTEM)).toBe(false)
    expect((await revs('global/a')).map((r) => r.action)).toEqual(['create', 'file_seed'])
    expect((await revs('global/a'))[1]).toMatchObject({ author_kind: 'system', source_ref: 'boot-companion-import' })
  })

  it('deleteSkillFile: a file_delete row; a path that is not there writes nothing', async () => {
    await mk()
    await dbMod.putSkillFile('global/a', 'scripts/run.sh', Buffer.from('x'), 0o755, HUMAN)
    expect(await dbMod.deleteSkillFile('global/a', 'nope.txt', HUMAN)).toBe(false)
    expect(await dbMod.deleteSkillFile('global/a', 'scripts/run.sh', HUMAN)).toBe(true)
    const rows = await revs('global/a')
    expect(rows.map((r) => r.action)).toEqual(['create', 'file_put', 'file_delete'])
    expect(rows[2]).toMatchObject({ has_scripts: 0, files_sha256: null })
  })

  it('a file write on a skill from before the trail leaves baseline + file_put', async () => {
    await rawSkill('global/old', 'text')
    await dbMod.putSkillFile('global/old', 'a.txt', Buffer.from('x'), undefined, HUMAN)
    expect(await actions('global/old')).toEqual(['baseline', 'file_put'])
  })
})

describe('atomicity: the skill write and its trail commit or roll back together', () => {
  it('createSkill: a failing trail insert leaves no skill row', async () => {
    await breakTrail('create')
    await expect(mk()).rejects.toThrow('simulated trail failure')
    expect(await dbMod.getSkill('global/a')).toBeUndefined()
  })

  it('updateSkill and setSkillContent: the text stays as it was', async () => {
    await mk()
    await breakTrail('modify')
    await expect(dbMod.updateSkill('global/a', { content: 'v2', description: 'changed' }, HUMAN)).rejects.toThrow('simulated trail failure')
    await expect(dbMod.setSkillContent('global/a', 'v3', 9, AGENT)).rejects.toThrow('simulated trail failure')
    expect(await dbMod.getSkill('global/a')).toMatchObject({ content: 'v1', description: 'd' })
  })

  it('deleteSkill: the skill and its files are still there', async () => {
    await mk()
    await dbMod.putSkillFile('global/a', 'a.txt', Buffer.from('x'), undefined, HUMAN)
    await breakTrail('delete')
    await expect(dbMod.deleteSkill('global/a', HUMAN)).rejects.toThrow('simulated trail failure')
    expect(await dbMod.getSkill('global/a')).toBeDefined()
    expect(await dbMod.countSkillFiles('global/a')).toBe(1)
  })

  it('putSkillFile, seedSkillFileIfAbsent, deleteSkillFile: the files stay as they were', async () => {
    await mk()
    await dbMod.putSkillFile('global/a', 'keep.txt', Buffer.from('keep'), undefined, HUMAN)
    await breakTrail('file_put')
    await expect(dbMod.putSkillFile('global/a', 'new.txt', Buffer.from('n'), undefined, HUMAN)).rejects.toThrow()
    await expect(dbMod.putSkillFile('global/a', 'keep.txt', Buffer.from('changed'), undefined, HUMAN)).rejects.toThrow()
    expect((await dbMod.getSkillFile('global/a', 'keep.txt'))?.content.toString()).toBe('keep')
    expect(await dbMod.getSkillFile('global/a', 'new.txt')).toBeUndefined()
    await facade.dbx.exec('DROP TRIGGER break_trail')
    await breakTrail('file_seed')
    await expect(dbMod.seedSkillFileIfAbsent('global/a', 'seeded.txt', Buffer.from('s'), undefined, SYSTEM)).rejects.toThrow()
    expect(await dbMod.getSkillFile('global/a', 'seeded.txt')).toBeUndefined()
    await facade.dbx.exec('DROP TRIGGER break_trail')
    await breakTrail('file_delete')
    await expect(dbMod.deleteSkillFile('global/a', 'keep.txt', HUMAN)).rejects.toThrow()
    expect(await dbMod.getSkillFile('global/a', 'keep.txt')).toBeDefined()
  })

  it('seedSkillIfAbsent: no skill row without its trail', async () => {
    await breakTrail('seed')
    await expect(dbMod.seedSkillIfAbsent({ id: 'global/s', name: 's', description: '', content: 'c', tenant_id: 'fleet', is_global: true }, SYSTEM)).rejects.toThrow()
    expect(await dbMod.getSkill('global/s')).toBeUndefined()
  })

  it('a failing audit-log insert rolls the write back too', async () => {
    await mk()
    await facade.dbx.exec("CREATE TRIGGER break_audit BEFORE INSERT ON agent_audit_log WHEN NEW.entity = 'skill' BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END")
    await expect(dbMod.updateSkill('global/a', { content: 'v2' }, HUMAN)).rejects.toThrow('simulated audit failure')
    expect((await dbMod.getSkill('global/a'))?.content).toBe('v1')
    expect(await actions('global/a')).toEqual(['create'])
  })

  it('writes at once on one skill get distinct, consecutive numbers', async () => {
    await mk()
    await Promise.all([1, 2, 3, 4].map((n) => dbMod.updateSkill('global/a', { content: `v${n + 1}` }, HUMAN)))
    expect((await revs('global/a')).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('audit log', () => {
  it('names the revision, the author and 12 hex digits of the hash, and never the text', async () => {
    const canary = 'canary-text-that-must-not-leak'
    await dbMod.createSkill({ id: 'global/a', name: 'a', content: canary, tenant_id: 'fleet', is_global: true }, HUMAN)
    await dbMod.updateSkill('global/a', { content: canary + ' two' }, AGENT)
    await dbMod.deleteSkill('global/a', SYSTEM)
    const rows = await audits()
    expect(rows.map((r) => [r.agent_id, r.entity, r.action, r.entity_id, r.tenant_id])).toEqual([
      ['user-a', 'skill', 'create', 'global/a', 'fleet'],
      ['agent-a', 'skill', 'update', 'global/a', 'fleet'],
      ['system', 'skill', 'delete', 'global/a', 'fleet'],
    ])
    expect(JSON.parse(rows[1]!.detail!)).toEqual({ seq: 2, action: 'modify', author_kind: 'agent', content_sha256: dbMod.sha256Hex(canary + ' two').slice(0, 12) })
    for (const r of rows) expect(r.detail ?? '').not.toContain('canary')
  })

  it('maps seed to create and the file actions to update; the baseline writes no audit row', async () => {
    await dbMod.seedSkillIfAbsent({ id: 'global/a', name: 'a', description: '', content: 'c', tenant_id: 'fleet', is_global: true }, SYSTEM)
    await dbMod.putSkillFile('global/a', 'a.txt', Buffer.from('x'), undefined, HUMAN)
    await rawSkill('global/old', 'before')
    await dbMod.putSkillFile('global/old', 'a.txt', Buffer.from('x'), undefined, HUMAN)   // baseline + file_put
    const rows = await audits()
    expect(rows.map((r) => [r.entity_id, r.action])).toEqual([['global/a', 'create'], ['global/a', 'update'], ['global/old', 'update']])
  })

  it('a write that changes nothing writes no audit row', async () => {
    await mk()
    await dbMod.setSkillContent('global/a', 'v1', 5, AGENT)
    expect(await audits()).toHaveLength(1)
  })
})

describe('boot paths', () => {
  it('a skill written through the writers is not baselined again', async () => {
    await mk()
    await rawSkill('global/old', 'x')
    expect(await dbMod.backfillSkillBaselines()).toEqual({ written: 1, errors: 0 })
    expect(await actions('global/a')).toEqual(['create'])
    expect(await actions('global/old')).toEqual(['baseline'])
  })

  it('the companion import is traced with the actor and the source it was given', async () => {
    const { importCompanionFilesOfDir } = await import('../web/skill-regen.js')
    await mk()
    const dir = join(storeDir, 'skill-dir')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'ignored')
    writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo hi')
    chmodSync(join(dir, 'scripts', 'run.sh'), 0o755)
    writeFileSync(join(dir, 'notes.md'), 'notes')
    const res = await importCompanionFilesOfDir('global/a', dir, { kind: 'import', id: 'user-a' }, false, { sourceRef: 'skill-archive:a' })
    expect(res.seeded).toBe(2)
    const rows = (await revs('global/a')).slice(1)
    expect(rows.map((r) => r.action)).toEqual(['file_seed', 'file_seed'])
    expect(rows.every((r) => r.author_kind === 'import' && r.author_id === 'user-a' && r.source_ref === 'skill-archive:a')).toBe(true)
    expect(rows[1]?.has_scripts).toBe(1)
    // A second import finds everything in place and writes nothing.
    expect((await importCompanionFilesOfDir('global/a', dir, { kind: 'import', id: 'user-a' })).seeded).toBe(0)
    expect(await revs('global/a')).toHaveLength(3)
  })

  it('the tenant purge removes the trail of the tenant skills with the skills', async () => {
    await dbMod.createTenant('tenant-x', 'Tenant X')
    await dbMod.createSkill({ id: 'tenant-x-s', name: 's', content: 'c', tenant_id: 'tenant-x' }, HUMAN)
    await mk()
    await dbMod.deleteTenant('tenant-x')
    expect(await revs('tenant-x-s')).toEqual([])
    expect(await actions('global/a')).toEqual(['create'])
  })
})

// Compile-time guard: tsc (which includes the tests) fails when a line below stops being a type error, i.e. when a writer
// accepts a call without the actor again. The function is never called.
export function actorIsRequired() {
  // @ts-expect-error the actor is required
  void dbMod.createSkill({ id: 'x', name: 'x', content: 'x', tenant_id: 'fleet' })
  // @ts-expect-error the actor is required
  void dbMod.setSkillContent('x', 'x', 1)
  // @ts-expect-error the actor is required
  void dbMod.insertFleetSkillFromFile('x', 'x', 'x', true, 1)
  // @ts-expect-error the actor is required
  void dbMod.updateSkill('x', { content: 'x' })
  // @ts-expect-error the actor is required
  void dbMod.deleteSkill('x')
  // @ts-expect-error the actor is required
  void dbMod.putSkillFile('x', 'a', Buffer.from('x'), undefined)
  // @ts-expect-error the actor is required
  void dbMod.seedSkillFileIfAbsent('x', 'a', Buffer.from('x'), undefined)
  // @ts-expect-error the actor is required
  void dbMod.deleteSkillFile('x', 'a')
  // @ts-expect-error the actor is required
  void dbMod.seedSkillIfAbsent({ id: 'x', name: 'x', description: '', content: 'x', tenant_id: 'fleet', is_global: true })
}
