// Kanban: the status, priority and sort_order a caller writes on PUT /api/kanban/:id (and the status / priority of a new
// card on POST /api/kanban) must be usable values. Before this check an unknown status or priority failed the column
// CHECK and answered a 500, a null sort_order failed the NOT NULL column (a 500), and "" / "abc" was stored as text.
// A status that DIFFERS from the stored one is a 400 use_move: a status change is a transition (event row, wake-up of the
// assignee, parent propagation, compare-and-set) and only POST /:id/move does those; the PUT used to change it silently.
// Real in-memory database, the real routes, the top-level catch of web.ts emulated (an uncaught throw is the 500).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { initDatabase, getDb, createKanbanCard, createTenant, updateKanbanCard } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { normalizePath } from '../web/routes/versioning.js'
import { isInvalidJsonBodyError, json } from '../web/http-helpers.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))
// updateKanbanCard stays the real function; the mock only records what the route hands it, so a test can look at the
// fields that would be WRITTEN (an equal status is dropped from them, see "the same status ...").
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, updateKanbanCard: vi.fn(actual.updateKanbanCard) }
})

interface Reply { status: number; body: any }
interface CtxOpts { role?: string; tenantId?: string | null; auth?: unknown }

// rawPath may be /api/... or /api/v1/...: the versioning step of web.ts rewrites the second to the first before the routes.
async function call(method: string, rawPath: string, raw: string | undefined, o: CtxOpts = {}): Promise<Reply> {
  const authReq = { headers: { authorization: 'Bearer the-file-token' } } as unknown as http.IncomingMessage
  const auth = await resolveAuth(authReq, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', Buffer.from(raw ?? '')); req.emit('end') })
  const out: Reply = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not JSON */ }
    },
  } as unknown as http.ServerResponse
  const url = new URL(`http://localhost:3420${normalizePath(rawPath).path}`)
  const decision = checkPermission(auth, method, url.pathname)
  if (!decision.allowed) return { status: decision.status, body: { error: 'denied' } }
  const ctx = {
    req, res, path: url.pathname, method, url,
    role: o.role ?? resolveRole(auth), tenantId: o.tenantId !== undefined ? o.tenantId : resolveTenantId(auth),
    auth: o.auth,
  } as unknown as RouteContext
  try {
    await tryHandleKanban(ctx)
  } catch (err) {
    if (isInvalidJsonBodyError(err, req)) json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400)
    else { json(res, { error: 'internal_error', hint: 'Szerver hiba' }, 500) }
  }
  return out
}

// Every row of every kanban / label / audit table: what a refused request must leave untouched.
function snapshot(): string {
  const db = getDb()
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'kanban%' OR name LIKE '%label%' OR name = 'agent_audit_log') AND name NOT LIKE '%fts%' ORDER BY name",
  ).all() as { name: string }[]).map((t) => t.name)
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
}

const ADMIN = { role: 'admin', tenantId: null, auth: { kind: 'session', user: 'user-a' } } as const
const TENANT = { role: 'agent', tenantId: 'tenant-x', auth: { kind: 'session', user: 'user-a' } } as const
const row = (id: string) => getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as Record<string, unknown>
const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const put = (id: string, body: unknown, o: CtxOpts = ADMIN, prefix = '/api') => call('PUT', `${prefix}/kanban/${id}`, JSON.stringify(body), o)

const STATUS_HINT = 'Allowed: planned, in_progress, waiting, testing, done'
const PRIORITY_HINT = 'Allowed: low, normal, high, urgent'
const MOVE_HINT = 'change a card status with POST /api/kanban/:id/move'

beforeEach(async () => {
  vi.mocked(updateKanbanCard).mockClear()
  initDatabase(':memory:')
  await createTenant('tenant-x', 'Tenant X')
  await createKanbanCard({ id: 'c1', title: 'Card' })
  await createKanbanCard({ id: 'tc1', title: 'Tenant card', tenant_id: 'tenant-x' })
})

