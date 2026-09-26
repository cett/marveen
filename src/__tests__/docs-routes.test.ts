// docs/ HTTP viewer (revived from a docs.ts route retired in an earlier docs cleanup, adapted to the
// nested user-guide/fork-guide layout). Real filesystem against an isolated
// temp docs/ dir (mirrors the PROJECT_ROOT-mocking pattern used in vault.test.ts)
// rather than mocking node:fs -- the module's whole job is path-traversal-safe
// file reading, so exercising it against real files is more meaningful than
// mocking fs calls one by one.
//
// Auth/RBAC gating itself is NOT re-tested here -- it happens upstream of this
// handler (requiresAuth + applyRbacGate in web.ts, see auth-gate.test.ts's
// "gates the docs viewer" case and authz.test.ts's session/viewer case). This
// file only exercises tryHandleDocs's own path-allowlist + containment guard
// and its 200/400/404 responses.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
  for (const tree of ['user-guide', 'fork-guide']) {
    for (const lang of ['hu', 'en']) {
      mkdirSync(join(docs, tree, lang), { recursive: true })
    }
  }
  return { TMP_ROOT: root, DOCS_DIR: docs }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT }))

import { tryHandleDocs, DOC_PATH_PATTERN } from '../web/routes/docs.js'

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
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'session', user: 'tenant-user' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

function cleanDocsDir(): void {
  rmSync(DOCS_DIR, { recursive: true, force: true })
  for (const tree of ['user-guide', 'fork-guide']) {
    for (const lang of ['hu', 'en']) {
      mkdirSync(join(DOCS_DIR, tree, lang), { recursive: true })
    }
  }
}

beforeEach(cleanDocsDir)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('DOC_PATH_PATTERN allowlist', () => {
  it('accepts user-guide/{hu,en}/<slug>.md and fork-guide/{hu,en}/<slug>.md', () => {
    expect(DOC_PATH_PATTERN.test('user-guide/en/01-overview.md')).toBe(true)
    expect(DOC_PATH_PATTERN.test('user-guide/hu/01-attekintes.md')).toBe(true)
    // fork-guide chapters carry an uppercase F prefix (F01-installation.md) --
    // the pattern's mixed-case class must accept these too.
    expect(DOC_PATH_PATTERN.test('fork-guide/en/F01-installation.md')).toBe(true)
    expect(DOC_PATH_PATTERN.test('fork-guide/hu/F01-telepites.md')).toBe(true)
  })

  it('rejects other languages, missing extension, a flat/rootless path, and traversal-shaped values', () => {
    expect(DOC_PATH_PATTERN.test('user-guide/de/01-overview.md')).toBe(false)
    expect(DOC_PATH_PATTERN.test('user-guide/en/01-overview')).toBe(false)
    expect(DOC_PATH_PATTERN.test('fork-guide/F01-installation.md')).toBe(false) // missing lang dir
    expect(DOC_PATH_PATTERN.test('user-guide/en/../../etc/passwd')).toBe(false)
    expect(DOC_PATH_PATTERN.test('../fork-guide/en/F01-installation.md')).toBe(false)
    expect(DOC_PATH_PATTERN.test('api-deprecation-policy.md')).toBe(false)
  })
})

describe('tryHandleDocs -- GET /api/docs/<path>', () => {
  it('returns the raw content for an existing user-guide doc', async () => {
    writeFileSync(join(DOCS_DIR, 'user-guide', 'en', '01-overview.md'), '# Overview\n\nbody text')
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs/user-guide/en/01-overview.md' })
    const handled = await tryHandleDocs(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(body()).toEqual({ path: 'user-guide/en/01-overview.md', content: '# Overview\n\nbody text' })
  })

  it('returns the raw content for an existing fork-guide doc (uppercase F-prefixed slug)', async () => {
    writeFileSync(join(DOCS_DIR, 'fork-guide', 'en', 'F01-installation.md'), '# Installation')
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs/fork-guide/en/F01-installation.md' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ path: 'fork-guide/en/F01-installation.md', content: '# Installation' })
  })

  it('returns 404 for a path that matches the allowlist but does not exist on disk', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs/user-guide/en/99-ghost.md' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(404)
    expect((body() as any).error).toBe('not_found')
  })

  it('returns 400 for a path-traversal attempt (encoded ../)', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/docs/user-guide%2f..%2f..%2fetc%2fpasswd' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('invalid_value')
  })

  it('returns 400 for a flat docs/ root file (old-style path, no longer allowlisted)', async () => {
    writeFileSync(join(DOCS_DIR, 'api-deprecation-policy.md'), '# Policy')
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/docs/api-deprecation-policy.md' })
    await tryHandleDocs(ctx)
    expect(status()).toBe(400)
  })

  it('returns 400 for a disallowed language directory', async () => {
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/docs/user-guide/de/01-overview.md' })
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
    const { ctx } = makeCtx({ method: 'POST', path: '/api/docs/user-guide/en/01-overview.md' })
    expect(await tryHandleDocs(ctx)).toBe(false)
  })
})
