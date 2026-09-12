import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  createBackgroundTaskAtomic: vi.fn(),
  getBackgroundTasks: vi.fn().mockReturnValue([]),
  getBackgroundTask: vi.fn().mockReturnValue(null),
  getRunningBackgroundTasks: vi.fn().mockReturnValue([]),
  finishBackgroundTask: vi.fn(),
  markMessageFailed: vi.fn(),
  claimPendingForAgent: vi.fn().mockReturnValue([]),
  getDb: vi.fn(),
  execFileSync: vi.fn(),
  resolveFromPath: vi.fn().mockReturnValue('/usr/bin/tmux'),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../platform.js', () => ({ resolveFromPath: mocks.resolveFromPath }))
vi.mock('../../logger.js', () => ({ logger: mocks.logger }))
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execFileSync: mocks.execFileSync }
})
vi.mock('../db.js', () => ({
  createBackgroundTaskAtomic: mocks.createBackgroundTaskAtomic,
  getBackgroundTasks: mocks.getBackgroundTasks,
  getBackgroundTask: mocks.getBackgroundTask,
  getRunningBackgroundTasks: mocks.getRunningBackgroundTasks,
  finishBackgroundTask: mocks.finishBackgroundTask,
  markMessageFailed: mocks.markMessageFailed,
  claimPendingForAgent: mocks.claimPendingForAgent,
  getDb: mocks.getDb,
}))

import { tryHandleBackgroundTasks, sweepOrphanedBackgroundTasks } from '../web/routes/background-tasks.js'

function makeCtx(opts: { method: string; path: string; body?: object | string }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

describe('background-tasks routes -- status dispatch (B11b)', () => {
  it('returns 429 when concurrent limit hit (limit_exceeded)', async () => {
    // createBackgroundTaskAtomic returns null -> spawnBackgroundTask returns limit_exceeded
    mocks.createBackgroundTaskAtomic.mockReturnValueOnce(null)
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/background-tasks',
      body: { agent_id: 'agent-a', prompt: 'do something' },
    })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(429)
    expect((body() as any).error).toBe('limit_exceeded')
  })

  it('returns 500 when tmux spawn fails (internal_error)', async () => {
    // createBackgroundTaskAtomic returns a task, execFileSync throws -> internal_error
    mocks.createBackgroundTaskAtomic.mockReturnValueOnce({
      id: 'ABCD1234', agent_id: 'agent-a', prompt: 'do something',
      status: 'running', tmux_session: 'bg-ABCD1234',
      started_at: Math.floor(Date.now() / 1000), finished_at: null, output: null,
    })
    mocks.execFileSync.mockImplementationOnce(() => { throw new Error('tmux not found') })
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/background-tasks',
      body: { agent_id: 'agent-a', prompt: 'do something' },
    })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(500)
    expect((body() as any).error).toBe('internal_error')
  })

  it('returns 400 when prompt is missing', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/background-tasks',
      body: { agent_id: 'agent-a', prompt: '  ' },
    })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(400)
    expect((body() as any).field).toBe('prompt')
  })

  it('returns 400 when agent_id is missing', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/background-tasks',
      body: { agent_id: '', prompt: 'do something' },
    })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(400)
    expect((body() as any).field).toBe('agentId')
  })

  it('returns 201 with the new task on successful spawn', async () => {
    // Fake timers so spawnBackgroundTask's setTimeout(checkAndFinalize) and
    // pollUntilDone's setInterval never actually fire a real 10s/30min timer
    // during the test run -- only the synchronous response matters here.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      mocks.createBackgroundTaskAtomic.mockReturnValueOnce({
        id: 'ABCD1234', agent_id: 'agent-a', prompt: 'do something',
        status: 'running', tmux_session: 'bg-ABCD1234',
        started_at: Math.floor(Date.now() / 1000), finished_at: null, output: null,
      })
      mocks.execFileSync.mockReturnValueOnce('')
      const { ctx, status, body } = makeCtx({
        method: 'POST',
        path: '/api/background-tasks',
        body: { agent_id: 'agent-a', prompt: 'do something' },
      })
      await tryHandleBackgroundTasks(ctx)
      expect(status()).toBe(201)
      expect((body() as any).id).toBe('ABCD1234')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('background-tasks routes -- GET list', () => {
  it('returns the formatted task list', async () => {
    mocks.getBackgroundTasks.mockReturnValueOnce([
      { id: 'AAAA1111', agent_id: 'agent-a', prompt: 'p1', status: 'done', tmux_session: null, started_at: 1700000000, finished_at: 1700000100, output: 'ok' },
    ])
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/background-tasks' })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(200)
    const b = body() as any[]
    expect(b).toHaveLength(1)
    expect(b[0].id).toBe('AAAA1111')
    expect(typeof b[0].started_label).toBe('string')
    expect(typeof b[0].finished_label).toBe('string')
  })

  it('passes the agent and all query params through to getBackgroundTasks', async () => {
    mocks.getBackgroundTasks.mockReturnValueOnce([])
    const { ctx } = makeCtx({ method: 'GET', path: '/api/background-tasks?agent=agent-b&all=true' })
    await tryHandleBackgroundTasks(ctx)
    expect(mocks.getBackgroundTasks).toHaveBeenCalledWith('agent-b', true)
  })

  it('a task with no finished_at gets a null finished_label', async () => {
    mocks.getBackgroundTasks.mockReturnValueOnce([
      { id: 'BBBB2222', agent_id: 'agent-a', prompt: 'p2', status: 'running', tmux_session: 'bg-BBBB2222', started_at: 1700000000, finished_at: null, output: null },
    ])
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/background-tasks' })
    await tryHandleBackgroundTasks(ctx)
    expect((body() as any[])[0].finished_label).toBeNull()
  })
})