describe('PUT /api/kanban/:id -- status must be an allowed value', () => {
  const BAD: Array<[string, unknown]> = [
    ['null', null], ['empty string', ''], ['number', 5], ['zero', 0], ['true', true], ['false', false], ['array', []],
    ['object', {}], ['unknown word', 'bogus'], ['wrong case', 'DONE'], ['padded', ' done'], ['inherited key name', '__proto__'],
  ]
  it.each(BAD)('status %s -> 400 invalid_value, nothing written (admin and tenant caller, /api and /api/v1)', async (_name, status) => {
    for (const [who, id] of [[ADMIN, 'c1'], [TENANT, 'tc1']] as const) {
      for (const prefix of ['/api', '/api/v1']) {
        const before = snapshot()
        const res = await put(id, { status, description: 'must not land' }, who, prefix)
        expect(res.status).toBe(400)
        expect(res.body).toEqual({ error: 'invalid_value', field: 'status', hint: STATUS_HINT })
        expect(snapshot()).toBe(before)
      }
    }
  })

  it('a different allowed status is a 400 use_move and writes nothing: no status change, no event row, no audit row, same updated_at', async () => {
    for (const to of ['in_progress', 'waiting', 'testing', 'done']) {
      const before = snapshot()
      const res = await put('c1', { status: to, description: 'must not land' })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_value', field: 'status', reason: 'use_move', hint: MOVE_HINT })
      expect(snapshot()).toBe(before)
    }
    expect(row('c1').status).toBe('planned')
  })

  it('a different status is refused from every starting status, for a tenant caller as well', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'done' WHERE id = 'c1'").run()
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = 'tc1'").run()
    expect((await put('c1', { status: 'planned' })).body).toMatchObject({ error: 'invalid_value', reason: 'use_move' })
    expect((await put('tc1', { status: 'in_progress' }, TENANT)).body).toMatchObject({ error: 'invalid_value', reason: 'use_move' })
    expect(row('c1').status).toBe('done')
    expect(row('tc1').status).toBe('waiting')
  })

  it('the same status is an accepted no-op: 200, the status and the event table are as they were (the UI sends the whole card back)', async () => {
    const events = count('kanban_card_events')
    const res = await put('c1', { status: 'planned', description: 'changed' })
    expect(res.status).toBe(200)
    expect(row('c1').status).toBe('planned')
    expect(row('c1').description).toBe('changed')
    expect(count('kanban_card_events')).toBe(events)
    expect((await put('tc1', { status: 'planned' }, TENANT)).status).toBe(200)
  })

  // The end state of the test above would be the same if the route handed the equal status to the UPDATE: it writes the
  // value that is already there. What the status key must NOT do is reach the write at all, because a move that lands
  // between the route's read and the UPDATE would then be reverted by the stale value. So the argument of
  // updateKanbanCard is looked at, and the race itself is replayed.
  describe('an equal status never reaches the write', () => {
    const written = (): Array<Record<string, unknown>> => vi.mocked(updateKanbanCard).mock.calls.map((c) => c[1] as Record<string, unknown>)

    it('the fields handed to updateKanbanCard have no status key, the other fields are there (admin and tenant caller, /api and /api/v1)', async () => {
      for (const [who, id] of [[ADMIN, 'c1'], [TENANT, 'tc1']] as const) {
        for (const prefix of ['/api', '/api/v1']) {
          vi.mocked(updateKanbanCard).mockClear()
          const res = await put(id, { status: 'planned', description: `kept by ${prefix}` }, who, prefix)
          expect(res.status).toBe(200)
          expect(written()).toHaveLength(1)
          expect(Object.keys(written()[0])).not.toContain('status')
          expect(written()[0]).toEqual({ description: `kept by ${prefix}` })
        }
      }
    })

    it('a body of nothing but the equal status hands over an empty field set, not the status', async () => {
      const res = await put('c1', { status: 'planned' })
      expect(res.status).toBe(200)
      expect(written()).toEqual([{}])
    })

    it('the full-card PUT of the UI: every stored column but the status is handed over', async () => {
      const stored = row('c1')
      await put('c1', { ...stored, assignee: null, title: 'Renamed' })
      expect(written()).toHaveLength(1)
      expect(Object.keys(written()[0])).not.toContain('status')
      expect(written()[0]).toMatchObject({ title: 'Renamed', priority: 'normal', sort_order: stored.sort_order })
    })

    it('with expected_updated_at: the status is still dropped, the guard goes to the options argument', async () => {
      const at = row('c1').updated_at as number
      const res = await put('c1', { status: 'planned', description: 'guarded', expected_updated_at: at })
      expect(res.status).toBe(200)
      expect(written()[0]).toEqual({ description: 'guarded' })
      expect(vi.mocked(updateKanbanCard).mock.calls[0][3]).toEqual({ expectedUpdatedAt: at })
    })

    it('a different status does not reach the write at all (400 before updateKanbanCard)', async () => {
      const res = await put('c1', { status: 'done', description: 'must not land' })
      expect(res.status).toBe(400)
      expect(updateKanbanCard).not.toHaveBeenCalled()
    })

    it('a move that lands between the route\'s read and the UPDATE is not reverted by the PUT', async () => {
      const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
      vi.mocked(updateKanbanCard).mockImplementationOnce(async (...args) => {
        // the race: another request moves the card after the route compared the status and before the UPDATE runs
        getDb().prepare("UPDATE kanban_cards SET status = 'in_progress' WHERE id = 'c1'").run()
        return actual.updateKanbanCard(...args)
      })
      const res = await put('c1', { status: 'planned', description: 'edited while it moved' })
      expect(res.status).toBe(200)
      expect(row('c1').description).toBe('edited while it moved')
      expect(row('c1').status).toBe('in_progress')
    })
  })

  it('the full-card PUT of the UI (every stored column sent back, status and sort_order included) is a 200', async () => {
    const stored = row('c1')
    const res = await put('c1', { ...stored, assignee: null, title: 'Renamed' })
    expect(res.status).toBe(200)
    expect(row('c1')).toMatchObject({ title: 'Renamed', status: 'planned', priority: 'normal', sort_order: stored.sort_order })
  })

  it('no status key is a partial update: 200 and the status is kept', async () => {
    expect((await put('c1', { description: 'changed' })).status).toBe(200)
    expect(row('c1').status).toBe('planned')
  })

  it('the refusal does not depend on the card existing in the caller tenant: a foreign card is a 404 before the status is looked at', async () => {
    expect((await put('c1', { status: 'bogus' }, TENANT)).status).toBe(404)
    expect((await put('c1', { status: 'done' }, TENANT)).status).toBe(404)
    expect(row('c1').status).toBe('planned')
  })

  it('a card that does not exist is a 404 for a valid status (admin)', async () => {
    expect((await put('missing', { status: 'planned' })).status).toBe(404)
  })

  it('POST /:id/move is untouched: it changes the status and writes the event row', async () => {
    const events = count('kanban_card_events')
    const res = await call('POST', '/api/kanban/c1/move', JSON.stringify({ status: 'waiting' }), ADMIN)
    expect(res.status).toBe(200)
    expect(row('c1').status).toBe('waiting')
    expect(count('kanban_card_events')).toBe(events + 1)
  })
})

