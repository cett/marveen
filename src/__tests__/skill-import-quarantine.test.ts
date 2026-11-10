// Archive import, the quarantine way: an imported skill is recorded as a pending revision and NOTHING of it is written
// where an agent loads skills from. Built with real zip archives and the real routes, on a fresh in-memory database
// and a fake home. Fixtures are neutral names only (agent-a, tenant-a, demo-a).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-q-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'main-a', SKILL_SQL_REGEN: true, TENANT_SKILL_FILES: 'single', STORE_DIR: join(FAKE_HOME, 'store') }
})
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => ['agent-a'],
  agentDir: (n: string) => join(FAKE_PROJECT, 'agents', n),
}))

import { initDatabase, db, createSkill, listGlobalFleetSkills, listAllSkills, listPendingRevisions, getSkill, listSkillRevisions } from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { tryHandleAgentsSkills } from '../web/routes/agents-skills.js'
import { inspectArchiveListing, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES } from '../web/skill-import-quarantine.js'
import { regenSkillFilesFromSQL } from '../web/skill-regen.js'
import type { RouteContext } from '../web/routes/types.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

// ---- a minimal zip writer (stored entries; unix mode in the external attributes) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
interface ZEntry { name: string; data?: string | Buffer; mode?: number }
function zip(entries: ZEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const data = Buffer.from(e.data ?? '')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const SKILL_MD = '---\nname: demo-a\ndescription: does a thing\n---\n# demo body\n'
const demoZip = (extra: ZEntry[] = [], dir = 'demo-a') => zip([{ name: `${dir}/SKILL.md`, data: SKILL_MD }, ...extra])
const SCRIPT: ZEntry = { name: 'demo-a/scripts/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o100755 }
const REF: ZEntry = { name: 'demo-a/references/a.md', data: 'notes' }

type Extras = Partial<Pick<RouteContext, 'auth' | 'role' | 'tokenAgentId' | 'agentId' | 'tenantId'>>
const ADMIN: Extras = { auth: { kind: 'session', user: 'user-a' }, role: 'admin' }
const TENANT_VIEWER: Extras = { auth: { kind: 'session', user: 'user-b' }, role: 'viewer', tenantId: 'tenant-a' }

type Handler = (ctx: RouteContext) => Promise<boolean>
async function post(handler: Handler, path: string, archive: Buffer | null, extras: Extras = ADMIN) {
  const boundary = 'XBOUNDARYX'
  const body = archive
    ? Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.skill"\r\nContent-Type: application/zip\r\n\r\n`), archive, Buffer.from(`\r\n--${boundary}--\r\n`)])
    : Buffer.from(`--${boundary}--\r\n`)
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = 'POST'
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', body); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420' + path)
  const ctx = { req, res, path: url.pathname, method: 'POST', url, tenantId: null, ...extras } as unknown as RouteContext
  expect(await handler(ctx)).toBe(true)
  return out
}
const importGlobal = (archive: Buffer | null, extras?: Extras) => post(tryHandleSkills, '/api/skills/import', archive, extras)
const importAgent = (agent: string, archive: Buffer | null, extras?: Extras) => post(tryHandleAgentsSkills, `/api/agents/${agent}/skills/import`, archive, extras)

const globalSkillsDir = () => join(FAKE_HOME, '.claude', 'skills')
const agentSkillsDir = (a: string) => join(FAKE_PROJECT, 'agents', a, '.claude', 'skills')
const listDir = (d: string): string[] => (existsSync(d) ? readdirSync(d) : [])
const stagingDirs = (): string[] => listDir(join(FAKE_HOME, 'store', 'skill-import'))
const revs = (id: string) => db.prepare('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY seq').all(id) as Array<Record<string, any>>
const revFiles = (revId: number) => db.prepare('SELECT rel_path, mode, content FROM skill_revision_files WHERE revision_id = ? ORDER BY rel_path').all(revId) as Array<{ rel_path: string; mode: number; content: Buffer }>
const skillRow = (id: string) => db.prepare('SELECT id, status, content, is_global, tenant_id FROM skills WHERE id = ?').get(id) as Record<string, any> | undefined

beforeEach(() => {
  initDatabase(':memory:')
  rmSync(FAKE_PROJECT, { recursive: true, force: true })
  rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true })
  mkdirSync(join(FAKE_PROJECT, 'agents', 'agent-a'), { recursive: true })
})

