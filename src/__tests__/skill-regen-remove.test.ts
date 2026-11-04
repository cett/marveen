import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT, flag } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-regen-remove-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project'), flag: { on: true } }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  const cfg = { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen' }
  Object.defineProperty(cfg, 'SKILL_SQL_REGEN', { get: () => flag.on, enumerable: true })
  return cfg
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => ['agent-b'],
}))
vi.mock('../db.js', () => ({ getSkill: vi.fn(), listAllSkills: vi.fn().mockResolvedValue([]), listSkillFiles: vi.fn().mockResolvedValue([]), seedSkillFileIfAbsent: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { removeGeneratedSkillFile } from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const dir = (name: string) => join(FAKE_HOME, '.claude', 'skills', name)
function seed(name: string, content: string) {
  mkdirSync(dir(name), { recursive: true })
  writeFileSync(join(dir(name), 'SKILL.md'), content)
}

describe('removeGeneratedSkillFile', () => {
  beforeEach(() => { flag.on = true })

  it('removes the generated SKILL.md and the now-empty skill directory', async () => {
    seed('gone', 'body')
    expect(await removeGeneratedSkillFile('global/gone', 'body', 'fleet')).toEqual({ removed: true, reason: null })
    expect(existsSync(dir('gone'))).toBe(false)
  })

  it('keeps a hand-edited file (content differs from the deleted row) and says so', async () => {
    seed('edited', 'hand edited text')
    expect(await removeGeneratedSkillFile('global/edited', 'row content', 'fleet')).toEqual({ removed: false, reason: 'modified_on_disk' })
    expect(readFileSync(join(dir('edited'), 'SKILL.md'), 'utf-8')).toBe('hand edited text')
  })

  it('removes SKILL.md but keeps the directory while companion files remain', async () => {
    seed('withscripts', 'body')
    mkdirSync(join(dir('withscripts'), 'scripts'), { recursive: true })
    writeFileSync(join(dir('withscripts'), 'scripts', 'run.sh'), 'echo hi')
    expect((await removeGeneratedSkillFile('global/withscripts', 'body', 'fleet')).removed).toBe(true)
    expect(existsSync(join(dir('withscripts'), 'SKILL.md'))).toBe(false)
    expect(existsSync(join(dir('withscripts'), 'scripts', 'run.sh'))).toBe(true)
  })

  it('removes an agent-local file at its agent path', async () => {
    const p = join(FAKE_PROJECT, 'agents', 'agent-b', '.claude', 'skills', 'loc')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'SKILL.md'), 'x')
    expect((await removeGeneratedSkillFile('agent/agent-b/loc', 'x', 'fleet')).removed).toBe(true)
    expect(existsSync(p)).toBe(false)
  })

  it('reports absent when there is no file', async () => {
    expect(await removeGeneratedSkillFile('global/never-existed', 'x', 'fleet')).toEqual({ removed: false, reason: 'absent' })
  })

  it('never touches the fleet skill dirs for a non-fleet (B2B tenant) skill (tenant copies: skill-regen-tenant.test.ts)', async () => {
    seed('tenantish', 'x')
    expect(await removeGeneratedSkillFile('global/tenantish', 'x', 'acme')).toEqual({ removed: false, reason: 'absent' })
    expect(existsSync(dir('tenantish'))).toBe(true)
  })

  it('rejects traversal and unknown id shapes without touching disk', async () => {
    seed('victim', 'x')
    expect((await removeGeneratedSkillFile('global/../victim', 'x', 'fleet')).reason).toBe('unrecognized_id')
    expect((await removeGeneratedSkillFile('weird', 'x', 'fleet')).reason).toBe('unrecognized_id')
    expect(existsSync(dir('victim'))).toBe(true)
  })

  it('is a no-op while the kill-switch is off', async () => {
    seed('keepme', 'body')
    flag.on = false
    expect(await removeGeneratedSkillFile('global/keepme', 'body', 'fleet')).toEqual({ removed: false, reason: 'disabled' })
    expect(existsSync(join(dir('keepme'), 'SKILL.md'))).toBe(true)
  })
})
