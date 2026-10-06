// stripMarkup decodes HTML character references instead of blanking them, and the
// rows that were imported with the old behaviour are re-imported (migration 0072).
// Unit tests on the pure function, then the three callers it feeds: the local
// crawler, the Confluence crawler (both through crawlSource against a real
// in-memory DB) and the shadow-memory/embedding bookkeeping in upsertImportMemory.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
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

import { stripMarkup } from '../web/import-utils.js'
import { crawlSource, upsertImportMemory } from '../web/import-crawler.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

describe('stripMarkup -- character references', () => {
  it('decodes Hungarian accents written as named, decimal and hex references', () => {
    expect(stripMarkup('<p>jegyz&#337;k&ouml;nyv</p>')).toBe('jegyzőkönyv')
    expect(stripMarkup('<p>jegyz&#x151;k&#xF6;nyv</p>')).toBe('jegyzőkönyv')
    expect(stripMarkup('<p>&Aacute;rv&iacute;zt&#369;r&#337; t&uuml;k&ouml;rf&uacute;r&oacute;g&eacute;p</p>')).toBe('Árvíztűrő tükörfúrógép')
  })

  it('keeps raw accents untouched', () => {
    expect(stripMarkup('<p>Árvíztűrő tükörfúrógép, jegyzőkönyv</p>')).toBe('Árvíztűrő tükörfúrógép, jegyzőkönyv')
  })

  it('decodes the basic five, &nbsp; as a space, and the numeric quote', () => {
    expect(stripMarkup('<p>a &amp; b &lt; c &gt; d &quot;e&quot; f&#39;s</p>')).toBe(`a & b < c > d "e" f's`)
    expect(stripMarkup('<p>a&nbsp;b&#160;c&#xA0;d</p>')).toBe('a b c d')
  })

  it('decodes once: &amp;lt; becomes the text &lt;, not <', () => {
    expect(stripMarkup('<p>&amp;lt;b&amp;gt;</p>')).toBe('&lt;b&gt;')
    expect(stripMarkup('<p>&amp;#337;</p>')).toBe('&#337;')
  })

  it('leaves an unknown or malformed reference as text instead of deleting it', () => {
    expect(stripMarkup('<p>x &bogusname; y</p>')).toBe('x &bogusname; y')
    expect(stripMarkup('<p>x &#xZZ; y &#; y &; y & y &amp y</p>')).toBe('x &#xZZ; y &#; y &; y & y &amp y')
  })

  it('leaves out-of-range and control code points as the original text', () => {
    expect(stripMarkup('<p>a&#0;b &#xD800;c &#1114112;d &#1;e &#127;f</p>')).toBe('a&#0;b &#xD800;c &#1114112;d &#1;e &#127;f')
    // ... but a document that really asks for U+FFFD gets it
    expect(stripMarkup('<p>&#65533;&#xFFFD;</p>')).toBe('\uFFFD\uFFFD')
  })

  it('does not turn the semicolon-less legacy forms in a URL into characters', () => {
    expect(stripMarkup('<p>https://x.test/?a=1&copy=2&reg=3</p>')).toBe('https://x.test/?a=1&copy=2&reg=3')
  })

  it('decodes AFTER the tag strip: an escaped tag stays as text, a real script block is still removed', () => {
    expect(stripMarkup('<p>use &lt;script&gt;alert(1)&lt;/script&gt; here</p>')).toBe('use <script>alert(1)</script> here')
    expect(stripMarkup('<p>a</p><script>alert(1)</script><p>b</p>')).toBe('a b')
    expect(stripMarkup('<style>p{color:red}</style><p>&lt;div&gt;</p>')).toBe('<div>')
  })

  it('maps a Windows-1252 numeric reference the way a browser does', () => {
    expect(stripMarkup('<p>a&#150;b</p>')).toBe('a–b')
  })
})

