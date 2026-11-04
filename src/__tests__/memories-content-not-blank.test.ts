// A memory's content is never blank: isBlankContent, the DB layer (updateMemory, updateTenantMemory), the
// import path (upsertImportMemory) and the memories triggers of migration 0087. Real in-memory SQLite.
//
// The bug this holds: a source that came out empty (an emptied file, a markup-only page) overwrote the
// memory's text with '' through the import path, with no version row and the embedding dropped.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlankContentError, blankCodePoints, isBlankContent } from '../blank-content.js'
import { getDb, insertImportSource, updateMemory, upsertImportMemory } from '../db.js'
import { updateTenantMemory } from '../db/tenant-scoped.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const NOW = 1_800_000_000
const ZWSP = String.fromCharCode(0x200b)
const NBSP = String.fromCharCode(0x00a0)
const BOM = String.fromCharCode(0xfeff)
const BLANKS: Record<string, string> = {
  empty: '',
  spaces: '   ',
  'tab and newlines': '\t\r\n \n',
  'no-break space': NBSP,
  'zero width space': ZWSP,
  'zero width run': ZWSP.repeat(5) + String.fromCharCode(0x200d),
  'byte order mark': BOM,
  'mixed whitespace and invisible': ` ${ZWSP}\n${NBSP}${BOM}`,
}

describe('isBlankContent', () => {
  it.each(Object.entries(BLANKS))('%s is blank', (_name, text) => {
    expect(isBlankContent(text)).toBe(true)
  })

  it('text with one visible character is not blank, wherever it stands among invisible ones', () => {
    for (const t of ['x', ` x `, `${ZWSP}x`, `x${ZWSP}`, `${ZWSP}${NBSP}x${BOM}`, '0', '.', String.fromCharCode(0x2800), String.fromCharCode(0x3164)]) {
      expect(isBlankContent(t), JSON.stringify(t)).toBe(false)
    }
  })

  it('a long text stops at its first visible character', () => {
    expect(isBlankContent(' '.repeat(200_000) + 'x' + ' '.repeat(200_000))).toBe(false)
  })
})

// ── the triggers of migration 0087 ───────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION = readFileSync(join(here, '..', 'migrations', '0087_memories_content_not_blank.sql'), 'utf-8')

function insertRow(content: string, agentId = 'zack'): number {
  return getDb().prepare(
    "INSERT INTO memories (chat_id, sector, agent_id, category, content, tenant_id, created_at, accessed_at) VALUES ('c', 'semantic', ?, 'warm', ?, 'default', ?, ?)",
  ).run(agentId, content, NOW, NOW).lastInsertRowid as number
}
const contentOf = (id: number): string => (getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }).content

describe('memories content triggers (migration 0087)', () => {
  it('the code points the triggers trim are exactly the ones isBlankContent treats as blank', () => {
    const lists = [...MIGRATION.matchAll(/char\(([\d,]+)\)/g)].map((m) => m[1]!.split(',').map(Number))
    expect(lists).toHaveLength(2) // insert and update trigger
    const expected = blankCodePoints()
    for (const list of lists) expect(list).toEqual(expected)
  })

  it('SQL and the helper agree on every character of the basic plane', () => {
    const db = getDb()
    const probe = db.prepare("SELECT trim(?, char(" + blankCodePoints().join(',') + ")) = '' AS blank")
    const disagree: number[] = []
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCharCode(cp)
      if (cp === 0) continue // a NUL ends the string in some SQLite builds; never blank text
      const sqlBlank = (probe.get(ch) as { blank: number }).blank === 1
      if (sqlBlank !== isBlankContent(ch)) disagree.push(cp)
    }
    expect(disagree).toEqual([])
  })

  it.each(Object.entries(BLANKS))('INSERT of %s is refused', (_name, text) => {
    expect(() => insertRow(text)).toThrow(/must not be blank/)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(0)
  })

  it.each(Object.entries(BLANKS))('UPDATE of content to %s is refused and the text stays', (_name, text) => {
    const id = insertRow('the memory')
    expect(() => getDb().prepare('UPDATE memories SET content = ? WHERE id = ?').run(text, id)).toThrow(/must not be blank/)
    expect(contentOf(id)).toBe('the memory')
  })

  it('a row with visible text is accepted, and an update that leaves content alone is not checked', () => {
    const id = insertRow(`${ZWSP}kept${ZWSP}`)
    getDb().prepare("UPDATE memories SET category = 'cold' WHERE id = ?").run(id)
    expect(contentOf(id)).toBe(`${ZWSP}kept${ZWSP}`)
  })
})

