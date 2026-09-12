// Error-shape tests for updates route 409 conflict responses (#672 B15).
// Covers: concurrency (already-running) and preflight (dirty-tree, detached-head) 409 branches.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
}))

vi.mock('../web/update-checker.js', () => ({
  getUpdateStatus: vi.fn().mockReturnValue({}),
  refreshUpdateStatus: vi.fn().mockResolvedValue({}),
}))

vi.mock('../update-agent-capability.js', () => ({
  claudeAgentRunnable: vi.fn().mockReturnValue(false),
}))

vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: false, error: 'not_found' }),
}))

import { getUpdateStatus, refreshUpdateStatus } from '../web/update-checker.js'
import { claudeAgentRunnable } from '../update-agent-capability.js'
import { runScheduledTaskNow } from '../web/schedule-runner.js'
import { logger } from '../logger.js'

import { checkNoConcurrentUpdate, checkUpdatePreflight } from '../update-preflight.js'

vi.mock('../update-preflight.js', () => ({
  checkUpdatePreflight: vi.fn(),
  checkNoConcurrentUpdate: vi.fn(),
  classifyLockWriteError: vi.fn().mockReturnValue('other'),
}))

let mockWriteBehavior: 'succeed' | 'eexist' | 'other-error' = 'succeed'
// The write-lock retry (after unlinkSync) -- 'succeed' by default so tests
// that never reach the retry are unaffected.
let mockRetryWriteBehavior: 'succeed' | 'eexist' | { code: string } = 'succeed'
let mockOpenSyncThrows = false
let mockStatBehavior: 'running' | 'not-running' = 'not-running'
// Path-aware readFileSync: map absolute path -> string content, or an Error
// instance to throw for that path. Unmapped paths throw ENOENT (matching a
// real missing file), which readLastResult()/diagnose's try/catch treat as
// "no result yet" -- the same effect as the old unconditional `''`.
const mockFsReads: Record<string, string | Error> = {}
function setMockRead(path: string, value: string | Error) { mockFsReads[path] = value }
let wxWriteCount = 0

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn((_p: unknown, _c: unknown, opts?: Record<string, unknown>) => {
    if (opts?.flag !== 'wx') return
    wxWriteCount += 1
    if (wxWriteCount === 1) {
      if (mockWriteBehavior === 'eexist') {
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
      }
      if (mockWriteBehavior === 'other-error') {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return
    }
    // Second-and-later 'wx' write in the same test is the lock retry.
    if (mockRetryWriteBehavior === 'succeed') return
    const code = mockRetryWriteBehavior === 'eexist' ? 'EEXIST' : mockRetryWriteBehavior.code
    throw Object.assign(new Error(`mock retry error: ${code}`), { code })
  }),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => {
    if (mockOpenSyncThrows) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    return 3
  }),
  closeSync: vi.fn(),
  statSync: vi.fn(() => ({ isFile: () => mockStatBehavior === 'running', size: 0 })),
  readFileSync: vi.fn((p: unknown) => {
    const key = String(p)
    const val = mockFsReads[key]
    if (val instanceof Error) throw val
    if (val !== undefined) return val
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
  }),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({ on: vi.fn(), unref: vi.fn() }),
  execFileSync: vi.fn().mockReturnValue('main\n'),
}))

import { writeFileSync, unlinkSync, mkdirSync, openSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  path: string,
  bodyOrRaw?: object | string | null,
): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const buf =
    bodyOrRaw == null
      ? Buffer.alloc(0)
      : typeof bodyOrRaw === 'string'
        ? Buffer.from(bodyOrRaw)
        : Buffer.from(JSON.stringify(bodyOrRaw))
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { method: string; headers: Record<string, string> }).method = method
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  setImmediate(() => {
    ;(req as unknown as EventEmitter).emit('data', buf)
    ;(req as unknown as EventEmitter).emit('end')
  })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      const str = b ? (Buffer.isBuffer(b) ? b.toString('utf-8') : b) : ''
      try { out.body = JSON.parse(str) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext,
    out,
  }
}

// ── Import subject under test AFTER mocks ─────────────────────────────────────

import { tryHandleUpdates } from '../web/routes/updates.js'

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteBehavior = 'succeed'
  mockRetryWriteBehavior = 'succeed'
  mockOpenSyncThrows = false
  mockStatBehavior = 'not-running'
  wxWriteCount = 0
  for (const k of Object.keys(mockFsReads)) delete mockFsReads[k]
})

