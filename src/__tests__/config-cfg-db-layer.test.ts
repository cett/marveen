import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSystemConfigTable, resolveCfgPrecedence, resolveCfgWithSource } from '../config.js'

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
    expect(resolveCfgPrecedence({ db: 'from-db', secret: 'from-secret', env: 'from-env' })).toBe('from-db')
  })

  it('falls to /run/secrets when there is no DB value', () => {
    expect(resolveCfgPrecedence({ secret: 'from-secret', env: 'from-env' })).toBe('from-secret')
  })

  it('falls to .env as the last resort', () => {
    expect(resolveCfgPrecedence({ env: 'from-env' })).toBe('from-env')
  })

  it('returns undefined when nothing is set', () => {
    expect(resolveCfgPrecedence({})).toBeUndefined()
  })

  it('treats an empty-string candidate as absent and falls through', () => {
    expect(resolveCfgPrecedence({ db: '', secret: '', env: 'from-env' })).toBe('from-env')
  })
})

// S8B: config-overrides.json (and the 'override' resolution layer/source) was
// retired -- resolveCfgWithSource now only ever attributes to db/secret/env.
describe('resolveCfgWithSource', () => {
  it('reports source "db" when the DB value wins', () => {
    expect(resolveCfgWithSource({ db: 'from-db', secret: 'from-secret', env: 'from-env' })).toEqual({
      value: 'from-db',
      source: 'db',
    })
  })

  it('reports source "secret" when /run/secrets wins (no DB value)', () => {
    expect(resolveCfgWithSource({ secret: 'from-secret', env: 'from-env' })).toEqual({
      value: 'from-secret',
      source: 'secret',
    })
  })

  it('reports source "env" when .env is the only candidate', () => {
    expect(resolveCfgWithSource({ env: 'from-env' })).toEqual({ value: 'from-env', source: 'env' })
  })

  it('reports an undefined source when nothing is set', () => {
    expect(resolveCfgWithSource({})).toEqual({ value: undefined, source: undefined })
  })

  it('treats an empty-string candidate as absent for source attribution too', () => {
    expect(resolveCfgWithSource({ db: '', secret: '', env: 'from-env' })).toEqual({
      value: 'from-env',
      source: 'env',
    })
  })

  it('resolveCfgPrecedence stays a pure value-only view of the same resolution', () => {
    const candidates = { secret: 'from-secret', env: 'from-env' }
    expect(resolveCfgPrecedence(candidates)).toBe(resolveCfgWithSource(candidates).value)
  })
})
