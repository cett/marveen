// The import crawler reads the due sources in its own `system` context, across tenants. What belongs to ONE source and is a
// write of its tenant (the import rows and their shadow memories, the source's run stamp) and the vault read run in a block
// of the source's tenant (runAsItemTenant). The audit row of a run and the global reads stay in the job's context. These
// cells run the real crawler on a real test database and record the db context every writer sees.
//
// Fixtures are neutral: tenants `tenant-a` / `tenant-b`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbx, runAs, getDbContextStats, currentDbContext } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

type Seen = { fn: string; role?: string; tenantId?: string; name?: string; first?: unknown }
const seen: Seen[] = []
const note = (fn: string, first?: unknown): void => {
  const ctx = currentDbContext()
  seen.push({ fn, role: ctx?.role, tenantId: ctx?.tenantId, name: ctx?.name, first })
}
const secretState: { value: string | null } = { value: null }

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../web/vault.js', () => ({
  getSecret: (ref: string) => { note('getSecret', ref); return secretState.value },
}))
vi.mock('../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db.js')>()
  const spy = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => { note(name, a[0]); return fn(...a) }
  return {
    ...real,
    upsertImportMemory: spy('upsertImportMemory', real.upsertImportMemory),
    markImportSourceRun: spy('markImportSourceRun', real.markImportSourceRun),
    insertImportAuditLog: spy('insertImportAuditLog', real.insertImportAuditLog),
    sumImportContentSize: spy('sumImportContentSize', real.sumImportContentSize),
    listEnabledImportSources: spy('listEnabledImportSources', real.listEnabledImportSources),
    getImportSource: spy('getImportSource', real.getImportSource),
    runLinkMaintenance: spy('runLinkMaintenance', () => Promise.resolve()),
  }
})

import { crawlSource, runDueImports } from '../web/import-crawler.js'

const writers = (fn: string) => seen.filter((s) => s.fn === fn)
const where = (s: Seen) => `${s.role}:${s.tenantId ?? '-'}`

