// scripts/migrate-legacy-store-docs.ts, RUN end to end as the operator runs it (a tsx child process) against a
// throw-away store: MARVEEN_STORE_DIR and HOME point into a temp dir, so the real store and its database are never
// opened. migrate-legacy-store-docs.test.ts covers the pure helpers and the manifest; this file covers what only a
// run shows: the dry-run opens no database, --write puts the files into workspace_docs byte-exact, the verify step
// reads them back and fails loudly on a missing or altered row, a re-run is idempotent, and the source files are
// never touched.
//
// Every test builds its own store (nothing is shared between tests, so the order does not matter). The fixture
// files take their names, types and agents from the real manifest entries, so no agent name is written here.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'scripts', 'legacy-store-docs-manifest.json'), 'utf8')) as Array<{
  file: string
  type: string
  agent_id: string
  confidence: string
}>

// Three real manifest entries, one of them not high-confidence when the manifest has such an entry.
const MEDIUM = MANIFEST.find((e) => e.confidence !== 'high')
const ENTRIES = [MANIFEST[0], MANIFEST[1], MEDIUM && !MANIFEST.slice(0, 2).includes(MEDIUM) ? MEDIUM : MANIFEST[2]]

// Content a mangling copy would damage: accents, an emoji, CRLF, no trailing newline, a (kanban <id>) marker.
const CONTENT: string[] = [
  '# Terv: árvíztűrő tükörfúrógép (kanban abc12345)\r\n\r\nA második sor CRLF-fel.\r\n',
  '## Jegyzet 🚀\n\nemoji és ékezet: őűáéíóöüú\nNincs záró újsor',
  '# Rövid\n',
]

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

interface Sandbox {
  storeDir: string
  homeDir: string
  dbPath: string
}
let box: Sandbox

/** A fresh store with the three fixture files and an empty home. */
function makeSandbox(files: number = ENTRIES.length): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'legacy-docs-'))
  roots.push(root)
  const storeDir = join(root, 'store')
  const homeDir = join(root, 'home')
  mkdirSync(storeDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  for (let i = 0; i < files; i++) writeFileSync(join(storeDir, ENTRIES[i].file), CONTENT[i], 'utf8')
  return { storeDir, homeDir, dbPath: join(storeDir, 'claudeclaw.db') }
}

