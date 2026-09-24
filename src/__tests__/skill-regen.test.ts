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
  // SKILL_SQL_REGEN also needs pinning: it resolves from this repo's real
  // .env (SKILL_SQL_REGEN=1 on this fleet's install, a deliberate ops
  // setting -- see config.ts), which otherwise leaks into the "kill-switch
  // is off" test below and makes it always-on instead.
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: false }
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

const { atomicWriteMock } = vi.hoisted(() => ({ atomicWriteMock: vi.fn() }))
vi.mock('../web/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/atomic-write.js')>()
  atomicWriteMock.mockImplementation(actual.atomicWriteFileSync)
  return { atomicWriteFileSync: atomicWriteMock }
})

const { loggerErrorMock, loggerWarnMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}))
vi.mock('../logger.js', () => ({
  logger: { error: loggerErrorMock, warn: loggerWarnMock, info: vi.fn(), debug: vi.fn() },
}))

import {
  regenSingleSkillFile,
  regenSkillFilesFromSQL,
  findMissingSkillFiles,
  listKnownSkillAgents,
} from '../web/skill-regen.js'

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

  it('rejects a path-traversal id (..) as unrecognized rather than resolving it', () => {
    // 'global/..' has exactly 2 parts (would otherwise pass the parts.length
    // check for the 'global' pattern), so this only fails if the top-level
    // '..' substring guard actually runs -- unlike a longer traversal id,
    // which would already be rejected by the parts.length check alone.
    getSkillMock.mockReturnValue(fleetSkillRow('global/..', 'x'))
    const result = regenSingleSkillFile('global/..', true)
    expect(result).toEqual({ written: false, skipped: false, reason: 'unrecognized_id' })
  })

  it('rejects an absolute-path id as unrecognized', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('/etc/passwd', 'x'))
    const result = regenSingleSkillFile('/etc/passwd', true)
    expect(result).toEqual({ written: false, skipped: false, reason: 'unrecognized_id' })
  })

  it('rejects an id with an empty path segment as unrecognized', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('global/', 'x'))
    const result = regenSingleSkillFile('global/', true)
    expect(result).toEqual({ written: false, skipped: false, reason: 'unrecognized_id' })
  })

  it('writes to the project-root path (not the per-agent dir) for the main agent id', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('agent/marveen/main-skill', 'main content'))
    const result = regenSingleSkillFile('agent/marveen/main-skill', true)
    expect(result.written).toBe(true)
    const path = join(FAKE_PROJECT, '.claude', 'skills', 'main-skill', 'SKILL.md')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('main content')
  })

  it('reports a write_error when the underlying write throws', () => {
    getSkillMock.mockReturnValue(fleetSkillRow('global/fails-to-write', 'x'))
    atomicWriteMock.mockImplementationOnce(() => { throw new Error('disk full') })
    const result = regenSingleSkillFile('global/fails-to-write', true)
    expect(result).toEqual({ written: false, skipped: false, reason: 'write_error' })
    expect(loggerErrorMock).toHaveBeenCalled()
  })
})

