// DELETE /api/skills/sql/:id of a GLOBAL skill (global/<x>, is_global = 1) by the main-agent bearer, against real PostgreSQL with
// forced row-level security, the backend booted as the APP role (`npm run test:pg`).
//
// The bearer is role `admin` with the tenant `default`, so the request context is a TENANT one: a global row can be written only by a
// privileged context (skills policy) and its revision row is refused to every tenant context (skill_revisions WITH CHECK), so the
// delete used to throw 42501 (a 500). The route now sends exactly that case, a global admin deleting a global/<x> row it has read, through
// the named system job `delete-global-skill`; every authz decision is made by the same code before it, and the job filters on the tenant
// of the row the route read and on is_global. The cells run the real route handler inside `runAsRequest` (the context the web server
// gives) and answer a thrown error the way the request handler does (the central 42501 -> 403 map), and read the result through the
// admin pool, the oracle. Fixtures are neutral.
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { runAsRequest } from '../../db/background-jobs.js'
import { deleteGlobalSkill, deleteSkill, SkillDeleteWroteNothing } from '../../db/tasks.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { answerRlsRefusal } from '../../web/rls-refusal-response.js'
import type { RouteContext } from '../../web/routes/types.js'

vi.mock('../../web/skill-regen.js', () => ({
  regenSingleSkillFile: vi.fn().mockResolvedValue({ skipped: true, reason: null }),
  removeGeneratedSkillFile: vi.fn().mockResolvedValue(undefined),
  removeGeneratedCompanionFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/agent-config.js')>()),
  listAgentNames: () => ['agent-a', 'agent-b'],
}))

import { tryHandleSkills } from '../../web/routes/skills.js'
import { normalizePath } from '../../web/routes/versioning.js'

const G = 'global/gx'
const A = 'agent/agent-a/ay'
const T = 'tenant-t1-own'
let db: PgTestDb
beforeAll(async () => { db = await createPgTestDb(); setBackend(db.appDbx(), 'pg') })
afterAll(async () => { setBackend(null); await db.close() })

async function seed(): Promise<void> {
  await db.pool.query('DROP TRIGGER IF EXISTS keep_row ON skills')
  await db.pool.query('DROP TRIGGER IF EXISTS keep_file ON skill_files')
  await db.pool.query("DELETE FROM skill_revisions WHERE skill_id IN ('global/gx', 'agent/agent-a/ay', 'tenant-t1-own')")
  await db.pool.query("DELETE FROM skill_files WHERE skill_id IN ('global/gx', 'agent/agent-a/ay', 'tenant-t1-own')")
  await db.pool.query("DELETE FROM skills WHERE id IN ('global/gx', 'agent/agent-a/ay', 'tenant-t1-own')")
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('fleet', 'Fleet', 1), ('tenant-t1', 'Tenant 1', 1), ('tenant-t2', 'Tenant 2', 1) ON CONFLICT DO NOTHING")
  await db.pool.query(`INSERT INTO skills (id, name, content, tenant_id, is_global, status) VALUES
    ('global/gx', 'gx', 'global text', 'fleet', 1, 'live'),
    ('agent/agent-a/ay', 'ay', 'agent text', 'fleet', 0, 'live'),
    ('tenant-t1-own', 'own', 'tenant text', 'tenant-t1', 0, 'live')`)
  await db.pool.query("INSERT INTO skill_files (skill_id, rel_path, content, mode) VALUES ('global/gx', 'references/a.md', 'a', 420), ('global/gx', 'references/b.md', 'b', 420), ('agent/agent-a/ay', 'references/a.md', 'a', 420)")
}
beforeEach(seed)

interface Who { role: string; tenantId: string; kind: 'token' | 'session'; tokenAgentId?: string }
const MAIN_BEARER: Who = { role: 'admin', tenantId: 'default', kind: 'token' }
const TENANT_ADMIN_SESSION: Who = { role: 'admin', tenantId: 'tenant-t1', kind: 'session' }
const TENANT_USER: Who = { role: 'agent', tenantId: 'tenant-t1', kind: 'token' }
const FLEET_TOKEN: Who = { role: 'fleet_agent', tenantId: 'default', kind: 'token', tokenAgentId: 'agent-a' }

