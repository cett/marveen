import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import { addGeneratedHeader } from '../skill-header.js'

// Companion files (scripts/, references/) of a skill: /api/skills/sql/<id>/files[/<rel>].
// Real skill-regen + real filesystem under a temp home; only the DB is faked.

const { FAKE_HOME, FAKE_PROJECT, store, files, avail } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-files-api-'))
  return {
    FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project'),
    store: new Map<string, any>(), files: new Map<string, any>(), avail: new Map<string, string[]>(),
  }
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
  listAgentNames: () => ['agent-b'],
  agentDir: (n: string) => join(FAKE_PROJECT, 'agents', n),
  readFileOr: (p: string, d: string) => { try { return readFileSync(p, 'utf-8') } catch { return d } },
}))
vi.mock('../web/agent-scaffold.js', () => ({ generateSkillMd: vi.fn() }))
vi.mock('../web/multipart.js', () => ({ parseMultipart: vi.fn().mockReturnValue({ file: null }) }))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const fk = (id: string, rel: string) => `${id}\u0000${rel}`
vi.mock('../db.js', () => ({
  getSkill: vi.fn((id: string) => store.get(id)),
  deleteSkill: vi.fn((id: string) => { for (const k of [...files.keys()]) if (k.startsWith(`${id}\u0000`)) files.delete(k); return store.delete(id) }),
  listAllSkills: vi.fn(() => [...store.values()]),
  listSkillAccess: vi.fn().mockReturnValue([]),
  getEnabledAgentsForTenant: vi.fn((t: string) => avail.get(t) ?? []),
  listSkillFiles: vi.fn((id: string) => [...files.values()].filter(f => f.skill_id === id).sort((a, b) => a.rel_path.localeCompare(b.rel_path))),
  getSkillFile: vi.fn((id: string, rel: string) => files.get(fk(id, rel))),
  putSkillFile: vi.fn((id: string, rel: string, content: Buffer, mode?: number) => {
    const r = { skill_id: id, rel_path: rel, content, mode: (mode ?? 0) & 0o111 ? 0o755 : 0o644, created_at: 0, updated_at: 1 }
    files.set(fk(id, rel), r); return r
  }),
  deleteSkillFile: vi.fn((id: string, rel: string) => files.delete(fk(id, rel))),
  countSkillFiles: vi.fn((id: string) => [...files.values()].filter(f => f.skill_id === id).length),
}))

import { tryHandleSkills } from '../web/routes/skills.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

function call(method: string, path: string, body?: object | string, who: { role?: string; tenantId?: string } = { role: 'admin' }) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role: who.role, tenantId: who.tenantId, auth: undefined } as unknown as RouteContext
  return tryHandleSkills(ctx).then(() => out)
}

const enc = encodeURIComponent
const SID = 'global/with-files'
const base = `/api/skills/sql/${enc(SID)}/files`
const gdir = () => join(FAKE_HOME, '.claude', 'skills', 'with-files')
const row = (id: string, tenant = 'fleet', content = '---\nname: x\n---\nbody') =>
  ({ id, name: id.split('/').pop(), description: '', content, tenant_id: tenant, is_global: 1, created_by: null, created_at: 0, updated_at: 0 })
const b64 = (s: string) => Buffer.from(s).toString('base64')

beforeEach(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
  store.clear(); files.clear(); avail.clear()
  mkdirSync(join(FAKE_PROJECT, 'agents', 'ann'), { recursive: true })
  store.set(SID, row(SID))
  mkdirSync(gdir(), { recursive: true })
  writeFileSync(join(gdir(), 'SKILL.md'), addGeneratedHeader(store.get(SID).content, SID))
})

