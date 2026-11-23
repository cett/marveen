// ensureConfigSnapshot(): the single bootstrap step that loads the system_config snapshot for a process. The loader is mocked
// (the rules of the loader itself are in config-snapshot-loader.test.ts); these cells pin the call rules: no URL means no load,
// the load happens once per process, and a failed load rejects with a message that names the step, never the URL.
// Privacy: the URL is a placeholder with a placeholder password.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ loads: 0, urls: [] as string[], throws: false }))

const PG_URL = 'postgres://user:placeholder-password@db.invalid:5432/marveen'
let envDir = ''

beforeEach(() => {
  state.loads = 0
  state.urls = []
  state.throws = false
  // an empty .env directory: the URL can come from the process environment only
  envDir = mkdtempSync(join(tmpdir(), 'carl-config-bootstrap-'))
  vi.stubEnv('CLAUDECLAW_ENV_DIR', envDir)
  vi.stubEnv('MARVEEN_PG_URL', '')
  vi.resetModules()
  vi.doMock('../config-snapshot-loader.js', () => ({
    loadSystemConfigSnapshot: (url: string) => {
      state.loads++
      state.urls.push(url)
      if (state.throws) throw new Error('system_config snapshot could not be read (no error code)')
      return { SCHEDULER_TZ: 'Asia/Tokyo' }
    },
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(envDir, { recursive: true, force: true })
})

describe('ensureConfigSnapshot', () => {
  it('an install on SQLite (no URL): nothing is loaded and no snapshot is set', async () => {
    const { ensureConfigSnapshot } = await import('../config-bootstrap.js')
    const snapshot = await import('../config-snapshot.js')
    await ensureConfigSnapshot()
    expect(state.loads).toBe(0)
    expect(snapshot.getConfigSnapshot()).toBeUndefined()
  })

  it('a PostgreSQL URL: the snapshot is loaded from that URL and set for the process', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    const { ensureConfigSnapshot } = await import('../config-bootstrap.js')
    const snapshot = await import('../config-snapshot.js')
    await ensureConfigSnapshot()
    expect(state.loads).toBe(1)
    expect(state.urls).toEqual([PG_URL])
    expect(snapshot.getConfigSnapshot()).toEqual({ SCHEDULER_TZ: 'Asia/Tokyo' })
  })

  it('called twice: the snapshot is loaded once, and the second call waits for the same load', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    const { ensureConfigSnapshot } = await import('../config-bootstrap.js')
    await ensureConfigSnapshot()
    await ensureConfigSnapshot()
    expect(state.loads).toBe(1)
  })

  it('a failed load rejects, and the message names the snapshot step, never the URL or the password', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    state.throws = true
    const { ensureConfigSnapshot } = await import('../config-bootstrap.js')
    const err = await ensureConfigSnapshot().catch((e: Error) => e)
    expect((err as Error).message).toContain('system_config snapshot could not be read')
    expect((err as Error).message).not.toContain('placeholder-password')
    expect((err as Error).message).not.toContain('db.invalid')
  })

  it('after a failed load, the next call rejects too: a caller cannot continue past it by calling again', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    state.throws = true
    const { ensureConfigSnapshot } = await import('../config-bootstrap.js')
    await expect(ensureConfigSnapshot()).rejects.toThrow('system_config snapshot could not be read')
    await expect(ensureConfigSnapshot()).rejects.toThrow('system_config snapshot could not be read')
    expect(state.loads).toBe(1)
  })
})
