// POST /api/hooks/watchdog-facts: the reads of the context watchdog hook (threshold, HANDOFF facts), served to the hook in PG mode.
// Real in-memory SQLite (no mocks). The PostgreSQL side (the app role, the row-level isolation between tenants, the identity
// column as the card number) is src/__tests__/pg/hooks-watchdog-facts.pg.test.ts; the real Python hook against this real route
// is hooks-tenant-python-differential.test.ts (the context-watchdog cells). Neutral fixtures only (agent-a, agent-b).
//
// What these cells pin (each has a red a removed guard would give):
//   - the caller is the agent the TOKEN names; an agent_id in the body is ignored, and no token agent is a 403
//   - `want` is exactly threshold or handoff (anything else 400, nothing read)
//   - the facts are the caller's own: its blackboard row, its open cards (assignee = caller, in_progress or waiting, not
//     archived), its own last outgoing message; the latest rows are the three newest
//   - the answer is bounded: LIMITs and string clips hold whatever a row holds
//   - the threshold is a positive integer or null (the hook decides the default)
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { dbx } from '../db/facade.js'
import { useTestDb } from './helpers/with-test-db.js'
import { tryHandleHooksTenant } from '../web/routes/hooks-tenant.js'
import { WATCHDOG_CARDS_LIMIT, WATCHDOG_LAST_OUT_MAX, WATCHDOG_RECENT_LIMIT, WATCHDOG_SUMMARY_MAX, WATCHDOG_TITLE_MAX } from '../db/hook-tenant-reads.js'
import type { RouteContext } from '../web/routes/types.js'

useTestDb()

function call(body: unknown, tokenAgentId: string | undefined, method = 'POST') {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420/api/hooks/watchdog-facts')
  const ctx = { req, res, path: url.pathname, method, url, role: 'fleet_agent', tokenAgentId, tenantId: null } as unknown as RouteContext
  return { ctx, out }
}

async function ask(body: unknown, agent: string | null = 'agent-a') {
  const { ctx, out } = call(body, agent ?? undefined)
  expect(await tryHandleHooksTenant(ctx)).toBe(true)
  return out
}

interface Facts {
  own: { task_ref: string | null; status: string; summary: string } | null
  recent: { agent_id: string; status: string; summary: string }[]
  cards: { number: number; title: string; status: string }[]
  last_outgoing: string | null
}
const handoff = async (agent = 'agent-a') => (await ask({ want: 'handoff' }, agent)).body as Facts
const threshold = async (agent = 'agent-a') => ((await ask({ want: 'threshold' }, agent)).body as { threshold_tokens: number | null }).threshold_tokens

let seq = 0
const bb = (agent: string, status: string, summary: string, updatedAt: number, taskRef: string | null = null) =>
  dbx.run('INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `bb-${++seq}`, agent, taskRef, status, summary, updatedAt)
const card = (title: string, status: string, assignee: string | null, updatedAt: number, archivedAt: number | null = null) =>
  dbx.run('INSERT INTO kanban_cards (id, title, status, assignee, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `kc-${++seq}`, title, status, assignee, updatedAt, updatedAt, archivedAt)
const msg = (from: string, content: string, createdAt: number) =>
  dbx.run("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, 'peer', ?, 'done', ?)", from, content, createdAt)
const setting = (agent: string, value: string) =>
  dbx.run("INSERT INTO agent_settings (agent_id, setting_key, setting_value, updated_at) VALUES (?, 'context_restart_gate', ?, 1)", agent, value)

beforeEach(() => { seq = 0 })

describe('who the caller is', () => {
  it('refuses a token that names no agent (403), for both wants', async () => {
    for (const want of ['threshold', 'handoff']) expect((await ask({ want }, null)).status, want).toBe(403)
  })

  it('ignores an agent_id in the body: the facts are the token agent\'s', async () => {
    await bb('agent-a', 'active', 'a work', 10)
    await bb('agent-b', 'active', 'b work', 20)
    await card('A card', 'in_progress', 'agent-a', 1)
    await card('B card', 'in_progress', 'agent-b', 2)
    await msg('agent-a', 'a said', 5)
    await msg('agent-b', 'b said', 6)
    const f = (await ask({ want: 'handoff', agent_id: 'agent-b' }, 'agent-a')).body as Facts
    expect(f.own?.summary).toBe('a work')
    expect(f.cards.map((c) => c.title)).toEqual(['A card'])
    expect(f.last_outgoing).toBe('a said')
  })
})

describe('want', () => {
  it('only threshold and handoff are accepted (anything else is 400 invalid_value, nothing is read)', async () => {
    for (const body of [{}, { want: '' }, { want: 'THRESHOLD' }, { want: 'both' }, { want: 1 }, { want: null }, { want: ['handoff'] }, { want: { x: 1 } }]) {
      const out = await ask(body)
      expect(out.status, JSON.stringify(body)).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'want' })
    }
  })

  it('a body that is not a JSON object is 400 parse_error', async () => {
    for (const raw of ['not json', '[]', 'null', '"handoff"', '']) {
      const { ctx, out } = call(raw, 'agent-a')
      expect(await tryHandleHooksTenant(ctx)).toBe(true)
      expect(out.status, raw).toBe(400)
    }
  })

  it('a GET (or any other method) is not the route', async () => {
    const { ctx } = call({ want: 'threshold' }, 'agent-a', 'GET')
    expect(await tryHandleHooksTenant(ctx)).toBe(false)
  })
})

