import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Real SQLite (migration 0091 applied by initDatabase): the skill write trail, its hashing and the boot baseline.
let dbMod: typeof import('../db.js')
let facade: typeof import('../db/facade.js')
let storeDir: string

const SYSTEM = { kind: 'system', id: null } as const
const HUMAN = { kind: 'human', id: 'user-a' } as const

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-skill-revisions-test-'))
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

const noop = () => Promise.resolve()

async function revisions(skillId: string) {
  return facade.dbx.all<import('../db/skill-revisions.js').SkillRevisionRow>('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY seq', skillId)
}

async function seedSkill(id: string, content: string, tenant = 'fleet') {
  await facade.dbx.run(
    "INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at) VALUES (?, ?, '', ?, ?, 0, NULL, 1, 1)",
    id, id, content, tenant)
}

/** One skill write plus its trace in one transaction, the way the writer functions will do it. */
async function traced(
  id: string,
  action: import('../db/skill-revisions.js').SkillRevisionAction,
  mutate: (tx: import('../db/facade.js').Tx) => Promise<void>,
  actor: import('../db/skill-revisions.js').SkillActor = HUMAN,
) {
  return facade.dbx.tx(async (tx) => {
    await mutate(tx)
    const skill = (await tx.get<{ id: string; tenant_id: string; content: string }>('SELECT id, tenant_id, content FROM skills WHERE id = ?', id))!
    return dbMod.writeSkillRevision(tx, { skill, action, actor })
  })
}

