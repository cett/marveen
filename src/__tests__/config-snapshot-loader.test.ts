// The system_config snapshot loader (config-snapshot-loader.ts) against a mocked driver: the rules that do not need a server.
// The same rules against a real PostgreSQL are in pg/config-snapshot-loader.pg.test.ts (pg-parity job).
//
// Privacy: the URL in these cells is a placeholder with a placeholder password; the cells check that neither appears in a thrown
// message.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  connectError: null as unknown,
  queryError: null as unknown,
  rows: [] as { key: string; value: string }[],
  ended: 0,
  opts: undefined as unknown,
}))

vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(opts: unknown) { state.opts = opts }
      connect(): Promise<void> { return state.connectError ? Promise.reject(state.connectError) : Promise.resolve() }
      query(): Promise<{ rows: unknown[] }> {
        return state.queryError ? Promise.reject(state.queryError) : Promise.resolve({ rows: state.rows })
      }
      end(): Promise<void> { state.ended++; return Promise.resolve() }
    },
  },
}))

import { loadSystemConfigSnapshot } from '../config-snapshot-loader.js'

const URL_PLACEHOLDER = 'postgres://user:placeholder-password@db.invalid:5432/marveen'

function driverError(code: string | undefined, message: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string }
  if (code !== undefined) err.code = code
  return err
}

beforeEach(() => {
  state.connectError = null
  state.queryError = null
  state.rows = []
  state.ended = 0
})

describe('loadSystemConfigSnapshot', () => {
  it('returns the rows as a key -> value map', async () => {
    state.rows = [{ key: 'SCHEDULER_TZ', value: 'Europe/Budapest' }, { key: 'OLLAMA_URL', value: 'http://localhost:11434' }]
    expect(await loadSystemConfigSnapshot(URL_PLACEHOLDER)).toEqual({
      SCHEDULER_TZ: 'Europe/Budapest',
      OLLAMA_URL: 'http://localhost:11434',
    })
  })

  it('SQLSTATE 42P01 (no system_config table yet) is an empty snapshot, matched by the code', async () => {
    state.queryError = driverError('42P01', 'relation "system_config" does not exist')
    expect(await loadSystemConfigSnapshot(URL_PLACEHOLDER)).toEqual({})
  })

  it('a different code with the same text throws: the match is on the code, never on the message', async () => {
    state.queryError = driverError('42703', 'relation "system_config" does not exist')
    await expect(loadSystemConfigSnapshot(URL_PLACEHOLDER)).rejects.toThrow('SQLSTATE 42703')
  })

  it('a permission error (42501) throws, it is not an empty snapshot', async () => {
    state.queryError = driverError('42501', 'permission denied for table system_config')
    await expect(loadSystemConfigSnapshot(URL_PLACEHOLDER)).rejects.toThrow('SQLSTATE 42501')
  })

  it('a connection failure throws, and neither the URL nor the password is in the message', async () => {
    state.connectError = driverError(undefined, `connect failed for ${URL_PLACEHOLDER}: password authentication failed`)
    const err = await loadSystemConfigSnapshot(URL_PLACEHOLDER).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('placeholder-password')
    expect((err as Error).message).not.toContain(URL_PLACEHOLDER)
    expect((err as Error).message).not.toContain('db.invalid')
    expect((err as Error).message).toContain('no error code')
  })

  it('a five-letter Node error code (EPERM) is labelled as an error code, not as a SQLSTATE', async () => {
    state.connectError = driverError('EPERM', 'operation not permitted')
    const err = await loadSystemConfigSnapshot(URL_PLACEHOLDER).catch((e: Error) => e)
    expect((err as Error).message).toContain('error code EPERM')
    expect((err as Error).message).not.toContain('SQLSTATE')
  })

  it('the client gets a connect timeout: 5000 ms by default, and the given value otherwise (a black-holed host must not hang the boot)', async () => {
    await loadSystemConfigSnapshot(URL_PLACEHOLDER)
    expect((state.opts as { connectionTimeoutMillis?: number }).connectionTimeoutMillis).toBe(5000)
    await loadSystemConfigSnapshot(URL_PLACEHOLDER, 1234)
    expect((state.opts as { connectionTimeoutMillis?: number }).connectionTimeoutMillis).toBe(1234)
  })

  it('the client is ended on success and on error (no connection left open)', async () => {
    await loadSystemConfigSnapshot(URL_PLACEHOLDER)
    expect(state.ended).toBe(1)
    state.queryError = driverError('42501', 'permission denied')
    await expect(loadSystemConfigSnapshot(URL_PLACEHOLDER)).rejects.toThrow()
    expect(state.ended).toBe(2)
    state.connectError = driverError(undefined, 'timeout')
    await expect(loadSystemConfigSnapshot(URL_PLACEHOLDER)).rejects.toThrow()
    expect(state.ended).toBe(3)
  })
})
