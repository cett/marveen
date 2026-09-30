import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-seed-refresh-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', STORE_DIR: join(FAKE_HOME, 'store') }
})
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'), listAgentNames: () => [] }))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const rows = new Map<string, { id: string; content: string; description: string }>()
const updateSkill = vi.fn((id: string, patch: { content?: string; description?: string }) => {
  const r = rows.get(id)
  if (!r) return undefined
  Object.assign(r, patch)
  return r
})
const seedSkillIfAbsent = vi.fn((o: { id: string; content: string; description: string }) => {
  if (rows.has(o.id)) return false
  rows.set(o.id, { id: o.id, content: o.content, description: o.description })
  return true
})
vi.mock('../db.js', () => ({
  getSkill: (id: string) => rows.get(id),
  updateSkill: (id: string, patch: { content?: string; description?: string }) => updateSkill(id, patch),
  seedSkillIfAbsent: (o: { id: string; content: string; description: string }) => seedSkillIfAbsent(o),
  listAllSkills: vi.fn().mockReturnValue([]),
  listSkillAccess: vi.fn().mockReturnValue([]),
  getEnabledAgentsForTenant: vi.fn().mockReturnValue([]),
  listSkillFiles: vi.fn().mockReturnValue([]),
  seedSkillFileIfAbsent: vi.fn(),
}))

import { applySeedSkillRefreshMarker } from '../web/skill-seed-refresh.js'
import { addGeneratedHeader } from '../skill-header.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const MARKER = join(FAKE_HOME, 'store', '.seed-refreshed-skills')
const skillFile = (name: string) => join(FAKE_HOME, '.claude', 'skills', name, 'SKILL.md')
const NEW = '---\nname: demo\ndescription: "new text"\n---\n\nnew body\n'
function writeSkill(name: string, content: string) {
  mkdirSync(join(FAKE_HOME, '.claude', 'skills', name), { recursive: true })
  writeFileSync(skillFile(name), content)
}
function writeMarker(...names: string[]) {
  mkdirSync(join(FAKE_HOME, 'store'), { recursive: true })
  writeFileSync(MARKER, names.join('\n') + '\n')
}

describe('applySeedSkillRefreshMarker', () => {
  beforeEach(() => {
    rows.clear()
    updateSkill.mockClear()
    seedSkillIfAbsent.mockClear()
    rmSync(MARKER, { force: true })
  })

  it('is a no-op without a marker', () => {
    expect(applySeedSkillRefreshMarker()).toEqual({ applied: 0, unchanged: 0, errors: 0 })
    expect(updateSkill).not.toHaveBeenCalled()
  })

  it('updates the existing row from the refreshed file (content + description) and removes the marker', () => {
    rows.set('global/demo', { id: 'global/demo', content: 'OLD', description: 'old' })
    writeSkill('demo', NEW)
    writeMarker('demo')
    expect(applySeedSkillRefreshMarker()).toEqual({ applied: 1, unchanged: 0, errors: 0 })
    expect(rows.get('global/demo')).toEqual({ id: 'global/demo', content: NEW, description: 'new text' })
    expect(existsSync(MARKER)).toBe(false)
  })

  it('strips a generated header before storing, so the row never carries it', () => {
    rows.set('global/demo', { id: 'global/demo', content: 'OLD', description: 'old' })
    writeSkill('demo', addGeneratedHeader(NEW, 'global/demo'))
    writeMarker('demo')
    applySeedSkillRefreshMarker()
    expect(rows.get('global/demo')?.content).toBe(NEW)
  })

  it('counts a row that already matches as unchanged and does not write it', () => {
    rows.set('global/demo', { id: 'global/demo', content: NEW, description: 'new text' })
    writeSkill('demo', NEW)
    writeMarker('demo')
    expect(applySeedSkillRefreshMarker()).toEqual({ applied: 0, unchanged: 1, errors: 0 })
    expect(updateSkill).not.toHaveBeenCalled()
  })

  it('seeds a row for a skill that has none yet', () => {
    writeSkill('fresh', NEW)
    writeMarker('fresh')
    expect(applySeedSkillRefreshMarker().applied).toBe(1)
    expect(rows.get('global/fresh')?.content).toBe(NEW)
  })

  it('rejects path-unsafe names, counts them as errors and keeps the marker', () => {
    writeMarker('../escape', 'a/b', '..')
    const r = applySeedSkillRefreshMarker()
    expect(r.errors).toBe(3)
    expect(updateSkill).not.toHaveBeenCalled()
    expect(seedSkillIfAbsent).not.toHaveBeenCalled()
    expect(existsSync(MARKER)).toBe(true)
  })

  it('handles duplicate names once and keeps the marker when a listed file is missing', () => {
    rows.set('global/demo', { id: 'global/demo', content: 'OLD', description: 'old' })
    writeSkill('demo', NEW)
    writeMarker('demo', 'demo', 'missing')
    const r = applySeedSkillRefreshMarker()
    expect(r).toEqual({ applied: 1, unchanged: 0, errors: 1 })
    expect(updateSkill).toHaveBeenCalledTimes(1)
    expect(existsSync(MARKER)).toBe(true)
  })
})
