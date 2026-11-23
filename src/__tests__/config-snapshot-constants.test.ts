// The 11 constants that config.ts computes from system_config (the cfg() readers) take the same value from a PostgreSQL snapshot
// as from the SQLite file, for the same key. Each case runs twice in fresh module instances: once with a stale SQLite file
// holding the value (the SQLite path), once with the snapshot holding it and a PostgreSQL URL set (the snapshot path). The two
// constants must be equal, and equal to the value that was written. Privacy: placeholder values only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const NAMES = [
  'SCHEDULER_TZ_CONFIGURED', 'APP_TZ', 'APP_TZ_INVALID', 'DASHBOARD_PUBLIC_URL', 'OLLAMA_URL',
  'HEARTBEAT_AGENT_ENABLED', 'SUBAGENT_INBOX_TEE', 'SUBAGENT_TELEGRAM_WAKE_ENABLED',
  'HEARTBEAT_CALENDAR_ACCOUNT', 'HEARTBEAT_CALENDAR_ID', 'DEFAULT_AGENT_MODEL',
] as const

let root: string
let storeFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'carl-config-constants-'))
  mkdirSync(join(root, 'store'))
  storeFile = join(root, 'store', 'claudeclaw.db')
  process.env.MARVEEN_STORE_DIR = join(root, 'store')
  delete process.env.MARVEEN_PG_URL
  vi.resetModules()
})

afterEach(() => {
  delete process.env.MARVEEN_STORE_DIR
  delete process.env.MARVEEN_PG_URL
  rmSync(root, { recursive: true, force: true })
})

const PG_URL = 'postgres://user:placeholder@db.invalid:5432/marveen'

async function pickFromSqlite(key: string, value: string): Promise<Record<string, unknown>> {
  const db = new Database(storeFile)
  db.exec('CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run(key, value)
  db.close()
  vi.resetModules()
  const c = (await import('../config.js')) as unknown as Record<string, unknown>
  return Object.fromEntries(NAMES.map((n) => [n, c[n]]))
}

async function pickFromSnapshot(key: string, value: string): Promise<Record<string, unknown>> {
  process.env.MARVEEN_PG_URL = PG_URL
  vi.resetModules()
  const snap = await import('../config-snapshot.js')
  snap.setConfigSnapshot({ [key]: value })
  const c = (await import('../config.js')) as unknown as Record<string, unknown>
  return Object.fromEntries(NAMES.map((n) => [n, c[n]]))
}

// The key, the value written for it, and the constants it moves (the expected value of each is listed in the cell).
const CASES: { key: string; value: string; constant: string; expected: unknown }[] = [
  { key: 'SCHEDULER_TZ', value: 'Asia/Tokyo', constant: 'APP_TZ', expected: 'Asia/Tokyo' },
  { key: 'SCHEDULER_TZ', value: 'Asia/Tokyo', constant: 'SCHEDULER_TZ_CONFIGURED', expected: 'Asia/Tokyo' },
  { key: 'SCHEDULER_TZ', value: 'Not/AZone', constant: 'APP_TZ_INVALID', expected: 'Not/AZone' },
  { key: 'DASHBOARD_PUBLIC_URL', value: 'https://dashboard.example.invalid', constant: 'DASHBOARD_PUBLIC_URL', expected: 'https://dashboard.example.invalid' },
  { key: 'OLLAMA_URL', value: 'http://ollama.example.invalid:11434', constant: 'OLLAMA_URL', expected: 'http://ollama.example.invalid:11434' },
  { key: 'HEARTBEAT_AGENT_ENABLED', value: 'true', constant: 'HEARTBEAT_AGENT_ENABLED', expected: true },
  { key: 'SUBAGENT_INBOX_TEE', value: 'true', constant: 'SUBAGENT_INBOX_TEE', expected: true },
  { key: 'SUBAGENT_TELEGRAM_WAKE_ENABLED', value: 'true', constant: 'SUBAGENT_TELEGRAM_WAKE_ENABLED', expected: true },
  { key: 'HEARTBEAT_CALENDAR_ACCOUNT', value: 'calendar-account-placeholder', constant: 'HEARTBEAT_CALENDAR_ACCOUNT', expected: 'calendar-account-placeholder' },
  { key: 'HEARTBEAT_CALENDAR_ID', value: 'calendar-id-placeholder', constant: 'HEARTBEAT_CALENDAR_ID', expected: 'calendar-id-placeholder' },
  { key: 'DEFAULT_AGENT_MODEL', value: 'model-placeholder', constant: 'DEFAULT_AGENT_MODEL', expected: 'model-placeholder' },
]

describe('the constants that config.ts computes from system_config take the snapshot value, as the SQLite file does', () => {
  it.each(CASES)('$constant from $key=$value: the snapshot gives the SQLite value', async ({ key, value, constant, expected }) => {
    const fromSqlite = await pickFromSqlite(key, value)
    const fromSnapshot = await pickFromSnapshot(key, value)
    expect(fromSnapshot[constant]).toEqual(fromSqlite[constant])
    expect(fromSnapshot[constant]).toEqual(expected)
  })
})