/** The route in the context the web server gives, and the answer of the request handler's catch for a thrown error. */
async function del(id: string, who: Who): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from([]), { method: 'DELETE', headers: {} as Record<string, string> })
  const out = { status: 200, body: {} as Record<string, unknown> }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = { raw: String(b) } } },
    setHeader() {}, headersSent: false,
  } as never
  const url = new URL(`http://localhost:3420/api/skills/sql/${encodeURIComponent(id)}`)
  const { path } = normalizePath(url.pathname)
  const ctx = { req, res, path, method: 'DELETE', url, role: who.role, tenantId: who.tenantId, tokenAgentId: who.tokenAgentId, agentId: who.tokenAgentId, auth: who.kind === 'token' ? { kind: 'token', tokenName: 'probe' } : { kind: 'session', user: 'user-a' } } as unknown as RouteContext
  try {
    await runAsRequest({ authenticated: true, role: who.role, agentId: who.role === 'fleet_agent' ? who.tokenAgentId : undefined, tenantId: who.tenantId }, () => tryHandleSkills(ctx))
  } catch (err) {
    if (!answerRlsRefusal(err, res, 'DELETE', path)) throw err
  }
  return out
}

const skillRow = async (id: string): Promise<number> => (await db.pool.query('SELECT 1 FROM skills WHERE id = $1', [id])).rowCount ?? 0
const fileCount = async (id: string): Promise<number> => (await db.pool.query('SELECT 1 FROM skill_files WHERE skill_id = $1', [id])).rowCount ?? 0
const revisions = async (id: string): Promise<string[]> =>
  (await db.pool.query("SELECT action || '@' || tenant_id AS a FROM skill_revisions WHERE skill_id = $1 ORDER BY seq", [id])).rows.map((r: { a: string }) => r.a)

describe('the main-agent bearer deletes a global skill', () => {
  it('200: the row and its files are gone, and the revision rows carry the SKILL\'s tenant, not the caller\'s', async () => {
    const r = await del(G, MAIN_BEARER)
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(await skillRow(G)).toBe(0)
    expect(await fileCount(G)).toBe(0)
    expect(await revisions(G)).toEqual(['baseline@fleet', 'delete@fleet'])
  })

  it('a global skill that is not live is deleted too (the admin rule of the route is kept, not tightened)', async () => {
    await db.pool.query("UPDATE skills SET status = 'disabled' WHERE id = 'global/gx'")
    expect((await del(G, MAIN_BEARER)).status).toBe(200)
    expect(await skillRow(G)).toBe(0)
  })

  it('an id that is not there is a 404 and nothing is created', async () => {
    expect((await del('global/missing', MAIN_BEARER)).status).toBe(404)
    expect(await revisions('global/missing')).toEqual([])
  })
})

describe('the authz decisions are the ones the route made before, and the job does not widen them', () => {
  it('a tenant ADMIN SESSION (admin role, a tenant of its own) is not a global admin: no job, the database refuses, 403 forbidden, nothing changes', async () => {
    const r = await del(G, TENANT_ADMIN_SESSION)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('forbidden')
    expect(JSON.stringify(r.body)).not.toMatch(/skill_revisions|policy|row-level/)
    expect(await skillRow(G)).toBe(1)
    expect(await fileCount(G)).toBe(2)
    expect(await revisions(G)).toEqual([])
  })

  it('a tenant user token of another tenant: the same 404 as before, nothing changes', async () => {
    expect((await del(G, TENANT_USER)).status).toBe(404)
    expect(await skillRow(G)).toBe(1)
    expect(await revisions(G)).toEqual([])
  })

  it('a fleet agent token: 403 by the route (a global skill is not its own), nothing changes', async () => {
    const r = await del(G, FLEET_TOKEN)
    expect(r.status).toBe(403)
    expect(await skillRow(G)).toBe(1)
    expect(await revisions(G)).toEqual([])
  })

  it('an agent/<a>/<x> skill of the fleet tenant stays a 404 for the main bearer (another tenant\'s row), no job, nothing changes', async () => {
    expect((await del(A, MAIN_BEARER)).status).toBe(404)
    expect(await skillRow(A)).toBe(1)
    expect(await fileCount(A)).toBe(1)
    expect(await revisions(A)).toEqual([])
  })

  it('a tenant skill of a tenant user is deleted on the path it always took (no job needed)', async () => {
    expect((await del(T, TENANT_USER)).status).toBe(200)
    expect(await skillRow(T)).toBe(0)
    expect(await revisions(T)).toEqual(['baseline@tenant-t1', 'delete@tenant-t1'])
  })
})

