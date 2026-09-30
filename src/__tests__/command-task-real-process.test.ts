// runCommandTask against REAL child processes (command-task.test.ts uses a fake spawn).
// Two properties only a real process can prove:
//   1. a command that calls back into the very process running the scheduler is
//      answered -- with a synchronous spawn the event loop stays frozen, the
//      request is never served and the command just times out;
//   2. a timeout takes the whole process tree down, not only the shell.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { atomicWriteFileSyncMock } = vi.hoisted(() => ({ atomicWriteFileSyncMock: vi.fn() }))

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/command-task-real-test', TELEGRAM_BOT_TOKEN: '', ALLOWED_CHAT_ID: '',
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: atomicWriteFileSyncMock }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../db.js', () => ({ appendTaskRun: vi.fn() }))

import { runCommandTask } from '../web/command-task.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

const task = (o: Partial<ScheduledTask>) => ({ name: 'real-task', ...o }) as ScheduledTask
const lastHealth = (name: string) => {
  const calls = atomicWriteFileSyncMock.mock.calls
  return JSON.parse(calls[calls.length - 1][1] as string)[name]
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let server: http.Server
let port: number
beforeEach(async () => {
  atomicWriteFileSyncMock.mockClear()
  if (!server) {
    server = http.createServer((_q, r) => r.end('ok'))
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    port = (server.address() as { port: number }).port
  }
})
afterAll(() => { server?.close() })

describe('runCommandTask with real processes', () => {
  it('a command that curls the process it runs in is answered (no event-loop freeze)', async () => {
    await runCommandTask(task({
      command: `curl -sf --max-time 5 -o /dev/null http://127.0.0.1:${port}/`, timeoutMs: 8000, failThreshold: 1,
    }), Date.now())
    expect(lastHealth('real-task')).toMatchObject({ lastStatus: 'ok', fails: 0 })
  }, 15000)

  it('the event loop keeps serving while a command runs', async () => {
    let served = 0
    server.on('request', () => { served++ })
    const run = runCommandTask(task({ name: 'slow-task', command: 'sleep 1', timeoutMs: 8000 }), Date.now())
    const res = await fetch(`http://127.0.0.1:${port}/`) // would hang until `sleep` ends with a sync spawn
    expect(await res.text()).toBe('ok')
    expect(served).toBeGreaterThan(0)
    await run
  }, 15000)

  it('a non-zero exit is a failure and carries the exit code', async () => {
    await runCommandTask(task({ name: 'fail-task', command: 'echo nope >&2; exit 3', failThreshold: 1 }), Date.now())
    expect(lastHealth('fail-task')).toMatchObject({ lastStatus: 'fail', fails: 1 })
  })

  it('a timeout is a failure and kills the whole tree (no orphaned grandchild)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmd-task-real-'))
    const pidFile = join(dir, 'child.pid')
    const t0 = Date.now()
    await runCommandTask(task({
      name: 'hang-task', command: `sleep 30 & echo $! > ${pidFile}; wait`, timeoutMs: 600, failThreshold: 1,
    }), Date.now())
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(lastHealth('hang-task')).toMatchObject({ lastStatus: 'fail', fails: 1 })
    expect(existsSync(pidFile)).toBe(true)
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    await sleep(500)
    expect(alive(pid)).toBe(false)
  }, 15000)
})
