#!/usr/bin/env node
/**
 * #815: backfill migration for the ~60 legacy working documents that sat as
 * plain .md files directly under store/ before #706 moved future writes to
 * the workspace_docs SQL table. #706/#724/#727 only wired the new write
 * path -- it never touched what was already on disk, so these pre-migration
 * files (2026-07-29 .. 2026-08-29) were never backfilled or cleaned up.
 *
 * Classification (type/agent_id per file) is NOT inferred by regex at
 * runtime -- it is a hand-reviewed manifest (legacy-store-docs-manifest.json,
 * one entry per file, each with a "confidence" flag). Files with
 * confidence "medium" had no author byline in their content; the agent_id
 * chosen for those is a documented default (see the manifest's "note"
 * field), not a certain fact -- flagged in every mode's output so a human
 * can correct it later via a simple UPDATE if wrong. This is metadata-only
 * risk: content is preserved byte-exact regardless of who it's filed under.
 *
 * This script NEVER deletes the source .md files. #761's own precedent
 * ([permission_change]-style caution) and #812's precedent (data_delete is
 * Jonas-locked) both apply here: data_delete is level-1-locked in
 * store/autonomy-config.json. The last step -- deleting store/*.md after
 * verification -- is a manual command this script prints for Jonas to run
 * himself; it is never executed by this script.
 *
 * Usage:
 *   npx tsx scripts/migrate-legacy-store-docs.ts              # dry-run (default, no DB writes)
 *   npx tsx scripts/migrate-legacy-store-docs.ts --write       # upsert into workspace_docs, then verify
 *   npx tsx scripts/migrate-legacy-store-docs.ts --write --verify-only   # re-verify an already-written run
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { saveWorkspaceDoc, getWorkspaceDoc, type WorkspaceDocType } from '../src/workspace-store.js'
import { initDatabase, getDb } from '../src/db.js'
import { STORE_DIR } from '../src/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type Confidence = 'high' | 'medium' | 'low'
interface ManifestEntry {
  file: string
  type: WorkspaceDocType
  agent_id: string
  confidence: Confidence
  note?: string
}

const args = process.argv.slice(2)
const doWrite = args.includes('--write')
const verifyOnly = args.includes('--verify-only')

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function extractTitle(content: string, fallback: string): string {
  const line = content.split('\n').find(l => l.trim().length > 0)
  if (!line) return fallback
  return line.replace(/^#+\s*/, '').trim() || fallback
}

// Prefer the explicit "(kanban <id>)" marker Rick's plans embed in prose;
// fall back to a leading numeric/hash id in the filename itself.
export function extractTaskRef(content: string, file: string): string | null {
  const inline = content.match(/\(kanban ([a-zA-Z0-9-]+)\)/)
  if (inline) return inline[1]
  const leading = file.match(/^([0-9]+(?:-[0-9]+)?|[0-9a-f]{8})-/)
  if (leading) return leading[1]
  return null
}

export function docKeyFor(file: string): string {
  return `legacy/${file.replace(/\.md$/, '')}`
}

function loadManifest(): ManifestEntry[] {
  const raw = readFileSync(path.join(__dirname, 'legacy-store-docs-manifest.json'), 'utf8')
  return JSON.parse(raw) as ManifestEntry[]
}

interface PreparedDoc {
  entry: ManifestEntry
  filePath: string
  content: string
  title: string
  taskRef: string | null
  docKey: string
  sizeBytes: number
  hash: string
}

function prepare(manifest: ManifestEntry[]): PreparedDoc[] {
  const out: PreparedDoc[] = []
  for (const entry of manifest) {
    const filePath = path.join(STORE_DIR, entry.file)
    if (!existsSync(filePath)) {
      console.error(`[SKIP] missing on disk (already migrated/removed?): ${entry.file}`)
      continue
    }
    const content = readFileSync(filePath, 'utf8')
    out.push({
      entry,
      filePath,
      content,
      title: extractTitle(content, entry.file),
      taskRef: extractTaskRef(content, entry.file),
      docKey: docKeyFor(entry.file),
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      hash: sha256(content),
    })
  }
  return out
}