describe('the job does not leak', () => {
  it('outside the job, deleteSkill of a global skill from the main bearer\'s context is still refused (42501), the policy is untouched', async () => {
    await expect(runAsRequest({ authenticated: true, role: 'admin', tenantId: 'default' }, () => deleteSkill(G, { kind: 'human', id: 'user-a' })))
      .rejects.toMatchObject({ code: '42501' })
    expect(await skillRow(G)).toBe(1)
  })

  it('the job filters on the tenant the route saw: another tenant is false, nothing changes', async () => {
    const r = await runAsRequest({ authenticated: true, role: 'admin', tenantId: 'default' }, () => deleteGlobalSkill(G, { kind: 'human', id: 'user-a' }, { tenant_id: 'tenant-t1' }))
    expect(r).toBe(false)
    expect(await skillRow(G)).toBe(1)
    expect(await revisions(G)).toEqual([])
  })

  it('the job filters on is_global: a non-global row is false even with its own tenant, and a row of another id is untouched', async () => {
    expect(await runAsRequest({ authenticated: true, role: 'admin', tenantId: 'default' }, () => deleteGlobalSkill(A, { kind: 'human', id: 'user-a' }, { tenant_id: 'fleet' }))).toBe(false)
    expect(await skillRow(A)).toBe(1)
    expect(await skillRow(G)).toBe(1)
  })

  it('an id that is gone between the route\'s read and the job is false', async () => {
    expect(await runAsRequest({ authenticated: true, role: 'admin', tenantId: 'default' }, () => deleteGlobalSkill('global/missing', { kind: 'human', id: 'user-a' }, { tenant_id: 'fleet' }))).toBe(false)
  })
})

describe('one atomic transaction with a row-count guard', () => {
  const run = (): Promise<boolean> => runAsRequest({ authenticated: true, role: 'admin', tenantId: 'default' }, () => deleteGlobalSkill(G, { kind: 'human', id: 'user-a' }, { tenant_id: 'fleet' }))

  it('a delete of the skill row that hits no row (a trigger swallows it) is an ERROR that undoes the revision row and the file delete, never a 200', async () => {
    await db.pool.query('CREATE OR REPLACE FUNCTION keep_it() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$')
    await db.pool.query('CREATE TRIGGER keep_row BEFORE DELETE ON skills FOR EACH ROW EXECUTE FUNCTION keep_it()')
    await expect(run()).rejects.toBeInstanceOf(SkillDeleteWroteNothing)
    expect(await skillRow(G)).toBe(1)
    expect(await fileCount(G)).toBe(2)
    expect(await revisions(G)).toEqual([]) // the revision row was written first in the transaction and is gone with it
  })

  it('a file delete that removes fewer files than were there is an ERROR as well (everything rolled back)', async () => {
    await db.pool.query('CREATE OR REPLACE FUNCTION keep_it() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$')
    await db.pool.query("CREATE TRIGGER keep_file BEFORE DELETE ON skill_files FOR EACH ROW WHEN (OLD.rel_path = 'references/b.md') EXECUTE FUNCTION keep_it()")
    await expect(run()).rejects.toBeInstanceOf(SkillDeleteWroteNothing)
    expect(await skillRow(G)).toBe(1)
    expect(await fileCount(G)).toBe(2)
    expect(await revisions(G)).toEqual([])
  })

  it('the skill row is locked FIRST: a concurrent writer that commits while the delete waits is READ by it (the delete row records the committed text, not a snapshot the writer replaced)', async () => {
    const holder = await db.pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query("UPDATE skills SET content = 'committed-while-waiting' WHERE id = 'global/gx'")
      let settled = false
      const pending = run().then((v) => { settled = true; return v })
      await new Promise((r) => setTimeout(r, 500))
      expect(settled).toBe(false) // waiting on the writer's row lock
      await holder.query('COMMIT')
      expect(await pending).toBe(true)
    } finally {
      holder.release()
    }
    expect(await skillRow(G)).toBe(0)
    const sha = createHash('sha256').update('committed-while-waiting').digest('hex')
    const last = (await db.pool.query("SELECT content_sha256 FROM skill_revisions WHERE skill_id = 'global/gx' AND action = 'delete'")).rows[0]
    expect(last?.content_sha256).toBe(sha)
  })
})
