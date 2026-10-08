// The intel registry store and its /api/intel/* routes, against a real
// throwaway database file (INTEL_DB). Covers what the former CLI test covered
// (schema bootstrap, deterministic ids, upsert vs duplicate, secondary
// writers, dump lifecycle filtering) plus the request validation the routes add.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { closeIntelDb, makeFactId } from '../intel-store.js'
import { tryHandleIntel } from '../web/routes/intel.js'
import type { RouteContext } from '../web/routes/types.js'

let dir: string
let dbFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intel-store-'))
  dbFile = join(dir, 'intel.db')
  process.env['INTEL_DB'] = dbFile
  closeIntelDb()
})

afterEach(() => {
  closeIntelDb()
  delete process.env['INTEL_DB']
  rmSync(dir, { recursive: true, force: true })
})

function call(method: string, path: string, body?: unknown, query = ''): Promise<{ handled: boolean; status: number; body: any }> {
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
  const url = new URL(`http://localhost:3420${path}${query}`)
  const ctx = { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext
  return tryHandleIntel(ctx).then((handled) => ({ handled, status: out.status, body: out.body }))
}

const fact = (over: Record<string, unknown> = {}) => ({
  title: 'T1', domain: 'market', source: 'src', source_tier: 2, content: 'price moved 5%', ...over,
})

/** Direct reads of the file, the way the old CLI test inspected it. */
function raw<T = unknown>(sql: string): T[] {
  const d = new Database(dbFile, { readonly: true })
  try { return d.prepare(sql).all() as T[] } finally { d.close() }
}

describe('/api/intel schema bootstrap', () => {
  it('does not create the file until something asks for it', () => {
    expect(existsSync(dbFile)).toBe(false)
  })

  it('init creates the file owner-only with all four tables, and is idempotent', async () => {
    const first = await call('POST', '/api/intel/init')
    expect(first.body).toMatchObject({ ok: true, db_path: dbFile })
    await call('POST', '/api/intel/init')
    const tables = raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
    for (const t of ['known_facts_registry', 'watchlist', 'decision_log', 'active_focus']) expect(tables).toContain(t)
    expect(statSync(dbFile).mode & 0o777).toBe(0o600)
  })

  it('does not handle other paths or methods', async () => {
    expect((await call('GET', '/api/intel/nope')).handled).toBe(false)
    expect((await call('GET', '/api/other')).handled).toBe(false)
    expect((await call('GET', '/api/intel/facts')).handled).toBe(false)
  })
})

describe('facts', () => {
  it('derives a <domain>-<YYYYMMDD>-<hash8> id when none is given', async () => {
    const r = await call('POST', '/api/intel/facts', fact())
    expect(r.body.ok).toBe(true)
    expect(r.body.duplicate).toBe(false)
    expect(r.body.id).toBe(makeFactId('market', 'price moved 5%'))
    expect(r.body.id).toMatch(/^market-\d{8}-[0-9a-f]{8}$/)
  })

  it('matches the ids the Python helper produced (sha256 of the UTF-8 content, first 8 hex)', () => {
    // Digests computed independently with hashlib.
    expect(makeFactId('market', 'price moved 5%', new Date(2026, 9, 8))).toBe('market-20261008-044b3fa0')
    expect(makeFactId('hu', 'árvíztűrő tükörfúrógép', new Date(2026, 0, 2))).toBe('hu-20260102-8f78453b')
  })

  it('the same content again updates in place instead of adding a row', async () => {
    const a = await call('POST', '/api/intel/facts', fact())
    const b = await call('POST', '/api/intel/facts', fact({ title: 'T1b', status: 'evolving' }))
    expect(b.body.id).toBe(a.body.id)
    const rows = raw<{ id: string; status: string; title: string }>('SELECT id, status, title FROM known_facts_registry')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'evolving', title: 'T1b' })
  })

  it('the same content under a different id is a reported no-op, not an error', async () => {
    await call('POST', '/api/intel/facts', fact())
    const dup = await call('POST', '/api/intel/facts', fact({ id: 'other-id', title: 'T1c' }))
    expect(dup.status).toBe(200)
    expect(dup.body).toMatchObject({ ok: true, duplicate: true, id: 'other-id' })
    expect(raw('SELECT id FROM known_facts_registry')).toHaveLength(1)
  })

  it('updating a fact to content another fact already holds is also a no-op', async () => {
    await call('POST', '/api/intel/facts', fact({ id: 'a', content: 'one' }))
    await call('POST', '/api/intel/facts', fact({ id: 'b', content: 'two' }))
    const r = await call('POST', '/api/intel/facts', fact({ id: 'b', content: 'one' }))
    expect(r.body.duplicate).toBe(true)
    expect(raw<{ content: string }>("SELECT content FROM known_facts_registry WHERE id='b'")[0]!.content).toBe('two')
  })

  it('clamps the priority into 0..1', async () => {
    await call('POST', '/api/intel/facts', fact({ id: 'hi', content: 'c1', priority_score: 7 }))
    await call('POST', '/api/intel/facts', fact({ id: 'lo', content: 'c2', priority_score: -3 }))
    const rows = raw<{ id: string; priority_score: number }>('SELECT id, priority_score FROM known_facts_registry ORDER BY id')
    expect(rows).toEqual([{ id: 'hi', priority_score: 1 }, { id: 'lo', priority_score: 0 }])
  })

  it.each([
    ['title', { title: '' }],
    ['domain', { domain: undefined }],
    ['source', { source: '   ' }],
    ['content', { content: undefined }],
    ['source_tier', { source_tier: 4 }],
    ['source_tier', { source_tier: '2' }],
    ['status', { status: 'bogus' }],
    ['priority_score', { priority_score: 'high' }],
    ['id', { id: 5 }],
  ])('rejects a bad %s', async (field, over) => {
    const r = await call('POST', '/api/intel/facts', fact(over))
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_value', field })
    expect(existsSync(dbFile) ? raw('SELECT id FROM known_facts_registry') : []).toHaveLength(0)
  })

  it('rejects a body that is not a JSON object', async () => {
    expect((await call('POST', '/api/intel/facts', '{nope')).status).toBe(400)
    expect((await call('POST', '/api/intel/facts', '[1]')).status).toBe(400)
  })
})