describe('updates /apply -- concurrency 409 (already-running)', () => {
  it('returns conflict token when update is already running', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 9999,
      message: 'Update already running (pid 9999). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })

  it('exposes reason and pid as separate machine-readable fields', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 9999,
      message: 'Update already running (pid 9999). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.reason).toBe('already-running')
    expect(out.body.pid).toBe(9999)
  })

  it('moves prose into hint, not error', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 9999,
      message: 'Update already running (pid 9999). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.hint).toMatch(/already running/)
    expect(out.body.error).not.toMatch(/running|pid|wait/i)
  })

  it('mutation-detection: error is conflict, not already_running or already-running', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 1,
      message: 'Update already running (pid 1). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.error).toBe('conflict')
    expect(out.body.error).not.toBe('already-running')
    expect(out.body.error).not.toBe('already_running')
  })
})

describe('updates /apply -- preflight 409 (dirty-tree)', () => {
  it('returns conflict token for dirty-tree preflight failure', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes. Commit or stash them, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })

  it('preserves reason for machine-readable distinction', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes. Commit or stash them, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.reason).toBe('dirty-tree')
  })

  it('moves preflight prose into hint', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes. Commit or stash them, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.hint).toMatch(/uncommitted|stash/i)
    expect(out.body.error).not.toMatch(/uncommitted|stash|changes/i)
  })

  it('mutation-detection: error is conflict, not the prose message or dirty-tree', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.error).toBe('conflict')
    expect(out.body.error).not.toBe('dirty-tree')
    expect(out.body.error).not.toMatch(/uncommitted|changes|working/i)
  })
})

describe('updates /apply -- preflight 409 (detached-head)', () => {
  it('returns conflict token for detached-head preflight failure', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'detached-head',
      message: 'The repository is in detached HEAD state. Checkout a branch, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(out.body.reason).toBe('detached-head')
    expect(out.body.hint).toMatch(/detached/i)
    expect(out.body.error).not.toMatch(/detached|head|branch/i)
  })
})

describe('updates /apply -- preflight 409 (local-commits)', () => {
  it('returns conflict token for local-commits preflight failure', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'local-commits',
      message: 'The branch has 2 local commits not yet pushed. Push or reset them, then retry.',
      ahead: 2,
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(out.body.reason).toBe('local-commits')
    expect(out.body.hint).toMatch(/local commits|push|reset/i)
  })
})

// ── #751 step 11: everything below is new coverage for GET/status/diagnose ────
// and the untested POST /apply branches (lock write, preflight crash,
// autoStash, store-unwritable, happy path, async spawn error).

const LAST_RESULT_PATH = '/tmp/mock-store/update.last-result'
const DIAGNOSE_MARKER_PATH = '/tmp/mock-store/update-diagnose.last'
const PIDFILE_PATH = '/tmp/mock-store/update.pid'

describe('GET /api/updates', () => {
  it('returns getUpdateStatus() verbatim', async () => {
    vi.mocked(getUpdateStatus).mockReturnValue({ upToDate: false, ahead: 3 } as never)
    const { ctx, out } = makeCtx('GET', '/api/updates')
    const handled = await tryHandleUpdates(ctx)
    expect(handled).toBe(true)
    expect(out.body).toEqual({ upToDate: false, ahead: 3 })
  })
})

