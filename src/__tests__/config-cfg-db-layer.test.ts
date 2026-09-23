import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSystemConfigTable, resolveCfgPrecedence } from '../config.js'

describe('readSystemConfigTable', () => {
  it('returns {} when the DB file does not exist', () => {
    expect(readSystemConfigTable('/tmp/definitely-not-a-real-marveen-db-file.sqlite')).toEqual({})
  })

  it('returns {} when the file exists but has no system_config table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-db-layer-'))
    const dbPath = join(dir, 'no-table.db')
    try {
      const db = new Database(dbPath)
      db.exec('CREATE TABLE other_table (id INTEGER PRIMARY KEY)')
      db.close()
      expect(readSystemConfigTable(dbPath)).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads every key/value row into a flat map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-db-layer-'))
    const dbPath = join(dir, 'with-table.db')
    try {
      const db = new Database(dbPath)
      db.exec(
        `CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()), source TEXT NOT NULL DEFAULT 'db')`
      )
      db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run('OLLAMA_URL', 'http://box:11434')
      db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run('DASHBOARD_PUBLIC_URL', 'https://box.example')
      db.close()

      expect(readSystemConfigTable(dbPath)).toEqual({
        OLLAMA_URL: 'http://box:11434',
        DASHBOARD_PUBLIC_URL: 'https://box.example',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveCfgPrecedence', () => {
  it('prefers the DB value over every other layer', () => {
    expect(
      resolveCfgPrecedence({ db: 'from-db', override: 'from-override', secret: 'from-secret', env: 'from-env' })
    ).toBe('from-db')
  })

  it('falls to config-overrides.json when there is no DB value', () => {
    expect(resolveCfgPrecedence({ override: 'from-override', secret: 'from-secret', env: 'from-env' })).toBe(
      'from-override'
    )
  })

  it('falls to /run/secrets when there is no DB or override value', () => {
    expect(resolveCfgPrecedence({ secret: 'from-secret', env: 'from-env' })).toBe('from-secret')
  })

  it('falls to .env as the last resort', () => {
    expect(resolveCfgPrecedence({ env: 'from-env' })).toBe('from-env')
  })

  it('returns undefined when nothing is set', () => {
    expect(resolveCfgPrecedence({})).toBeUndefined()
  })

  it('treats an empty-string candidate as absent and falls through', () => {
    expect(resolveCfgPrecedence({ db: '', override: '', secret: '', env: 'from-env' })).toBe('from-env')
  })
})