describe('PUT /api/kanban/:id -- priority must be an allowed value', () => {
  const BAD: Array<[string, unknown]> = [
    ['null', null], ['empty string', ''], ['number', 5], ['true', true], ['array', []], ['object', {}], ['unknown word', 'bogus'], ['wrong case', 'High'],
  ]
  it.each(BAD)('priority %s -> 400 invalid_value, nothing written (admin and tenant caller, /api and /api/v1)', async (_name, priority) => {
    for (const [who, id] of [[ADMIN, 'c1'], [TENANT, 'tc1']] as const) {
      for (const prefix of ['/api', '/api/v1']) {
        const before = snapshot()
        const res = await put(id, { priority, description: 'must not land' }, who, prefix)
        expect(res.status).toBe(400)
        expect(res.body).toEqual({ error: 'invalid_value', field: 'priority', hint: PRIORITY_HINT })
        expect(snapshot()).toBe(before)
      }
    }
  })

  it.each(['low', 'normal', 'high', 'urgent'])('priority %s is a 200 and is stored', async (priority) => {
    expect((await put('c1', { priority })).status).toBe(200)
    expect(row('c1').priority).toBe(priority)
    expect((await put('tc1', { priority }, TENANT)).status).toBe(200)
    expect(row('tc1').priority).toBe(priority)
  })
})