describe('background-tasks routes -- GET by id', () => {
  it('returns 404 when the task does not exist', async () => {
    mocks.getBackgroundTask.mockReturnValueOnce(null)
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/background-tasks/DEADBEEF' })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(404)
    expect((body() as any).error).toBe('not_found')
  })

  it('includes live pane output for a running task', async () => {
    mocks.getBackgroundTask.mockReturnValueOnce({
      id: 'DEADBEEF', agent_id: 'agent-a', prompt: 'p', status: 'running', tmux_session: 'bg-DEADBEEF',
      started_at: 1700000000, finished_at: null, output: null,
    })
    mocks.execFileSync.mockReturnValueOnce('live pane text')
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/background-tasks/DEADBEEF' })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(200)
    expect((body() as any).liveOutput).toBe('live pane text')
  })

  it('omits live pane output for a finished task', async () => {
    mocks.getBackgroundTask.mockReturnValueOnce({
      id: 'DEADBEEF', agent_id: 'agent-a', prompt: 'p', status: 'done', tmux_session: 'bg-DEADBEEF',
      started_at: 1700000000, finished_at: 1700000200, output: 'final output',
    })
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/background-tasks/DEADBEEF' })
    await tryHandleBackgroundTasks(ctx)
    expect((body() as any).liveOutput).toBeNull()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })
})

describe('background-tasks routes -- DELETE', () => {
  it('returns 404 when the task does not exist', async () => {
    mocks.getBackgroundTask.mockReturnValueOnce(null)
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/background-tasks/DEADBEEF' })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(404)
  })

  it('kills the tmux session and marks a running task failed', async () => {
    mocks.getBackgroundTask.mockReturnValueOnce({
      id: 'DEADBEEF', agent_id: 'agent-a', prompt: 'p', status: 'running', tmux_session: 'bg-DEADBEEF',
      started_at: 1700000000, finished_at: null, output: null,
    })
    mocks.execFileSync.mockReturnValueOnce('captured output') // capture-pane
    mocks.execFileSync.mockReturnValueOnce('') // kill-session
    const { ctx, status, body } = makeCtx({ method: 'DELETE', path: '/api/background-tasks/DEADBEEF' })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(200)
    expect((body() as any).ok).toBe(true)
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2)
    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith('DEADBEEF', 'failed', 'captured output')
  })

  it('does not attempt to kill a session for an already-finished task', async () => {
    mocks.getBackgroundTask.mockReturnValueOnce({
      id: 'DEADBEEF', agent_id: 'agent-a', prompt: 'p', status: 'done', tmux_session: 'bg-DEADBEEF',
      started_at: 1700000000, finished_at: 1700000100, output: 'old output',
    })
    mocks.execFileSync.mockReturnValueOnce('captured output') // capture-pane only
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/background-tasks/DEADBEEF' })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(200)
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
  })

  it('falls back to "(cancelled)" output when there is no tmux session', async () => {
    mocks.getBackgroundTask.mockReturnValueOnce({
      id: 'DEADBEEF', agent_id: 'agent-a', prompt: 'p', status: 'done', tmux_session: null,
      started_at: 1700000000, finished_at: 1700000100, output: 'old output',
    })
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/background-tasks/DEADBEEF' })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(200)
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith('DEADBEEF', 'failed', '(cancelled)')
  })
})

describe('background-tasks routes -- unmatched', () => {
  it('returns false for a path/method it does not handle', async () => {
    const { ctx } = makeCtx({ method: 'PATCH', path: '/api/background-tasks/DEADBEEF' })
    const handled = await tryHandleBackgroundTasks(ctx)
    expect(handled).toBe(false)
  })
})

describe('sweepOrphanedBackgroundTasks', () => {
  it('does nothing when there are no running tasks', () => {
    mocks.getRunningBackgroundTasks.mockReturnValueOnce([])
    sweepOrphanedBackgroundTasks()
    expect(mocks.finishBackgroundTask).not.toHaveBeenCalled()
  })

  it('marks a task failed when its tmux session is gone (orphaned on restart)', () => {
    mocks.getRunningBackgroundTasks.mockReturnValueOnce([
      { id: 'ORPH0001', agent_id: 'agent-a', prompt: 'p', status: 'running', tmux_session: 'bg-ORPH0001', started_at: 1700000000, finished_at: null, output: null },
    ])
    // list-sessions (isBgSessionAlive) -> empty output, session not found
    mocks.execFileSync.mockReturnValueOnce('')
    sweepOrphanedBackgroundTasks()
    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith('ORPH0001', 'failed', '(orphaned on restart)')
  })

  it('treats a task with no tmux_session as orphaned without touching tmux', () => {
    mocks.getRunningBackgroundTasks.mockReturnValueOnce([
      { id: 'ORPH0002', agent_id: 'agent-a', prompt: 'p', status: 'running', tmux_session: null, started_at: 1700000000, finished_at: null, output: null },
    ])
    sweepOrphanedBackgroundTasks()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith('ORPH0002', 'failed', '(orphaned on restart)')
  })

  it('resumes polling (no finish call) when the tmux session is still alive', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      mocks.getRunningBackgroundTasks.mockReturnValueOnce([
        { id: 'ALIVE001', agent_id: 'agent-a', prompt: 'p', status: 'running', tmux_session: 'bg-ALIVE001', started_at: 1700000000, finished_at: null, output: null },
      ])
      // list-sessions (isBgSessionAlive) -> session name present in output
      mocks.execFileSync.mockReturnValueOnce('bg-ALIVE001\n')
      sweepOrphanedBackgroundTasks()
      expect(mocks.finishBackgroundTask).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
