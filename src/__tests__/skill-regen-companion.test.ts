import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, statSync, symlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

// Companion files of a skill: generation next to SKILL.md, the disk -> DB seed,
// drift restore and removal. Real filesystem under a temp project; DB is faked.

const { FAKE_HOME, FAKE_PROJECT, store, files } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-regen-companion-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project'), store: new Map<string, any>(), files: new Map<string, any>() }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: true }
})
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'), listAgentNames: () => [] }))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
const fk = (id: string, rel: string) => `${id}\u0000${rel}`
vi.mock('../db.js', () => ({
  getSkill: vi.fn((id: string) => store.get(id)),
  listAllSkills: vi.fn(() => [...store.values()]),
  listSkillAccess: vi.fn().mockReturnValue([]),
  getEnabledAgentsForTenant: vi.fn().mockReturnValue([]),
  listSkillFiles: vi.fn((id: string) => [...files.values()].filter(f => f.skill_id === id)),
  seedSkillFileIfAbsent: vi.fn((id: string, rel: string, content: Buffer, mode?: number) => {
    if (files.has(fk(id, rel))) return false
    files.set(fk(id, rel), { skill_id: id, rel_path: rel, content, mode: (mode ?? 0) & 0o111 ? 0o755 : 0o644 })
    return true
  }),
}))

import { regenSingleSkillFile, regenSkillFilesFromSQL, importSkillCompanionFilesFromDisk, removeGeneratedSkillFile } from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const SID = 'global/comp'
const dir = () => join(FAKE_HOME, '.claude', 'skills', 'comp')
const put = (rel: string, content: string | Buffer, mode = 0o644) =>
  files.set(fk(SID, rel), { skill_id: SID, rel_path: rel, content: Buffer.from(content), mode })

beforeEach(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
  store.clear(); files.clear()
  store.set(SID, { id: SID, name: 'comp', description: '', content: 'body', tenant_id: 'fleet', is_global: 1 })
})

describe('generation', () => {
  it('a single regen writes the companion files (nested dirs, exec bit) even when SKILL.md is unchanged', () => {
    regenSingleSkillFile(SID)                       // SKILL.md only
    put('scripts/run.sh', '#!/bin/sh\n', 0o755)
    put('references/deep/n.md', 'notes')
    expect(regenSingleSkillFile(SID)).toEqual({ written: true, skipped: false, reason: null })
    expect(readFileSync(join(dir(), 'scripts/run.sh'), 'utf-8')).toBe('#!/bin/sh\n')
    expect(statSync(join(dir(), 'scripts/run.sh')).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(dir(), 'references/deep/n.md'), 'utf-8')).toBe('notes')
    expect(regenSingleSkillFile(SID)).toEqual({ written: false, skipped: true, reason: 'content_equal' })
  })

  it('the bulk startup regen generates them too, and counts them', () => {
    put('scripts/a.py', 'print(1)\n')
    const res = regenSkillFilesFromSQL(false, true)
    expect(res).toEqual({ enabled: true, written: 2, skipped: 0, errors: 0 })   // SKILL.md + 1 companion
    expect(readFileSync(join(dir(), 'scripts/a.py'), 'utf-8')).toBe('print(1)\n')
  })

  it('restores a drifted companion file from the DB, and repairs a wrong mode', () => {
    put('scripts/a.sh', 'good\n', 0o755)
    regenSingleSkillFile(SID)
    writeFileSync(join(dir(), 'scripts/a.sh'), 'tampered\n')
    regenSingleSkillFile(SID)
    expect(readFileSync(join(dir(), 'scripts/a.sh'), 'utf-8')).toBe('good\n')
    chmodSync(join(dir(), 'scripts/a.sh'), 0o600)
    regenSingleSkillFile(SID)
    expect(statSync(join(dir(), 'scripts/a.sh')).mode & 0o777).toBe(0o755)
  })

  it('never writes through a symlinked directory, and reports the error', () => {
    regenSingleSkillFile(SID)
    const outside = join(FAKE_HOME, 'outside'); mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(dir(), 'scripts'))
    put('scripts/pwn.sh', 'x')
    expect(regenSingleSkillFile(SID).reason).toBe('write_error')
    expect(existsSync(join(outside, 'pwn.sh'))).toBe(false)
  })

  it('a DB row with an unsafe path is an error, not a write outside the skill dir', () => {
    put('../escape.txt', 'x')
    expect(regenSingleSkillFile(SID).reason).toBe('write_error')
    expect(existsSync(join(FAKE_HOME, '.claude', 'skills', 'escape.txt'))).toBe(false)
  })
})

