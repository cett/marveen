// Route + spool tests for the conversation ledger API. Real in-memory SQLite,
// no mocks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, db } from '../db.js'
import { tryHandleConversationLedger } from '../web/routes/conversation-ledger.js'
import { flushLedgerSpool } from '../conversation-ledger-spool.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function makeCtx(method: string, path: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => {
    ;(req as NodeJS.EventEmitter).emit('data', buf)
    ;(req as NodeJS.EventEmitter).emit('end')
  })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext,
    out,
  }
}

async function call(method: string, path: string, body?: unknown) {
  const { ctx, out } = makeCtx(method, path, body)
  const handled = await tryHandleConversationLedger(ctx)
  return { handled, ...out }
}

const inbound = (over: Record<string, unknown> = {}) => ({
  agent_id: 'agent-a', chat_id: '42', direction: 'in', message_id: '100', text: 'hello', ts: '2026-10-08T10:00:00Z', created_at: 1000, ...over,
})

describe('POST /api/conversation-ledger', () => {
  it('stores an inbound turn and ignores the same one a second time', async () => {
    const first = await call('POST', '/api/conversation-ledger', inbound())
    expect(first.body).toEqual({ ok: true, received: 1, inserted: 1 })
    const again = await call('POST', '/api/conversation-ledger', inbound())
    expect(again.body).toEqual({ ok: true, received: 1, inserted: 0 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversation_log').get() as { n: number }).n).toBe(1)
  })

  it('does not dedupe outbound rows without a message id', async () => {
    const out = { agent_id: 'agent-a', chat_id: '42', direction: 'out', text: 'reply', created_at: 2000 }
    await call('POST', '/api/conversation-ledger', out)
    await call('POST', '/api/conversation-ledger', out)
    expect((db.prepare("SELECT COUNT(*) AS n FROM conversation_log WHERE direction = 'out'").get() as { n: number }).n).toBe(2)
  })

  it('fills in an ISO ts for an outbound turn that has none', async () => {
    await call('POST', '/api/conversation-ledger', { agent_id: 'agent-a', chat_id: '42', direction: 'out', text: 'r', created_at: 1_700_000_000 })
    const row = db.prepare("SELECT ts FROM conversation_log WHERE direction = 'out'").get() as { ts: string }
    expect(row.ts).toBe('2023-11-14T22:13:20Z')
  })

  it('accepts a batch (the spool flush) and keeps the original created_at', async () => {
    const res = await call('POST', '/api/conversation-ledger', { entries: [inbound({ message_id: '1', created_at: 500 }), inbound({ message_id: '2', created_at: 600 })] })
    expect(res.body).toMatchObject({ received: 2, inserted: 2 })
    const rows = db.prepare('SELECT created_at FROM conversation_log ORDER BY id').all() as { created_at: number }[]
    expect(rows.map(r => r.created_at)).toEqual([500, 600])
  })

  it('rejects a bad entry as a whole, writing nothing', async () => {
    const res = await call('POST', '/api/conversation-ledger', { entries: [inbound(), inbound({ direction: 'sideways', message_id: '9' })] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_value')
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversation_log').get() as { n: number }).n).toBe(0)
  })

  it('rejects an unparseable body and an empty batch', async () => {
    expect((await call('POST', '/api/conversation-ledger', 'not json')).status).toBe(400)
    expect((await call('POST', '/api/conversation-ledger', { entries: [] })).status).toBe(400)
  })
})

describe('GET /api/conversation-ledger/:agent/recent', () => {
  it('returns the last turns oldest-first and only for that agent', async () => {
    for (let i = 1; i <= 5; i++) await call('POST', '/api/conversation-ledger', inbound({ message_id: String(i), text: `m${i}`, created_at: 1000 + i }))
    await call('POST', '/api/conversation-ledger', inbound({ agent_id: 'agent-b', text: 'other' }))
    const res = await call('GET', '/api/conversation-ledger/agent-a/recent?limit=3')
    expect(res.body.turns.map((t: { text: string }) => t.text)).toEqual(['m3', 'm4', 'm5'])
    expect(res.body.turns[0]).toEqual({ direction: 'in', chat_id: '42', text: 'm3', ts: '2026-10-08T10:00:00Z' })
  })

  it('validates the limit', async () => {
    expect((await call('GET', '/api/conversation-ledger/agent-a/recent?limit=0')).status).toBe(400)
    expect((await call('GET', '/api/conversation-ledger/agent-a/recent?limit=9999')).status).toBe(400)
  })
})

describe('GET /api/conversation-ledger/:agent/open-question', () => {
  it('is null when nothing was asked', async () => {
    expect((await call('GET', '/api/conversation-ledger/agent-a/open-question')).body).toEqual({ open_question: null })
  })

  it('returns the unanswered inbound, then null once a later outbound exists', async () => {
    await call('POST', '/api/conversation-ledger', inbound({ message_id: '1', text: 'first', created_at: 1000 }))
    await call('POST', '/api/conversation-ledger', inbound({ message_id: '2', text: 'second', created_at: 1010 }))
    const open = await call('GET', '/api/conversation-ledger/agent-a/open-question')
    expect(open.body.open_question).toEqual({ chat_id: '42', message_id: '2', text: 'second', ts: '2026-10-08T10:00:00Z', created_at: 1010 })
    await call('POST', '/api/conversation-ledger', { agent_id: 'agent-a', chat_id: '42', direction: 'out', message_id: '7', text: 'answer', created_at: 1020 })
    expect((await call('GET', '/api/conversation-ledger/agent-a/open-question')).body).toEqual({ open_question: null })
  })

  it('treats an outbound with the same second and a higher id as later', async () => {
    await call('POST', '/api/conversation-ledger', inbound({ created_at: 1000 }))
    await call('POST', '/api/conversation-ledger', { agent_id: 'agent-a', chat_id: '42', direction: 'out', text: 'a', created_at: 1000 })
    expect((await call('GET', '/api/conversation-ledger/agent-a/open-question')).body.open_question).toBeNull()
  })
})

describe('flushLedgerSpool', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-spool-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('inserts valid lines, skips junk, and removes the file', () => {
    writeFileSync(join(dir, 'agent-a.jsonl'), [
      JSON.stringify(inbound({ message_id: '1' })),
      'not json',
      JSON.stringify({ agent_id: 'agent-a', chat_id: '42', direction: 'sideways' }),
      JSON.stringify(inbound({ message_id: '2' })),
      '',
    ].join('\n'))
    expect(flushLedgerSpool(dir)).toBe(2)
    expect(readdirSync(dir)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversation_log').get() as { n: number }).n).toBe(2)
  })

  it('is a no-op for a missing directory and idempotent on replays', () => {
    expect(flushLedgerSpool(join(dir, 'missing'))).toBe(0)
    writeFileSync(join(dir, 'a.jsonl'), JSON.stringify(inbound()) + '\n')
    expect(flushLedgerSpool(dir)).toBe(1)
    writeFileSync(join(dir, 'a.jsonl'), JSON.stringify(inbound()) + '\n')
    expect(flushLedgerSpool(dir)).toBe(0)
    expect(existsSync(join(dir, 'a.jsonl'))).toBe(false)
  })
})