async function createSource(id: string, tenantId: string, path: string, extra: { type?: string; baseUrl?: string; ref?: string; email?: string } = {}): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id, base_url, vault_token_ref, confluence_email)
    VALUES (?, ?, ?, 4, 1, NULL, ?, ?, ?, ?, ?, ?)
  `, id, extra.type ?? 'local', path, now, now, tenantId, extra.baseUrl ?? null, extra.ref ?? null, extra.email ?? null)
}
const lastRun = async (id: string): Promise<number | null> => (await dbx.get<{ last_run_at: number | null }>('SELECT last_run_at FROM import_sources WHERE id = ?', id))!.last_run_at
async function waitForRun(id: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if ((await lastRun(id)) !== null) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`the crawl of ${id} never finished`)
}
const job = <T>(fn: () => T): T => runAs.system('import-crawler', fn, { inheritTrace: false })

describe('import crawler: the writes of a source run in the tenant of that source', () => {
  let dirA: string
  let dirB: string
  useTestDb()

  beforeEach(() => {
    seen.length = 0
    secretState.value = null
    dirA = mkdtempSync(join(tmpdir(), 'import-block-a-'))
    dirB = mkdtempSync(join(tmpdir(), 'import-block-b-'))
    writeFileSync(join(dirA, 'note-a.txt'), 'budget notes of the first tenant')
    writeFileSync(join(dirB, 'note-b.txt'), 'roadmap notes of the second tenant')
  })
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  })

  it('two due sources of two tenants, through the scheduler: each import write and run stamp carries its own tenant, the global parts are system, no escalation', async () => {
    await createSource('src-a', 'tenant-a', dirA)
    await createSource('src-b', 'tenant-b', dirB)
    await job(() => runDueImports())
    await waitForRun('src-a')
    await waitForRun('src-b')

    const upserts = writers('upsertImportMemory')
    expect(upserts).toHaveLength(2)
    // by source: the first argument is the source id
    expect(Object.fromEntries(upserts.map((s) => [s.first, where(s)]))).toEqual({ 'src-a': 'tenant:tenant-a', 'src-b': 'tenant:tenant-b' })
    expect(Object.fromEntries(writers('markImportSourceRun').map((s) => [s.first, where(s)]))).toEqual({ 'src-a': 'tenant:tenant-a', 'src-b': 'tenant:tenant-b' })
    // the audit row names the tenant of its source, so it is a write of that tenant: it runs in the source's block
    expect(Object.fromEntries(writers('insertImportAuditLog').map((s) => [s.first, where(s)]))).toEqual({ 'src-a': 'tenant:tenant-a', 'src-b': 'tenant:tenant-b' })
    // the scheduler read, the source lookup and the global size read stay in the job's own context
    for (const fn of ['listEnabledImportSources', 'getImportSource', 'sumImportContentSize']) {
      expect(writers(fn).length, fn).toBeGreaterThan(0)
      for (const s of writers(fn)) expect([where(s), s.name], fn).toEqual(['system:-', 'import-crawler'])
    }
    // the rows really landed with their tenant
    const rows = await dbx.all<{ source_id: string; tenant_id: string }>('SELECT source_id, tenant_id FROM import_memories ORDER BY source_id')
    expect(rows).toEqual([{ source_id: 'src-a', tenant_id: 'tenant-a' }, { source_id: 'src-b', tenant_id: 'tenant-b' }])
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('the block carries no job name: the write is a tenant context, not the job context with a tenant', async () => {
    await createSource('src-a', 'tenant-a', dirA)
    await job(() => crawlSource('src-a'))
    const up = writers('upsertImportMemory')[0]
    expect(up.name).toBeUndefined()
    expect(up.role).toBe('tenant')
  })

  it('a crawl started by a route in a tenant or an admin context opens the block of the SOURCE tenant and is no escalation', async () => {
    await createSource('src-a', 'tenant-a', dirA)
    await createSource('src-b', 'tenant-b', dirB)
    await runAs.tenant('tenant-a', () => crawlSource('src-a'))
    await runAs.admin('http-admin', () => crawlSource('src-b'))
    expect(Object.fromEntries(writers('upsertImportMemory').map((s) => [s.first, where(s)]))).toEqual({ 'src-a': 'tenant:tenant-a', 'src-b': 'tenant:tenant-b' })
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('the vault read of a confluence source runs in the tenant of the source, and a missing secret ends the crawl without a write', async () => {
    await createSource('conf-a', 'tenant-a', '-', { type: 'confluence', baseUrl: 'https://wiki.example.invalid', ref: 'vault-ref-a', email: 'user@example.invalid' })
    await createSource('conf-b', 'tenant-b', '-', { type: 'confluence', baseUrl: 'https://wiki.example.invalid', ref: 'vault-ref-b', email: 'user@example.invalid' })
    await job(() => crawlSource('conf-a'))
    await job(() => crawlSource('conf-b'))
    expect(writers('getSecret').map((s) => [s.first, where(s)])).toEqual([['vault-ref-a', 'tenant:tenant-a'], ['vault-ref-b', 'tenant:tenant-b']])
    expect(writers('upsertImportMemory')).toEqual([])
    expect(Object.fromEntries(writers('markImportSourceRun').map((s) => [s.first, where(s)]))).toEqual({ 'conf-a': 'tenant:tenant-a', 'conf-b': 'tenant:tenant-b' })
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('a confluence page is stored in the tenant block of its source (the second upsert site), after the vault read in the same block', async () => {
    const json = (body: unknown): Promise<Response> => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) } as unknown as Response)
    vi.stubGlobal('fetch', vi.fn((url: string): Promise<Response> => {
      if (url.includes('/spaces?keys=SPACE')) return json({ results: [{ id: 'sp1', key: 'SPACE', name: 'Space', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) return json({ results: [{ id: 'p1', title: 'Page', spaceId: 'sp1', version: { number: 1, createdAt: '2026-09-01T00:00:00.000Z' } }] })
      if (url.includes('/pages/p1')) return json({ id: 'p1', title: 'Page', spaceId: 'sp1', body: { storage: { value: '<p>wiki text of the first tenant</p>' } }, version: { number: 1, createdAt: '2026-09-01T00:00:00.000Z' } })
      return Promise.reject(new Error(`unexpected URL: ${url}`))
    }))
    try {
      secretState.value = 'token-value'
      await createSource('conf-a', 'tenant-a', 'SPACE', { type: 'confluence', baseUrl: 'https://wiki.example.invalid', ref: 'vault-ref-a', email: 'user@example.invalid' })
      await job(() => crawlSource('conf-a'))
    } finally {
      vi.unstubAllGlobals()
    }
    expect(writers('getSecret').map(where)).toEqual(['tenant:tenant-a'])
    expect(writers('upsertImportMemory').map((s) => [s.first, where(s)])).toEqual([['conf-a', 'tenant:tenant-a']])
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('the audit row of a run carries the tenant of its source (the column default would stamp `default`)', async () => {
    await createSource('src-a', 'tenant-a', dirA)
    await createSource('src-b', 'tenant-b', dirB)
    await job(() => crawlSource('src-a'))
    await job(() => crawlSource('src-b'))
    const rows = await dbx.all<{ source_id: string; tenant_id: string }>('SELECT source_id, tenant_id FROM import_audit_log ORDER BY source_id')
    expect(rows).toEqual([{ source_id: 'src-a', tenant_id: 'tenant-a' }, { source_id: 'src-b', tenant_id: 'tenant-b' }])
  })

  // The error branch of crawlSource writes its own audit row (the catch): a failing crawl of tenant-b must leave a row with
  // tenant-b, written in the block of tenant-b, not a row the column default stamps `default`.
  it('the audit row of a FAILING crawl carries the tenant of its source and is written in its block', async () => {
    // a confluence source whose server is unreachable: the crawl throws and the catch branch writes the row
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))))
    try {
      secretState.value = 'token-value'
      await createSource('err-b', 'tenant-b', 'SPACE', { type: 'confluence', baseUrl: 'https://wiki.example.invalid', ref: 'vault-ref-b', email: 'user@example.invalid' })
      await job(() => crawlSource('err-b'))
    } finally {
      vi.unstubAllGlobals()
    }
    const rows = await dbx.all<{ source_id: string; tenant_id: string; error: string | null }>('SELECT source_id, tenant_id, error FROM import_audit_log')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source_id: 'err-b', tenant_id: 'tenant-b' })
    expect(rows[0]!.error).toBeTruthy()
    expect(writers('insertImportAuditLog').map((s) => [s.first, where(s)])).toEqual([['err-b', 'tenant:tenant-b']])
  })

  it('a source without a tenant is skipped and counted: no read of its content, no write, no run stamp, and the other source still crawls', async () => {
    await createSource('src-none', '', dirA)
    await createSource('src-b', 'tenant-b', dirB)
    await job(() => runDueImports())
    await waitForRun('src-b')
    // give the skipped one the same time the good one needed to finish
    await new Promise((r) => setTimeout(r, 50))

    expect(await lastRun('src-none')).toBeNull()
    expect(writers('upsertImportMemory').map((s) => s.first)).toEqual(['src-b'])
    expect(writers('markImportSourceRun').map((s) => s.first)).toEqual(['src-b'])
    expect(writers('insertImportAuditLog').map((s) => s.first)).toEqual(['src-b'])
    expect(getDbContextStats().tenantUnresolved['import-crawler']).toBe(1)
    // nothing ran as the default tenant
    expect(seen.some((s) => s.tenantId === 'default')).toBe(false)
  })

  it('a skipped source releases its running guard: the next pass meets it again and counts again', async () => {
    await createSource('src-none', '', dirA)
    await job(() => crawlSource('src-none'))
    await job(() => crawlSource('src-none'))
    expect(getDbContextStats().tenantUnresolved['import-crawler']).toBe(2)
    expect(writers('upsertImportMemory')).toEqual([])
  })
})