describe('removal', () => {
  it('skill delete removes byte-equal companion files and the directory, keeps edited and untracked files', () => {
    put('scripts/a.sh', 'a\n'); put('scripts/b.sh', 'b\n')
    regenSingleSkillFile(SID)
    writeFileSync(join(dir(), 'scripts/b.sh'), 'edited\n')
    writeFileSync(join(dir(), 'notes.txt'), 'mine')
    const rows = [...files.values()]
    const r = removeGeneratedSkillFile(SID, 'body', 'fleet', rows)
    expect(r.removed).toBe(true)
    expect(existsSync(join(dir(), 'scripts/a.sh'))).toBe(false)
    expect(readFileSync(join(dir(), 'scripts/b.sh'), 'utf-8')).toBe('edited\n')
    expect(readFileSync(join(dir(), 'notes.txt'), 'utf-8')).toBe('mine')
    expect(existsSync(join(dir(), 'SKILL.md'))).toBe(false)
  })
})

describe('importSkillCompanionFilesFromDisk (disk -> DB, insert-if-absent)', () => {
  function seedDisk() {
    mkdirSync(join(dir(), 'scripts'), { recursive: true })
    mkdirSync(join(dir(), 'node_modules/x'), { recursive: true })
    mkdirSync(join(dir(), '__pycache__'), { recursive: true })
    writeFileSync(join(dir(), 'SKILL.md'), 'body')
    writeFileSync(join(dir(), 'scripts/run.sh'), '#!/bin/sh\n'); chmodSync(join(dir(), 'scripts/run.sh'), 0o755)
    writeFileSync(join(dir(), 'notes.md'), 'n')
    writeFileSync(join(dir(), '.DS_Store'), 'junk')
    writeFileSync(join(dir(), 'node_modules/x/i.js'), 'junk')
    writeFileSync(join(dir(), '__pycache__/c.pyc'), 'junk')
    const outside = join(FAKE_HOME, 'secret.txt'); writeFileSync(outside, 'secret')
    symlinkSync(outside, join(dir(), 'link.txt'))
  }

  it('imports real files with their exec bit, skipping SKILL.md, symlinks and tool caches', () => {
    seedDisk()
    const r = importSkillCompanionFilesFromDisk()
    expect(r).toEqual({ seeded: 2, skipped: 0, errors: 0 })
    expect([...files.values()].map(f => f.rel_path).sort()).toEqual(['notes.md', 'scripts/run.sh'])
    expect(files.get(fk(SID, 'scripts/run.sh')).mode).toBe(0o755)
  })

  it('never overwrites a DB file, so a later disk edit cannot win over the DB', () => {
    seedDisk()
    put('notes.md', 'DB version')
    importSkillCompanionFilesFromDisk()
    expect(files.get(fk(SID, 'notes.md')).content.toString()).toBe('DB version')
  })

  it('a second run imports nothing new', () => {
    seedDisk()
    importSkillCompanionFilesFromDisk()
    expect(importSkillCompanionFilesFromDisk()).toEqual({ seeded: 0, skipped: 2, errors: 0 })
  })

  it('leaves non-fleet (tenant) skills and skills without a file alone', () => {
    store.set('acme-x', { id: 'acme-x', name: 'x', description: '', content: 'c', tenant_id: 'acme', is_global: 0 })
    store.set('global/nofile', { id: 'global/nofile', name: 'nofile', description: '', content: 'c', tenant_id: 'fleet', is_global: 1 })
    expect(importSkillCompanionFilesFromDisk()).toEqual({ seeded: 0, skipped: 0, errors: 0 })
  })
})