describe('regenSkillFilesFromSQL', () => {
  beforeEach(() => {
    listAllSkillsMock.mockReset()
    loggerWarnMock.mockClear()
  })

  it('is a no-op when the kill-switch is off, not forced, and not a dry run', () => {
    listAllSkillsMock.mockReturnValue([fleetSkillRow('global/never-queried', 'x')])
    const result = regenSkillFilesFromSQL(false, false)
    expect(result).toEqual({ enabled: false, written: 0, skipped: 0, errors: 0 })
    expect(listAllSkillsMock).not.toHaveBeenCalled()
  })

  it('runs a dry run even with the kill-switch off, without touching disk', () => {
    listAllSkillsMock.mockReturnValue([fleetSkillRow('global/dry-run-skill', '# dry')])
    const result = regenSkillFilesFromSQL(true, false)
    expect(result).toEqual({ enabled: true, written: 1, skipped: 0, errors: 0 })
    const path = join(FAKE_HOME, '.claude', 'skills', 'dry-run-skill', 'SKILL.md')
    expect(existsSync(path)).toBe(false)
  })

  it('bypasses the kill-switch when forceEnabled is set', () => {
    listAllSkillsMock.mockReturnValue([fleetSkillRow('global/forced-bulk', '# forced')])
    const result = regenSkillFilesFromSQL(false, true)
    expect(result).toEqual({ enabled: true, written: 1, skipped: 0, errors: 0 })
    const path = join(FAKE_HOME, '.claude', 'skills', 'forced-bulk', 'SKILL.md')
    expect(existsSync(path)).toBe(true)
  })

  it('returns errors:1 and does not throw when the skills query itself fails', () => {
    listAllSkillsMock.mockImplementation(() => { throw new Error('db locked') })
    const result = regenSkillFilesFromSQL(false, true)
    expect(result).toEqual({ enabled: true, written: 0, skipped: 0, errors: 1 })
    expect(loggerErrorMock).toHaveBeenCalled()
  })

  it('filters to fleet-tenant rows only, ignoring tenant-scoped B2B rows', () => {
    listAllSkillsMock.mockReturnValue([
      fleetSkillRow('global/fleet-only', '# fleet'),
      { id: 'acme-corp-skill', name: 'skill', description: '', content: 'x', tenant_id: 'acme-corp', is_global: 0, created_by: null, created_at: 0, updated_at: 0 },
    ])
    const result = regenSkillFilesFromSQL(false, true)
    expect(result).toEqual({ enabled: true, written: 1, skipped: 0, errors: 0 })
  })

  it('counts an unrecognized row id as an error and logs a warning, without aborting the batch', () => {
    listAllSkillsMock.mockReturnValue([
      fleetSkillRow('not-a-known-pattern', 'x'),
      fleetSkillRow('global/still-written', '# ok'),
    ])
    const result = regenSkillFilesFromSQL(false, true)
    expect(result).toEqual({ enabled: true, written: 1, skipped: 0, errors: 1 })
    expect(loggerWarnMock).toHaveBeenCalledWith({ id: 'not-a-known-pattern' }, expect.stringContaining('unrecognized ID pattern'))
  })

  it('skips content-equal rows on a repeat run (idempotent bulk regen)', () => {
    listAllSkillsMock.mockReturnValue([fleetSkillRow('global/repeat-me', '# same content')])
    regenSkillFilesFromSQL(false, true)
    const result = regenSkillFilesFromSQL(false, true)
    expect(result).toEqual({ enabled: true, written: 0, skipped: 1, errors: 0 })
  })

  it('counts a per-row write failure as an error without aborting the rest of the batch', () => {
    listAllSkillsMock.mockReturnValue([
      fleetSkillRow('global/write-fails-in-bulk', '# will fail'),
      fleetSkillRow('global/written-after-failure', '# ok'),
    ])
    atomicWriteMock.mockImplementationOnce(() => { throw new Error('disk full') })
    const result = regenSkillFilesFromSQL(false, true)
    expect(result).toEqual({ enabled: true, written: 1, skipped: 0, errors: 1 })
  })
})

describe('findMissingSkillFiles', () => {
  beforeEach(() => { listAllSkillsMock.mockReset() })

  it('returns an empty array when the skills query fails, rather than throwing', () => {
    listAllSkillsMock.mockImplementation(() => { throw new Error('db locked') })
    expect(findMissingSkillFiles()).toEqual([])
  })

  it('lists fleet skill ids that have no file on disk yet', () => {
    listAllSkillsMock.mockReturnValue([
      fleetSkillRow('global/not-yet-written', '# missing'),
      { id: 'acme-corp-skill', name: 'skill', description: '', content: 'x', tenant_id: 'acme-corp', is_global: 0, created_by: null, created_at: 0, updated_at: 0 },
    ])
    expect(findMissingSkillFiles()).toEqual(['global/not-yet-written'])
  })

  it('omits a skill once its file has been written to disk', () => {
    listAllSkillsMock.mockReturnValue([fleetSkillRow('global/now-present', '# present')])
    regenSkillFilesFromSQL(false, true)
    expect(findMissingSkillFiles()).toEqual([])
  })
})

describe('listKnownSkillAgents', () => {
  it('returns the main agent id followed by every other known agent name', () => {
    expect(listKnownSkillAgents()).toEqual(['marveen', 'agent-b'])
  })
})