describe('crawlers decode entities end to end', () => {
  let tmpDir: string
  beforeEach(() => {
    initDatabase(':memory:')
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'strip-entities-'))
  })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); vi.unstubAllGlobals() })

  function seedLocal(id: string) {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
      VALUES (?, 'local', ?, 4, 1, ?, ?, 'default')`).run(id, tmpDir, now, now)
  }

  it('local .html file: stored content and shadow memory carry the real accents', async () => {
    writeFileSync(join(tmpDir, 'doc.html'), '<html><body><p>jegyz&#337;k&ouml;nyv &amp; &Eacute;vk&ouml;nyv</p></body></html>', 'utf-8')
    seedLocal('loc-1')
    await crawlSource('loc-1')
    const row = getDb().prepare('SELECT content, memory_shadow_id FROM import_memories WHERE source_id = ?').get('loc-1') as any
    expect(row.content).toBe('jegyzőkönyv & Évkönyv')
    const shadow = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(row.memory_shadow_id) as any
    expect(shadow.content).toBe('jegyzőkönyv & Évkönyv')
  })

  it('local .html file: a secret hidden behind character references is caught after the decode', async () => {
    writeFileSync(join(tmpDir, 'leak.html'), '<p>config password&#61;hunter2hunter2 end</p>', 'utf-8')
    seedLocal('loc-2')
    await crawlSource('loc-2')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM import_memories WHERE source_id = ?').get('loc-2')).toEqual({ n: 0 })
  })

  it('Confluence storage HTML: entity accents are decoded in the stored page', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id, vault_token_ref, confluence_email, base_url)
      VALUES ('cf-1', 'confluence', 'SPACE', 4, 1, ?, ?, 'default', 'tok', 'u@example.com', 'https://example.atlassian.net')`).run(now, now)
    mockGetSecret.mockReturnValue('t')
    const res = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body }) as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/spaces?keys=SPACE')) return res({ results: [{ id: 'sp1', key: 'SPACE', name: 'S', type: 'global', status: 'current' }] })
      if (url.includes('/pages?space-id=sp1')) return res({ results: [{ id: 'p1', title: 'T', spaceId: 'sp1' }] })
      if (url.includes('/pages/p1')) return res({ id: 'p1', title: 'T', spaceId: 'sp1', body: { storage: { value: '<p>jegyz&#x151;k&ouml;nyv&nbsp;2026</p>' } } })
      throw new Error(`unexpected ${url}`)
    }))
    await crawlSource('cf-1')
    const row = getDb().prepare("SELECT content FROM import_memories WHERE source_id = 'cf-1'").get() as any
    expect(row.content).toBe('jegyzőkönyv 2026')
  })
})