describe('PUT/GET/DELETE /api/skills/sql/<id>/files/<rel>', () => {
  it('stores a text file, generates it next to SKILL.md, keeps the exec bit, and reads it back', async () => {
    const put = await call('PUT', `${base}/${enc('scripts/run.sh')}`, { content: '#!/bin/sh\necho hi\n', mode: 0o755 })
    expect(put.status).toBe(201)
    expect(put.body.file).toMatchObject({ rel_path: 'scripts/run.sh', size: 18, mode: 0o755 })
    const onDisk = join(gdir(), 'scripts', 'run.sh')
    expect(readFileSync(onDisk, 'utf-8')).toBe('#!/bin/sh\necho hi\n')
    expect(statSync(onDisk).mode & 0o777).toBe(0o755)

    const get = await call('GET', `${base}/${enc('scripts/run.sh')}`)
    expect(get.status).toBe(200)
    expect(Buffer.from(get.body.content_base64, 'base64').toString()).toBe('#!/bin/sh\necho hi\n')
    const list = await call('GET', base)
    expect(list.body.files.map((f: any) => f.rel_path)).toEqual(['scripts/run.sh'])
  })

  it('stores binary content byte-exact (base64), and an update replaces it (200, not 201)', async () => {
    const bytes = Buffer.from([0, 255, 1, 2, 254, 10, 13])
    expect((await call('PUT', `${base}/${enc('references/blob.bin')}`, { content_base64: bytes.toString('base64') })).status).toBe(201)
    expect(readFileSync(join(gdir(), 'references', 'blob.bin')).equals(bytes)).toBe(true)
    const again = await call('PUT', `${base}/${enc('references/blob.bin')}`, { content_base64: b64('v2') })
    expect(again.status).toBe(200)
    expect(readFileSync(join(gdir(), 'references', 'blob.bin'), 'utf-8')).toBe('v2')
  })

  it('DELETE removes the row and the generated file (and the emptied directory), not a hand-edited one', async () => {
    await call('PUT', `${base}/${enc('scripts/a.py')}`, { content: 'print(1)\n' })
    await call('PUT', `${base}/${enc('scripts/b.py')}`, { content: 'print(2)\n' })
    expect((await call('DELETE', `${base}/${enc('scripts/a.py')}`)).status).toBe(200)
    expect(existsSync(join(gdir(), 'scripts', 'a.py'))).toBe(false)
    expect(files.has(fk(SID, 'scripts/a.py'))).toBe(false)
    writeFileSync(join(gdir(), 'scripts', 'b.py'), 'hand edited\n')
    expect((await call('DELETE', `${base}/${enc('scripts/b.py')}`)).status).toBe(200)
    expect(readFileSync(join(gdir(), 'scripts', 'b.py'), 'utf-8')).toBe('hand edited\n')
    expect((await call('DELETE', `${base}/${enc('scripts/nope.py')}`)).status).toBe(404)
  })

  it('rejects unsafe paths, SKILL.md itself, a bad body, a bad mode and an oversized file', async () => {
    for (const bad of ['../evil', 'a/../b', '/abs', 'a//b', 'SKILL.md', 'a\\b', 'a/./b']) {
      const r = await call('PUT', `${base}/${enc(bad)}`, { content: 'x' })
      expect(r.status, bad).toBe(400)
      expect(r.body.field).toBe('rel_path')
    }
    expect((await call('PUT', `${base}/ok.txt`, { content: 'x', content_base64: 'eA==' })).status).toBe(400)
    expect((await call('PUT', `${base}/ok.txt`, {})).status).toBe(400)
    expect((await call('PUT', `${base}/ok.txt`, { content_base64: '***' })).status).toBe(400)
    expect((await call('PUT', `${base}/ok.txt`, { content: 'x', mode: 'rwx' })).status).toBe(400)
    expect((await call('PUT', `${base}/ok.txt`, 'not json')).status).toBe(400)
    const big = await call('PUT', `${base}/big.bin`, { content_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })
    expect(big.status).toBe(413)
    expect(existsSync(join(gdir(), 'ok.txt'))).toBe(false)
  })

  it('caps the number of companion files per skill', async () => {
    for (let i = 0; i < 200; i++) files.set(fk(SID, `f${i}.txt`), { skill_id: SID, rel_path: `f${i}.txt`, content: Buffer.from('x'), mode: 0o644, updated_at: 1 })
    const r = await call('PUT', `${base}/one-too-many.txt`, { content: 'x' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('limit_exceeded')
    expect((await call('PUT', `${base}/f0.txt`, { content: 'update ok' })).status).toBe(200)   // an update is not a new file
  })

  it('does not write through a symlinked directory inside the skill dir', async () => {
    const outside = join(FAKE_HOME, 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(gdir(), 'scripts'))
    const r = await call('PUT', `${base}/${enc('scripts/pwn.sh')}`, { content: 'x' })
    expect(r.status).toBe(500)
    expect(existsSync(join(outside, 'pwn.sh'))).toBe(false)
  })

  it('404s for an unknown skill, and hides another tenant\'s skill', async () => {
    expect((await call('GET', `/api/skills/sql/${enc('global/ghost')}/files`)).status).toBe(404)
    store.set('acme-demo', row('acme-demo', 'acme'))
    const other = await call('PUT', `/api/skills/sql/acme-demo/files/x.txt`, { content: 'x' }, { role: 'user', tenantId: 'beta' })
    expect(other.status).toBe(404)
    expect((await call('GET', `/api/skills/sql/acme-demo/files`, undefined, { role: 'user', tenantId: 'beta' })).status).toBe(404)
  })

  it('the owning tenant writes to its skill; the files land under the tenant\'s own agents', async () => {
    store.set('acme-demo', row('acme-demo', 'acme', '---\nname: demo\n---\nbody'))
    avail.set('acme', ['ann'])
    const r = await call('PUT', `/api/skills/sql/acme-demo/files/${enc('references/notes.md')}`, { content: 'notes' }, { role: 'user', tenantId: 'acme' })
    expect(r.status).toBe(201)
    const dir = join(FAKE_PROJECT, 'agents', 'ann', '.claude', 'skills', 'acme-demo')
    expect(readFileSync(join(dir, 'references', 'notes.md'), 'utf-8')).toBe('notes')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('(tenant skill acme-demo)')
    expect((await call('DELETE', `/api/skills/sql/acme-demo/files/${enc('references/notes.md')}`, undefined, { role: 'user', tenantId: 'acme' })).status).toBe(200)
    expect(existsSync(join(dir, 'references'))).toBe(false)
  })
})

describe('DELETE /api/skills/sql/<id> with companion files', () => {
  it('removes the generated companion files together with SKILL.md and the directory', async () => {
    await call('PUT', `${base}/${enc('scripts/a.py')}`, { content: 'print(1)\n' })
    await call('PUT', `${base}/${enc('references/r.md')}`, { content: 'ref' })
    const out = await call('DELETE', `/api/skills/sql/${enc(SID)}`)
    expect(out.status).toBe(200)
    expect(existsSync(gdir())).toBe(false)
    expect([...files.keys()]).toEqual([])
  })
})
