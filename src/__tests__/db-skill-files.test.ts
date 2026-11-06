import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Real SQLite (migration 0063 applied by initDatabase): the skill_files functions.
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-skill-files-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  await dbMod.createSkill({ id: 'global/a', name: 'a', content: 'A', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
  await dbMod.createSkill({ id: 'global/b', name: 'b', content: 'B', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('skill_files', () => {
  it('upserts, reads back bytes exactly, and lists per skill in path order', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255])
    await dbMod.putSkillFile('global/a', 'scripts/z.sh', bytes, 0o755, { kind: 'system', id: null })
    await dbMod.putSkillFile('global/a', 'references/a.md', Buffer.from('doc'), undefined, { kind: 'system', id: null })
    await dbMod.putSkillFile('global/b', 'scripts/z.sh', Buffer.from('other skill'), undefined, { kind: 'system', id: null })
    const f = (await dbMod.getSkillFile('global/a', 'scripts/z.sh'))!
    expect(Buffer.compare(f.content, bytes)).toBe(0)
    expect(f.mode).toBe(0o755)
    expect((await dbMod.listSkillFiles('global/a')).map(r => r.rel_path)).toEqual(['references/a.md', 'scripts/z.sh'])
    expect(await dbMod.countSkillFiles('global/a')).toBe(2)
    expect(await dbMod.countSkillFiles('global/b')).toBe(1)
  })

  it('an update replaces content and mode instead of adding a row', async () => {
    await dbMod.putSkillFile('global/a', 'x.sh', Buffer.from('v1'), 0o644, { kind: 'system', id: null })
    await dbMod.putSkillFile('global/a', 'x.sh', Buffer.from('v2'), 0o755, { kind: 'system', id: null })
    expect(await dbMod.countSkillFiles('global/a')).toBe(1)
    const f = (await dbMod.getSkillFile('global/a', 'x.sh'))!
    expect(f.content.toString()).toBe('v2')
    expect(f.mode).toBe(0o755)
  })

  it('seedSkillFileIfAbsent never overwrites what the DB already has', async () => {
    expect(await dbMod.seedSkillFileIfAbsent('global/a', 'x.txt', Buffer.from('first'), undefined, { kind: 'system', id: null })).toBe(true)
    expect(await dbMod.seedSkillFileIfAbsent('global/a', 'x.txt', Buffer.from('second'), undefined, { kind: 'system', id: null })).toBe(false)
    expect((await dbMod.getSkillFile('global/a', 'x.txt'))!.content.toString()).toBe('first')
  })

  it('stores a sanitized mode only', async () => {
    await dbMod.putSkillFile('global/a', 'm.txt', Buffer.from('x'), 0o4777, { kind: 'system', id: null })
    expect((await dbMod.getSkillFile('global/a', 'm.txt'))!.mode).toBe(0o755)
    await dbMod.putSkillFile('global/a', 'n.txt', Buffer.from('x'), 0o600, { kind: 'system', id: null })
    expect((await dbMod.getSkillFile('global/a', 'n.txt'))!.mode).toBe(0o644)
  })

  it('deleteSkillFile removes one row; deleteSkill removes all of that skill\'s rows and only those', async () => {
    await dbMod.putSkillFile('global/a', '1.txt', Buffer.from('1'), undefined, { kind: 'system', id: null })
    await dbMod.putSkillFile('global/a', '2.txt', Buffer.from('2'), undefined, { kind: 'system', id: null })
    await dbMod.putSkillFile('global/b', '1.txt', Buffer.from('b'), undefined, { kind: 'system', id: null })
    expect(await dbMod.deleteSkillFile('global/a', '1.txt', { kind: 'system', id: null })).toBe(true)
    expect(await dbMod.deleteSkillFile('global/a', '1.txt', { kind: 'system', id: null })).toBe(false)
    await dbMod.deleteSkill('global/a', { kind: 'system', id: null })
    expect(await dbMod.listSkillFiles('global/a')).toEqual([])
    expect(await dbMod.countSkillFiles('global/b')).toBe(1)
  })
})
