import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { InflightRestoreEnv, PersistedInflight } from '../web/schedule-inflight-store.js'

// The durable mirror of the runner's in-flight map (schedule-inflight-store.ts): the writes (real database, a
// fresh :memory: instance per test) and the strict read-back validation (pure). The session and host of a stored
// entry become tmux / ssh targets, so the read-back accepts only what the runner derives for that agent today.

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

let dbMod: typeof import('../db.js')
let conn: typeof import('../db/connection.js')
let store: typeof import('../web/schedule-inflight-store.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'inflight-store-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  conn = await import('../db/connection.js')
  store = await import('../web/schedule-inflight-store.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

function stored(): Record<string, Record<string, unknown>> | undefined {
  const row = conn.db.prepare('SELECT value FROM system_config WHERE key = ?').get('scheduled_inflight') as { value: string } | undefined
  return row ? (JSON.parse(row.value) as Record<string, Record<string, unknown>>) : undefined
}

const NOW = 1_800_000_000_000
const MAX_TRACK = 6 * 60 * 60_000

function entry(over: Partial<PersistedInflight> = {}): PersistedInflight {
  return {
    taskName: 'task-a',
    agentName: 'agent-a',
    session: 'agent-agent-a',
    host: null,
    injectedAt: NOW - 60_000,
    alerted: false,
    sawTurn: false,
    timeoutMs: 300_000,
    blackboardSnapshot: { status: 'active', summary: 'running task-a', task_ref: null },
    ...over,
  }
}

const env: InflightRestoreEnv = {
  now: NOW,
  maxTrackMs: MAX_TRACK,
  isKnownAgent: (n) => n === 'agent-a' || n === 'agent-b',
  sessionFor: (n) => `agent-${n}`,
  hostFor: (n) => (n === 'agent-b' ? 'remote-host-1' : null),
}

describe('persist writes', () => {
  it('an upsert stores exactly the persisted fields (no workingDir, configDir or restored marker)', async () => {
    const withExtras = { ...entry(), workingDir: '/some/dir', configDir: '/some/config', restored: true }
    await store.persistInflightUpsert(withExtras)
    const all = stored()!
    expect(Object.keys(all)).toEqual(['task-a@agent-a'])
    expect(Object.keys(all['task-a@agent-a']!).sort()).toEqual(
      ['agentName', 'alerted', 'blackboardSnapshot', 'host', 'injectedAt', 'sawTurn', 'session', 'taskName', 'timeoutMs'])
  })

  it('two concurrent upserts for two keys both land (the read-modify-write loses nothing)', async () => {
    await Promise.all([
      store.persistInflightUpsert(entry({ taskName: 'task-a' })),
      store.persistInflightUpsert(entry({ taskName: 'task-b' })),
      store.persistInflightUpsert(entry({ taskName: 'task-c', agentName: 'agent-b', session: 'agent-agent-b', host: 'remote-host-1' })),
    ])
    expect(Object.keys(stored()!).sort()).toEqual(['task-a@agent-a', 'task-b@agent-a', 'task-c@agent-b'])
  })

  it('an upsert on an existing key replaces the older entry', async () => {
    await store.persistInflightUpsert(entry({ injectedAt: NOW - 120_000 }))
    await store.persistInflightUpsert(entry({ injectedAt: NOW - 10_000 }))
    expect(stored()!['task-a@agent-a']!['injectedAt']).toBe(NOW - 10_000)
  })

  it('a remove deletes only its key', async () => {
    await store.persistInflightUpsert(entry({ taskName: 'task-a' }))
    await store.persistInflightUpsert(entry({ taskName: 'task-b' }))
    await store.persistInflightRemove('task-a@agent-a')
    expect(Object.keys(stored()!)).toEqual(['task-b@agent-a'])
  })

  it('a remove of a key that is not stored writes nothing', async () => {
    await store.persistInflightUpsert(entry())
    const before = conn.db.prepare('SELECT value, updated_at FROM system_config WHERE key = ?').get('scheduled_inflight')
    await store.persistInflightRemove('nothing@agent-a')
    expect(conn.db.prepare('SELECT value, updated_at FROM system_config WHERE key = ?').get('scheduled_inflight')).toEqual(before)
  })

  it('a remove with no stored value at all creates no row', async () => {
    await store.persistInflightRemove('task-a@agent-a')
    expect(stored()).toBeUndefined()
  })

  it('flags update the stored entry and keep the other fields', async () => {
    await store.persistInflightUpsert(entry())
    await store.persistInflightFlags('task-a@agent-a', { alerted: true, sawTurn: true })
    const e = stored()!['task-a@agent-a']!
    expect(e['alerted']).toBe(true)
    expect(e['sawTurn']).toBe(true)
    expect(e['session']).toBe('agent-agent-a')
    expect(e['injectedAt']).toBe(NOW - 60_000)
  })

  it('flags for a key that was already removed do not resurrect it', async () => {
    await store.persistInflightUpsert(entry())
    await store.persistInflightRemove('task-a@agent-a')
    await store.persistInflightFlags('task-a@agent-a', { alerted: true, sawTurn: true })
    expect(stored()).toEqual({})
  })

  it('a write survives a corrupt stored value (starts from empty)', async () => {
    await dbMod.setSystemConfig('scheduled_inflight', '{not json')
    await store.persistInflightUpsert(entry())
    expect(Object.keys(stored()!)).toEqual(['task-a@agent-a'])
  })

  it('a write survives a stored value that is a JSON array (starts from empty)', async () => {
    await dbMod.setSystemConfig('scheduled_inflight', '[1,2]')
    await store.persistInflightUpsert(entry())
    expect(Object.keys(stored()!)).toEqual(['task-a@agent-a'])
  })

  it('a failing database write is swallowed and logged, never thrown', async () => {
    const { logger } = await import('../logger.js')
    conn.db.close()
    await expect(store.persistInflightUpsert(entry())).resolves.toBeUndefined()
    await expect(store.persistInflightRemove('task-a@agent-a')).resolves.toBeUndefined()
    await expect(store.persistInflightFlags('task-a@agent-a', { alerted: true, sawTurn: true })).resolves.toBeUndefined()
    expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

describe('parseStoredInflight', () => {
  const raw = (o: unknown): string => JSON.stringify(o)

  it('loads a valid entry, local and remote', () => {
    const remote = entry({ taskName: 'task-r', agentName: 'agent-b', session: 'agent-agent-b', host: 'remote-host-1' })
    const r = store.parseStoredInflight(raw({ 'task-a@agent-a': entry(), 'task-r@agent-b': remote }), env)
    expect(r.corrupt).toBe(false)
    expect(r.dropped).toEqual([])
    expect([...r.entries.keys()]).toEqual(['task-a@agent-a', 'task-r@agent-b'])
    expect(r.entries.get('task-a@agent-a')).toEqual(entry())
  })

  it('no stored value is an empty, non-corrupt result', () => {
    const r = store.parseStoredInflight(undefined, env)
    expect(r.entries.size).toBe(0)
    expect(r.corrupt).toBe(false)
  })

  it.each(['{not json', '[]', '"text"', '42', 'null'])('a value that is not a JSON object (%s) is corrupt and loads nothing', (value) => {
    const r = store.parseStoredInflight(value, env)
    expect(r.corrupt).toBe(true)
    expect(r.entries.size).toBe(0)
  })

  const bad: Array<[string, unknown, string]> = [
    ['a free-text session', entry({ session: 'agent-agent-a; touch /tmp/x' }), 'bad-session'],
    ['another valid-looking session', entry({ session: 'agent-agent-b' }), 'bad-session'],
    ['a host on a local agent', entry({ host: 'remote-host-1' }), 'bad-host'],
    ['an unknown host on a remote agent', entry({ taskName: 't', agentName: 'agent-b', session: 'agent-agent-b', host: 'evil-host' }), 'bad-host'],
    ['no host on a remote agent', entry({ taskName: 't', agentName: 'agent-b', session: 'agent-agent-b', host: null }), 'bad-host'],
    ['an unknown agent', entry({ agentName: 'agent-z', session: 'agent-agent-z' }), 'unknown-agent'],
    ['a path-like agent', entry({ agentName: '../agent-a', session: 'agent-../agent-a' }), 'unknown-agent'],
    ['a task name with a control character', entry({ taskName: 'task\na' }), 'bad-name'],
    ['an empty task name', entry({ taskName: '' }), 'bad-name'],
    ['an over-long task name', entry({ taskName: 'x'.repeat(201) }), 'bad-name'],
    ['an injectedAt in the future', entry({ injectedAt: NOW + 61_000 }), 'injected-in-future'],
    ['an injectedAt exactly at the max-track age', entry({ injectedAt: NOW - MAX_TRACK }), 'older-than-max-track'],
    ['an injectedAt older than the max-track age', entry({ injectedAt: NOW - MAX_TRACK - 1 }), 'older-than-max-track'],
    ['a non-finite injectedAt', { ...entry(), injectedAt: null }, 'bad-injected-at'],
    ['a string injectedAt', { ...entry(), injectedAt: String(NOW) }, 'bad-injected-at'],
    ['a non-boolean alerted', { ...entry(), alerted: 'yes' }, 'bad-flags'],
    ['a non-boolean sawTurn', { ...entry(), sawTurn: 1 }, 'bad-flags'],
    ['a timeout below one minute', entry({ timeoutMs: 59_999 }), 'bad-timeout'],
    ['a timeout above the max-track age', entry({ timeoutMs: MAX_TRACK + 1 }), 'bad-timeout'],
    ['a snapshot with a non-string status', { ...entry(), blackboardSnapshot: { status: 1, summary: 's', task_ref: null } }, 'bad-snapshot'],
    ['a snapshot that is an array', { ...entry(), blackboardSnapshot: [] }, 'bad-snapshot'],
    ['a snapshot with an over-long summary', { ...entry(), blackboardSnapshot: { status: 'active', summary: 's'.repeat(2001), task_ref: null } }, 'bad-snapshot'],
    ['an entry that is not an object', 'text', 'not-an-object'],
  ]

  it.each(bad)('drops %s and still loads the valid neighbour', (_label, badEntry, reason) => {
    const key = (badEntry as { taskName?: string; agentName?: string }).taskName !== undefined
      ? `${(badEntry as { taskName: string }).taskName}@${(badEntry as { agentName: string }).agentName}`
      : 'bad@agent-a'
    const r = store.parseStoredInflight(raw({ [key]: badEntry, 'good@agent-a': entry({ taskName: 'good' }) }), env)
    expect(r.dropped.map((d) => d.reason)).toContain(reason)
    expect([...r.entries.keys()]).toEqual(['good@agent-a'])
    expect(r.corrupt).toBe(false)
  })

  it('drops an entry whose key does not match its task and agent', () => {
    const r = store.parseStoredInflight(raw({ 'other@agent-a': entry() }), env)
    expect(r.dropped).toEqual([{ key: 'other@agent-a', reason: 'key-mismatch' }])
  })

  it('accepts an injectedAt one millisecond inside the max-track age and one minute ahead', () => {
    const r = store.parseStoredInflight(raw({
      'task-a@agent-a': entry({ injectedAt: NOW - MAX_TRACK + 1 }),
      'task-b@agent-a': entry({ taskName: 'task-b', injectedAt: NOW + 60_000 }),
    }), env)
    expect(r.entries.size).toBe(2)
  })

  it('accepts a missing or null snapshot (an entry that never wrote a blackboard row)', () => {
    const r = store.parseStoredInflight(raw({
      'task-a@agent-a': { ...entry(), blackboardSnapshot: undefined },
      'task-b@agent-a': { ...entry({ taskName: 'task-b' }), blackboardSnapshot: null },
    }), env)
    expect(r.entries.size).toBe(2)
    expect(r.entries.get('task-a@agent-a')!.blackboardSnapshot).toBeUndefined()
    expect(r.entries.get('task-b@agent-a')!.blackboardSnapshot).toBeUndefined()
  })

  it('does not pass extra stored fields through (a stored workingDir is ignored)', () => {
    const r = store.parseStoredInflight(raw({ 'task-a@agent-a': { ...entry(), workingDir: '/etc', configDir: '/etc', restored: false } }), env)
    const loaded = r.entries.get('task-a@agent-a') as unknown as Record<string, unknown>
    expect(loaded['workingDir']).toBeUndefined()
    expect(loaded['configDir']).toBeUndefined()
    expect(loaded['restored']).toBeUndefined()
  })
})

describe('persistInflightCleanup', () => {
  it('a corrupt value is deleted', async () => {
    await dbMod.setSystemConfig('scheduled_inflight', '{not json')
    await store.persistInflightCleanup(store.parseStoredInflight('{not json', env))
    expect(stored()).toBeUndefined()
  })

  it('a value with dropped entries is rewritten without them', async () => {
    const value = JSON.stringify({ 'task-a@agent-a': entry(), 'bad@agent-a': entry({ session: 'agent-x; id' }) })
    await dbMod.setSystemConfig('scheduled_inflight', value)
    await store.persistInflightCleanup(store.parseStoredInflight(value, env))
    expect(Object.keys(stored()!)).toEqual(['task-a@agent-a'])
  })

  it('a fully valid value is left untouched (no write)', async () => {
    const value = JSON.stringify({ 'task-a@agent-a': entry() })
    await dbMod.setSystemConfig('scheduled_inflight', value)
    const before = conn.db.prepare('SELECT value, updated_at FROM system_config WHERE key = ?').get('scheduled_inflight')
    await store.persistInflightCleanup(store.parseStoredInflight(value, env))
    expect(conn.db.prepare('SELECT value, updated_at FROM system_config WHERE key = ?').get('scheduled_inflight')).toEqual(before)
  })
})
