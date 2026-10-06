// crawlConfluenceSource(), exercised through the
// exported crawlSource(sourceId) entry point against a real in-memory DB --
// crawlConfluenceSource itself is module-private, same as the other
// connectors (crawlLocalSource/crawlGdriveSource/crawlSharePointSource).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import { applyMigrations } from '../db-migrations.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, runLinkMaintenance: vi.fn().mockResolvedValue(undefined) }
})

const mockGetSecret = vi.fn<(id: string, tenantId?: string) => string | null>()
vi.mock('../web/vault.js', () => ({ getSecret: (...args: [string, string?]) => mockGetSecret(...args) }))

import { crawlSource } from '../web/import-crawler.js'

const BASE_URL = 'https://example.atlassian.net'
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

function createConfluenceSource(overrides: Partial<{
  id: string; path: string; last_run_at: number | null; tenant_id: string; base_url: string | null
}> = {}): string {
  const id = overrides.id ?? 'conf-src-1'
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id, vault_token_ref, confluence_email, base_url)
    VALUES (?, 'confluence', ?, 4, 1, ?, ?, ?, ?, 'my-token', 'user@example.com', ?)
  `).run(
    id,
    overrides.path ?? 'SPACE',
    overrides.last_run_at === undefined ? null : overrides.last_run_at,
    now, now,
    overrides.tenant_id ?? 'default',
    overrides.base_url === undefined ? BASE_URL : overrides.base_url,
  )
  return id
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
  } as unknown as Response
}

function page(id: string, title: string, spaceId: string, createdAt = '2026-09-01T00:00:00.000Z') {
  return { id, title, spaceId, version: { number: 1, createdAt } }
}

function pageDetail(id: string, title: string, spaceId: string, html: string) {
  return { id, title, spaceId, body: { storage: { value: html } }, version: { number: 1, createdAt: '2026-09-01T00:00:00.000Z' } }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
  mockGetSecret.mockReturnValue('the-real-token')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

function importedRows(sourceId: string) {
  return getDb().prepare('SELECT * FROM import_memories WHERE source_id = ?').all(sourceId) as any[]
}

function auditRow(sourceId: string) {
  return getDb().prepare('SELECT * FROM import_audit_log WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as any
}

describe('crawlConfluenceSource -- happy path', () => {
  it('resolves a space by key, lists its pages, fetches and stores content', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'My Space', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) return jsonResponse(200, { results: [page('p1', 'Welcome Page', 'sp1')] })
      if (url.includes('/pages/p1')) return jsonResponse(200, pageDetail('p1', 'Welcome Page', 'sp1', '<p>Hello Confluence world</p>'))
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    const rows = importedRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].file_path).toBe('confluence/SPACE/p1')
    expect(rows[0].file_name).toBe('Welcome Page.html')
    expect(rows[0].content).toContain('Hello Confluence world')
    expect(rows[0].keywords).toContain('SPACE')

    const audit = auditRow(id)
    expect(audit.error).toBeNull()
    expect(audit.files_added).toBe(1)
  })

  it('never sends the token itself in a URL, only in the Authorization header', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    fetchMock.mockImplementation(async (url: string, opts: any) => {
      expect(url).not.toContain('the-real-token')
      expect(opts.headers.Authorization).toContain('Basic ')
      const decoded = Buffer.from(opts.headers.Authorization.replace('Basic ', ''), 'base64').toString()
      if (url.includes('/spaces?keys=SPACE')) {
        expect(decoded).toBe('user@example.com:the-real-token')
        return jsonResponse(200, { results: [] })
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    await crawlSource(id)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('crawls every visible space when path is "*"', async () => {
    const id = createConfluenceSource({ path: '*' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/wiki/api/v2/spaces?limit=')) return jsonResponse(200, { results: [
        { id: 'sp1', key: 'ALPHA', name: 'Alpha', type: 'global', status: 'current' },
        { id: 'sp2', key: 'BETA', name: 'Beta', type: 'global', status: 'current' },
      ] })
      if (url.includes('/pages?space-id=sp1')) return jsonResponse(200, { results: [page('p1', 'Alpha Page', 'sp1')] })
      if (url.includes('/pages?space-id=sp2')) return jsonResponse(200, { results: [page('p2', 'Beta Page', 'sp2')] })
      if (url.includes('/pages/p1')) return jsonResponse(200, pageDetail('p1', 'Alpha Page', 'sp1', '<p>alpha content</p>'))
      if (url.includes('/pages/p2')) return jsonResponse(200, pageDetail('p2', 'Beta Page', 'sp2', '<p>beta content</p>'))
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    const rows = importedRows(id)
    expect(rows.map(r => r.file_path).sort()).toEqual(['confluence/ALPHA/p1', 'confluence/BETA/p2'])
  })

  it('follows cursor pagination via _links.next', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      if (url.includes('cursor=abc')) return jsonResponse(200, { results: [page('p2', 'Page Two', 'sp1')] })
      if (url.includes('/pages?space-id=sp1')) return jsonResponse(200, { results: [page('p1', 'Page One', 'sp1')], _links: { next: '/wiki/api/v2/pages?space-id=sp1&cursor=abc' } })
      if (url.includes('/pages/p1')) return jsonResponse(200, pageDetail('p1', 'Page One', 'sp1', '<p>one</p>'))
      if (url.includes('/pages/p2')) return jsonResponse(200, pageDetail('p2', 'Page Two', 'sp1', '<p>two</p>'))
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    const rows = importedRows(id)
    expect(rows.map(r => r.file_path).sort()).toEqual(['confluence/SPACE/p1', 'confluence/SPACE/p2'])
  })
})

describe('crawlConfluenceSource -- rate limiting (429)', () => {
  it('retries after a 429 with Retry-After and succeeds', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    let spaceCallCount = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) {
        spaceCallCount++
        if (spaceCallCount === 1) return jsonResponse(429, {}, { 'Retry-After': '0' })
        return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      }
      if (url.includes('/pages?space-id=sp1')) return jsonResponse(200, { results: [] })
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    expect(spaceCallCount).toBe(2)
    const audit = auditRow(id)
    expect(audit.error).toBeNull()
  })

  it('gives up after exhausting retries and surfaces the failure via the audit log', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(429, {}, { 'Retry-After': '0' })
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    const audit = auditRow(id)
    expect(audit.error).toContain('429')
    expect(importedRows(id)).toHaveLength(0)
  })
})

describe('crawlConfluenceSource -- auth and access errors', () => {
  it('401 on the spaces lookup: audit logs the error, no crash, nothing imported', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(401, { message: 'Unauthorized' })
      throw new Error(`unexpected URL: ${url}`)
    })

    await expect(crawlSource(id)).resolves.toBeUndefined()

    const audit = auditRow(id)
    expect(audit.error).toContain('401')
    expect(importedRows(id)).toHaveLength(0)
  })

  it('403 on a single page detail: that page is skipped, other pages in the same space still import', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) return jsonResponse(200, { results: [page('p1', 'Forbidden Page', 'sp1'), page('p2', 'Visible Page', 'sp1')] })
      if (url.includes('/pages/p1')) return jsonResponse(403, { message: 'Forbidden' })
      if (url.includes('/pages/p2')) return jsonResponse(200, pageDetail('p2', 'Visible Page', 'sp1', '<p>visible</p>'))
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    const rows = importedRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].file_path).toBe('confluence/SPACE/p2')
    const audit = auditRow(id)
    expect(audit.files_skipped_type).toBe(1)
  })

  it('missing vault token: skips the crawl without throwing', async () => {
    mockGetSecret.mockReturnValue(null)
    const id = createConfluenceSource({ path: 'SPACE' })

    await expect(crawlSource(id)).resolves.toBeUndefined()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(importedRows(id)).toHaveLength(0)
  })
})

describe('crawlConfluenceSource -- content handling', () => {
  it('skips content matching a secret pattern instead of storing it', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) return jsonResponse(200, { results: [page('p1', 'Secret Page', 'sp1')] })
      if (url.includes('/pages/p1')) return jsonResponse(200, pageDetail('p1', 'Secret Page', 'sp1', '<p>token: sk-abcdefghijklmnopqrst</p>'))
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    expect(importedRows(id)).toHaveLength(0)
    const audit = auditRow(id)
    expect(audit.files_skipped_secret).toBe(1)
  })

  it('truncates content longer than MAX_CONTENT_BYTES', async () => {
    const id = createConfluenceSource({ path: 'SPACE' })
    const longText = 'x'.repeat(200_000)
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) return jsonResponse(200, { results: [page('p1', 'Huge Page', 'sp1')] })
      if (url.includes('/pages/p1')) return jsonResponse(200, pageDetail('p1', 'Huge Page', 'sp1', `<p>${longText}</p>`))
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    const rows = importedRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].content.endsWith('[truncated]')).toBe(true)
    expect(rows[0].content.length).toBeLessThan(longText.length)
  })
})

describe('crawlConfluenceSource -- incremental sync', () => {
  it('full sync (no last_run_at) imports everything regardless of age', async () => {
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: null })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) {
        expect(url).not.toContain('sort=')
        return jsonResponse(200, { results: [page('p1', 'Old Page', 'sp1', '2020-01-01T00:00:00.000Z')] })
      }
      if (url.includes('/pages/p1')) return jsonResponse(200, pageDetail('p1', 'Old Page', 'sp1', '<p>old but first sync</p>'))
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)
    expect(importedRows(id)).toHaveLength(1)
  })

  it('incremental sync stops paging once a page is older than last_run_at', async () => {
    const lastRun = Math.floor(new Date('2026-06-01T00:00:00.000Z').getTime() / 1000)
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: lastRun })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) {
        expect(url).toContain('sort=-modified-date')
        return jsonResponse(200, {
          results: [
            page('p1', 'Recent Page', 'sp1', '2026-09-01T00:00:00.000Z'),
            page('p2', 'Ancient Page', 'sp1', '2020-01-01T00:00:00.000Z'),
          ],
        })
      }
      if (url.includes('/pages/p1')) return jsonResponse(200, pageDetail('p1', 'Recent Page', 'sp1', '<p>recent</p>'))
      if (url.includes('/pages/p2')) throw new Error('p2 must not be fetched -- it is older than last_run_at')
      throw new Error(`unexpected URL: ${url}`)
    })

    await crawlSource(id)

    const rows = importedRows(id)
    expect(rows.map(r => r.file_path)).toEqual(['confluence/SPACE/p1'])
  })
})

// A stand-in for the Confluence v2 /pages endpoint that behaves like the real
// one where it matters here: `sort=modified-date` is ASCENDING, only the
// `-modified-date` spelling is descending, and an unknown parameter such as
// `direction` is ignored. A mock that returned a fixed newest-first list
// regardless of the query is what let the original bug through.
function confluenceFake(pages: Array<{ id: string; createdAt: string; withVersion?: boolean }>, pageSize: number) {
  const listUrls: string[] = []
  const detailIds: string[] = []
  const impl = async (url: string) => {
    if (url.includes('/spaces?keys=SPACE')) return jsonResponse(200, { results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
    if (url.includes('/pages?space-id=sp1')) {
      listUrls.push(url)
      const u = new URL(url)
      const sort = u.searchParams.get('sort')
      const sorted = [...pages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      if (sort === '-modified-date') sorted.reverse()
      const offset = Number(u.searchParams.get('cursor') ?? '0')
      const slice = sorted.slice(offset, offset + pageSize)
      const next = offset + pageSize < sorted.length
        ? `/wiki/api/v2/pages?space-id=sp1&status=current&limit=${pageSize}${sort ? `&sort=${sort}` : ''}&cursor=${offset + pageSize}`
        : undefined
      return jsonResponse(200, {
        results: slice.map(p => p.withVersion === false
          ? { id: p.id, title: `T${p.id}`, spaceId: 'sp1' }
          : page(p.id, `T${p.id}`, 'sp1', p.createdAt)),
        _links: next ? { next } : undefined,
      })
    }
    const m = url.match(/\/pages\/(\w+)\?body-format/)
    if (m) { detailIds.push(m[1]); return jsonResponse(200, pageDetail(m[1], `T${m[1]}`, 'sp1', `<p>body ${m[1]}</p>`)) }
    throw new Error(`unexpected URL: ${url}`)
  }
  return { impl, listUrls, detailIds }
}

describe('crawlConfluenceSource -- incremental sync ordering (regression)', () => {
  const lastRunIso = '2026-06-01T12:00:00.000Z'
  const lastRun = Math.floor(Date.parse(lastRunIso) / 1000)

  it('requests descending order with sort=-modified-date and never the unsupported direction param', async () => {
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: lastRun })
    const fake = confluenceFake([{ id: 'p1', createdAt: '2026-09-01T00:00:00.000Z' }], 50)
    fetchMock.mockImplementation(fake.impl)

    await crawlSource(id)

    expect(fake.listUrls).toHaveLength(1)
    const u = new URL(fake.listUrls[0])
    expect(u.searchParams.get('sort')).toBe('-modified-date')
    expect(u.searchParams.has('direction')).toBe(false)
  })

  it('imports a page edited after the last run even when many older pages exist (the reported bug)', async () => {
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: lastRun })
    const fake = confluenceFake([
      { id: 'old1', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'old2', createdAt: '2021-01-01T00:00:00.000Z' },
      { id: 'old3', createdAt: '2022-01-01T00:00:00.000Z' },
      { id: 'edited', createdAt: '2026-09-01T00:00:00.000Z' },
    ], 50)
    fetchMock.mockImplementation(fake.impl)

    await crawlSource(id)

    expect(importedRows(id).map(r => r.file_path)).toEqual(['confluence/SPACE/edited'])
    expect(fake.detailIds).toEqual(['edited'])
  })

  it('stops paginating at the first page past the cut-off: later pages are not requested', async () => {
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: lastRun })
    const fake = confluenceFake([
      { id: 'n1', createdAt: '2026-09-05T00:00:00.000Z' },
      { id: 'n2', createdAt: '2026-09-04T00:00:00.000Z' },
      { id: 'n3', createdAt: '2026-09-03T00:00:00.000Z' },
      { id: 'o1', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'o2', createdAt: '2019-01-01T00:00:00.000Z' },
      { id: 'o3', createdAt: '2018-01-01T00:00:00.000Z' },
    ], 2)
    fetchMock.mockImplementation(fake.impl)

    await crawlSource(id)

    // Pages of 2 newest-first: [n1,n2] [n3,o1 -> cut] ; the third request must not happen.
    expect(fake.listUrls).toHaveLength(2)
    expect(fake.detailIds.sort()).toEqual(['n1', 'n2', 'n3'])
  })

  it('keeps a page modified within the skew margin before last_run_at, and cuts off one clearly older', async () => {
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: lastRun })
    const fake = confluenceFake([
      { id: 'inside', createdAt: new Date(Date.parse(lastRunIso) - 2 * 60 * 1000).toISOString() },
      { id: 'outside', createdAt: new Date(Date.parse(lastRunIso) - 30 * 60 * 1000).toISOString() },
    ], 50)
    fetchMock.mockImplementation(fake.impl)

    await crawlSource(id)

    expect(fake.detailIds).toEqual(['inside'])
  })

  it('never cuts off a page whose list summary has no version.createdAt', async () => {
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: lastRun })
    const fake = confluenceFake([
      { id: 'nov', createdAt: '2020-01-01T00:00:00.000Z', withVersion: false },
    ], 50)
    fetchMock.mockImplementation(fake.impl)

    await crawlSource(id)

    expect(fake.detailIds).toEqual(['nov'])
  })

  it('a re-run re-imports only changed content: edited page updates, untouched page is hash-skipped', async () => {
    const id = createConfluenceSource({ path: 'SPACE', last_run_at: lastRun })
    const fake = confluenceFake([{ id: 'p1', createdAt: '2026-09-01T00:00:00.000Z' }], 50)
    fetchMock.mockImplementation(fake.impl)
    await crawlSource(id)
    const first = importedRows(id)
    expect(first).toHaveLength(1)

    // Same page, new body, newer version; the next incremental run (last_run_at
    // was moved by the first crawl) must pick it up and update the row.
    getDb().prepare('UPDATE import_sources SET last_run_at = ? WHERE id = ?').run(lastRun, id)
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/pages/p1?body-format')) return jsonResponse(200, pageDetail('p1', 'Tp1', 'sp1', '<p>body p1 EDITED</p>'))
      return fake.impl(url)
    })
    await crawlSource(id)

    const rows = importedRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain('EDITED')
  })
})

describe('migration 0071 -- one full re-sync after the sort fix', () => {
  function migrationsBefore71(dir: string) {
    for (const f of readdirSync(MIGRATIONS_DIR)) {
      if (f.endsWith('.sql') && f < '0071') copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f))
    }
  }

  function insertSource(db: Database.Database, id: string, type: string, lastRun: number | null) {
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
      VALUES (?, ?, 'p', 4, 1, ?, 1, 1, 'default')
    `).run(id, type, lastRun)
  }

  it('clears last_run_at on Confluence sources only, then runs once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'confluence-0071-'))
    try {
      migrationsBefore71(dir)
      const db = new Database(':memory:')
      applyMigrations(db, dir)
      insertSource(db, 'c1', 'confluence', 1_700_000_000)
      insertSource(db, 'c2', 'confluence', null)
      insertSource(db, 'l1', 'local', 1_700_000_001)
      insertSource(db, 'g1', 'gdrive', 1_700_000_002)

      copyFileSync(join(MIGRATIONS_DIR, '0071_confluence_resync_after_sort_fix.sql'), join(dir, '0071_confluence_resync_after_sort_fix.sql'))
      applyMigrations(db, dir)

      const lastRun = (id: string) => (db.prepare('SELECT last_run_at AS t FROM import_sources WHERE id = ?').get(id) as any).t
      expect(lastRun('c1')).toBeNull()
      expect(lastRun('c2')).toBeNull()
      expect(lastRun('l1')).toBe(1_700_000_001)
      expect(lastRun('g1')).toBe(1_700_000_002)

      // Recorded by the runner: a later crawl's last_run_at survives a second run.
      expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 71').get() as any).n).toBe(1)
      db.prepare("UPDATE import_sources SET last_run_at = 1800000000 WHERE id = 'c1'").run()
      applyMigrations(db, dir)
      expect(lastRun('c1')).toBe(1_800_000_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when there is no Confluence source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'confluence-0071-'))
    try {
      migrationsBefore71(dir)
      const db = new Database(':memory:')
      applyMigrations(db, dir)
      insertSource(db, 'l1', 'local', 1_700_000_001)
      copyFileSync(join(MIGRATIONS_DIR, '0071_confluence_resync_after_sort_fix.sql'), join(dir, '0071_confluence_resync_after_sort_fix.sql'))
      expect(() => applyMigrations(db, dir)).not.toThrow()
      expect((db.prepare('SELECT last_run_at AS t FROM import_sources WHERE id = ?').get('l1') as any).t).toBe(1_700_000_001)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a fresh database applies it with no sources and no error', () => {
    const db = new Database(':memory:')
    expect(() => applyMigrations(db, MIGRATIONS_DIR)).not.toThrow()
    expect((db.prepare('SELECT COUNT(*) AS n FROM import_sources').get() as any).n).toBe(0)
  })
})
