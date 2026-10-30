// The HTTP layer of the blank-content guard: POST /api/memories, PUT /api/memories/:id and
// POST /api/memories/import. memories-content-not-blank.test.ts covers the helper, the db functions and the
// triggers; a route guard weakened back to `content.trim() === ''` stayed green there (a text of U+200B passes
// trim()), and updateMemory would then throw BlankContentError, which no route catches. These tests call the real
// route handlers on an in-memory database, with the characters built from code points.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getDb } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

const ZWSP = String.fromCodePoint(0x200b)
const ZWJ = String.fromCodePoint(0x200d)
const BOM = String.fromCodePoint(0xfeff)
const SHY = String.fromCodePoint(0x00ad)
const WORD_JOINER = String.fromCodePoint(0x2060)
const NBSP = String.fromCodePoint(0x00a0)

// One entry per kind of blank the guard has to know: empty, plain whitespace, and the invisible characters that
// String.prototype.trim does not strip.
const BLANKS: [string, string][] = [
  ['empty', ''],
  ['spaces', '   '],
  ['tab and newlines', '\t\n\r\n'],
  ['no-break space', NBSP],
  ['zero width space', ZWSP],
  ['zero width mix with a newline', `${ZWSP}${ZWJ}${BOM}\n`],
  ['soft hyphen', SHY],
  ['word joiner', WORD_JOINER],
]

function makeCtx(method: string, path: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext, out }
}

const count = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n
const contentOf = (id: number): string => (getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }).content

function seed(content: string): number {
  return (getDb().prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, tenant_id)
     VALUES ('0', NULL, ?, 'semantic', 1.0, 1000, 1000, 'agent-a', 'warm', 0, 'kw', 'default') RETURNING id`,
  ).get(content) as { id: number }).id
}

beforeAll(() => { initDatabase(':memory:') })

beforeEach(() => {
  getDb().prepare('DELETE FROM memories').run()
  // The import route asks Ollama to categorise a chunk; with the call failing it falls back to a plain save, which
  // is what these tests need and keeps them off the network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test') }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('POST /api/memories', () => {
  it.each(BLANKS)('refuses %s with 400 required and writes nothing', async (_name, blank) => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'agent-a', content: blank, category: 'warm' })
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'content' })
    expect(count()).toBe(0)
  })

  it.each([['a number', 5], ['null', null], ['an object', { a: 1 }]])('refuses %s as content with 400', async (_name, content) => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'agent-a', content, category: 'warm' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(400)
    expect(count()).toBe(0)
  })

  it('refuses a body with no content key', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'agent-a', category: 'warm' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(400)
    expect(count()).toBe(0)
  })

  it('control: a text with visible characters is saved', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'agent-a', content: `${ZWSP}kávé${ZWSP}`, category: 'warm' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(count()).toBe(1)
  })
})

describe('PUT /api/memories/:id', () => {
  it.each(BLANKS)('refuses %s with 400 and the stored text stays', async (_name, blank) => {
    const id = seed('the original text')
    const { ctx, out } = makeCtx('PUT', `/api/memories/${id}`, { content: blank })
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'content' })
    expect(contentOf(id)).toBe('the original text')
  })

  it.each([['a number', 5], ['null', null]])('refuses %s as content with 400', async (_name, content) => {
    const id = seed('the original text')
    const { ctx, out } = makeCtx('PUT', `/api/memories/${id}`, { content })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(400)
    expect(contentOf(id)).toBe('the original text')
  })

  it('refuses a body with no content key', async () => {
    const id = seed('the original text')
    const { ctx, out } = makeCtx('PUT', `/api/memories/${id}`, { category: 'cold' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(400)
    expect(contentOf(id)).toBe('the original text')
  })

  it('control: a text with visible characters replaces the stored one', async () => {
    const id = seed('the original text')
    const { ctx, out } = makeCtx('PUT', `/api/memories/${id}`, { content: 'the new text' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(contentOf(id)).toBe('the new text')
  })
})

describe('POST /api/memories/import', () => {
  it('drops the blank chunks, saves the rest and reports how many it dropped', async () => {
    const chunks = ['first real chunk', ZWSP, '   ', '', 7, null, `${BOM}\n`, 'second real chunk']
    const { ctx, out } = makeCtx('POST', '/api/memories/import', { agent_id: 'agent-a', chunks })
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.imported).toBe(2)
    expect(out.body.skipped_blank).toBe(6)
    expect(count()).toBe(2)
  })

  it('answers 400 when every chunk is blank, and writes nothing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/import', { agent_id: 'agent-a', chunks: [ZWSP, '  ', ''] })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'chunks' })
    expect(count()).toBe(0)
  })

  it.each([['an empty array', []], ['not an array', 'text'], ['a missing key', undefined]])('answers 400 for %s', async (_name, chunks) => {
    const { ctx, out } = makeCtx('POST', '/api/memories/import', { agent_id: 'agent-a', chunks })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(400)
    expect(count()).toBe(0)
  })

  it('reports skipped_blank 0 when nothing was dropped', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/import', { agent_id: 'agent-a', chunks: ['only a real chunk'] })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ imported: 1, skipped_blank: 0 })
  })
})
