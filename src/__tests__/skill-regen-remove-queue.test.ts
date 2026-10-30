// The skill file removers run in the same queue as the writers: a single regen that already read the row must not
// write the file back after the delete route removed it (the file of a deleted skill would stay on disk).
// Adopted from the QA probe of the W3-4 review.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-regen-remove-queue-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: true }
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => [],
}))

const { getSkillMock, listAllSkillsMock, listSkillFilesMock } = vi.hoisted(() => ({
  getSkillMock: vi.fn(),
  listAllSkillsMock: vi.fn(),
  listSkillFilesMock: vi.fn(),
}))
vi.mock('../db.js', () => ({
  getSkill: getSkillMock,
  listAllSkills: listAllSkillsMock,
  listSkillAccess: vi.fn().mockResolvedValue([]),
  listSkillFiles: listSkillFilesMock,
  getEnabledAgentsForTenant: vi.fn().mockResolvedValue([]),
}))
vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { regenSingleSkillFile, removeGeneratedSkillFile, removeGeneratedCompanionFile } from '../web/skill-regen.js'
import { existsSync } from 'node:fs'
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

describe('remove vs in-flight regen', () => {
  it('a deleted skill\'s file must not come back', async () => {
    getSkillMock.mockReset()
    listSkillFilesMock.mockReset().mockResolvedValue([])
    // first write the file normally
    getSkillMock.mockResolvedValueOnce(row('# v1'))
    await regenSingleSkillFile(ID, true)
    expect(onDisk()).toBe(addGeneratedHeader('# v1', ID))

    // regen #2 has read the row (slow delivery), then the delete route removes the file: the remover waits its turn
    const slow = gate()
    getSkillMock.mockImplementationOnce(async () => { const snap = row('# v1'); await slow.promise; return snap })
    const inFlight = regenSingleSkillFile(ID, true)
    await settle()
    const removing = removeGeneratedSkillFile(ID, '# v1', 'fleet', [])
    slow.open()
    await inFlight
    expect((await removing).removed).toBe(true)
    let exists = true
    try { onDisk() } catch { exists = false }
    expect(exists).toBe(false)
  })
})

describe('companion file remove vs in-flight regen', () => {
  it('a deleted companion file must not come back', async () => {
    const companion = join(FAKE_HOME, '.claude', 'skills', 'queued-skill', 'scripts', 'a.sh')
    const fileRow = { skill_id: ID, rel_path: 'scripts/a.sh', content: Buffer.from('a\n'), mode: 0o644 }
    getSkillMock.mockReset().mockResolvedValue(row('# v1'))
    listSkillFilesMock.mockReset().mockResolvedValue([fileRow])
    await regenSingleSkillFile(ID, true)
    expect(existsSync(companion)).toBe(true)

    // regen #2 has listed the file (slow delivery), then the companion delete route removes the generated copy
    const slow = gate()
    listSkillFilesMock.mockImplementationOnce(async () => { const snap = [fileRow]; await slow.promise; return snap })
    const inFlight = regenSingleSkillFile(ID, true)
    await settle()
    const removing = removeGeneratedCompanionFile(ID, 'scripts/a.sh', Buffer.from('a\n'), 'fleet')
    slow.open()
    await inFlight
    expect(await removing).toBe(1)
    expect(existsSync(companion)).toBe(false)
  })
})
