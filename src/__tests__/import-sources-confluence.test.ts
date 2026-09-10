// Confluence source-type validation for POST/PUT /api/import/sources
// (kanban 21d27a8c ST2): required base_url/vault_token_ref/confluence_email,
// and the token-must-already-exist-in-the-vault precondition. Other source
// types (local/gdrive/sharepoint) are covered by import-memories.test.ts and
// are deliberately not re-tested here.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, getDb } from '../db.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('../web/import-crawler.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/import-crawler.js')>()
  return { ...orig, crawlSource: vi.fn().mockResolvedValue(undefined) }
})

const mockGetSecret = vi.fn<(id: string, tenantId?: string) => string | null>()
vi.mock('../web/vault.js', () => ({ getSecret: (...args: [string, string?]) => mockGetSecret(...args) }))

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
  mockGetSecret.mockReturnValue(null)
})

function makeCtx(
  method: string,
  path: string,
  body?: object,
  opts: { role?: string; tenantId?: string | null } = {},
): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
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
    ctx: { req, res, path: url.pathname, method, url, role: opts.role ?? 'admin', tenantId: opts.tenantId } as unknown as RouteContext,
    out,
  }
}

import { tryHandleImportMemories } from '../web/routes/import-memories.js'

const VALID_CONFLUENCE_FIELDS = {
  type: 'confluence', path: 'SPACE',
  vault_token_ref: 'my-token', confluence_email: 'user@example.com',
  base_url: 'https://example.atlassian.net',
}