describe('hashing', () => {
  it('sha256Hex matches the known vector for "abc"', () => {
    expect(dbMod.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashes a Buffer by its bytes, the same as the equal string', () => {
    expect(dbMod.sha256Hex(Buffer.from('abc'))).toBe(dbMod.sha256Hex('abc'))
  })

  it('hashFileSet does not depend on the row order', () => {
    const a = { rel_path: 'references/a.md', mode: 0o644, content: Buffer.from('A') }
    const b = { rel_path: 'scripts/b.sh', mode: 0o755, content: Buffer.from('B') }
    expect(dbMod.hashFileSet([a, b])).toBe(dbMod.hashFileSet([b, a]))
    expect(dbMod.hashFileSet([a, b])).not.toBeNull()
  })

  it('hashFileSet is null for no files and changes with the path, the mode and the bytes', () => {
    const base = { rel_path: 'x.txt', mode: 0o644, content: Buffer.from('one') }
    expect(dbMod.hashFileSet([])).toBeNull()
    const h = dbMod.hashFileSet([base])
    expect(dbMod.hashFileSet([{ ...base, rel_path: 'y.txt' }])).not.toBe(h)
    expect(dbMod.hashFileSet([{ ...base, mode: 0o755 }])).not.toBe(h)
    expect(dbMod.hashFileSet([{ ...base, content: Buffer.from('two') }])).not.toBe(h)
  })

  it('hashFileSet keeps the path / mode boundary: a digit moved between them is another set', () => {
    // Same bytes, and "f" + 420 vs "f4" + 20 read the same without separators: the separators are part of the hashed lines.
    const bytes = Buffer.from('same')
    const one = dbMod.hashFileSet([{ rel_path: 'f', mode: 420, content: bytes }])
    const two = dbMod.hashFileSet([{ rel_path: 'f4', mode: 20, content: bytes }])
    expect(one).not.toBe(two)
  })

  it('hashFileSet keeps the file boundary: one file is not two', () => {
    const one = dbMod.hashFileSet([{ rel_path: 'a', mode: 420, content: Buffer.from('x') }, { rel_path: 'b', mode: 420, content: Buffer.from('y') }])
    const merged = dbMod.hashFileSet([{ rel_path: 'a', mode: 420, content: Buffer.from('xb') }])
    expect(one).not.toBe(merged)
  })

  it('hasRunnableFiles: scripts/ path, any exec bit, but not plain text', () => {
    const f = (rel_path: string, mode: number) => ({ rel_path, mode, content: Buffer.from('x') })
    expect(dbMod.hasRunnableFiles([])).toBe(false)
    expect(dbMod.hasRunnableFiles([f('references/a.md', 0o644)])).toBe(false)
    expect(dbMod.hasRunnableFiles([f('scripts/run.txt', 0o644)])).toBe(true)
    expect(dbMod.hasRunnableFiles([f('tools/run.sh', 0o755)])).toBe(true)
    // "scripts" as a file name or a longer directory name is not the scripts/ directory.
    expect(dbMod.hasRunnableFiles([f('scripts', 0o644), f('my-scripts/a.md', 0o644)])).toBe(false)
  })
})

describe('writeSkillRevision', () => {
  it('records a create with the hash of the stored text, no previous hash and seq 1', async () => {
    const row = await traced('global/a', 'create', (tx) => tx.run(
      "INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_at, updated_at) VALUES ('global/a', 'a', '', 'abc', 'fleet', 1, 1, 1)").then(() => undefined))
    expect(row).toMatchObject({
      skill_id: 'global/a', tenant_id: 'fleet', seq: 1, action: 'create',
      content_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      prev_sha256: null, files_sha256: null, has_scripts: 0, content: 'abc',
      author_kind: 'human', author_id: 'user-a',
    })
  })

  it('chains prev_sha256 to the previous revision and numbers seq without gaps', async () => {
    await seedSkill('global/a', 'v1')
    const r1 = await traced('global/a', 'baseline', noop, SYSTEM)
    const r2 = await traced('global/a', 'modify', (tx) => tx.run("UPDATE skills SET content = 'v2' WHERE id = 'global/a'").then(() => undefined))
    const r3 = await traced('global/a', 'modify', (tx) => tx.run("UPDATE skills SET content = 'v3' WHERE id = 'global/a'").then(() => undefined))
    expect([r1?.seq, r2?.seq, r3?.seq]).toEqual([1, 2, 3])
    expect(r2?.prev_sha256).toBe(r1?.content_sha256)
    expect(r3?.prev_sha256).toBe(r2?.content_sha256)
    expect(r2?.content_sha256).toBe(dbMod.sha256Hex('v2'))
  })

  it('records who, from where and why', async () => {
    await seedSkill('global/a', 'v1')
    const row = await facade.dbx.tx(async (tx) => dbMod.writeSkillRevision(tx, {
      skill: { id: 'global/a', tenant_id: 'fleet', content: 'v1' }, action: 'seed',
      actor: { kind: 'import', id: null }, sourceRef: 'bundle-a.zip', reason: 'initial import',
    }))
    expect(row).toMatchObject({ author_kind: 'import', author_id: null, source_ref: 'bundle-a.zip', reason: 'initial import' })
  })

  it('writes no row for a modify that changes nothing', async () => {
    await seedSkill('global/a', 'same')
    await traced('global/a', 'baseline', noop, SYSTEM)
    const again = await traced('global/a', 'modify', noop)
    expect(again).toBeNull()
    expect(await revisions('global/a')).toHaveLength(1)
  })

  it('a modify that changes the text is recorded, and one back to the earlier text too (it is a change from the latest)', async () => {
    await seedSkill('global/a', 'v1')
    await traced('global/a', 'baseline', noop, SYSTEM)
    await traced('global/a', 'modify', (tx) => tx.run("UPDATE skills SET content = 'v2' WHERE id = 'global/a'").then(() => undefined))
    const back = await traced('global/a', 'modify', (tx) => tx.run("UPDATE skills SET content = 'v1' WHERE id = 'global/a'").then(() => undefined))
    expect(back?.seq).toBe(3)
    expect(back?.content_sha256).toBe(dbMod.sha256Hex('v1'))
  })

  it('create, seed, delete and baseline are always recorded, also when the text equals the latest', async () => {
    await seedSkill('global/a', 'same')
    await traced('global/a', 'baseline', noop, SYSTEM)
    for (const action of ['seed', 'delete', 'create'] as const) {
      expect(await traced('global/a', action, noop), action).not.toBeNull()
    }
    expect((await revisions('global/a')).map((r) => r.action)).toEqual(['baseline', 'seed', 'delete', 'create'])
  })

  it('records a companion file put without copying the file or the text, and flags scripts', async () => {
    await seedSkill('global/a', 'text')
    await traced('global/a', 'baseline', noop, SYSTEM)
    const put = await traced('global/a', 'file_put', (tx) => tx.run(
      "INSERT INTO skill_files (skill_id, rel_path, content, mode) VALUES ('global/a', 'scripts/run.sh', ?, 493)", Buffer.from('echo hi')).then(() => undefined))
    expect(put).toMatchObject({ seq: 2, action: 'file_put', has_scripts: 1, content: null })
    expect(put?.files_sha256).toBe(dbMod.hashFileSet([{ rel_path: 'scripts/run.sh', mode: 0o755, content: Buffer.from('echo hi') }]))
    // The SKILL.md hash is the same as before: only the file set moved.
    expect(put?.content_sha256).toBe(dbMod.sha256Hex('text'))
  })

  it('a file put with the same bytes and mode writes no row, a different byte does', async () => {
    await seedSkill('global/a', 'text')
    const insert = (bytes: string) => (tx: import('../db/facade.js').Tx) => tx.run(
      "INSERT INTO skill_files (skill_id, rel_path, content, mode) VALUES ('global/a', 'references/a.md', ?, 420) ON CONFLICT(skill_id, rel_path) DO UPDATE SET content = excluded.content", Buffer.from(bytes)).then(() => undefined)
    await traced('global/a', 'baseline', noop, SYSTEM)
    expect(await traced('global/a', 'file_put', insert('one'))).not.toBeNull()
    expect(await traced('global/a', 'file_put', insert('one'))).toBeNull()
    expect(await traced('global/a', 'file_seed', insert('one'))).toBeNull()
    expect(await traced('global/a', 'file_put', insert('two'))).not.toBeNull()
    expect(await revisions('global/a')).toHaveLength(3)
  })

  it('a file delete is recorded and takes the scripts flag back to 0', async () => {
    await seedSkill('global/a', 'text')
    await traced('global/a', 'baseline', noop, SYSTEM)
    await traced('global/a', 'file_put', (tx) => tx.run(
      "INSERT INTO skill_files (skill_id, rel_path, content, mode) VALUES ('global/a', 'scripts/run.sh', ?, 493)", Buffer.from('x')).then(() => undefined))
    const del = await traced('global/a', 'file_delete', (tx) => tx.run("DELETE FROM skill_files WHERE skill_id = 'global/a'").then(() => undefined))
    expect(del).toMatchObject({ action: 'file_delete', has_scripts: 0, files_sha256: null, content: null })
  })

  it('a delete keeps the last text, and the trail outlives the skill', async () => {
    await seedSkill('global/a', 'last words')
    await traced('global/a', 'baseline', noop, SYSTEM)
    const del = await facade.dbx.tx(async (tx) => {
      const skill = (await tx.get<{ id: string; tenant_id: string; content: string }>('SELECT id, tenant_id, content FROM skills WHERE id = ?', 'global/a'))!
      const rev = await dbMod.writeSkillRevision(tx, { skill, action: 'delete', actor: HUMAN })
      await tx.run('DELETE FROM skills WHERE id = ?', 'global/a')
      return rev
    })
    expect(del).toMatchObject({ action: 'delete', content: 'last words' })
    expect(await dbMod.getSkill('global/a')).toBeUndefined()
    expect((await revisions('global/a')).map((r) => r.action)).toEqual(['baseline', 'delete'])
  })

  it('after a delete, a re-create continues the numbering', async () => {
    await seedSkill('global/a', 'v1')
    await traced('global/a', 'baseline', noop, SYSTEM)
    await facade.dbx.tx(async (tx) => {
      await dbMod.writeSkillRevision(tx, { skill: { id: 'global/a', tenant_id: 'fleet', content: 'v1' }, action: 'delete', actor: HUMAN })
      await tx.run('DELETE FROM skills WHERE id = ?', 'global/a')
    })
    await seedSkill('global/a', 'v1')
    const again = await traced('global/a', 'modify', noop)
    // A modify straight after a delete is not "unchanged": the latest revision is the delete.
    expect(again?.seq).toBe(3)
  })

  it('has no foreign key to skills (the table is built to outlive the skill)', async () => {
    const fks = await facade.dbx.all("SELECT * FROM pragma_foreign_key_list('skill_revisions')")
    expect(fks).toEqual([])
  })

  it('rejects an unknown action or author kind at the table', async () => {
    const ins = (action: string, kind: string) => facade.dbx.run(
      'INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES (?, ?, 1, ?, ?)', 'global/z', 'fleet', action, kind)
    await expect(ins('rollback', 'human')).rejects.toThrow()
    await expect(ins('create', 'robot')).rejects.toThrow()
    await expect(ins('create', 'human')).resolves.toBeDefined()
  })

  it('accepts the values reserved for the later quarantine steps, so the table never needs a rebuild for them', async () => {
    let seq = 0
    const ins = (action: string, kind: string) => facade.dbx.run(
      'INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES (?, ?, ?, ?, ?)', 'global/r', 'fleet', ++seq, action, kind)
    for (const action of ['activate', 'revoke', 'reject', 'expire']) await expect(ins(action, 'human'), action).resolves.toBeDefined()
    await expect(ins('create', 'auto')).resolves.toBeDefined()
    // Reserved is not open: a near miss is still refused.
    await expect(ins('activated', 'human')).rejects.toThrow()
    await expect(ins('create', 'automatic')).rejects.toThrow()
  })

  it('refuses a second row with the same (skill, seq)', async () => {
    const ins = () => facade.dbx.run(
      "INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('global/z', 'fleet', 1, 'create', 'human')")
    await ins()
    await expect(ins()).rejects.toThrow()
  })
})

describe('atomicity and ordering', () => {
  it('a failing revision insert rolls the skill write back', async () => {
    await seedSkill('global/a', 'v1')
    await expect(facade.dbx.tx(async (tx) => {
      await tx.run("UPDATE skills SET content = 'v2' WHERE id = 'global/a'")
      // An action the CHECK refuses stands in for any failure of the trace insert.
      await dbMod.writeSkillRevision(tx, { skill: { id: 'global/a', tenant_id: 'fleet', content: 'v2' }, action: 'bogus' as never, actor: HUMAN })
    })).rejects.toThrow()
    expect((await dbMod.getSkill('global/a'))?.content).toBe('v1')
    expect(await revisions('global/a')).toEqual([])
  })

  it('a rolled-back skill write leaves no revision behind', async () => {
    await seedSkill('global/a', 'v1')
    await expect(facade.dbx.tx(async (tx) => {
      await tx.run("UPDATE skills SET content = 'v2' WHERE id = 'global/a'")
      await dbMod.writeSkillRevision(tx, { skill: { id: 'global/a', tenant_id: 'fleet', content: 'v2' }, action: 'modify', actor: HUMAN })
      throw new Error('later step failed')
    })).rejects.toThrow('later step failed')
    expect((await dbMod.getSkill('global/a'))?.content).toBe('v1')
    expect(await revisions('global/a')).toEqual([])
  })

  it('two writes at once get distinct, consecutive seq numbers', async () => {
    await seedSkill('global/a', 'v0')
    await traced('global/a', 'baseline', noop, SYSTEM)
    const write = (text: string) => traced('global/a', 'modify', (tx) => tx.run('UPDATE skills SET content = ? WHERE id = ?', text, 'global/a').then(() => undefined))
    await Promise.all([write('v1'), write('v2'), write('v3')])
    expect((await revisions('global/a')).map((r) => r.seq)).toEqual([1, 2, 3, 4])
  })

  it('numbers each skill on its own', async () => {
    await seedSkill('global/a', 'a')
    await seedSkill('global/b', 'b')
    await traced('global/a', 'baseline', noop, SYSTEM)
    await traced('global/a', 'modify', (tx) => tx.run("UPDATE skills SET content = 'a2' WHERE id = 'global/a'").then(() => undefined))
    const b = await traced('global/b', 'baseline', noop, SYSTEM)
    expect(b?.seq).toBe(1)
  })
})

describe('backfillSkillBaselines', () => {
  it('gives every skill without a revision a baseline at seq 1 with the right hash, text and tenant', async () => {
    await seedSkill('global/a', 'abc')
    await seedSkill('agent/agent-a/b', 'other text', 'tenant-x')
    const res = await dbMod.backfillSkillBaselines()
    expect(res).toEqual({ written: 2, errors: 0 })
    const a = await revisions('global/a')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({
      seq: 1, action: 'baseline', author_kind: 'system', author_id: 'baseline', tenant_id: 'fleet', content: 'abc',
      content_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', prev_sha256: null,
    })
    expect((await revisions('agent/agent-a/b'))[0]).toMatchObject({ tenant_id: 'tenant-x', content: 'other text' })
  })

  it('records the companion files the skill has at that time', async () => {
    await seedSkill('global/a', 'text')
    await facade.dbx.run("INSERT INTO skill_files (skill_id, rel_path, content, mode) VALUES ('global/a', 'scripts/run.sh', ?, 493)", Buffer.from('x'))
    await dbMod.backfillSkillBaselines()
    const [base] = await revisions('global/a')
    expect(base?.has_scripts).toBe(1)
    expect(base?.files_sha256).toBe(dbMod.hashFileSet([{ rel_path: 'scripts/run.sh', mode: 0o755, content: Buffer.from('x') }]))
  })

  it('is idempotent: a second run writes nothing and duplicates nothing', async () => {
    await seedSkill('global/a', 'a')
    expect((await dbMod.backfillSkillBaselines()).written).toBe(1)
    expect(await dbMod.backfillSkillBaselines()).toEqual({ written: 0, errors: 0 })
    expect(await revisions('global/a')).toHaveLength(1)
  })

  it('leaves a skill that already has a revision alone', async () => {
    await seedSkill('global/a', 'a')
    await traced('global/a', 'create', noop)
    await dbMod.backfillSkillBaselines()
    expect((await revisions('global/a')).map((r) => r.action)).toEqual(['create'])
  })

  it('a skill traced between the listing and its turn is not given a baseline on top', async () => {
    await seedSkill('global/a', 'a')
    const realAll = facade.dbx.all.bind(facade.dbx)
    // The listing returns the skill as untraced; then a real write traces it before the baseline transaction starts.
    const spy = vi.spyOn(facade.dbx, 'all').mockImplementation(async (sql: string, ...params: unknown[]) => {
      const rows = await realAll(sql, ...params)
      if (sql.includes('NOT EXISTS')) {
        await facade.dbx.run("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('global/a', 'fleet', 1, 'create', 'human')")
      }
      return rows
    })
    const res = await dbMod.backfillSkillBaselines()
    spy.mockRestore()
    expect(res).toEqual({ written: 0, errors: 0 })
    expect((await revisions('global/a')).map((r) => r.action)).toEqual(['create'])
  })

  it('a skill whose baseline fails is logged and skipped, the others still get theirs', async () => {
    await seedSkill('global/a', 'a')
    await seedSkill('global/bad', 'b')
    await seedSkill('global/c', 'c')
    await facade.dbx.exec(`
      CREATE TRIGGER fail_one BEFORE INSERT ON skill_revisions WHEN NEW.skill_id = 'global/bad'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`)
    const res = await dbMod.backfillSkillBaselines()
    expect(res).toEqual({ written: 2, errors: 1 })
    expect(await revisions('global/a')).toHaveLength(1)
    expect(await revisions('global/c')).toHaveLength(1)
    expect(await revisions('global/bad')).toEqual([])
    // The failed skill is picked up on the next boot, once the cause is gone.
    await facade.dbx.exec('DROP TRIGGER fail_one')
    expect(await dbMod.backfillSkillBaselines()).toEqual({ written: 1, errors: 0 })
  })

  it('does nothing on an empty skills table', async () => {
    expect(await dbMod.backfillSkillBaselines()).toEqual({ written: 0, errors: 0 })
  })
})
