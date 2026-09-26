// Coverage for src/db/connection.ts's own mechanics (permission tightening,
// idempotent re-init, the delivered-without-timestamp self-healing trigger,
// the from/to_agent lowercase backfill, and the legacy task-run-history.json
// one-shot import) -- these are exercised only indirectly (via db.js's
// re-exported domain functions) by the rest of the suite, never directly
// against connection.ts's own exports. Real on-disk SQLite files are used
// (not ':memory:') since several of the behaviors under test (permission
// bits, data surviving a close+reopen cycle) require a real file.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  return { TMP_ROOT: mkdtempSync(join(tmpdir(), 'db-connection-test-')) }
})

vi.mock('../config.js', () => ({ STORE_DIR: TMP_ROOT, DB_FILENAME: 'test.db' }))
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { initDatabase, getDb, closeDatabase, tryLoadVecExtension } from '../db/connection.js'

afterAll(() => {
  closeDatabase()
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe('initDatabase against a real on-disk file', () => {
  const dbPath = join(TMP_ROOT, 'main.db')

  it('opens the file, runs migrations, and getDb() returns the live handle', () => {
    initDatabase(dbPath)
    const db = getDb()
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_messages'").get()
    expect(row).toBeTruthy()
  })

  it('tightens the main DB file to owner-only (0600)', () => {
    const mode = statSync(dbPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('is idempotent: re-init on the same path closes the old handle and preserves data', () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('agent-a', 'agent-b', 'hello', 'pending', now)

    expect(() => initDatabase(dbPath)).not.toThrow()

    const row = getDb().prepare('SELECT content FROM agent_messages WHERE from_agent = ?').get('agent-a') as
      { content: string } | undefined
    expect(row?.content).toBe('hello')
  })

  it('the delivered-without-timestamp trigger self-heals a status flip with no delivered_at', () => {
    const now = Math.floor(Date.now() / 1000)
    const db = getDb()
    const info = db.prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('agent-c', 'agent-d', 'closed elsewhere', 'pending', now)

    db.prepare('UPDATE agent_messages SET status = ? WHERE id = ?').run('delivered', info.lastInsertRowid)

    const row = db.prepare('SELECT delivered_at, result FROM agent_messages WHERE id = ?').get(info.lastInsertRowid) as
      { delivered_at: number | null; result: string | null }
    expect(row.delivered_at).not.toBeNull()
    expect(row.result).toBe('closed-without-delivery')
  })

  it('does not overwrite an existing result when self-healing delivered_at', () => {
    const now = Math.floor(Date.now() / 1000)
    const db = getDb()
    const info = db.prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, result) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('agent-e', 'agent-f', 'msg', 'pending', now, 'already-had-a-result')

    db.prepare('UPDATE agent_messages SET status = ? WHERE id = ?').run('delivered', info.lastInsertRowid)

    const row = db.prepare('SELECT result FROM agent_messages WHERE id = ?').get(info.lastInsertRowid) as
      { result: string }
    expect(row.result).toBe('already-had-a-result')
  })

  it('a normal delivered update that already carries delivered_at is left untouched', () => {
    const now = Math.floor(Date.now() / 1000)
    const db = getDb()
    const info = db.prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('agent-g', 'agent-h', 'msg', 'pending', now)

    db.prepare('UPDATE agent_messages SET status = ?, delivered_at = ? WHERE id = ?')
      .run('delivered', now, info.lastInsertRowid)

    const row = db.prepare('SELECT delivered_at, result FROM agent_messages WHERE id = ?').get(info.lastInsertRowid) as
      { delivered_at: number; result: string | null }
    expect(row.delivered_at).toBe(now)
    expect(row.result).toBeNull()
  })

  it('folds a mixed-case federation prefix to lowercase on the next init pass, keeping the peer segment case', () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('Teodor/AgentName', 'local-agent', 'federated hello', 'pending', now)
    // A same-system (no '/') id must be left alone by the fold.
    getDb().prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('plain-agent', 'local-agent', 'local hello', 'pending', now)

    // The fold runs unconditionally on every initDatabase() call, so a second
    // pass over the same file is what applies it to the rows above.
    initDatabase(dbPath)

    const rows = getDb().prepare(
      "SELECT from_agent FROM agent_messages WHERE content IN ('federated hello', 'local hello') ORDER BY content",
    ).all() as { from_agent: string }[]
    const byContent = Object.fromEntries(
      rows.map((r, i) => [i === 0 ? 'federated hello' : 'local hello', r.from_agent]),
    )
    expect(byContent['federated hello']).toBe('teodor/AgentName')
    expect(byContent['local hello']).toBe('plain-agent')
  })

  it('the fold is idempotent: a third pass leaves an already-lowercase prefix unchanged', () => {
    initDatabase(dbPath)
    const row = getDb().prepare(
      "SELECT from_agent FROM agent_messages WHERE content = 'federated hello'",
    ).get() as { from_agent: string }
    expect(row.from_agent).toBe('teodor/AgentName')
  })
})

describe('initDatabase(":memory:")', () => {
  it('skips file pre-create and permission tightening, and still runs migrations', () => {
    expect(() => initDatabase(':memory:')).not.toThrow()
    const row = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_runs'").get()
    expect(row).toBeTruthy()
  })
})

describe('legacy task-run-history.json one-shot import', () => {
  it('imports valid rows, skips malformed ones, and renames the file so it never re-imports', () => {
    const legacyPath = join(TMP_ROOT, 'task-run-history.json')
    writeFileSync(legacyPath, JSON.stringify([
      { name: 'morning-chain', agent: 'agent-a', ts: 1700000000 },
      { name: 'missing-ts', agent: 'agent-b' }, // malformed: dropped
      'not-an-object', // malformed: dropped
    ]))

    const importDbPath = join(TMP_ROOT, 'import.db')
    initDatabase(importDbPath)

    const rows = getDb().prepare('SELECT name, agent, ts FROM task_runs').all() as
      { name: string; agent: string; ts: number }[]
    expect(rows).toEqual([{ name: 'morning-chain', agent: 'agent-a', ts: 1700000000 }])
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true)
  })

  it('does not re-import on a later init once task_runs already has rows', () => {
    const legacyPath = join(TMP_ROOT, 'import.db').replace(/import\.db$/, 'task-run-history.json')
    // Re-create a legacy file with a NEW row; since task_runs is already
    // non-empty for this DB, initDatabase must leave it alone (only rename
    // the file out of the way) rather than importing it again.
    writeFileSync(legacyPath, JSON.stringify([{ name: 'should-not-import', agent: 'agent-z', ts: 1 }]))

    initDatabase(join(TMP_ROOT, 'import.db'))

    const rows = getDb().prepare("SELECT name FROM task_runs WHERE name = 'should-not-import'").all()
    expect(rows).toEqual([])
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true)
  })

  it('a corrupt JSON legacy file is skipped without throwing', () => {
    const corruptDbPath = join(TMP_ROOT, 'corrupt.db')
    const legacyPath = join(TMP_ROOT, 'task-run-history.json')
    writeFileSync(legacyPath, '{ not valid json')

    expect(() => initDatabase(corruptDbPath)).not.toThrow()
    // Left in place -- the corrupt-JSON catch path never reaches the rename.
    expect(readFileSync(legacyPath, 'utf-8')).toBe('{ not valid json')
  })
})

describe('tryLoadVecExtension', () => {
  it('does not throw whether or not the native extension is available', () => {
    initDatabase(':memory:')
    expect(() => tryLoadVecExtension()).not.toThrow()
  })
})

describe('closeDatabase', () => {
  it('is safe to call twice in a row', () => {
    initDatabase(':memory:')
    expect(() => closeDatabase()).not.toThrow()
    expect(() => closeDatabase()).not.toThrow()
  })
})
