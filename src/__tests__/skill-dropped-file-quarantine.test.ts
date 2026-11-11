// A companion file that an activation drops, and that somebody edited by hand on disk: it is neither deleted (it may hold
// work the database does not have) nor left where it is (the boot-time companion import would seed it back into the live
// skill without a review). It is moved aside under the SKILL.md quarantine name, and the import skips that name.
// Real SQLite, real skill-regen, real route; only HOME is a throwaway directory.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dropped-quarantine-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'agent-main', SKILL_SQL_REGEN: true }
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => [],
}))

import { initDatabase, dbx, createSkill, putSkillFile, getSkillFile, submitPendingRevision, listSkillFiles } from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import type { RouteContext } from '../web/routes/types.js'
import { regenSingleSkillFile, removeGeneratedCompanionFile, importSkillCompanionFilesFromDisk } from '../web/skill-regen.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })
beforeEach(() => { initDatabase(':memory:') })

const SYSTEM = { kind: 'system' as const, id: null }
const AGENT = { kind: 'agent' as const, id: 'agent-a' }
const PLAIN = '---\nname: x\ndescription: d\n---\nbody\n'
const PRIVILEGED = '---\nname: x\ndescription: d\nallowed-tools: Bash\n---\nbody\n'
const ORIGINAL = '#!/bin/sh\necho original\n'
const EDITED = '#!/bin/sh\necho hand edit\n'

async function call(path: string, body: unknown, method = 'POST') {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420' + path)
  const ctx = { req, res, path: url.pathname, method, url, tenantId: null, auth: { kind: 'session', user: 'reviewer' }, role: 'admin' } as unknown as RouteContext
  expect(await tryHandleSkills(ctx)).toBe(true)
  return out
}

/** A live fleet skill with one script, written to disk, plus a pending proposal that drops the script. Returns the revision id. */
async function skillWithDroppedScript(name: string): Promise<{ id: string; dir: string; revisionId: number }> {
  const id = `global/${name}`
  const r = await createSkill({ id, name, description: 'd', content: PLAIN, tenant_id: 'fleet', is_global: true }, SYSTEM)
  expect(r.outcome).toBe('created')
  await putSkillFile(id, 'scripts/run.sh', Buffer.from(ORIGINAL), 0o755, SYSTEM)
  await regenSingleSkillFile(id, true)
  const dir = join(FAKE_HOME, '.claude', 'skills', name)
  expect(readFileSync(join(dir, 'scripts', 'run.sh'), 'utf-8')).toBe(ORIGINAL)
  const { revision } = await dbx.tx((tx) => submitPendingRevision(tx, {
    skill: { id, tenant_id: 'fleet' }, action: 'modify', content: PRIVILEGED, files: [], actor: AGENT, touchesPrivilege: true,
  }))
  return { id, dir, revisionId: revision.id }
}

const asideCopies = (dir: string, base: string): string[] => readdirSync(join(dir, 'scripts')).filter((n) => new RegExp(`^${base}\\.revoked-\\d+$`).test(n))

describe('an activation drops a script that was edited by hand on disk', () => {
  it('the edit is moved aside, the original path is gone, and the boot import seeds nothing back', async () => {
    const { id, dir, revisionId } = await skillWithDroppedScript('dq-edited')
    writeFileSync(join(dir, 'scripts', 'run.sh'), EDITED)

    expect((await call(`/api/skills/sql/revisions/${revisionId}/decide`, { decision: 'activate' })).status).toBe(200)

    expect(existsSync(join(dir, 'scripts', 'run.sh'))).toBe(false)
    const aside = asideCopies(dir, 'run\\.sh')
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, 'scripts', aside[0]), 'utf-8')).toBe(EDITED)
    expect(await getSkillFile(id, 'scripts/run.sh')).toBeUndefined()

    // the point of it: the next start does not copy the dropped script, under either name, back into the live skill
    expect((await importSkillCompanionFilesFromDisk()).seeded).toBe(0)
    expect(await listSkillFiles(id)).toEqual([])
  })

  it('a dropped script nobody edited is removed, and nothing is left aside', async () => {
    const { id, dir, revisionId } = await skillWithDroppedScript('dq-clean')
    expect((await call(`/api/skills/sql/revisions/${revisionId}/decide`, { decision: 'activate' })).status).toBe(200)
    expect(existsSync(join(dir, 'scripts', 'run.sh'))).toBe(false)
    expect(existsSync(join(dir, 'scripts')) ? asideCopies(dir, 'run\\.sh') : []).toEqual([])
    expect((await importSkillCompanionFilesFromDisk()).seeded).toBe(0)
    expect(await listSkillFiles(id)).toEqual([])
  })

  it('a refused activation (stale) moves nothing', async () => {
    const { dir, revisionId } = await skillWithDroppedScript('dq-stale')
    writeFileSync(join(dir, 'scripts', 'run.sh'), EDITED)
    // the live description moves after the proposal, so the activation is refused
    await dbx.run("UPDATE skills SET description = 'changed' WHERE id = 'global/dq-stale'")
    expect((await call(`/api/skills/sql/revisions/${revisionId}/decide`, { decision: 'activate' })).status).toBe(409)
    expect(readFileSync(join(dir, 'scripts', 'run.sh'), 'utf-8')).toBe(EDITED)
    expect(asideCopies(dir, 'run\\.sh')).toEqual([])
  })
})