function printPlan(docs: PreparedDoc[]): void {
  console.log(`${docs.length} legacy .md files found under store/.\n`)
  console.log('file'.padEnd(42), 'type'.padEnd(8), 'agent'.padEnd(9), 'conf'.padEnd(7), 'doc_key')
  for (const d of docs) {
    console.log(
      d.entry.file.padEnd(42),
      d.entry.type.padEnd(8),
      d.entry.agent_id.padEnd(9),
      d.entry.confidence.padEnd(7),
      d.docKey
    )
  }
  const flagged = docs.filter(d => d.entry.confidence !== 'high')
  if (flagged.length > 0) {
    console.log(`\n${flagged.length} entries have non-high classification confidence -- review before/independent of running --write:`)
    for (const d of flagged) {
      console.log(`  - ${d.entry.file}: agent_id=${d.entry.agent_id} (${d.entry.confidence}) -- ${d.entry.note ?? 'no note'}`)
    }
  }
}

function runWrite(docs: PreparedDoc[]): void {
  console.log(`Writing ${docs.length} docs into workspace_docs (upsert by agent_id+doc_key, safe to re-run)...\n`)
  for (const d of docs) {
    saveWorkspaceDoc({
      agent_id: d.entry.agent_id,
      tenant_id: 'default',
      doc_key: d.docKey,
      title: d.title,
      content: d.content,
      content_type: 'text',
      type: d.entry.type,
      task_ref: d.taskRef,
    })
    console.log(`  wrote ${d.docKey} (agent=${d.entry.agent_id}, ${d.sizeBytes}B)`)
  }
}

function runVerify(docs: PreparedDoc[]): { allOk: boolean; verifiedFiles: string[] } {
  console.log(`\nVerifying ${docs.length} docs byte-for-byte against the DB...\n`)
  let allOk = true
  const verifiedFiles: string[] = []
  const db = getDb()
  for (const d of docs) {
    const row = db.prepare(
      'SELECT id FROM workspace_docs WHERE agent_id = ? AND doc_key = ?'
    ).get(d.entry.agent_id, d.docKey) as { id: string } | undefined
    if (!row) {
      console.log(`  FAIL ${d.entry.file}: no row found for agent_id=${d.entry.agent_id} doc_key=${d.docKey}`)
      allOk = false
      continue
    }
    const stored = getWorkspaceDoc(row.id)
    if (!stored || stored.content === null) {
      console.log(`  FAIL ${d.entry.file}: row ${row.id} has no content`)
      allOk = false
      continue
    }
    const storedHash = sha256(stored.content)
    const lenOk = stored.size_bytes === d.sizeBytes
    const hashOk = storedHash === d.hash
    if (lenOk && hashOk) {
      console.log(`  PASS ${d.entry.file} (${d.sizeBytes}B, sha256 match)`)
      verifiedFiles.push(d.filePath)
    } else {
      console.log(`  FAIL ${d.entry.file}: length ${stored.size_bytes} vs ${d.sizeBytes} (${lenOk ? 'ok' : 'MISMATCH'}), hash ${hashOk ? 'ok' : 'MISMATCH'}`)
      allOk = false
    }
  }
  return { allOk, verifiedFiles }
}

function main(): void {
  const manifest = loadManifest()
  const docs = prepare(manifest)

  if (!doWrite && !verifyOnly) {
    // Pure dry-run: never opens the DB (initDatabase() would also run
    // pending schema migrations, an unwanted side effect for a listing-only
    // invocation).
    console.log('[dry-run] no --write flag given -- nothing will be written to the DB.\n')
    printPlan(docs)
    console.log('\nRun with --write to upsert into workspace_docs (still does not touch/delete the source files).')
    return
  }

  initDatabase()

  if (verifyOnly) {
    const { allOk, verifiedFiles } = runVerify(docs)
    printDeleteInstructions(allOk, verifiedFiles)
    process.exit(allOk ? 0 : 1)
  }

  printPlan(docs)
  runWrite(docs)
  const { allOk, verifiedFiles } = runVerify(docs)
  printDeleteInstructions(allOk, verifiedFiles)
  if (!allOk) process.exit(1)
}

function printDeleteInstructions(allOk: boolean, verifiedFiles: string[]): void {
  console.log('\n--- deletion (NOT performed by this script; data_delete is Jonas-locked, see #761/#812 precedent) ---')
  if (!allOk) {
    console.log('At least one file failed verification -- fix and re-run before deleting anything.')
    return
  }
  if (verifiedFiles.length === 0) {
    console.log('Nothing verified yet -- run with --write first.')
    return
  }
  console.log(`All ${verifiedFiles.length} files verified byte-exact in workspace_docs. To remove the now-redundant`)
  console.log('source files, Jonas can run:\n')
  console.log(`  rm ${verifiedFiles.map(f => `"${f}"`).join(' \\\n     ')}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