// ── updateMemory / updateTenantMemory ────────────────────────────────────────

describe('updateMemory and updateTenantMemory refuse blank content', () => {
  it.each(Object.entries(BLANKS))('updateMemory with %s throws, the text stays and no version row is written', async (_name, text) => {
    const id = insertRow('the memory')
    await expect(updateMemory(id, text)).rejects.toBeInstanceOf(BlankContentError)
    expect(contentOf(id)).toBe('the memory')
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?').get(id) as { n: number }).n).toBe(0)
  })

  it('updateMemory still updates with real text (and keeps the old text as a version)', async () => {
    const id = insertRow('old')
    await expect(updateMemory(id, 'new')).resolves.toBe(true)
    expect(contentOf(id)).toBe('new')
    expect((getDb().prepare('SELECT content FROM memory_versions WHERE memory_id = ?').get(id) as { content: string }).content).toBe('old')
  })

  it.each(Object.entries(BLANKS))('updateTenantMemory with %s throws and the text stays', async (_name, text) => {
    const id = insertRow('the memory')
    await expect(updateTenantMemory('default', id, { content: text })).rejects.toBeInstanceOf(BlankContentError)
    expect(contentOf(id)).toBe('the memory')
  })

  it('updateTenantMemory with only a category (no content) is untouched by the check', async () => {
    const id = insertRow('the memory')
    await expect(updateTenantMemory('default', id, { category: 'cold' })).resolves.toBe(true)
    expect(contentOf(id)).toBe('the memory')
  })
})

// ── the import path ──────────────────────────────────────────────────────────

async function source(): Promise<void> {
  await insertImportSource({
    id: 'src-a', type: 'local', path: '/docs', label: 'a', intervalHours: 4, enabled: true, now: NOW,
    tenantId: 'default', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
  })
}
const upsert = (file: string, hash: string, content: string) =>
  upsertImportMemory('src-a', `/docs/${file}`, file, hash, content, 'kw', NOW, 'default')
const count = (table: string): number => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('upsertImportMemory with a source that came out blank', () => {
  it.each(Object.entries(BLANKS))('%s: the existing memory, its embedding and the import row stay as they were', async (_name, text) => {
    await source()
    expect(await upsert('note.md', 'h1', 'the real text')).toBe('added')
    const shadow = getDb().prepare("SELECT id FROM memories WHERE agent_id = 'import'").get() as { id: number }
    getDb().prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(Buffer.from([1, 2, 3, 4]), shadow.id)
    const before = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(shadow.id)
    const importBefore = getDb().prepare('SELECT * FROM import_memories').get()

    expect(await upsert('note.md', 'h2-the-file-was-emptied', text)).toBe('skipped_blank')

    expect(getDb().prepare('SELECT * FROM memories WHERE id = ?').get(shadow.id)).toEqual(before)
    expect(getDb().prepare('SELECT * FROM import_memories').get()).toEqual(importBefore)
  })

  it('a blank source that was never imported adds no import row and no memory', async () => {
    await source()
    expect(await upsert('empty.md', 'h1', ZWSP)).toBe('skipped_blank')
    expect(count('import_memories')).toBe(0)
    expect(count('memories')).toBe(0)
  })

  it('the file refilled later updates the memory as usual', async () => {
    await source()
    await upsert('note.md', 'h1', 'first')
    await upsert('note.md', 'h2', '')
    expect(await upsert('note.md', 'h3', 'second')).toBe('updated')
    expect(getDb().prepare("SELECT content FROM memories WHERE agent_id = 'import'").get()).toEqual({ content: 'second' })
  })
})
