// scripts/dashboard-url.ts against a stub dashboard: it asks for a one-time enrollment code and
// prints the enroll URL; it never prints a token and it fails loudly when there is no dashboard.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

let server: Server
let base: string
let calls: Array<{ method: string; url: string }>
let reply: { status: number; body: unknown }

beforeEach(async () => {
  calls = []
  reply = { status: 201, body: { code: 'CODE_from-stub', expires_at: 1900000000 } }
  server = createServer((req, res) => {
    calls.push({ method: req.method ?? '', url: req.url ?? '' })
    req.resume()
    req.on('end', () => {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

// Async spawn: the stub answers from this process's event loop, so a blocking spawnSync would deadlock it.
function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(TSX, ['scripts/dashboard-url.ts', ...args], { cwd: ROOT, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

describe('npm run dashboard-url', () => {
  it('asks the running dashboard for a code and prints the enroll URL on the default origin', async () => {
    const r = await run([], { DASHBOARD_BASE_URL: base })
    expect(r.status).toBe(0)
    expect(calls).toEqual([{ method: 'POST', url: '/api/admin/browser-enroll-codes' }])
    expect(r.stdout.trim()).toMatch(/^http:\/\/localhost:\d+\/\?enroll=CODE_from-stub$/)
    expect(r.stdout).not.toMatch(/token=/)
  }, 30000)

  it('--base names the origin the browser will use', async () => {
    const r = await run(['--base', 'https://dash.example.net'], { DASHBOARD_BASE_URL: base })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('https://dash.example.net/?enroll=CODE_from-stub')
  }, 30000)

  it('rejects a --base that is not an origin', async () => {
    const r = await run(['--base', 'not a url'], { DASHBOARD_BASE_URL: base })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(calls).toEqual([])
  }, 30000)

  it('fails with a message and prints no URL when the dashboard refuses', async () => {
    reply = { status: 403, body: { error: 'forbidden' } }
    const r = await run([], { DASHBOARD_BASE_URL: base })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('HTTP 403')
  }, 30000)

  it('fails with a message when no dashboard answers', async () => {
    const r = await run([], { DASHBOARD_BASE_URL: 'http://127.0.0.1:1' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('did not answer')
  }, 30000)
})