describe('the single-file DELETE route', () => {
  const del = (id: string) => call(`/api/skills/sql/${encodeURIComponent(id)}/files/${encodeURIComponent('scripts/run.sh')}`, {}, 'DELETE')

  it('a hand-edited copy is moved aside with its bytes, the original path is gone, and the boot import seeds nothing back', async () => {
    const { id, dir } = await skillWithDroppedScript('dq-delete-edited')
    writeFileSync(join(dir, 'scripts', 'run.sh'), EDITED)
    expect((await del(id)).status).toBe(200)
    expect(existsSync(join(dir, 'scripts', 'run.sh'))).toBe(false)
    const aside = asideCopies(dir, 'run\\.sh')
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, 'scripts', aside[0]), 'utf-8')).toBe(EDITED)
    expect(await getSkillFile(id, 'scripts/run.sh')).toBeUndefined()
    expect((await importSkillCompanionFilesFromDisk()).seeded).toBe(0)
    expect(await listSkillFiles(id)).toEqual([])
  })

  it('a copy nobody edited is removed, nothing is left aside', async () => {
    const { id, dir } = await skillWithDroppedScript('dq-delete-clean')
    expect((await del(id)).status).toBe(200)
    expect(existsSync(join(dir, 'scripts', 'run.sh'))).toBe(false)
    expect(existsSync(join(dir, 'scripts')) ? asideCopies(dir, 'run\\.sh') : []).toEqual([])
    expect((await importSkillCompanionFilesFromDisk()).seeded).toBe(0)
  })
})

describe('the scope of the quarantine', () => {
  // Every caller of removeGeneratedCompanionFile asks for the move now (the activation and the DELETE route), so there
  // is no flag-less caller left to pin. The removal of a whole skill's files on revoke and delete is a different path.

  it('with the flag it moves the copy aside, and a byte-equal copy is simply removed', async () => {
    const { id, dir } = await skillWithDroppedScript('dq-flag')
    writeFileSync(join(dir, 'scripts', 'run.sh'), EDITED)
    expect(await removeGeneratedCompanionFile(id, 'scripts/run.sh', Buffer.from(ORIGINAL), 'fleet', true)).toBe(1)
    expect(existsSync(join(dir, 'scripts', 'run.sh'))).toBe(false)
    expect(asideCopies(dir, 'run\\.sh')).toHaveLength(1)
    // byte-equal: removed, not moved
    writeFileSync(join(dir, 'scripts', 'other.sh'), ORIGINAL)
    expect(await removeGeneratedCompanionFile(id, 'scripts/other.sh', Buffer.from(ORIGINAL), 'fleet', true)).toBe(1)
    expect(asideCopies(dir, 'other\\.sh')).toEqual([])
  })
})

describe('the boot import and the quarantine name', () => {
  it('skips a moved-aside copy (also a SKILL.md one) but still imports a file whose name only looks similar', async () => {
    const { id, dir } = await skillWithDroppedScript('dq-import')
    writeFileSync(join(dir, 'scripts', 'gone.sh.revoked-1731000000000'), EDITED)
    writeFileSync(join(dir, 'SKILL.md.revoked-1731000000000'), EDITED)
    writeFileSync(join(dir, 'scripts', 'plain.sh.revoked-notanumber'), EDITED)
    const res = await importSkillCompanionFilesFromDisk()
    expect(res.seeded).toBe(1)
    expect(await getSkillFile(id, 'scripts/plain.sh.revoked-notanumber')).toBeDefined()
    expect(await getSkillFile(id, 'scripts/gone.sh.revoked-1731000000000')).toBeUndefined()
    expect(await getSkillFile(id, 'SKILL.md.revoked-1731000000000')).toBeUndefined()
  })
})