function run(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(TSX, ['scripts/migrate-legacy-store-docs.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, MARVEEN_STORE_DIR: box.storeDir, HOME: box.homeDir },
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

interface DocRow {
  id: string
  agent_id: string
  tenant_id: string
  doc_key: string
  title: string
  content: string | null
  type: string
  task_ref: string | null
  size_bytes: number
}
function docs(): DocRow[] {
  const db = new Database(box.dbPath, { readonly: true })
  try {
    return db.prepare("SELECT * FROM workspace_docs WHERE doc_key LIKE 'legacy/%' ORDER BY doc_key").all() as DocRow[]
  } finally {
    db.close()
  }
}
function rewriteDb(sql: string, ...params: unknown[]): void {
  const db = new Database(box.dbPath)
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

beforeEach(() => {
  box = makeSandbox()
})

const stem = (file: string) => file.replace(/\.md$/, '')

describe('migrate-legacy-store-docs.ts: dry-run', () => {
  it('lists what it would do, opens no database and writes nothing', async () => {
    const r = await run([])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[dry-run]')
    expect(r.stdout).toContain(`${ENTRIES.length} legacy .md files found under store/`)
    for (const e of ENTRIES) expect(r.stdout).toContain(`legacy/${stem(e.file)}`)
    // initDatabase() would create the file (and run migrations): a listing must not.
    expect(existsSync(box.dbPath)).toBe(false)
  }, 60000)
})

describe('migrate-legacy-store-docs.ts: --write', () => {
  it('stores every file byte-exact with the manifest type and agent, and verifies it back', async () => {
    const r = await run(['--write'])
    expect(r.status).toBe(0)
    for (const e of ENTRIES) {
      expect(r.stdout).toContain(`wrote legacy/${stem(e.file)} (agent=${e.agent_id}`)
      expect(r.stdout).toMatch(new RegExp(`PASS ${e.file.replace(/\./g, '\\.')} \\(\\d+B, sha256 match\\)`))
    }
    expect(r.stdout).not.toContain('FAIL')

    const rows = docs()
    expect(rows).toHaveLength(ENTRIES.length)
    ENTRIES.forEach((e, i) => {
      const row = rows.find((x) => x.doc_key === `legacy/${stem(e.file)}`)
      expect(row, `${e.file} has a row`).toBeDefined()
      expect(row!.content).toBe(CONTENT[i]) // CRLF, accents, emoji and a missing final newline survive
      expect(row!.size_bytes).toBe(Buffer.byteLength(CONTENT[i], 'utf8'))
      expect(row!.type).toBe(e.type)
      expect(row!.agent_id).toBe(e.agent_id)
      expect(row!.tenant_id).toBe('default')
    })
    // title and task_ref come from the content: first non-blank line without its #, the (kanban <id>) marker
    const first = rows.find((x) => x.doc_key === `legacy/${stem(ENTRIES[0].file)}`)!
    expect(first.title).toBe('Terv: árvíztűrő tükörfúrógép (kanban abc12345)')
    expect(first.task_ref).toBe('abc12345')
    expect(rows.find((x) => x.doc_key === `legacy/${stem(ENTRIES[2].file)}`)!.title).toBe('Rövid')
  }, 60000)

  it('never deletes or changes the source files; it only prints the rm command for the owner', async () => {
    const r = await run(['--write'])
    expect(r.status).toBe(0)
    ENTRIES.forEach((e, i) => {
      const p = join(box.storeDir, e.file)
      expect(existsSync(p), `${e.file} still on disk`).toBe(true)
      expect(readFileSync(p, 'utf8')).toBe(CONTENT[i])
      expect(r.stdout).toContain(`"${p}"`)
    })
    expect(r.stdout).toContain('NOT performed by this script')
  }, 60000)

  it('a file named in the manifest but not on disk is skipped, not an error, and not written', async () => {
    box = makeSandbox(1) // only the first fixture file exists
    const r = await run(['--write'])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain(`[SKIP] missing on disk (already migrated/removed?): ${ENTRIES[1].file}`)
    expect(r.stdout).toContain('1 legacy .md files found under store/')
    expect(docs().map((d) => d.doc_key)).toEqual([`legacy/${stem(ENTRIES[0].file)}`])
  }, 60000)

  it('is idempotent: a second run keeps one row per file, with the same ids', async () => {
    expect((await run(['--write'])).status).toBe(0)
    const before = docs()
    const again = await run(['--write'])
    expect(again.status).toBe(0)
    expect(again.stdout).not.toContain('FAIL')
    const after = docs()
    expect(after).toHaveLength(ENTRIES.length)
    expect(after.map((d) => [d.id, d.doc_key, d.content])).toEqual(before.map((d) => [d.id, d.doc_key, d.content]))
  }, 60000)

  it('a re-run after a source file changed updates the row (the write is not skipped as "already there")', async () => {
    expect((await run(['--write'])).status).toBe(0)
    const idBefore = docs().find((d) => d.doc_key === `legacy/${stem(ENTRIES[0].file)}`)!.id
    const changed = '# Terv: átírva\n\nÚj törzs.\n'
    writeFileSync(join(box.storeDir, ENTRIES[0].file), changed, 'utf8')

    const r = await run(['--write'])
    expect(r.status).toBe(0)
    const row = docs().find((d) => d.doc_key === `legacy/${stem(ENTRIES[0].file)}`)!
    expect(row.id).toBe(idBefore)
    expect(row.content).toBe(changed)
    expect(row.title).toBe('Terv: átírva')
    expect(row.size_bytes).toBe(Buffer.byteLength(changed, 'utf8'))
    expect(docs()).toHaveLength(ENTRIES.length)
  }, 60000)
})

describe('migrate-legacy-store-docs.ts: --verify-only', () => {
  it('passes on a store that was written', async () => {
    expect((await run(['--write'])).status).toBe(0)
    const r = await run(['--verify-only'])
    expect(r.status).toBe(0)
    for (const e of ENTRIES) expect(r.stdout).toContain(`PASS ${e.file}`)
    expect(r.stdout).not.toContain('FAIL')
  }, 60000)

  it('fails (exit 1) when nothing was written yet, names the missing row and refuses to print an rm command', async () => {
    const r = await run(['--verify-only'])
    expect(r.status).toBe(1)
    for (const e of ENTRIES) expect(r.stdout).toContain(`FAIL ${e.file}: no row found for agent_id=${e.agent_id} doc_key=legacy/${stem(e.file)}`)
    expect(r.stdout).toContain('At least one file failed verification')
    expect(r.stdout).not.toMatch(/\n\s+rm "/)
  }, 60000)

  it('fails (exit 1) on a row whose content was altered, even at the same length (the hash decides)', async () => {
    expect((await run(['--write'])).status).toBe(0)
    const key = `legacy/${stem(ENTRIES[2].file)}`
    const original = CONTENT[2]
    const altered = original.replace('Rövid', 'Röviz') // same byte length
    expect(Buffer.byteLength(altered, 'utf8')).toBe(Buffer.byteLength(original, 'utf8'))
    rewriteDb('UPDATE workspace_docs SET content = ? WHERE doc_key = ?', altered, key)

    const r = await run(['--verify-only'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`FAIL ${ENTRIES[2].file}`)
    expect(r.stdout).toContain('hash MISMATCH')
    expect(r.stdout).toContain(`PASS ${ENTRIES[0].file}`) // the intact ones are still reported
    expect(r.stdout).not.toMatch(/\n\s+rm "/)
  }, 60000)

  it('fails (exit 1) on a row whose stored size no longer matches the file', async () => {
    expect((await run(['--write'])).status).toBe(0)
    rewriteDb('UPDATE workspace_docs SET size_bytes = size_bytes + 1 WHERE doc_key = ?', `legacy/${stem(ENTRIES[1].file)}`)

    const r = await run(['--verify-only'])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(new RegExp(`FAIL ${ENTRIES[1].file.replace(/\./g, '\\.')}: length \\d+ vs \\d+ \\(MISMATCH\\)`))
  }, 60000)

  it('a --write run exits 1 and prints no rm command when a written row cannot be read back', async () => {
    // Make the verify step fail inside the same run: after a first --write, a trigger rewrites the content of one
    // legacy doc whenever the re-run updates it, so what is read back differs from what was written.
    expect((await run(['--write'])).status).toBe(0)
    rewriteDb(
      `CREATE TRIGGER legacy_docs_blank AFTER UPDATE ON workspace_docs WHEN NEW.doc_key = '${`legacy/${stem(ENTRIES[0].file)}`}'
       BEGIN UPDATE workspace_docs SET content = 'x' WHERE id = NEW.id AND content <> 'x'; END`,
    )
    writeFileSync(join(box.storeDir, ENTRIES[0].file), '# Terv: másik\n', 'utf8') // forces an UPDATE on the re-run

    const r = await run(['--write'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`FAIL ${ENTRIES[0].file}`)
    expect(r.stdout).toContain('At least one file failed verification')
    expect(r.stdout).not.toMatch(/\n\s+rm "/)
  }, 60000)
})
