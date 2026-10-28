// The skill file writers (bulk regen, single regen, tenant regen) run one at a time. With an async db every await
// is a point where a second writer can start, so a bulk regen that read its rows before a dashboard edit could
// write the older content after the single regen of that edit and leave the file stale.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-regen-queue-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: false }
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => [],
}))

const { getSkillMock, listAllSkillsMock } = vi.hoisted(() => ({
  getSkillMock: vi.fn(),
  listAllSkillsMock: vi.fn(),
}))
vi.mock('../db.js', () => ({
  getSkill: getSkillMock,
  listAllSkills: listAllSkillsMock,
  listSkillAccess: vi.fn().mockResolvedValue([]),
  listSkillFiles: vi.fn().mockResolvedValue([]),
  getEnabledAgentsForTenant: vi.fn().mockReturnValue([]),
}))
vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { regenSingleSkillFile, regenSkillFilesFromSQL } from '../web/skill-regen.js'
import { addGeneratedHeader } from '../skill-header.js'

const ID = 'global/queued-skill'
const skillMd = join(FAKE_HOME, '.claude', 'skills', 'queued-skill', 'SKILL.md')
const row = (content: string) => ({ id: ID, name: 'queued-skill', description: '', content, tenant_id: 'fleet', is_global: 1, created_by: null, created_at: 0, updated_at: 0 })
const onDisk = () => readFileSync(skillMd, 'utf-8')

/** A promise a test settles by hand. */
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** Lets pending microtasks and a macrotask run, so a call that is not waiting has surely made progress. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

describe('skill file writers run one at a time', () => {
  beforeEach(() => {
    getSkillMock.mockReset()
    listAllSkillsMock.mockReset()
  })

  it('a bulk regen that read its rows before an edit cannot overwrite the single regen of that edit', async () => {
    let current = row('# v1')
    // The bulk query takes its snapshot now and delivers it late (a slow query on a busy db).
    const slow = gate()
    listAllSkillsMock.mockImplementation(async () => {
      const snapshot = [current]
      await slow.promise
      return snapshot
    })
    getSkillMock.mockImplementation(async () => current)

    const bulk = regenSkillFilesFromSQL(false, true)
    await settle()
    current = row('# v2')
    const single = regenSingleSkillFile(ID, true)
    await settle()
    slow.open()
    await Promise.all([bulk, single])

    expect(onDisk()).toBe(addGeneratedHeader('# v2', ID))
  })

  it('the single regen waits for the bulk one and reads the row after it finished', async () => {
    const slow = gate()
    const order: string[] = []
    listAllSkillsMock.mockImplementation(async () => {
      order.push('bulk-read')
      await slow.promise
      order.push('bulk-done')
      return [row('# bulk')]
    })
    getSkillMock.mockImplementation(async () => {
      order.push('single-read')
      return row('# single')
    })

    const bulk = regenSkillFilesFromSQL(false, true)
    const single = regenSingleSkillFile(ID, true)
    await settle()
    expect(order).toEqual(['bulk-read'])
    slow.open()
    await Promise.all([bulk, single])
    expect(order).toEqual(['bulk-read', 'bulk-done', 'single-read'])
  })

  it('a failing call does not block the next one in the queue', async () => {
    getSkillMock.mockRejectedValueOnce(new Error('db down'))
    getSkillMock.mockResolvedValueOnce(row('# after the failure'))

    const failed = regenSingleSkillFile(ID, true)
    const next = regenSingleSkillFile(ID, true)
    await expect(failed).rejects.toThrow('db down')
    await expect(next).resolves.toMatchObject({ written: true })
    expect(onDisk()).toBe(addGeneratedHeader('# after the failure', ID))
  })

  it('calls run in the order they were made', async () => {
    const reads: string[] = []
    const first = gate()
    getSkillMock.mockImplementationOnce(async () => {
      reads.push('first')
      await first.promise
      return row('# first')
    })
    getSkillMock.mockImplementationOnce(async () => {
      reads.push('second')
      return row('# second')
    })

    const a = regenSingleSkillFile(ID, true)
    const b = regenSingleSkillFile(ID, true)
    await settle()
    expect(reads).toEqual(['first'])
    first.open()
    await Promise.all([a, b])
    expect(reads).toEqual(['first', 'second'])
    expect(onDisk()).toBe(addGeneratedHeader('# second', ID))
  })
})