describe('PUT /api/kanban/:id -- sort_order must be a finite number', () => {
  const BAD_RAW: Array<[string, string]> = [
    ['null', 'null'], ['empty string', '""'], ['a word', '"abc"'], ['a numeric string', '"5"'], ['true', 'true'], ['false', 'false'],
    ['array', '[]'], ['one-element array', '[1]'], ['object', '{}'], ['an exponent past the double range (parses to Infinity)', '1e999'],
  ]
  it.each(BAD_RAW)('sort_order %s -> 400 invalid_value, nothing written (admin and tenant caller, /api and /api/v1)', async (_name, raw) => {
    for (const [who, id] of [[ADMIN, 'c1'], [TENANT, 'tc1']] as const) {
      for (const prefix of ['/api', '/api/v1']) {
        const before = snapshot()
        const res = await call('PUT', `${prefix}/kanban/${id}`, `{"sort_order": ${raw}, "description": "must not land"}`, who)
        expect(res.status).toBe(400)
        expect(res.body).toEqual({ error: 'invalid_value', field: 'sort_order', hint: 'sort_order must be a finite number' })
        expect(snapshot()).toBe(before)
      }
    }
  })

  it.each([0, 1.5, -3, 1e308, -0.25])('sort_order %s is a 200 and is stored as that number', async (n) => {
    expect((await put('c1', { sort_order: n })).status).toBe(200)
    expect(row('c1').sort_order).toBe(n)
    expect(getDb().prepare("SELECT typeof(sort_order) AS t FROM kanban_cards WHERE id = 'c1'").get()).toEqual({ t: 'real' })
  })
})

