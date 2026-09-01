import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-regen-test-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => ['agent-b'],
}))

const { getSkillMock, listAllSkillsMock } = vi.hoisted(() => ({
  getSkillMock: vi.fn(),
  listAllSkillsMock: vi.fn().mockReturnValue([]),
}))
vi.mock('../db.js', () => ({
  getSkill: getSkillMock,
  listAllSkills: listAllSkillsMock,
}))

import { regenSingleSkillFile } from '../web/skill-regen.js'

function fleetSkillRow(id: string, content: string) {
  return { id, name: id, description: '', content, tenant_id: 'fleet', is_global: 1, created_by: null, created_at: 0, updated_at: 0 }
}

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

describe('regenSingleSkillFile', () => {
  beforeEach(() => { getSkillMock.mockReset() })

  it('is a no-op when the kill-switch is off and not forced', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('global/never-called', 'content'))
    const result = regenSingleSkillFile('global/never-called', false)
    expect(result).toEqual({ written: false, skipped: true, reason: 'disabled' })
    expect(getSkillMock).not.toHaveBeenCalled()
  })

  it('writes the file for a fleet (global) skill when forced', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('global/my-skill', '# Content v1'))
    const result = regenSingleSkillFile('global/my-skill', true)
    expect(result).toEqual({ written: true, skipped: false, reason: null })
    const path = join(FAKE_HOME, '.claude', 'skills', 'my-skill', 'SKILL.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('# Content v1')
  })

  it('is idempotent: a second call with unchanged content skips the write', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('global/my-skill', '# Content v1'))
    const result = regenSingleSkillFile('global/my-skill', true)
    expect(result).toEqual({ written: false, skipped: true, reason: 'content_equal' })
  })

  it('writes to the agent-local path for a non-main agent id', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('agent/agent-b/local-skill', 'local content'))
    const result = regenSingleSkillFile('agent/agent-b/local-skill', true)
    expect(result.written).toBe(true)
    const path = join(FAKE_PROJECT, 'agents', 'agent-b', '.claude', 'skills', 'local-skill', 'SKILL.md')
    expect(existsSync(path)).toBe(true)
  })

  it('returns not_found for a missing skill id', () => {
    getSkillMock.mockReturnValue(undefined)
    const result = regenSingleSkillFile('global/missing', true)
    expect(result).toEqual({ written: false, skipped: false, reason: 'not_found' })
  })

  it('is a no-op (not_file_backed) for a tenant-scoped B2B skill, without touching disk', () => {
    getSkillMock.mockReturnValue({ id: 'acme-corp-my-skill', name: 'my-skill', description: '', content: 'x', tenant_id: 'acme-corp', is_global: 0, created_by: null, created_at: 0, updated_at: 0 })
    const result = regenSingleSkillFile('acme-corp-my-skill', true)
    expect(result).toEqual({ written: false, skipped: true, reason: 'not_file_backed' })
  })

  it('returns unrecognized_id for a fleet skill whose id matches no known path pattern', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('not-a-known-pattern', 'x'))
    const result = regenSingleSkillFile('not-a-known-pattern', true)
    expect(result).toEqual({ written: false, skipped: false, reason: 'unrecognized_id' })
  })
})