describe('GET /api/updates/status', () => {
  it('reports not running, no result, no diagnose offer when nothing has run yet', async () => {
    const { ctx, out } = makeCtx('GET', '/api/updates/status')
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ running: false, result: null, canDiagnose: false, needsHuman: false })
  })

  it('reports running:true when the pidfile is present', async () => {
    mockStatBehavior = 'running'
    const { ctx, out } = makeCtx('GET', '/api/updates/status')
    await tryHandleUpdates(ctx)
    expect(out.body.running).toBe(true)
  })

  it('offers canDiagnose when the last run rolled back and the agent can run', async () => {
    setMockRead(LAST_RESULT_PATH, JSON.stringify({ status: 'rolled-back', ts: 123 }))
    vi.mocked(claudeAgentRunnable).mockReturnValue(true)
    const { ctx, out } = makeCtx('GET', '/api/updates/status')
    await tryHandleUpdates(ctx)
    expect(out.body.canDiagnose).toBe(true)
    expect(out.body.needsHuman).toBe(false)
    expect(out.body.result).toEqual({ status: 'rolled-back', ts: 123 })
  })

  it('flags needsHuman when the last run rolled back but the agent cannot run', async () => {
    setMockRead(LAST_RESULT_PATH, JSON.stringify({ status: 'rolled-back', ts: 123 }))
    vi.mocked(claudeAgentRunnable).mockReturnValue(false)
    const { ctx, out } = makeCtx('GET', '/api/updates/status')
    await tryHandleUpdates(ctx)
    expect(out.body.canDiagnose).toBe(false)
    expect(out.body.needsHuman).toBe(true)
  })

  it('offers neither flag after a successful run', async () => {
    setMockRead(LAST_RESULT_PATH, JSON.stringify({ status: 'success', ts: 123 }))
    vi.mocked(claudeAgentRunnable).mockReturnValue(true)
    const { ctx, out } = makeCtx('GET', '/api/updates/status')
    await tryHandleUpdates(ctx)
    expect(out.body.canDiagnose).toBe(false)
    expect(out.body.needsHuman).toBe(false)
  })
})

describe('POST /api/updates/diagnose', () => {
  it('refuses when there is nothing to diagnose', async () => {
    const { ctx, out } = makeCtx('POST', '/api/updates/diagnose')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('no-rollback')
  })

  it('refuses when the host cannot run a Claude agent', async () => {
    setMockRead(LAST_RESULT_PATH, JSON.stringify({ status: 'rolled-back', ts: 123 }))
    vi.mocked(claudeAgentRunnable).mockReturnValue(false)
    const { ctx, out } = makeCtx('POST', '/api/updates/diagnose')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(400)
    expect(out.body.reason).toBe('claude-unrunnable')
  })

  it('is idempotent when the marker already records this outcome', async () => {
    setMockRead(LAST_RESULT_PATH, JSON.stringify({ status: 'rolled-back', ts: 123 }))
    setMockRead(DIAGNOSE_MARKER_PATH, '123')
    vi.mocked(claudeAgentRunnable).mockReturnValue(true)
    const { ctx, out } = makeCtx('POST', '/api/updates/diagnose')
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ ok: true, already: true })
    expect(runScheduledTaskNow).not.toHaveBeenCalled()
  })

  it('reports fire-failed when the diagnose task cannot be started', async () => {
    setMockRead(LAST_RESULT_PATH, JSON.stringify({ status: 'rolled-back', ts: 123 }))
    vi.mocked(claudeAgentRunnable).mockReturnValue(true)
    vi.mocked(runScheduledTaskNow).mockResolvedValue({ ok: false, error: 'boom' })
    const { ctx, out } = makeCtx('POST', '/api/updates/diagnose')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('fire-failed')
  })

  it('fires the diagnose task and writes the marker on success', async () => {
    setMockRead(LAST_RESULT_PATH, JSON.stringify({ status: 'rolled-back', ts: 123 }))
    vi.mocked(claudeAgentRunnable).mockReturnValue(true)
    vi.mocked(runScheduledTaskNow).mockResolvedValue({ ok: true, result: 'agent notified' })
    const { ctx, out } = makeCtx('POST', '/api/updates/diagnose')
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ ok: true, result: 'agent notified' })
    expect(vi.mocked(writeFileSync).mock.calls.some(
      (c) => c[0] === DIAGNOSE_MARKER_PATH && c[1] === '123',
    )).toBe(true)
  })
})

describe('POST /api/updates/apply -- lock write failures', () => {
  it('returns lock-write-failed when the first pidfile write throws a non-EEXIST error', async () => {
    mockWriteBehavior = 'other-error'
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('lock-write-failed')
  })

  it('returns 409 already-running when the retry write also EEXISTs and is classified as a race', async () => {
    mockWriteBehavior = 'eexist'
    mockRetryWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({ ok: true })
    const { classifyLockWriteError } = await import('../update-preflight.js')
    vi.mocked(classifyLockWriteError).mockReturnValue('race')
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('already-running')
    expect(out.body.pid).toBe(0)
  })

  it('returns 500 lock-write-failed when the retry write fails for a non-race reason', async () => {
    mockWriteBehavior = 'eexist'
    mockRetryWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({ ok: true })
    const { classifyLockWriteError } = await import('../update-preflight.js')
    vi.mocked(classifyLockWriteError).mockReturnValue('other')
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('lock-write-failed')
  })
})

