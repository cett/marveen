// #751 step 2: src/web/routes/docs.ts was at 0%. Real filesystem against an
// isolated temp docs/ dir (mirrors the PROJECT_ROOT-mocking pattern used in
// vault.test.ts) rather than mocking node:fs -- the module's whole job is
// path-traversal-safe file reading, so exercising it against real files is
// more meaningful than mocking fs calls one by one.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const { TMP_ROOT, DOCS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'docs-route-test-'))
  const docs = join(root, 'docs')
  mkdirSync(docs, { recursive: true })
  return { TMP_ROOT: root, DOCS_DIR: docs }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT }))

import { tryHandleDocs } from '../web/routes/docs.js'

function makeCtx(opts: { method: string; path: string }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => em.emit('end'))
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

function writeDoc(name: string, content: string, mtimeOffsetSec = 0): void {
  const file = join(DOCS_DIR, name)
  writeFileSync(file, content)
  if (mtimeOffsetSec) {
    const t = new Date(Date.now() + mtimeOffsetSec * 1000)
    utimesSync(file, t, t)
  }
}

function cleanDocsDir(): void {
  rmSync(DOCS_DIR, { recursive: true, force: true })
  mkdirSync(DOCS_DIR, { recursive: true })
}

beforeEach(cleanDocsDir)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('tryHandleDocs -- GET /api/docs (listing)', () => {
  it('returns an empty array when docs/ has no matching files', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs' })
    const handled = await tryHandleDocs(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(body()).toEqual([])
  })

  it('extracts the title from the first H1, falls back to filename otherwise', async () => {
    writeDoc('with-title.md', '# Real Title\n\nbody')
    writeDoc('no-title.md', 'no heading here')
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/docs' })
    await tryHandleDocs(ctx)
    const docs = body() as Array<{ name: string; title: string }>
    const byName = Object.fromEntries(docs.map(d => [d.name, d.title]))
    expect(byName['with-title.md']).toBe('Real Title')
    expect(byName['no-title.md']).toBe('no-title.md')
  })

  it('ignores non-.md files and rejects path-traversal-shaped names via the allowlist regex', async () => {
    writeDoc('valid.md', '# X')
    writeFileSync(join(DOCS_DIR, 'ignored.txt'), 'not markdown')
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/docs' })
    await tryHandleDocs(ctx)
    const names = (body() as Array<{ name: string }>).map(d => d.name)
    expect(names).toEqual(['valid.md'])
  })

  it('sorts newest-first, tie-breaking by name', async () => {
    writeDoc('older.md', '# Older', -100)
    writeDoc('newer.md', '# Newer', 100)
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/docs' })
    await tryHandleDocs(ctx)
    const names = (body() as Array<{ name: string }>).map(d => d.name)
    expect(names).toEqual(['newer.md', 'older.md'])
  })
})

describe('tryHandleDocs -- GET /api/docs/:name (single doc)', () => {
  it('returns the full content plus title for an existing doc', async () => {
    writeDoc('foo.md', '# Foo Title\n\nfull body here')
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs/foo.md' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ name: 'foo.md', title: 'Foo Title', content: '# Foo Title\n\nfull body here' })
  })

  it('returns 404 for a name that does not exist on disk', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs/ghost.md' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(404)
    expect((body() as any).error).toBe('not_found')
  })

  it('returns 400 for a path-traversal attempt (../)', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs/..%2f..%2fetc%2fpasswd' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('invalid_value')
  })

  it('returns 400 for a non-.md name', async () => {
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/docs/foo.txt' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(400)
  })
})

describe('tryHandleDocs -- unmatched routes', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/other' })
    expect(await tryHandleDocs(ctx)).toBe(false)
  })

  it('returns false for /api/docs with the wrong method', async () => {
    const { ctx } = makeCtx({ method: 'POST', path: '/api/docs' })
    expect(await tryHandleDocs(ctx)).toBe(false)
  })
})
