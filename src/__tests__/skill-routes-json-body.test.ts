// A JSON body that is not an object (null, an array, a string, a number) answered 500 internal_error on five skills
// routes: JSON.parse('null') is null and the first field read threw. They share one guard now: 400 invalid_value with the
// hint "Body must be a JSON object". Text that is not JSON still answers parse_error, and an object still reaches the
// route's own validation. Real in-memory SQLite and the real route handler; only the on-disk regeneration is stubbed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, createSkill, submitPendingRevision, dbx } from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/skill-regen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/skill-regen.js')>()),
  regenSingleSkillFile: vi.fn().mockResolvedValue({ reason: 'ok' }),
  removeGeneratedSkillFile: vi.fn().mockResolvedValue(undefined),
  removeGeneratedCompanionFile: vi.fn().mockResolvedValue(undefined),
}))

const SYSTEM = { kind: 'system' as const, id: null }
const PLAIN = '---\nname: x\ndescription: d\n---\nbody\n'
const ID = 'global/json-body'

beforeEach(async () => {
  initDatabase(':memory:')
  await createSkill({ id: ID, name: 'json-body', description: 'd', content: PLAIN, tenant_id: 'fleet', is_global: true }, SYSTEM)
})

async function call(method: string, path: string, rawBody: string) {
  const buf = Buffer.from(rawBody)
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

const enc = encodeURIComponent
const ROUTES: Array<{ label: string; method: string; path: () => string }> = [
  { label: 'create (tenant skill)', method: 'POST', path: () => '/api/skills/sql' },
  { label: 'create or update (fleet skill)', method: 'PUT', path: () => `/api/skills/sql/${enc(ID)}` },
  { label: 'companion file put', method: 'PUT', path: () => `/api/skills/sql/${enc(ID)}/files/${enc('references/a.txt')}` },
  { label: 'decide a pending revision', method: 'POST', path: () => '/api/skills/sql/revisions/1/decide' },
  { label: 'grant access to a tenant', method: 'POST', path: () => `/api/skills/sql/${enc(ID)}/access` },
]
const NOT_AN_OBJECT = ['null', '[]', '[{"decision":"activate"}]', '"x"', '42', 'true']

describe('a body that is not a JSON object is a 400, not a 500', () => {
  for (const route of ROUTES) {
    describe(route.label, () => {
      for (const body of NOT_AN_OBJECT) {
        it(`${body} answers 400 invalid_value`, async () => {
          const out = await call(route.method, route.path(), body)
          expect(out.status).toBe(400)
          expect(out.body).toMatchObject({ error: 'invalid_value', hint: 'Body must be a JSON object' })
        })
      }

      it('text that is not JSON still answers parse_error', async () => {
        const out = await call(route.method, route.path(), '{not json')
        expect(out.status).toBe(400)
        expect(out.body).toMatchObject({ error: 'parse_error', hint: 'Invalid JSON' })
      })

      it('an object is not refused by the guard: the route\'s own validation answers', async () => {
        const out = await call(route.method, route.path(), '{}')
        expect(out.status).not.toBe(500)
        expect(out.body?.hint).not.toBe('Body must be a JSON object')
        expect(out.body?.error).not.toBe('parse_error')
      })
    })
  }

  it('a valid object still goes through the whole route (decide: reject)', async () => {
    const { revision } = await dbx.tx((tx) => submitPendingRevision(tx, {
      skill: { id: ID, tenant_id: 'fleet' }, action: 'modify', content: PLAIN.replace('body', 'body 2'), files: [],
      actor: { kind: 'agent', id: 'agent-a' }, touchesPrivilege: true,
    }))
    const out = await call('POST', `/api/skills/sql/revisions/${revision.id}/decide`, '{"decision":"reject"}')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, outcome: 'rejected' })
  })

  it('a valid object still goes through the whole route (companion file put)', async () => {
    const out = await call('PUT', `/api/skills/sql/${enc(ID)}/files/${enc('references/a.txt')}`, '{"content":"hello"}')
    expect(out.status).toBe(201)
  })
})