describe('upsertImportMemory -- shadow embedding bookkeeping', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function seed() {
    const now = 1_700_000_000
    getDb().prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
      VALUES ('s1', 'local', '/x', 4, 1, ?, ?, 'default')`).run(now, now)
    upsertImportMemory('s1', '/x/a.html', 'a.html', 'h1', 'jegyz k nyv', 'kw', now, 'default')
    const shadowId = (getDb().prepare("SELECT memory_shadow_id AS id FROM import_memories WHERE file_path = '/x/a.html'").get() as any).id
    getDb().prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(Buffer.from([1, 2, 3, 4]), shadowId)
    return shadowId as number
  }
  const blob = (id: number) => (getDb().prepare('SELECT embedding_blob AS b FROM memories WHERE id = ?').get(id) as any).b

  it('drops the stale embedding when the text changed, and refreshes the shadow content and updated_at', () => {
    const id = seed()
    expect(upsertImportMemory('s1', '/x/a.html', 'a.html', 'h2', 'jegyzőkönyv', 'kw', 1_700_000_500, 'default')).toBe('updated')
    expect(blob(id)).toBeNull()
    const m = getDb().prepare('SELECT content, updated_at FROM memories WHERE id = ?').get(id) as any
    expect(m).toEqual({ content: 'jegyzőkönyv', updated_at: 1_700_000_500 })
  })

  it('keeps the embedding when only the hash changed and the extracted text is identical', () => {
    const id = seed()
    expect(upsertImportMemory('s1', '/x/a.html', 'a.html', 'h2', 'jegyz k nyv', 'kw', 1_700_000_500, 'default')).toBe('updated')
    expect(blob(id)).not.toBeNull()
  })
})

describe('migration 0072', () => {
  const FILE = '0072_import_html_entity_resync.sql'

  function setup(dir: string) {
    for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && f < '0072') copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    const src = db.prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id) VALUES (?, ?, 'p', 4, 1, ?, 1, 1, 'default')`)
    src.run('loc', 'local', 1_700_000_000)
    src.run('conf', 'confluence', 1_700_000_000)
    src.run('gd', 'gdrive', 1_700_000_000)
    const mem = db.prepare(`INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, last_seen_at, created_at, updated_at, tenant_id) VALUES (?, ?, ?, ?, 'real-hash', 'c', 1, 1, 1, 'default')`)
    mem.run('m1', 'loc', '/a.html', 'a.html')
    mem.run('m2', 'loc', '/b.XML', 'b.XML')
    mem.run('m3', 'loc', '/c.txt', 'c.txt')
    mem.run('m4', 'conf', 'confluence/S/1', 'Page.html')
    mem.run('m5', 'gd', 'g1', 'g.html')
    return db
  }
  const hash = (db: Database.Database, id: string) => (db.prepare('SELECT content_hash AS h FROM import_memories WHERE id = ?').get(id) as any).h
  const lastRun = (db: Database.Database, id: string) => (db.prepare('SELECT last_run_at AS t FROM import_sources WHERE id = ?').get(id) as any).t

  it('marks local markup rows and every Confluence row, clears Confluence last_run_at, touches nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strip-0072-'))
    try {
      const db = setup(dir)
      copyFileSync(join(MIGRATIONS_DIR, FILE), join(dir, FILE))
      applyMigrations(db, dir)
      expect(['m1', 'm2', 'm4'].map(i => hash(db, i))).toEqual(['resync-0072', 'resync-0072', 'resync-0072'])
      expect(['m3', 'm5'].map(i => hash(db, i))).toEqual(['real-hash', 'real-hash'])
      expect(lastRun(db, 'conf')).toBeNull()
      expect(lastRun(db, 'loc')).toBe(1_700_000_000)
      expect(lastRun(db, 'gd')).toBe(1_700_000_000)
      // runs once: a later crawl's hash survives another applyMigrations
      db.prepare("UPDATE import_memories SET content_hash = 'new' WHERE id = 'm1'").run()
      applyMigrations(db, dir)
      expect(hash(db, 'm1')).toBe('new')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('applies cleanly on a database with no import rows', () => {
    expect(() => applyMigrations(new Database(':memory:'), MIGRATIONS_DIR)).not.toThrow()
  })

  it('the next local crawl re-imports a marked row even though the raw file did not change', async () => {
    initDatabase(':memory:')
    const tmp = mkdtempSync(join(tmpdir(), 'strip-0072-crawl-'))
    try {
      writeFileSync(join(tmp, 'doc.html'), '<p>jegyz&#337;k&ouml;nyv</p>', 'utf-8')
      const now = Math.floor(Date.now() / 1000)
      getDb().prepare(`INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id) VALUES ('l', 'local', ?, 4, 1, ?, ?, 'default')`).run(tmp, now, now)
      await crawlSource('l')
      // simulate the pre-fix state: garbled text, then the migration's marker
      getDb().prepare("UPDATE import_memories SET content = 'jegyz k nyv', content_hash = 'resync-0072' WHERE source_id = 'l'").run()
      await crawlSource('l')
      expect((getDb().prepare("SELECT content FROM import_memories WHERE source_id = 'l'").get() as any).content).toBe('jegyzőkönyv')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
})
