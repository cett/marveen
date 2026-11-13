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
import { insertImportSource, updateMemory, upsertImportMemory, dbx } from '../db.js'
import { updateTenantMemory } from '../db/tenant-scoped.js'
import { testDbMode, useTestDb } from './helpers/with-test-db.js'

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
const PG_BASELINE = readFileSync(join(here, '..', 'migrations-pg', '0001_baseline.sql'), 'utf-8')

/** What the engine says when the guard refuses: the SQLite trigger's message, or PostgreSQL's CHECK violation. */
const REFUSED = testDbMode() === 'pg' ? /memories_content_check/ : /must not be blank/

/**
 * Every BMP code point (surrogates and NUL left out: a lone surrogate is not text and a NUL ends a string) that the
 * guard of the ACTIVE engine treats as a blank content of its own. SQLite: the `trim(?, char(...))` expression of the
 * trigger with the helper's list (the list itself is held equal to the migration's by the test above), one probe per
 * code point. PostgreSQL, asked of the engine itself: the CHECK constraint on memories.content as the server stores it
 * (pg_get_constraintdef), evaluated for every code point in one statement with `content` replaced by the character,
 * so the answer is the constraint's, not a copy of the list in this test.
 */
async function engineBlankCodePoints(): Promise<number[]> {
  if (testDbMode() === 'pg') {
    const defs = (await dbx.all("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'memories'::regclass AND contype = 'c'")) as { def: string }[]
    const guards = defs.filter((d) => /btrim\(content,/.test(d.def))
    expect(guards, JSON.stringify(defs)).toHaveLength(1)
    const check = guards[0]!.def.replace(/^CHECK\s*/, '').replace(/btrim\(content,/g, 'btrim(chr(g.cp),')
    expect(check).toContain('chr(g.cp)')
    const rows = (await dbx.all(`SELECT g.cp AS cp FROM generate_series(1, 65535) AS g(cp) WHERE (g.cp < 55296 OR g.cp > 57343) AND NOT ${check} ORDER BY g.cp`)) as { cp: number }[]
    return rows.map((r) => r.cp)
  }
  const probeSql = "SELECT trim(?, char(" + blankCodePoints().join(',') + ")) = '' AS blank"
  const out: number[] = []
  for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    if (((await dbx.get(probeSql, String.fromCharCode(cp))) as { blank: number }).blank === 1) out.push(cp)
  }
  return out
}

async function insertRow(content: string, agentId = 'zack'): Promise<number> {
  // RETURNING id: the facade's lastInsertRowid is a SQLite notion, PostgreSQL has no such value for a plain INSERT
  return ((await dbx.get("INSERT INTO memories (chat_id, sector, agent_id, category, content, tenant_id, created_at, accessed_at) VALUES ('c', 'semantic', ?, 'warm', ?, 'default', ?, ?) RETURNING id", agentId, content, NOW, NOW)) as { id: number }).id
}
const contentOf = async (id: number): Promise<string> => ((await dbx.get('SELECT content FROM memories WHERE id = ?', id)) as { content: string }).content

describe('memories content triggers (migration 0087)', () => {
  it('the code points the triggers trim are exactly the ones isBlankContent treats as blank', () => {
    const lists = [...MIGRATION.matchAll(/char\(([\d,]+)\)/g)].map((m) => m[1]!.split(',').map(Number))
    expect(lists).toHaveLength(2) // insert and update trigger
    const expected = blankCodePoints()
    for (const list of lists) expect(list).toEqual(expected)
  })

  it('the code points of the PostgreSQL baseline CHECK are exactly the ones isBlankContent treats as blank', () => {
    const checks = [...PG_BASELINE.matchAll(/CHECK \(btrim\(content, E'([^']*)'\) <> ''\)/g)]
    expect(checks).toHaveLength(1) // the memories table
    const listed = [...checks[0]![1]!.matchAll(/\\u([0-9a-fA-F]{4})/g)].map((m) => parseInt(m[1]!, 16)).sort((a, b) => a - b)
    expect(listed).toEqual(blankCodePoints())
  })

  it('the engine and the helper agree on every character of the basic plane', async () => {
    // a NUL ends the string in some SQLite builds and PostgreSQL refuses it: never blank text, left out
    const expected = blankCodePoints().filter((cp) => cp !== 0)
    expect(await engineBlankCodePoints()).toEqual(expected)
  })

  it.each(Object.entries(BLANKS))('INSERT of %s is refused', async (_name, text) => {
    await expect(insertRow(text)).rejects.toThrow(REFUSED)
    expect(((await dbx.get('SELECT COUNT(*) AS n FROM memories')) as { n: number }).n).toBe(0)
  })

  it.each(Object.entries(BLANKS))('UPDATE of content to %s is refused and the text stays', async (_name, text) => {
    const id = await insertRow('the memory')
    await expect(dbx.run('UPDATE memories SET content = ? WHERE id = ?', text, id)).rejects.toThrow(REFUSED)
    expect(await contentOf(id)).toBe('the memory')
  })

  it('a row with visible text is accepted, and an update that leaves content alone is not checked', async () => {
    const id = await insertRow(`${ZWSP}kept${ZWSP}`)
    await dbx.run("UPDATE memories SET category = 'cold' WHERE id = ?", id)
    expect(await contentOf(id)).toBe(`${ZWSP}kept${ZWSP}`)
  })
})

// ── updateMemory / updateTenantMemory ────────────────────────────────────────

describe('updateMemory and updateTenantMemory refuse blank content', () => {
  it.each(Object.entries(BLANKS))('updateMemory with %s throws, the text stays and no version row is written', async (_name, text) => {
    const id = await insertRow('the memory')
    await expect(updateMemory(id, text)).rejects.toBeInstanceOf(BlankContentError)
    expect(await contentOf(id)).toBe('the memory')
    expect(((await dbx.get('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?', id)) as { n: number }).n).toBe(0)
  })

  it('updateMemory still updates with real text (and keeps the old text as a version)', async () => {
    const id = await insertRow('old')
    await expect(updateMemory(id, 'new')).resolves.toBe(true)
    expect(await contentOf(id)).toBe('new')
    expect(((await dbx.get('SELECT content FROM memory_versions WHERE memory_id = ?', id)) as { content: string }).content).toBe('old')
  })

  it.each(Object.entries(BLANKS))('updateTenantMemory with %s throws and the text stays', async (_name, text) => {
    const id = await insertRow('the memory')
    await expect(updateTenantMemory('default', id, { content: text })).rejects.toBeInstanceOf(BlankContentError)
    expect(await contentOf(id)).toBe('the memory')
  })

  it('updateTenantMemory with only a category (no content) is untouched by the check', async () => {
    const id = await insertRow('the memory')
    await expect(updateTenantMemory('default', id, { category: 'cold' })).resolves.toBe(true)
    expect(await contentOf(id)).toBe('the memory')
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
const count = async (table: string): Promise<number> => ((await dbx.get(`SELECT COUNT(*) AS n FROM ${table}`)) as { n: number }).n

describe('upsertImportMemory with a source that came out blank', () => {
  it.each(Object.entries(BLANKS))('%s: the existing memory, its embedding and the import row stay as they were', async (_name, text) => {
    await source()
    expect(await upsert('note.md', 'h1', 'the real text')).toBe('added')
    const shadow = (await dbx.get("SELECT id FROM memories WHERE agent_id = 'import'")) as { id: number }
    await dbx.run('UPDATE memories SET embedding_blob = ? WHERE id = ?', Buffer.from([1, 2, 3, 4]), shadow.id)
    const before = await dbx.get('SELECT * FROM memories WHERE id = ?', shadow.id)
    const importBefore = await dbx.get('SELECT * FROM import_memories')

    expect(await upsert('note.md', 'h2-the-file-was-emptied', text)).toBe('skipped_blank')

    expect(await dbx.get('SELECT * FROM memories WHERE id = ?', shadow.id)).toEqual(before)
    expect(await dbx.get('SELECT * FROM import_memories')).toEqual(importBefore)
  })

  it('a blank source that was never imported adds no import row and no memory', async () => {
    await source()
    expect(await upsert('empty.md', 'h1', ZWSP)).toBe('skipped_blank')
    expect(await count('import_memories')).toBe(0)
    expect(await count('memories')).toBe(0)
  })

  it('the file refilled later updates the memory as usual', async () => {
    await source()
    await upsert('note.md', 'h1', 'first')
    await upsert('note.md', 'h2', '')
    expect(await upsert('note.md', 'h3', 'second')).toBe('updated')
    expect(await dbx.get("SELECT content FROM memories WHERE agent_id = 'import'")).toEqual({ content: 'second' })
  })
})
