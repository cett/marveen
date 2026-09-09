// #815: unit coverage for the pure helpers in migrate-legacy-store-docs.ts
// (title/task_ref extraction, doc_key derivation) and an integrity check on
// the hand-reviewed manifest itself. DB-touching behavior (write/verify) is
// exercised manually against a scratch copy of store/ -- see the PR
// description for the transcript. That part isn't unit-tested here because
// it is a one-time backfill script, not long-lived product code; the risk
// that matters (content mangled on the way into the DB) is what these pure
// functions guard, and manifest.test covers "does every real file have an
// entry, and does every entry point at a real file".
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  extractTitle,
  extractTaskRef,
  docKeyFor,
  sha256,
} from '../migrate-legacy-store-docs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_DIR = path.join(__dirname, '..', '..', 'store')
const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'legacy-store-docs-manifest.json'), 'utf8')
)

describe('extractTitle', () => {
  it('strips a single leading # and surrounding space', () => {
    expect(extractTitle('# Terv: valami (kanban 123)\n\nbody', 'fallback.md')).toBe('Terv: valami (kanban 123)')
  })

  it('strips a level-2 heading too', () => {
    expect(extractTitle('## #32 Multiuser terv (v3.1)\n\nbody', 'fallback.md')).toBe('#32 Multiuser terv (v3.1)')
  })

  it('skips leading blank lines', () => {
    expect(extractTitle('\n\n# Real title\nbody', 'fallback.md')).toBe('Real title')
  })

  it('falls back to the filename when the file is empty', () => {
    expect(extractTitle('', 'fallback.md')).toBe('fallback.md')
  })

  it('falls back to the filename when the first line is blank after stripping #', () => {
    expect(extractTitle('#   \nbody', 'fallback.md')).toBe('fallback.md')
  })
})

describe('extractTaskRef', () => {
  it('prefers the inline "(kanban <id>)" marker over the filename', () => {
    expect(extractTaskRef('# Terv: X (kanban d133d751)\n', '668-rick-plan.md')).toBe('d133d751')
  })

  it('falls back to a leading numeric filename prefix', () => {
    expect(extractTaskRef('no marker here', '646-brief.md')).toBe('646')
  })

  it('falls back to a leading hex-hash filename prefix', () => {
    expect(extractTaskRef('no marker here', '102eef79-rick-plan.md')).toBe('102eef79')
  })

  it('falls back to a leading dashed numeric pair', () => {
    expect(extractTaskRef('no marker here', '691-692-rick-plan.md')).toBe('691-692')
  })

  it('returns null when neither signal is present', () => {
    expect(extractTaskRef('no marker here', 'semantic-consolidation-design.md')).toBeNull()
  })
})

describe('docKeyFor', () => {
  it('prefixes with legacy/ and strips the .md extension', () => {
    expect(docKeyFor('646-brief.md')).toBe('legacy/646-brief')
  })
})

describe('sha256', () => {
  it('is stable and content-sensitive', () => {
    const a = sha256('hello')
    const b = sha256('hello')
    const c = sha256('hellO')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('legacy-store-docs-manifest.json integrity', () => {
  const knownAgents = new Set([
    'jarvis', 'boo', 'carmen', 'dave', 'diana', 'peter', 'poly', 'rick', 'vera', 'zoe', 'zack',
  ])
  const knownTypes = new Set(['plan', 'brief', 'report', 'notes'])

  it('has a valid type/agent_id/confidence for every entry', () => {
    for (const e of manifest as Array<{ file: string; type: string; agent_id: string; confidence: string }>) {
      expect(knownTypes.has(e.type), `${e.file}: unknown type "${e.type}"`).toBe(true)
      expect(knownAgents.has(e.agent_id), `${e.file}: unknown agent_id "${e.agent_id}"`).toBe(true)
      expect(['high', 'medium', 'low']).toContain(e.confidence)
    }
  })

  it('has no duplicate file entries', () => {
    const files = (manifest as Array<{ file: string }>).map(e => e.file)
    expect(new Set(files).size).toBe(files.length)
  })

  // This is the guard that matters most for a manifest maintained by hand:
  // every legacy .md file that actually exists on disk right now must have
  // exactly one manifest entry, and vice versa. Skipped when store/ isn't
  // present (store/ is gitignored -- CI checks out only tracked files, so
  // this file set is only there on a real install).
  const storeExists = (() => {
    try { readdirSync(STORE_DIR); return true } catch { return false }
  })()

  it.runIf(storeExists)('covers exactly the .md files currently in store/', () => {
    const actual = new Set(readdirSync(STORE_DIR).filter(f => f.endsWith('.md')))
    const listed = new Set((manifest as Array<{ file: string }>).map(e => e.file))
    const missingFromManifest = [...actual].filter(f => !listed.has(f))
    const missingOnDisk = [...listed].filter(f => !actual.has(f))
    expect(missingFromManifest, 'store/*.md files with no manifest entry').toEqual([])
    expect(missingOnDisk, 'manifest entries with no matching file on disk (fine post-cleanup, flag pre-cleanup)').toEqual([])
  })
})