describe('threshold', () => {
  it('is null when the agent has no row', async () => {
    expect(await threshold()).toBeNull()
  })

  it('is the positive number of thresholdTokens, as an integer', async () => {
    await setting('agent-a', JSON.stringify({ enabled: true, thresholdTokens: 250000 }))
    expect(await threshold()).toBe(250000)
  })

  it('truncates a fractional value and does not read another agent\'s row', async () => {
    await setting('agent-a', JSON.stringify({ thresholdTokens: 1234.9 }))
    await setting('agent-b', JSON.stringify({ thresholdTokens: 999 }))
    expect(await threshold('agent-a')).toBe(1234)
    expect(await threshold('agent-b')).toBe(999)
  })

  it('is null for every value the hook would not take: not JSON, no key, zero, negative, text, NaN-like, a list', async () => {
    for (const v of ['not json', '{}', '{"thresholdTokens":0}', '{"thresholdTokens":-1}', '{"thresholdTokens":"400000"}', '{"thresholdTokens":null}', '{"thresholdTokens":true}', '[1,2]', 'null', '"x"', '5']) {
      await dbx.run("DELETE FROM agent_settings WHERE agent_id = 'agent-a'")
      await setting('agent-a', v)
      expect(await threshold(), v).toBeNull()
    }
  })
})

describe('handoff facts', () => {
  it('is all empty for an agent with nothing', async () => {
    expect(await handoff()).toEqual({ own: null, recent: [], cards: [], last_outgoing: null })
  })

  it('carries the own row (task_ref null stays null), the three newest rows newest first, and the last outgoing message', async () => {
    await bb('agent-a', 'blocked', 'own summary', 100, 'ref-9')
    await bb('agent-b', 'active', 'b', 400)
    await bb('agent-c', 'done', 'c', 300)
    await bb('agent-d', 'stale', 'd', 200)
    await msg('agent-a', 'older', 10)
    await msg('agent-a', 'newest', 30)
    await msg('agent-a', 'middle', 20)
    const f = await handoff()
    expect(f.own).toEqual({ task_ref: 'ref-9', status: 'blocked', summary: 'own summary' })
    expect(f.recent.map((r) => r.agent_id)).toEqual(['agent-b', 'agent-c', 'agent-d'])
    expect(f.recent[0]).toEqual({ agent_id: 'agent-b', status: 'active', summary: 'b' })
    expect(f.last_outgoing).toBe('newest')
    await dbx.run("UPDATE fleet_blackboard SET task_ref = NULL WHERE agent_id = 'agent-a'")
    expect((await handoff()).own?.task_ref).toBeNull()
  })

  it('open cards: only the caller\'s, only in_progress or waiting, never archived, newest first, five at most, with the dashboard number', async () => {
    await card('c-in-progress', 'in_progress', 'agent-a', 50)
    await card('c-waiting', 'waiting', 'agent-a', 60)
    await card('c-planned', 'planned', 'agent-a', 70)
    await card('c-done', 'done', 'agent-a', 80)
    await card('c-testing', 'testing', 'agent-a', 85)
    await card('c-archived', 'in_progress', 'agent-a', 90, 1)
    await card('c-other-agent', 'in_progress', 'agent-b', 95)
    await card('c-unassigned', 'in_progress', null, 96)
    const f = await handoff()
    expect(f.cards.map((c) => c.title)).toEqual(['c-waiting', 'c-in-progress'])
    // the number is the rowid on SQLite (insertion order): c-in-progress was the first insert, c-waiting the second
    expect(f.cards.map((c) => c.number)).toEqual([2, 1])
    expect(f.cards.every((c) => Number.isInteger(c.number))).toBe(true)
  })

  it('is bounded: the LIMITs and the clips hold whatever a row holds', async () => {
    const long = 'x'.repeat(5000)
    // the table caps a summary at 500 characters (a CHECK), so the 600 clip is a second line the table never reaches: the row
    // at the cap must come back whole
    const cap = 'y'.repeat(500)
    await bb('agent-a', 'active', cap, 1)
    for (let i = 0; i < 6; i++) await bb(`agent-${i}`, 'active', cap, 10 + i)
    for (let i = 0; i < 8; i++) await card(long, 'in_progress', 'agent-a', i)
    await msg('agent-a', long, 1)
    const f = await handoff()
    expect(f.own?.summary.length).toBe(500)
    expect(WATCHDOG_SUMMARY_MAX).toBeGreaterThanOrEqual(500)
    expect(f.recent).toHaveLength(WATCHDOG_RECENT_LIMIT)
    expect(f.recent.every((r) => r.summary.length === 500)).toBe(true)
    expect(f.cards).toHaveLength(WATCHDOG_CARDS_LIMIT)
    expect(f.cards.every((c) => c.title.length === WATCHDOG_TITLE_MAX)).toBe(true)
    expect(f.last_outgoing?.length).toBe(WATCHDOG_LAST_OUT_MAX)
  })

  it('the clips equal the hook\'s own constants (a drift would make the two disagree about a long row)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const py = readFileSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'context-watchdog.py'), 'utf-8')
    expect(py).toContain(`HANDOFF_SUMMARY_MAX_CHARS = ${WATCHDOG_SUMMARY_MAX}`)
    expect(py).toContain(`[:${WATCHDOG_LAST_OUT_MAX}]`)
  })
})
