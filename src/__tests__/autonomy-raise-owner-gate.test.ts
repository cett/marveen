// Raising an autonomy level (more freedom for the agents) needs a person logged in to the dashboard. An admin TOKEN,
// which the main agent and any agent with an admin-capable token carry, must not be able to widen its own freedom
// (skill_patch 2 -> 3 is autonomous skill patching without approval). Lowering and setting the same level stay on the
// token: tightening is cheap and has to work from an agent. Every level change leaves an audit row.
// The database is replaced by an in-memory row map (the route's read/write surface); the session check is a switch.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

interface Row { key: string; label: string; level: number; locked: number; max_level: number; timeout_minutes: number | null; human_only: number; updated_at: number; updated_by: string }
let rows: Map<string, Row>
let auditFails = false
const auditWrites: Array<Record<string, any>> = []
let loggedInOwner: { user: string } | null = null

vi.mock('../db.js', () => ({
  listAutonomyCategories: () => Array.from(rows.values()),
  getAutonomyCategory: (key: string) => { const r = rows.get(key); return r ? { ...r } : undefined },
  setAutonomyCategoryLevel: (key: string, level: number, by: string) => { const r = rows.get(key); if (r) { r.level = level; r.updated_by = by; r.updated_at = 1 } },
  setAutonomyCategoryTimeout: () => {},
  setAutonomyCategoryHumanOnly: () => {},
  writeAgentAuditLog: (entry: Record<string, any>) => { if (auditFails) throw new Error('audit down'); auditWrites.push(entry) },
}))
vi.mock('../web/approval-human-only.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/approval-human-only.js')>()),
  humanSessionOf: () => Promise.resolve(loggedInOwner),
}))

import { tryHandleAutonomy } from '../web/routes/autonomy.js'

const TOKEN = { role: 'admin', auth: { kind: 'token', tokenName: 'main-token' } } as Partial<RouteContext>
const SESSION = { role: 'admin', auth: { kind: 'session', user: 'owner' } } as Partial<RouteContext>

async function post(body: object, extras: Partial<RouteContext>) {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = 'POST'
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = { writeHead(s: number) { out.status = s }, end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } } } as any
  const url = new URL('http://localhost:3420/api/autonomy')
  await tryHandleAutonomy({ req, res, path: url.pathname, method: 'POST', url, ...extras } as RouteContext)
  return out
}

beforeEach(() => {
  loggedInOwner = null
  auditFails = false
  auditWrites.length = 0
  const mk = (key: string, level: number, extra: Partial<Row> = {}): [string, Row] => [key, { key, label: key, level, locked: 0, max_level: 3, timeout_minutes: null, human_only: 0, updated_at: 0, updated_by: 'system', ...extra }]
  rows = new Map([mk('skill_patch', 2), mk('capped', 2, { max_level: 2 }), mk('payment', 1, { locked: 1, max_level: 1 })])
})

describe('raising a level', () => {
  it('an admin token cannot: 403 human_session_required, and the stored level is unchanged, with no audit row', async () => {
    const out = await post({ key: 'skill_patch', level: 3 }, TOKEN)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ error: 'forbidden', code: 'human_session_required' })
    expect(rows.get('skill_patch')!.level).toBe(2)
    expect(auditWrites).toEqual([])
  })

  it('a person logged in can: 200, the level is stored, and one audit row names who, from and to', async () => {
    loggedInOwner = { user: 'owner' }
    const out = await post({ key: 'skill_patch', level: 3 }, SESSION)
    expect(out.status).toBe(200)
    expect(rows.get('skill_patch')!.level).toBe(3)
    expect(auditWrites).toHaveLength(1)
    expect(auditWrites[0]).toMatchObject({ agent_id: 'owner', entity: 'approval', action: 'update', entity_id: 'skill_patch', detail: { autonomy_category: 'skill_patch', level_from: 2, level_to: 3 } })
  })

  it('a session cookie of no admin (humanSessionOf says nobody) with a session-shaped auth is refused too', async () => {
    const out = await post({ key: 'skill_patch', level: 3 }, SESSION)
    expect(out.status).toBe(403)
    expect(rows.get('skill_patch')!.level).toBe(2)
  })

  it('a locked category stays refused with its own message, for a token and not the new one', async () => {
    const out = await post({ key: 'payment', level: 2 }, TOKEN)
    expect(out.status).toBe(403)
    expect(out.body.code).toBeUndefined()
    expect(out.body.hint).toMatch(/locked at level 1/)
  })

  it('past max_level is 400 for a person, the stored level is unchanged', async () => {
    loggedInOwner = { user: 'owner' }
    const out = await post({ key: 'capped', level: 3 }, SESSION)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'level' })
    expect(rows.get('capped')!.level).toBe(2)
  })

  it('level 4 and a non-number are 400 before any of this', async () => {
    loggedInOwner = { user: 'owner' }
    expect((await post({ key: 'skill_patch', level: 4 }, SESSION)).status).toBe(400)
    expect((await post({ key: 'skill_patch', level: '3' }, SESSION)).status).toBe(400)
    expect(rows.get('skill_patch')!.level).toBe(2)
  })
})

describe('lowering and the same level stay on the token', () => {
  it('lowering by a token: 200, stored, and audited with the token name', async () => {
    const out = await post({ key: 'skill_patch', level: 1 }, TOKEN)
    expect(out.status).toBe(200)
    expect(rows.get('skill_patch')!.level).toBe(1)
    expect(auditWrites).toHaveLength(1)
    expect(auditWrites[0]).toMatchObject({ agent_id: 'main-token', detail: { level_from: 2, level_to: 1 } })
  })

  it('the same level by a token: 200, nothing changes, no audit row', async () => {
    const out = await post({ key: 'skill_patch', level: 2 }, TOKEN)
    expect(out.status).toBe(200)
    expect(rows.get('skill_patch')!.level).toBe(2)
    expect(auditWrites).toEqual([])
  })

  it('an audit failure does not abort the change', async () => {
    auditFails = true
    const out = await post({ key: 'skill_patch', level: 1 }, TOKEN)
    expect(out.status).toBe(200)
    expect(rows.get('skill_patch')!.level).toBe(1)
  })
})
