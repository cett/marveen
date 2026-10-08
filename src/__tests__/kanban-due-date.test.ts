// kanban_cards.due_date is an integer epoch (or null). The db layer normalises a calendar date and
// refuses the rest; the routes turn the refusal into a 400.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, db, createKanbanCard, updateKanbanCard, parseKanbanDueDate } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const stored = (id: string) => db.prepare('SELECT due_date, typeof(due_date) AS t FROM kanban_cards WHERE id = ?').get(id) as { due_date: number | null; t: string }

describe('parseKanbanDueDate', () => {
  it('accepts integer epochs, digit strings, valid dates, null and the empty string', () => {
    expect(parseKanbanDueDate(1790812800)).toBe(1790812800)
    expect(parseKanbanDueDate('1790812800')).toBe(1790812800)
    expect(parseKanbanDueDate('2026-07-15')).toBe(1784073600)
    expect(parseKanbanDueDate(null)).toBeNull()
    expect(parseKanbanDueDate('')).toBeNull()
    expect(parseKanbanDueDate(0)).toBe(0)
  })

  it('rejects everything else', () => {
    for (const bad of [1.5, -1, NaN, 'next week', '2026-13-01', '2026-02-30', '15/07/2026', {}, [], true, '2026-07-15T10:00:00Z']) {
      expect(parseKanbanDueDate(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('the db layer', () => {
  it('stores a date string as the UTC-midnight epoch on create and on update', () => {
    createKanbanCard({ id: 'c1', title: 't', due_date: '2026-07-15' })
    expect(stored('c1')).toEqual({ due_date: 1784073600, t: 'integer' })
    expect(updateKanbanCard('c1', { due_date: '2026-10-29' as unknown as number })).toBe(true)
    expect(stored('c1').due_date).toBe(1793232000)
    expect(updateKanbanCard('c1', { due_date: null })).toBe(true)
    expect(stored('c1').t).toBe('null')
  })

  it('throws on an invalid value instead of writing it', () => {
    expect(() => createKanbanCard({ id: 'c2', title: 't', due_date: 'tomorrow' })).toThrow(/due_date/)
    createKanbanCard({ id: 'c3', title: 't' })
    expect(() => updateKanbanCard('c3', { due_date: 'soon' as unknown as number })).toThrow(/due_date/)
    expect(stored('c3').t).toBe('null')
  })
})

describe('the routes', () => {
  async function call(method: string, path: string, body: unknown) {
    const buf = Buffer.from(JSON.stringify(body))
    const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
    req.method = method
    req.headers = {}
    setImmediate(() => { ;(req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
    const out = { status: 200, body: null as any }
    const res = {
      writeHead(s: number) { out.status = s },
      setHeader() {},
      end(b?: string | Buffer) { if (b) out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString() : b) },
    }
    const url = new URL(`http://localhost:3420${path}`)
    const ctx = { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext
    expect(await tryHandleKanban(ctx)).toBe(true)
    return out
  }

  it('POST and PUT refuse a bad due_date with 400 and accept a date', async () => {
    const bad = await call('POST', '/api/kanban', { title: 'x', due_date: 'next friday' })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'invalid_value', field: 'due_date' })
    const ok = await call('POST', '/api/kanban', { title: 'x', due_date: '2026-07-15' })
    expect(ok.status).toBe(200)
    const id = ok.body.id as string
    expect(stored(id).due_date).toBe(1784073600)
    expect((await call('PUT', `/api/kanban/${id}`, { due_date: 'soon' })).status).toBe(400)
    expect(stored(id).due_date).toBe(1784073600)
    expect((await call('PUT', `/api/kanban/${id}`, { due_date: 1790812800 })).status).toBe(200)
    expect(stored(id).due_date).toBe(1790812800)
  })
})