describe('POST /api/updates/apply -- preflight and store failures', () => {
  it('releases the lock and reports precheck-crashed when checkUpdatePreflight throws', async () => {
    vi.mocked(checkUpdatePreflight).mockImplementation(() => { throw new Error('git exploded') })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('precheck-crashed')
    expect(unlinkSync).toHaveBeenCalledWith(PIDFILE_PATH)
  })

  it('skips the dirty-tree 409 and proceeds to spawn when autoStash is requested', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply', { autoStash: true })
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(spawn).toHaveBeenCalled()
  })

  it('releases the lock and reports store-unwritable when the log file cannot be opened', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({ ok: true })
    mockOpenSyncThrows = true
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('store-unwritable')
    expect(unlinkSync).toHaveBeenCalledWith(PIDFILE_PATH)
  })
})

describe('POST /api/updates/apply -- happy path and async spawn error', () => {
  it('acquires the lock, spawns update.sh with AUTO_STASH reflecting the body, and returns ok', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({ ok: true })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply', { autoStash: true })
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['/tmp/mock-root/update.sh'],
      expect.objectContaining({
        cwd: '/tmp/mock-root',
        env: expect.objectContaining({ AUTO_STASH: '1' }),
      }),
    )
  })

  it('sets AUTO_STASH=0 when autoStash was not requested', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({ ok: true })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['/tmp/mock-root/update.sh'],
      expect.objectContaining({ env: expect.objectContaining({ AUTO_STASH: '0' }) }),
    )
  })

  it('releases the lock on an async spawn error only if the pidfile is still ours', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({ ok: true })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ ok: true })

    const pidfileContentWritten = vi.mocked(writeFileSync).mock.calls[0][1] as string
    setMockRead(PIDFILE_PATH, pidfileContentWritten)
    vi.mocked(unlinkSync).mockClear()

    const spawnReturnValue = vi.mocked(spawn).mock.results[0].value as { on: ReturnType<typeof vi.fn> }
    const errorHandler = spawnReturnValue.on.mock.calls.find((c) => c[0] === 'error')?.[1] as
      ((err: Error) => void) | undefined
    expect(errorHandler).toBeInstanceOf(Function)
    errorHandler!(new Error('spawn ENOENT'))

    expect(unlinkSync).toHaveBeenCalledWith(PIDFILE_PATH)
    expect(logger.error).toHaveBeenCalled()
  })

  it('does not release the lock on an async spawn error if the pidfile no longer matches (already recycled)', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({ ok: true })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ ok: true })

    setMockRead(PIDFILE_PATH, 'someone-elses-pidfile-content')
    vi.mocked(unlinkSync).mockClear()

    const spawnReturnValue = vi.mocked(spawn).mock.results[0].value as { on: ReturnType<typeof vi.fn> }
    const errorHandler = spawnReturnValue.on.mock.calls.find((c) => c[0] === 'error')?.[1] as
      ((err: Error) => void) | undefined
    errorHandler!(new Error('spawn ENOENT'))

    expect(unlinkSync).not.toHaveBeenCalled()
  })
})

describe('POST /api/updates/apply -- synchronous handler crash', () => {
  it('releases the lock and returns internal_error when spawn throws synchronously', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({ ok: true })
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('spawn crashed') })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
    expect(unlinkSync).toHaveBeenCalledWith(PIDFILE_PATH)
  })
})

describe('POST /api/updates/check', () => {
  it('returns refreshUpdateStatus() verbatim', async () => {
    vi.mocked(refreshUpdateStatus).mockResolvedValue({ upToDate: true } as never)
    const { ctx, out } = makeCtx('POST', '/api/updates/check')
    await tryHandleUpdates(ctx)
    expect(out.body).toEqual({ upToDate: true })
  })
})

describe('tryHandleUpdates -- unrelated paths', () => {
  it('returns false for a path it does not own', async () => {
    const { ctx } = makeCtx('GET', '/api/something-else')
    const handled = await tryHandleUpdates(ctx)
    expect(handled).toBe(false)
  })
})