describe('a global archive import goes to quarantine', () => {
  it('records a pending revision, and writes nothing where an agent loads skills from', async () => {
    const before = stagingDirs()
    const r = await importGlobal(demoZip([SCRIPT, REF]))
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ ok: true, status: 'pending_review', imported: ['demo-a'], skills: [{ name: 'demo-a', revision: 1, touches_privilege: true, has_scripts: true }], refused: [] })

    // The row waits for review; the companion files are NOT in skill_files.
    expect(skillRow('global/demo-a')).toMatchObject({ status: 'pending_review', content: SKILL_MD, is_global: 1, tenant_id: 'fleet' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM skill_files WHERE skill_id = 'global/demo-a'").get()).toEqual({ n: 0 })

    // One revision, pending, with the proposed text, the proposed files, hashes and who imported it.
    const rows = revs('global/demo-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'create', status: 'pending', touches_privilege: 1, has_scripts: 1, author_kind: 'import', submitted_by: 'user-a', source_ref: 'skill-archive:demo-a', content: SKILL_MD })
    expect(rows[0].content_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].files_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(revFiles(rows[0].id).map((f) => [f.rel_path, f.mode, f.content.toString()])).toEqual([
      ['references/a.md', 0o644, 'notes'], ['scripts/run.sh', 0o755, '#!/bin/sh\necho hi\n'],
    ])

    // Nothing live: no directory, no file, not in a list an agent reads, not in the regeneration.
    expect(listDir(globalSkillsDir())).toEqual([])
    expect((await listGlobalFleetSkills()).map((s) => s.id)).not.toContain('global/demo-a')
    await regenSkillFilesFromSQL()
    expect(listDir(globalSkillsDir())).toEqual([])
    // The admin list still shows it, with its status.
    expect((await listAllSkills()).find((s) => s.id === 'global/demo-a')?.status).toBe('pending_review')
    // The staging directory is gone.
    expect(stagingDirs()).toEqual(before)
  })

  it('a caller who is not an admin cannot see it (404, the answer for a skill that is not there)', async () => {
    await importGlobal(demoZip())
    const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
    req.method = 'GET'; req.headers = {}
    const out = { status: 200, body: null as any }
    const res = { writeHead(s: number) { out.status = s }, setHeader() {}, end(b?: string) { if (b) out.body = JSON.parse(b) } }
    const url = new URL('http://localhost:3420/api/skills/sql/global%2Fdemo-a')
    await tryHandleSkills({ req, res, path: url.pathname, method: 'GET', url, tenantId: 'tenant-a', ...TENANT_VIEWER } as unknown as RouteContext)
    expect(out.status).toBe(404)
  })

  it('a re-import of the same archive is a 409 and records nothing new (the name is taken by the pending skill)', async () => {
    await importGlobal(demoZip())
    const again = await importGlobal(demoZip())
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('conflict')
    expect(revs('global/demo-a')).toHaveLength(1)
  })

  it('a name the database already has (a live skill) is a 409: not overwritten, no pending revision', async () => {
    await createSkill({ id: 'global/demo-a', name: 'demo-a', content: '# live text\n', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    const r = await importGlobal(demoZip([SCRIPT]))
    expect(r.status).toBe(409)
    expect(skillRow('global/demo-a')).toMatchObject({ status: 'live', content: '# live text\n' })
    expect(await listPendingRevisions('global/demo-a')).toEqual([])
  })

  it('a disabled skill holds its name too', async () => {
    await createSkill({ id: 'global/demo-a', name: 'demo-a', content: '# t\n', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    db.prepare("UPDATE skills SET status = 'disabled' WHERE id = 'global/demo-a'").run()
    expect((await importGlobal(demoZip())).status).toBe(409)
    expect(skillRow('global/demo-a')).toMatchObject({ status: 'disabled' })
  })

  it('all or nothing: one taken name in an archive refuses the whole archive, the new skill is not recorded either', async () => {
    await createSkill({ id: 'global/demo-b', name: 'demo-b', content: '# t\n', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    const archive = zip([{ name: 'demo-a/SKILL.md', data: SKILL_MD }, { name: 'demo-b/SKILL.md', data: SKILL_MD }])
    expect((await importGlobal(archive)).status).toBe(409)
    expect(skillRow('global/demo-a')).toBeUndefined()
    expect(revs('global/demo-a')).toEqual([])
  })

  it('a directory that already exists on disk is a 409 and nothing is recorded', async () => {
    mkdirSync(join(globalSkillsDir(), 'demo-a'), { recursive: true })
    const r = await importGlobal(demoZip())
    expect(r.status).toBe(409)
    expect(skillRow('global/demo-a')).toBeUndefined()
    expect(revs('global/demo-a')).toEqual([])
  })

  it('an agent skills directory that already holds the name is a 409 and nothing is recorded', async () => {
    mkdirSync(join(agentSkillsDir('agent-a'), 'demo-a'), { recursive: true })
    const r = await importAgent('agent-a', demoZip())
    expect(r.status).toBe(409)
    expect(skillRow('agent/agent-a/demo-a')).toBeUndefined()
    expect(revs('agent/agent-a/demo-a')).toEqual([])
  })

  it.each([
    ['no file', null, 'required'],
    ['a path that climbs out', zip([{ name: '../evil/SKILL.md', data: 'x' }]), 'invalid_value'],
    ['an absolute path', zip([{ name: '/evil/SKILL.md', data: 'x' }]), 'invalid_value'],
    ['a symlink entry', zip([{ name: 'demo-a/SKILL.md', data: SKILL_MD }, { name: 'demo-a/link', data: 'SKILL.md', mode: 0o120777 }]), 'invalid_value'],
    ['no SKILL.md', zip([{ name: 'demo-a/readme.md', data: 'x' }]), 'invalid_value'],
    ['a symlink to an absolute path', zip([{ name: 'demo-a/SKILL.md', data: SKILL_MD }, { name: 'demo-a/link', data: '/etc/hosts', mode: 0o120777 }]), 'invalid_value'],
    ['a fifo entry', zip([{ name: 'demo-a/SKILL.md', data: SKILL_MD }, { name: 'demo-a/pipe', mode: 0o010644 }]), 'invalid_value'],
    ['a block device entry', zip([{ name: 'demo-a/SKILL.md', data: SKILL_MD }, { name: 'demo-a/dev', mode: 0o060644 }]), 'invalid_value'],
  ])('refuses %s: 400, nothing recorded, nothing left behind', async (_n, archive, error) => {
    const before = stagingDirs()
    const r = await importGlobal(archive)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe(error)
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_revisions').get()).toEqual({ n: 0 })
    expect(listDir(globalSkillsDir())).toEqual([])
    expect(stagingDirs()).toEqual(before)
  })

  it('a file over the size limit refuses that skill whole: the proposal is never a partial set', async () => {
    const r = await importGlobal(demoZip([{ name: 'demo-a/big.bin', data: Buffer.alloc(5 * 1024 * 1024 + 1) }]))
    expect(r.status).toBe(400)
    expect(skillRow('global/demo-a')).toBeUndefined()
    expect(revs('global/demo-a')).toEqual([])
  })

  it('an archive with one good and one refused skill records the good one and names the refused one', async () => {
    const archive = zip([
      { name: 'demo-a/SKILL.md', data: SKILL_MD },
      { name: 'demo-b/SKILL.md', data: SKILL_MD },
      { name: 'demo-b/big.bin', data: Buffer.alloc(5 * 1024 * 1024 + 1) },
    ])
    const r = await importGlobal(archive)
    expect(r.status).toBe(202)
    expect(r.body.imported).toEqual(['demo-a'])
    expect(r.body.refused).toEqual([{ skill: 'demo-b', hint: expect.stringContaining('size limit') }])
    expect(skillRow('global/demo-b')).toBeUndefined()
  })
})

describe('an archive import for an agent goes to quarantine too', () => {
  it('agent skill: pending_review row, nothing in the agent skills directory', async () => {
    const r = await importAgent('agent-a', demoZip([SCRIPT]))
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ imported: ['demo-a'], status: 'pending_review' })
    expect(skillRow('agent/agent-a/demo-a')).toMatchObject({ status: 'pending_review', is_global: 0 })
    expect(revs('agent/agent-a/demo-a')[0]).toMatchObject({ status: 'pending', has_scripts: 1 })
    expect(listDir(agentSkillsDir('agent-a'))).toEqual([])
    expect(listDir(globalSkillsDir())).toEqual([])
  })

  it('the main agent imports a global skill (as before), also quarantined', async () => {
    const r = await importAgent('main-a', demoZip())
    expect(r.status).toBe(202)
    expect(skillRow('global/demo-a')).toMatchObject({ status: 'pending_review', is_global: 1 })
    expect(listDir(globalSkillsDir())).toEqual([])
  })

  it('an unknown agent is a 404 and nothing is recorded', async () => {
    expect((await importAgent('agent-z', demoZip())).status).toBe(404)
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_revisions').get()).toEqual({ n: 0 })
  })
})

describe('a pending revision does not disturb the trail of the live state', () => {
  const SYS = { kind: 'system', id: null } as const

  it('prev_sha256 and the no-change rule read the latest ACTIVATED revision, not the pending one', async () => {
    const { updateSkill, submitPendingRevision, sha256Hex } = await import('../db.js')
    await createSkill({ id: 'global/demo-a', name: 'demo-a', content: '# one\n', tenant_id: 'fleet', is_global: true }, SYS)
    const { dbx } = await import('../db/facade.js')
    const sub = await dbx.tx((tx) => submitPendingRevision(tx, { skill: { id: 'global/demo-a', tenant_id: 'fleet' }, action: 'modify', content: '# two\n', files: [], actor: { kind: 'agent', id: 'agent-a' }, touchesPrivilege: false }))
    expect(sub.created).toBe(true)
    expect(sub.revision).toMatchObject({ status: 'pending', prev_sha256: sha256Hex('# one\n') })

    // The same text as the live state: still no new row (the pending revision is not "the latest").
    await updateSkill('global/demo-a', { content: '# one\n' }, SYS)
    expect(revs('global/demo-a').map((r) => r.action)).toEqual(['create', 'modify'])
    // A real change: its prev_sha256 is the live hash, never the pending one.
    await updateSkill('global/demo-a', { content: '# three\n' }, SYS)
    const last = revs('global/demo-a').at(-1)!
    expect(last).toMatchObject({ action: 'modify', status: 'activated', prev_sha256: sha256Hex('# one\n') })
    // The read API shows both states.
    expect((await listSkillRevisions('global/demo-a')).map((r) => r.status)).toEqual(['activated', 'pending', 'activated'])
  })

  it('the same proposal twice is one revision; another text is a second one', async () => {
    const { submitPendingRevision } = await import('../db.js')
    const { dbx } = await import('../db/facade.js')
    await createSkill({ id: 'global/demo-a', name: 'demo-a', content: '# one\n', tenant_id: 'fleet', is_global: true }, SYS)
    const submit = (content: string) => dbx.tx((tx) => submitPendingRevision(tx, { skill: { id: 'global/demo-a', tenant_id: 'fleet' }, action: 'modify', content, files: [], actor: SYS, touchesPrivilege: true }))
    const a = await submit('# two\n')
    const b = await submit('# two\n')
    expect(b.created).toBe(false)
    expect(b.revision.id).toBe(a.revision.id)
    const c = await submit('# three\n')
    expect(c.created).toBe(true)
    // A proposal replaces the live state, not the proposal before it: prev_sha256 is the ACTIVATED hash.
    const { sha256Hex } = await import('../db.js')
    expect(c.revision.prev_sha256).toBe(sha256Hex('# one\n'))
    expect((await listPendingRevisions('global/demo-a')).map((r) => r.seq)).toEqual([2, 3])
  })

  it('a skill that predates the trail gets its baseline before a modify proposal, and none for a create', async () => {
    const { submitPendingRevision } = await import('../db.js')
    const { dbx } = await import('../db/facade.js')
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('global/old-a', 'old-a', '', '# old\\n', 'fleet', 1)").run()
    await dbx.tx((tx) => submitPendingRevision(tx, { skill: { id: 'global/old-a', tenant_id: 'fleet' }, action: 'modify', content: '# new\n', files: [], actor: SYS, touchesPrivilege: true }))
    expect(revs('global/old-a').map((r) => [r.action, r.status])).toEqual([['baseline', 'activated'], ['modify', 'pending']])
    await dbx.tx((tx) => submitPendingRevision(tx, { skill: { id: 'global/new-a', tenant_id: 'fleet' }, action: 'create', content: '# new\n', files: [], actor: SYS, touchesPrivilege: true }))
    expect(revs('global/new-a').map((r) => [r.action, r.status])).toEqual([['create', 'pending']])
  })

  it('getSkill still answers for a pending_review row (the admin path), as a row that is not live', async () => {
    await importGlobal(demoZip())
    expect((await getSkill('global/demo-a'))?.status).toBe('pending_review')
  })

  it('the files of a pending revision are removed with the tenant (no orphan bytes)', async () => {
    const { createTenant, deleteTenant } = await import('../db.js')
    await importGlobal(demoZip([SCRIPT]))
    const id = (revs('global/demo-a')[0] as { id: number }).id
    expect(revFiles(id)).toHaveLength(1)
    // Re-key the proposal to a tenant that can be deleted: the files carry no tenant column, they follow the revision.
    await createTenant('tenant-p', 'Tenant P')
    db.prepare("UPDATE skill_revisions SET tenant_id = 'tenant-p' WHERE id = ?").run(id)
    await deleteTenant('tenant-p')
    expect(revFiles(id)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_revisions WHERE id = ?').get(id)).toEqual({ n: 0 })
  })
})

describe('the archive listing is judged before anything is unzipped', () => {
  const line = (type: string, size: number, name = 'demo-a/x') => `${type}rw-r--r--  3.0 unx ${String(size).padStart(8)} tx stor 20-Jan-01 00:00 ${name}`
  it('regular files and directories pass', () => {
    expect(inspectArchiveListing([line('-', 10), line('d', 0, 'demo-a/')].join('\n'))).toBeNull()
  })
  it.each(['l', 'c', 'b', 'p', 's'])('a %s entry is refused', (t) => {
    expect(inspectArchiveListing([line('-', 10), line(t, 0)].join('\n'))).toMatch(/only regular files/)
  })
  it('the entry-count and the declared-size ceilings are exact (at the limit passes, one over is refused)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => line('-', 1, `demo-a/f${i}`)).join('\n')
    expect(inspectArchiveListing(many(MAX_ARCHIVE_ENTRIES))).toBeNull()
    expect(inspectArchiveListing(many(MAX_ARCHIVE_ENTRIES + 1))).toMatch(/entries/)
    expect(inspectArchiveListing(line('-', MAX_ARCHIVE_BYTES))).toBeNull()
    expect(inspectArchiveListing(line('-', MAX_ARCHIVE_BYTES + 1))).toMatch(/bytes/)
  })
  it('an entry made on a FAT host (shorter attribute field) is judged, not skipped', () => {
    const fat = (size: number) => `-rw-a--     2.0 fat ${String(size).padStart(8)} b- stor 20-Jan-01 00:00 demo-a/x`
    expect(inspectArchiveListing(fat(10), 1)).toBeNull()
    expect(inspectArchiveListing(fat(MAX_ARCHIVE_BYTES + 1))).toMatch(/bytes/)
  })
  it('an entry the listing did not parse is refused (the count disagrees with the name list)', () => {
    expect(inspectArchiveListing(line('-', 10), 2)).toMatch(/could not be read/)
    expect(inspectArchiveListing(line('-', 10), 1)).toBeNull()
  })
  it('header and footer lines of the listing are ignored', () => {
    expect(inspectArchiveListing(['Archive:  a.skill', 'Zip file size: 100 bytes, number of entries: 1', line('-', 10), '1 file, 10 bytes uncompressed'].join('\n'))).toBeNull()
  })
})
