// POST /api/hooks/watchdog-facts (HANDOFF facts, the dedup baseline) and POST /api/hooks/watchdog-record (the hook's writes and the
// threshold in ONE round trip), served to the context watchdog hook in PG mode.
// Real in-memory SQLite (no mocks). The PostgreSQL side (the app role, the row-level isolation between tenants, the identity
// column as the card number) is src/__tests__/pg/hooks-watchdog-facts.pg.test.ts; the real Python hook against this real route
// is hooks-tenant-python-differential.test.ts (the context-watchdog cells). Neutral fixtures only (agent-a, agent-b).
//
// What these cells pin (each has a red a removed guard would give):
//   - the caller is the agent the TOKEN names; an agent_id in the body is ignored, and no token agent is a 403
//   - `want` is exactly handoff or prior_handoff (anything else, the retired `threshold` included, is 400, nothing read)
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

function call(body: unknown, tokenAgentId: string | undefined, method = 'POST', route = '/api/hooks/watchdog-facts') {
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
  const url = new URL('http://localhost:3420' + route)
  const ctx = { req, res, path: url.pathname, method, url, role: 'fleet_agent', tokenAgentId, tenantId: null } as unknown as RouteContext
  return { ctx, out }
}

async function ask(body: unknown, agent: string | null = 'agent-a', route = '/api/hooks/watchdog-facts') {
  const { ctx, out } = call(body, agent ?? undefined, 'POST', route)
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
const RECORD = '/api/hooks/watchdog-record'
// the threshold is answered by the record route (an empty request records nothing and still answers it)
const threshold = async (agent = 'agent-a') => ((await ask({}, agent, RECORD)).body as { threshold_tokens: number | null }).threshold_tokens

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
  it('refuses a token that names no agent (403), for every want and for the record route', async () => {
    for (const want of ['handoff', 'prior_handoff']) expect((await ask({ want, session_id: 's' }, null)).status, want).toBe(403)
    expect((await ask({}, null, RECORD)).status).toBe(403)
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
  it('only handoff and prior_handoff are accepted (anything else is 400 invalid_value, nothing is read)', async () => {
    for (const body of [{}, { want: '' }, { want: 'threshold' }, { want: 'THRESHOLD' }, { want: 'both' }, { want: 1 }, { want: null }, { want: ['handoff'] }, { want: { x: 1 } }]) {
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
    const { ctx } = call({ want: 'handoff' }, 'agent-a', 'GET')
    expect(await tryHandleHooksTenant(ctx)).toBe(false)
    const rec = call({}, 'agent-a', 'GET', RECORD)
    expect(await tryHandleHooksTenant(rec.ctx)).toBe(false)
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

// ---------------------------------------------------------------------------------------------------------------------------
// prior_handoff: the dedup baseline of the hook, the caller's OWN latest 'handoff' audit row of the session.
// ---------------------------------------------------------------------------------------------------------------------------
const audit = (agent: string, session: string, verdict: string, ts: number, reason: string, hash: string | null = 'h1') =>
  dbx.run("INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, reason, content_hash, session_id, trigger_source) VALUES (?, ?, 'PostToolUse', ?, ?, ?, ?, 'watchdog')", ts, agent, verdict, reason, hash, session)
const prior = async (session: unknown, agent: string | null = 'agent-a') => ask({ want: 'prior_handoff', session_id: session }, agent)

describe('prior_handoff', () => {
  it('is null when the caller has no handoff row for the session (an ANSWER of null, the hook then emits)', async () => {
    const out = await prior('s-1')
    expect(out.status).toBe(200)
    expect(out.body).toBeNull()
  })

  it('answers the caller\'s own latest handoff row of THAT session only: not another agent\'s, not another session\'s, not another verdict', async () => {
    await audit('agent-a', 's-1', 'handoff', 100, 'ctx=61%', 'old')
    await audit('agent-a', 's-1', 'handoff', 200, 'ctx=72%', 'new')
    await audit('agent-a', 's-1', 'allow', 300, 'ctx=99%', 'verdict')
    await audit('agent-a', 's-2', 'handoff', 400, 'ctx=80%', 'other-session')
    await audit('agent-b', 's-1', 'handoff', 500, 'ctx=90%', 'other-agent')
    expect((await prior('s-1')).body).toEqual({ ts: 200, reason: 'ctx=72%', content_hash: 'new' })
    expect((await prior('s-1', 'agent-b')).body).toEqual({ ts: 500, reason: 'ctx=90%', content_hash: 'other-agent' })
    expect((await prior('s-3')).body).toBeNull()
  })

  it('a session_id that is not a string of 1 to 200 characters is 400 invalid_value (nothing read)', async () => {
    for (const s of [undefined, null, '', 5, ['s'], 'x'.repeat(201), 'a\u0000b']) {
      const out = await prior(s)
      expect(out.status, String(s)).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'session_id' })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
// record: the hook's writes and the threshold in ONE round trip (system job `hook-watchdog-record`).
// ---------------------------------------------------------------------------------------------------------------------------
const NOW = Date.now()
const T = Math.floor(NOW / 1000) - 60
const usage = (over: Record<string, unknown> = {}) => ({
  session_id: 's-1', timestamp: T, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40,
  model: 'm-1', content_preview: 'hello', tool_name: 'Bash', ...over,
})
const span = (over: Record<string, unknown> = {}) => ({
  operation: 'model.call', trace_id: 's-1', span_id: 'sp-1', parent_span_id: null, start_ms: NOW - 2000, end_ms: NOW - 1000,
  status: 'ok', attributes: '{"model":"m-1"}', ...over,
})
interface Answer { threshold_tokens: number | null; usage: boolean; spans: number; dropped: number }
const record = async (body: unknown, agent: string | null = 'agent-a') => ask(body, agent, RECORD)
const recordOk = async (body: unknown, agent = 'agent-a') => {
  const out = await record(body, agent)
  expect(out.status).toBe(200)
  return out.body as Answer
}
const tenants = () => dbx.run("INSERT INTO tenants (id, display_name, created_at) VALUES ('t1', 'T1', 0), ('t2', 'T2', 0)")
const serve = (agent: string, ...ts: string[]) => Promise.all(ts.map((t) => dbx.run('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 1)', t, agent)))
const usageRows = () => dbx.all<{ agent: string; tenant_id: string | null; thinking_tokens: number; model: string | null }>('SELECT agent, tenant_id, thinking_tokens, model FROM token_usage ORDER BY id')
const spanRows = () => dbx.all<{ trace_id: string; span_id: string; agent_id: string; tenant_id: string | null; start_ms: number; end_ms: number; status: string; attributes: string | null; parent_span_id: string | null }>('SELECT trace_id, span_id, agent_id, tenant_id, start_ms, end_ms, status, attributes, parent_span_id FROM otel_spans ORDER BY span_id')

describe('record: the writes', () => {
  it('writes the usage row and the spans of the TOKEN agent, whatever the body names (agent, tenant, agent_id in an item)', async () => {
    const out = await recordOk({ agent_id: 'agent-b', agent: 'agent-b', tenant_id: 'evil', usage: usage({ agent: 'agent-b', agent_id: 'agent-b', tenant_id: 'evil' }), spans: [span({ agent_id: 'agent-b', tenant_id: 'evil' })], close_stale: null })
    expect(out).toMatchObject({ usage: true, spans: 1, dropped: 0 })
    expect(await usageRows()).toEqual([{ agent: 'agent-a', tenant_id: 'default', thinking_tokens: 0, model: 'm-1' }])
    expect(await spanRows()).toMatchObject([{ agent_id: 'agent-a', tenant_id: 'default', span_id: 'sp-1' }])
  })

  it('stamps the tenants SERVER-side with the two resolvers (they differ on purpose): usage by resolveAgentTenant, spans by resolveWriteTenant', async () => {
    await tenants()
    await serve('agent-one', 't1')
    await serve('agent-multi', 't1', 't2')
    for (const agent of ['agent-a', 'agent-one', 'agent-multi']) await recordOk({ usage: usage({ session_id: `s-${agent}` }), spans: [span({ trace_id: `s-${agent}`, span_id: `sp-${agent}` })] }, agent)
    const u = await dbx.all<{ agent: string; tenant_id: string | null }>('SELECT agent, tenant_id FROM token_usage ORDER BY agent')
    expect(u).toEqual([{ agent: 'agent-a', tenant_id: 'default' }, { agent: 'agent-multi', tenant_id: '_multi_' }, { agent: 'agent-one', tenant_id: 't1' }])
    const s = await dbx.all<{ agent_id: string; tenant_id: string | null }>('SELECT agent_id, tenant_id FROM otel_spans ORDER BY agent_id')
    // a shared agent with no fresh context: the span says "unknown" (NULL), it is not filed under a tenant
    expect(s).toEqual([{ agent_id: 'agent-a', tenant_id: 'default' }, { agent_id: 'agent-multi', tenant_id: null }, { agent_id: 'agent-one', tenant_id: 't1' }])
  })

  it('is idempotent: the same request twice leaves one usage row and one span', async () => {
    const body = { usage: usage(), spans: [span()] }
    await recordOk(body)
    const second = await recordOk(body)
    expect(second).toMatchObject({ usage: true, spans: 1, dropped: 0 })
    expect(await usageRows()).toHaveLength(1)
    expect(await spanRows()).toHaveLength(1)
  })

  it('collector then hook, and hook then collector, on the SAME transcript line leave ONE row (and neither writer turns the other\'s tenant into another)', async () => {
    const { recordTokenUsageCalls } = await import('../db/observability.js')
    const { resolveAgentTenant } = await import('../db/agents.js')
    await tenants()
    await serve('agent-multi', 't1', 't2')
    const line = { agent: 'agent-multi', sessionId: 's-1', timestamp: T, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, thinkingTokens: 7, model: null, contentPreview: 'hello', toolName: 'Bash' }
    const collect = async () => recordTokenUsageCalls([line], await resolveAgentTenant('agent-multi'), '/x.jsonl', 1, 1)
    await collect()
    await recordOk({ usage: usage() }, 'agent-multi')
    let rows = await usageRows()
    expect(rows).toEqual([{ agent: 'agent-multi', tenant_id: '_multi_', thinking_tokens: 7, model: 'm-1' }])
    await dbx.run('DELETE FROM token_usage')
    await recordOk({ usage: usage() }, 'agent-multi')
    await collect()
    rows = await usageRows()
    expect(rows).toEqual([{ agent: 'agent-multi', tenant_id: '_multi_', thinking_tokens: 7, model: 'm-1' }])
  })

  it('a second write refreshes end_ms, status and attributes only (start, parent and operation stay)', async () => {
    await recordOk({ spans: [span({ operation: 'agent.turn', span_id: 'turn-1', parent_span_id: null, start_ms: NOW - 5000, end_ms: NOW - 4000, status: 'running', attributes: null })] })
    await recordOk({ spans: [span({ operation: 'model.call', span_id: 'turn-1', parent_span_id: 'p', start_ms: NOW - 9000, end_ms: NOW - 100, status: 'ok', attributes: '{"a":1}' })] })
    expect(await spanRows()).toMatchObject([{ span_id: 'turn-1', start_ms: NOW - 5000, end_ms: NOW - 100, status: 'ok', attributes: '{"a":1}', parent_span_id: null }])
    const op = await dbx.get<{ operation: string }>("SELECT operation FROM otel_spans WHERE span_id = 'turn-1'")
    expect(op?.operation).toBe('agent.turn')
  })

  it('an agent that names ANOTHER agent\'s trace and span id cannot overwrite that span (refused, counted, threshold still answered)', async () => {
    await setting('agent-a', JSON.stringify({ thresholdTokens: 250000 }))
    await recordOk({ spans: [span({ end_ms: NOW - 1000, status: 'ok', attributes: '{"owner":"b"}' })] }, 'agent-b')
    const out = await recordOk({ spans: [span({ end_ms: NOW - 10, status: 'error', attributes: '{"owner":"a"}' })] }, 'agent-a')
    expect(out).toMatchObject({ spans: 0, dropped: 1, threshold_tokens: 250000 })
    expect(await spanRows()).toMatchObject([{ agent_id: 'agent-b', end_ms: NOW - 1000, status: 'ok', attributes: '{"owner":"b"}' }])
  })

  it('close_stale closes the OTHER running agent.turn spans of the trace, the caller\'s own only', async () => {
    const turn = (agent: string, id: string, status = 'running') => recordOk({ spans: [span({ operation: 'agent.turn', trace_id: 'trace-x', span_id: id, status })] }, agent)
    await turn('agent-a', 'old-a')
    await turn('agent-b', 'old-b')
    await turn('agent-a', 'keep-a')
    await turn('agent-a', 'done-a', 'ok')
    await recordOk({ close_stale: { trace_id: 'trace-x', keep_span_id: 'keep-a' } }, 'agent-a')
    const rows = await dbx.all<{ span_id: string; status: string }>('SELECT span_id, status FROM otel_spans ORDER BY span_id')
    expect(rows).toEqual([{ span_id: 'done-a', status: 'ok' }, { span_id: 'keep-a', status: 'running' }, { span_id: 'old-a', status: 'ok' }, { span_id: 'old-b', status: 'running' }])
  })

  it('close_stale closes the other running agent.turn spans ONLY: a running model.call of the same trace and agent stays open', async () => {
    const open = (operation: string, id: string) => recordOk({ spans: [span({ operation, trace_id: 'trace-y', span_id: id, status: 'running' })] }, 'agent-a')
    await open('agent.turn', 'old-turn')
    await open('model.call', 'running-model')
    await open('agent.turn', 'keep-turn')
    await recordOk({ close_stale: { trace_id: 'trace-y', keep_span_id: 'keep-turn' } }, 'agent-a')
    const rows = await dbx.all<{ span_id: string; status: string }>('SELECT span_id, status FROM otel_spans ORDER BY span_id')
    expect(rows).toEqual([{ span_id: 'keep-turn', status: 'running' }, { span_id: 'old-turn', status: 'ok' }, { span_id: 'running-model', status: 'running' }])
  })

  it('the attribute cap is BYTES, not characters: 2000 three-byte letters (6000 bytes) are dropped and counted, 1360 (4095 bytes) are kept', async () => {
    const json = (n: number) => JSON.stringify({ t: '€'.repeat(n) }) // the euro sign is 3 bytes in UTF-8
    const tooBig = json(2000)
    expect(tooBig.length).toBeLessThan(4096)                         // under the cap as CHARACTERS ...
    expect(Buffer.byteLength(tooBig, 'utf8')).toBeGreaterThan(4096)  // ... over it as bytes
    expect(await recordOk({ spans: [span({ span_id: 'wide', attributes: tooBig })] })).toMatchObject({ spans: 0, dropped: 1 })
    const fits = json(1360)
    expect(Buffer.byteLength(fits, 'utf8')).toBeLessThanOrEqual(4096)
    expect(await recordOk({ spans: [span({ span_id: 'narrow', attributes: fits })] })).toMatchObject({ spans: 1, dropped: 0 })
    expect((await spanRows()).map((r) => r.span_id)).toEqual(['narrow'])
  })

  it('an invalid item is dropped and counted, never poisons the batch, and the threshold is still answered', async () => {
    await setting('agent-a', JSON.stringify({ thresholdTokens: 300000 }))
    const bad = [
      span({ span_id: 'b1', operation: 'tool.call' }), span({ span_id: 'b2', status: 'weird' }), span({ span_id: 'b3', attributes: 'x'.repeat(4097) }),
      span({ span_id: 'w3c-b4' }), span({ span_id: 'b5', start_ms: NOW - 10, end_ms: NOW - 20 }), span({ span_id: 'b6', start_ms: 5 }),
      span({ span_id: 'b7', end_ms: NOW + 3 * 86_400_000 }), span({ span_id: '' }), 'text', null, [],
    ]
    const out = await recordOk({ usage: usage({ input_tokens: -1 }), spans: [bad[0], bad[1], bad[2], span({ span_id: 'good' })], close_stale: { trace_id: 5 } })
    expect(out).toMatchObject({ usage: false, spans: 1, dropped: 5, threshold_tokens: 300000 })
    for (const b of bad.slice(3)) expect((await recordOk({ spans: [b] })).dropped, JSON.stringify(b)).toBe(1)
    expect((await spanRows()).map((r) => r.span_id)).toEqual(['good'])
    expect(await usageRows()).toEqual([])
  })

  it('a usage item with an out of range or mistyped field is dropped (counted), the spans next to it are written', async () => {
    let n = 0
    for (const u of [usage({ timestamp: 5 }), usage({ timestamp: T + 3 * 86_400 }), usage({ output_tokens: 1.5 }), usage({ cache_read_tokens: '3' }), usage({ input_tokens: 2_000_000_001 }), usage({ session_id: '' }), usage({ model: 7 }), usage({ content_preview: 'x'.repeat(201) }), { session_id: 's-1' }]) {
      const out = await recordOk({ usage: u, spans: [span({ span_id: `s-${++n}` })] })
      expect(out, JSON.stringify(u)).toMatchObject({ usage: false, spans: 1, dropped: 1 })
    }
    expect(await usageRows()).toEqual([])
  })

  it('a write that fails is answered 200 with the flag false, counted and warned, and the threshold is STILL answered', async () => {
    const { getWatchdogRecordStats, resetWatchdogRecordStats } = await import('../db/hook-watchdog-record.js')
    const { vi } = await import('vitest')
    await setting('agent-a', JSON.stringify({ thresholdTokens: 123456 }))
    resetWatchdogRecordStats()
    const real = dbx.run.bind(dbx)
    const spy = vi.spyOn(dbx, 'run').mockImplementation(((sql: string, ...args: unknown[]) => {
      if (/INSERT INTO (token_usage|otel_spans)/.test(sql)) return Promise.reject(new Error('forced'))
      return real(sql, ...args)
    }) as typeof dbx.run)
    try {
      const out = await recordOk({ usage: usage(), spans: [span()], close_stale: null })
      expect(out).toEqual({ threshold_tokens: 123456, usage: false, spans: 0, dropped: 2 })
      expect(getWatchdogRecordStats().writeFailures).toBe(2)
    } finally {
      spy.mockRestore()
    }
    expect(await usageRows()).toEqual([])
  })
})

describe('record: the request and the caller', () => {
  it('structural errors are 400 (nothing written): usage, spans, close_stale of the wrong type, more than four spans', async () => {
    for (const body of [{ usage: [] }, { usage: 'x' }, { spans: {} }, { spans: 'x' }, { spans: [span(), span(), span(), span(), span()] }, { close_stale: [] }, { close_stale: 'x' }]) {
      const out = await record(body)
      expect(out.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value' })
    }
    expect(await usageRows()).toEqual([])
    expect(await spanRows()).toEqual([])
  })

  it('an empty body is a threshold-only call; four spans are accepted', async () => {
    expect(await recordOk({})).toEqual({ threshold_tokens: null, usage: false, spans: 0, dropped: 0 })
    const four = [1, 2, 3, 4].map((n) => span({ span_id: `sp-${n}` }))
    expect(await recordOk({ spans: four })).toMatchObject({ spans: 4, dropped: 0 })
  })

  it('a body that is not a JSON object is 400 parse_error; a token without an agent is 403 and nothing is written', async () => {
    for (const raw of ['not json', '[]', 'null', '']) {
      const { ctx, out } = call(raw, 'agent-a', 'POST', RECORD)
      expect(await tryHandleHooksTenant(ctx)).toBe(true)
      expect(out.status, raw).toBe(400)
    }
    expect((await record({ usage: usage(), spans: [span()] }, null)).status).toBe(403)
    expect(await usageRows()).toEqual([])
    expect(await spanRows()).toEqual([])
  })
})