describe('PUT /api/kanban/:id -- the order of the answers', () => {
  it('title -> status -> priority -> sort_order: when several are bad, the first in that order answers', async () => {
    const all = { title: '', status: 'bogus', priority: 'bogus', sort_order: 'x' }
    expect((await put('c1', all)).body).toMatchObject({ error: 'required', field: 'title' })
    expect((await put('c1', { ...all, title: 'ok' })).body).toMatchObject({ field: 'status' })
    expect((await put('c1', { ...all, title: 'ok', status: 'planned' })).body).toMatchObject({ field: 'priority' })
    expect((await put('c1', { ...all, title: 'ok', status: 'planned', priority: 'low' })).body).toMatchObject({ field: 'sort_order' })
  })

  it('a different status next to a bad priority is the use_move answer (status is looked at first)', async () => {
    expect((await put('c1', { status: 'done', priority: 'bogus' })).body).toMatchObject({ error: 'invalid_value', reason: 'use_move' })
  })

  it('the answers that were there before are still given first: due_date, a foreign parent_id, a non-string assignee, a malformed expected_updated_at', async () => {
    await createTenant('tenant-y', 'Tenant Y')
    await createKanbanCard({ id: 'foreign-parent', title: 'Foreign', tenant_id: 'tenant-y' })
    expect((await put('c1', { status: 'bogus', due_date: 'not-a-date' })).body).toMatchObject({ field: 'due_date' })
    expect((await put('tc1', { status: 'bogus', parent_id: 'foreign-parent' }, TENANT)).body).toMatchObject({ error: 'not_found', field: 'parent_id' })
    expect((await put('c1', { status: 'bogus', assignee: 5 })).body).toMatchObject({ field: 'assignee' })
    expect((await put('c1', { priority: 'bogus', expected_updated_at: 'x' })).body).toMatchObject({ field: 'expected_updated_at' })
  })

  it('a bad value next to a stale expected_updated_at is the 400, not a write and not the 409; a good value next to a stale one is still the 409', async () => {
    expect((await put('c1', { priority: 'bogus', expected_updated_at: 1 })).status).toBe(400)
    expect((await put('c1', { status: 'done', expected_updated_at: 1 })).body).toMatchObject({ error: 'invalid_value', reason: 'use_move' })
    expect((await put('c1', { priority: 'high', expected_updated_at: 1 })).status).toBe(409)
    expect(row('c1').priority).toBe('normal')
    const current = row('c1').updated_at as number
    expect((await put('c1', { priority: 'high', status: 'planned', sort_order: 2, expected_updated_at: current })).status).toBe(200)
    expect(row('c1')).toMatchObject({ priority: 'high', sort_order: 2 })
  })

  it('a foreign tenant card is a 404 whatever the status, priority and sort_order are (no probing by the answer)', async () => {
    for (const body of [{ status: 'bogus' }, { status: 'done' }, { priority: 'bogus' }, { sort_order: 'x' }]) {
      expect((await put('c1', body, TENANT)).status).toBe(404)
    }
  })
})

describe('POST /api/kanban -- the status and priority of a new card', () => {
  it.each([['status', ''], ['status', 'bogus'], ['status', 5], ['status', true], ['status', []], ['priority', ''], ['priority', 'bogus'], ['priority', 5], ['priority', false]])(
    '%s %j -> 400 invalid_value and no card is created',
    async (field, value) => {
      const before = snapshot()
      const res = await call('POST', '/api/kanban', JSON.stringify({ title: 'New', [field]: value }), ADMIN)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_value', field, hint: field === 'status' ? STATUS_HINT : PRIORITY_HINT })
      expect(snapshot()).toBe(before)
    },
  )

  it('a null status or priority is the default, as before: a planned, normal card', async () => {
    const res = await call('POST', '/api/kanban', JSON.stringify({ title: 'New', status: null, priority: null }), ADMIN)
    expect(res.status).toBe(200)
    expect(row(res.body.id)).toMatchObject({ status: 'planned', priority: 'normal' })
  })

  it('a new card may be born in any allowed status and priority', async () => {
    for (const status of ['planned', 'in_progress', 'waiting', 'testing', 'done']) {
      const res = await call('POST', '/api/kanban', JSON.stringify({ title: 'New', status, priority: 'urgent' }), ADMIN)
      expect(res.status).toBe(200)
      expect(row(res.body.id)).toMatchObject({ status, priority: 'urgent' })
    }
  })

  it('the title answer comes before the status answer', async () => {
    expect((await call('POST', '/api/kanban', JSON.stringify({ status: 'bogus' }), ADMIN)).body).toMatchObject({ error: 'required', field: 'title' })
  })
})

describe('the allowed sets are the ones of the schema CHECK', () => {
  const checkSet = (column: string): string[] => {
    const sql = (getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'kanban_cards'").get() as { sql: string }).sql
    const m = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql)
    expect(m, `no CHECK on ${column} in the schema`).not.toBeNull()
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
  }
  const hintSet = (hint: string): string[] => hint.replace('Allowed: ', '').split(', ').sort()

  it('status', async () => {
    const res = await put('c1', { status: 'bogus' })
    expect(hintSet(res.body.hint)).toEqual(checkSet('status'))
  })

  it('priority', async () => {
    const res = await put('c1', { priority: 'bogus' })
    expect(hintSet(res.body.hint)).toEqual(checkSet('priority'))
  })
})