describe('POST /api/import/sources -- confluence validation', () => {
  it('rejects a confluence source missing vault_token_ref', async () => {
    const { vault_token_ref: _omit, ...rest } = VALID_CONFLUENCE_FIELDS
    const { ctx, out } = makeCtx('POST', '/api/import/sources', rest)
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).error).toBe('required')
    expect((out.body as any).field).toBe('vault_token_ref')
  })

  it('rejects a confluence source missing confluence_email', async () => {
    const { confluence_email: _omit, ...rest } = VALID_CONFLUENCE_FIELDS
    const { ctx, out } = makeCtx('POST', '/api/import/sources', rest)
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).error).toBe('required')
    expect((out.body as any).field).toBe('confluence_email')
  })

  it('rejects a confluence source missing base_url', async () => {
    const { base_url: _omit, ...rest } = VALID_CONFLUENCE_FIELDS
    const { ctx, out } = makeCtx('POST', '/api/import/sources', rest)
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).error).toBe('required')
    expect((out.body as any).field).toBe('base_url')
  })

  it('rejects a confluence source with a malformed base_url', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { ...VALID_CONFLUENCE_FIELDS, base_url: 'not-a-url' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).field).toBe('base_url')
  })

  it('409s when vault_token_ref does not resolve to a stored secret', async () => {
    mockGetSecret.mockReturnValue(null)
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { ...VALID_CONFLUENCE_FIELDS, vault_token_ref: 'missing-token' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(409)
    expect((out.body as any).error).toBe('conflict')
    expect((out.body as any).field).toBe('vault_token_ref')
    expect(mockGetSecret).toHaveBeenCalledWith('missing-token', 'default')
  })

  it('creates the source when the token exists in the vault, base_url trailing slash stripped', async () => {
    mockGetSecret.mockReturnValue('FIXTURE-TOKEN-real-value-000')
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { ...VALID_CONFLUENCE_FIELDS, base_url: 'https://example.atlassian.net/' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    const row = getDb().prepare("SELECT * FROM import_sources WHERE id = ?").get((out.body as any).id) as any
    expect(row.type).toBe('confluence')
    expect(row.vault_token_ref).toBe('my-token')
    expect(row.confluence_email).toBe('user@example.com')
    expect(row.base_url).toBe('https://example.atlassian.net')
  })

  it('never logs or echoes the actual token value back in the response', async () => {
    mockGetSecret.mockReturnValue('FIXTURE-TOKEN-do-not-leak-999')
    const { ctx, out } = makeCtx('POST', '/api/import/sources', VALID_CONFLUENCE_FIELDS)
    await tryHandleImportMemories(ctx)
    expect(JSON.stringify(out.body)).not.toContain('FIXTURE-TOKEN-do-not-leak-999')
  })

  it('does not require vault_token_ref/confluence_email/base_url for non-confluence types', async () => {
    const { ctx, out } = makeCtx('POST', '/api/import/sources', { type: 'local', path: '/tmp/whatever' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(mockGetSecret).not.toHaveBeenCalled()
  })
})

describe('PUT /api/import/sources/:id -- confluence validation', () => {
  function seedConfluenceSource(overrides: Partial<{ vault_token_ref: string | null; confluence_email: string | null; base_url: string | null; enabled: number; tenant_id: string }> = {}): string {
    const id = 'src-conf-1'
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`
      INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id, vault_token_ref, confluence_email, base_url)
      VALUES (?, 'confluence', 'SPACE', NULL, 4, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      overrides.enabled ?? 1,
      now, now,
      overrides.tenant_id ?? 'default',
      overrides.vault_token_ref === undefined ? 'my-token' : overrides.vault_token_ref,
      overrides.confluence_email === undefined ? 'user@example.com' : overrides.confluence_email,
      overrides.base_url === undefined ? 'https://example.atlassian.net' : overrides.base_url,
    )
    return id
  }

  it('allows updating unrelated fields (label) without re-checking the vault', async () => {
    const id = seedConfluenceSource()
    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { label: 'New label' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(mockGetSecret).not.toHaveBeenCalled()
  })

  it('re-validates the token when re-enabling a disabled confluence source', async () => {
    const id = seedConfluenceSource({ enabled: 0 })
    mockGetSecret.mockReturnValue(null)
    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { enabled: true })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(409)
    expect((out.body as any).field).toBe('vault_token_ref')
  })

  it('allows re-enabling once the token exists', async () => {
    const id = seedConfluenceSource({ enabled: 0 })
    mockGetSecret.mockReturnValue('FIXTURE-TOKEN-real-111')
    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { enabled: true })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    const row = getDb().prepare("SELECT enabled FROM import_sources WHERE id = ?").get(id) as any
    expect(row.enabled).toBe(1)
  })

  it('re-validates when changing vault_token_ref on an enabled source', async () => {
    const id = seedConfluenceSource({ enabled: 1 })
    mockGetSecret.mockReturnValue(null)
    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { vault_token_ref: 'rotated-token' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(409)
    expect(mockGetSecret).toHaveBeenCalledWith('rotated-token', 'default')
  })

  it('rejects setting an empty base_url on an enabled confluence source', async () => {
    const id = seedConfluenceSource({ enabled: 1 })
    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { base_url: '' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).field).toBe('base_url')
    expect(mockGetSecret).not.toHaveBeenCalled()
  })

  it('rejects a malformed base_url on PUT', async () => {
    const id = seedConfluenceSource({ enabled: 1 })
    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { base_url: 'not-a-url' })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).field).toBe('base_url')
  })

  it('disabling a confluence source never triggers a vault check', async () => {
    const id = seedConfluenceSource({ enabled: 1 })
    const { ctx, out } = makeCtx('PUT', `/api/import/sources/${id}`, { enabled: false })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(mockGetSecret).not.toHaveBeenCalled()
  })

  it('updating a non-confluence source never triggers a vault check', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`
      INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
      VALUES ('src-local-1', 'local', '/tmp', NULL, 4, 1, NULL, ?, ?, 'default')
    `).run(now, now)
    const { ctx, out } = makeCtx('PUT', '/api/import/sources/src-local-1', { enabled: true })
    await tryHandleImportMemories(ctx)
    expect(out.status).toBe(200)
    expect(mockGetSecret).not.toHaveBeenCalled()
  })
})