describe('secondary writers', () => {
  it('watchlist, focus and decisions each write one row and return the id', async () => {
    const w = await call('POST', '/api/intel/watchlist', { title: 'raw material price', domain: 'market', direction: 'upward' })
    const f = await call('POST', '/api/intel/focus', { topic: 'Q3 sourcing', mode: 'deep', days: 30 })
    const d = await call('POST', '/api/intel/decisions', { recommendation: 'hold', reasoning: 'band intact' })
    for (const r of [w, f, d]) expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(raw('SELECT id FROM watchlist')).toHaveLength(1)
    expect(raw('SELECT id FROM decision_log')).toHaveLength(1)
    const focus = raw<{ mode: string; expires_at: number; started_at: number }>('SELECT * FROM active_focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.mode).toBe('deep')
    expect(focus[0]!.expires_at - focus[0]!.started_at).toBe(30 * 86400)
  })

  it('a focus without days never expires; a transient mode is the default', async () => {
    await call('POST', '/api/intel/focus', { topic: 'open ended' })
    const row = raw<{ mode: string; expires_at: number | null }>('SELECT mode, expires_at FROM active_focus')[0]!
    expect(row).toEqual({ mode: 'transient', expires_at: null })
  })

  it('validates the required fields and enums', async () => {
    expect((await call('POST', '/api/intel/watchlist', { title: 'x', domain: 'y' })).body.field).toBe('direction')
    expect((await call('POST', '/api/intel/focus', { topic: 'x', mode: 'forever' })).body.field).toBe('mode')
    expect((await call('POST', '/api/intel/focus', { topic: 'x', days: 'soon' })).body.field).toBe('days')
    expect((await call('POST', '/api/intel/decisions', { recommendation: 'x' })).body.field).toBe('reasoning')
  })
})

describe('dump', () => {
  it('returns registry, watchlist and active focus', async () => {
    const f = await call('POST', '/api/intel/facts', fact())
    await call('POST', '/api/intel/watchlist', { title: 'w', domain: 'market', direction: 'up' })
    await call('POST', '/api/intel/focus', { topic: 'f', days: 5 })
    const r = await call('GET', '/api/intel/dump')
    expect(r.status).toBe(200)
    expect(r.body.registry).toHaveLength(1)
    expect(r.body.registry[0].id).toBe(f.body.id)
    expect(r.body.watchlist).toHaveLength(1)
    expect(r.body.active_focus).toHaveLength(1)
    expect(r.body.db_path).toBe(dbFile)
  })

  it('drops closed facts and expired focus', async () => {
    await call('POST', '/api/intel/facts', fact({ status: 'closed' }))
    await call('POST', '/api/intel/focus', { topic: 'f', days: 5 })
    const d = new Database(dbFile)
    d.prepare('UPDATE active_focus SET expires_at = 1').run()
    d.close()
    const r = await call('GET', '/api/intel/dump')
    expect(r.body.registry).toEqual([])
    expect(r.body.active_focus).toEqual([])
  })

  it('honours the days window on updated_at', async () => {
    await call('POST', '/api/intel/facts', fact())
    const d = new Database(dbFile)
    d.prepare('UPDATE known_facts_registry SET updated_at = updated_at - ?').run(10 * 86400)
    d.close()
    expect((await call('GET', '/api/intel/dump', undefined, '?days=14')).body.registry).toHaveLength(1)
    expect((await call('GET', '/api/intel/dump', undefined, '?days=5')).body.registry).toHaveLength(0)
  })

  it('orders the registry by priority, then recency', async () => {
    await call('POST', '/api/intel/facts', fact({ id: 'low', content: 'a', priority_score: 0.2 }))
    await call('POST', '/api/intel/facts', fact({ id: 'high', content: 'b', priority_score: 0.9 }))
    const ids = (await call('GET', '/api/intel/dump')).body.registry.map((r: { id: string }) => r.id)
    expect(ids).toEqual(['high', 'low'])
  })

  it('rejects a days value that is not a sensible number', async () => {
    for (const q of ['?days=abc', '?days=-1', '?days=99999']) {
      const r = await call('GET', '/api/intel/dump', undefined, q)
      expect(r.status).toBe(400)
      expect(r.body.field).toBe('days')
    }
  })
})
