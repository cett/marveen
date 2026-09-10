import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const fsState: {
  existing: Set<string>
  dirFiles: string[]
  fileContents: Map<string, string>
  statSize: number
  statMtimeMs: number
  unlinked: string[]
} = {
  existing: new Set(),
  dirFiles: [],
  fileContents: new Map(),
  statSize: 1234,
  statMtimeMs: 1_700_000_000_000,
  unlinked: [],
}

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.existing.has(p),
  readdirSync: () => fsState.dirFiles,
  statSync: () => ({ size: fsState.statSize, mtimeMs: fsState.statMtimeMs }),
  readFileSync: (p: string) => {
    const c = fsState.fileContents.get(p)
    if (c === undefined) throw new Error(`ENOENT: ${p}`)
    return c
  },
  unlinkSync: (p: string) => { fsState.unlinked.push(p) },
}))

const spawnMock = vi.fn()
let execFileImpl: (...args: any[]) => void = (_file, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' })

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
  execFile: (...args: any[]) => execFileImpl(...args),
}))

vi.mock('../config.js', () => ({ PROJECT_ROOT: '/repo' }))

import { tryHandleBackups } from '../web/routes/backups.js'

function makeCtx(method: string, path: string): { ctx: RouteContext; status: () => number; body: () => any } {
  const em = new EventEmitter() as any
  em.headers = {}
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

beforeEach(() => {
  fsState.existing = new Set()
  fsState.dirFiles = []
  fsState.fileContents = new Map()
  fsState.unlinked = []
  spawnMock.mockReset()
  spawnMock.mockReturnValue({ unref: vi.fn() })
  execFileImpl = (_file, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' })
})

describe('backups route -- unrelated path', () => {
  it('returns false for a non-matching path', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleBackups(ctx)).toBe(false)
  })
})

describe('GET /api/backups', () => {
  it('returns an empty list when the backup directory does not exist', async () => {
    const { ctx, status, body } = makeCtx('GET', '/api/backups')
    await tryHandleBackups(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ backups: [], last_backup: null })
  })

  it('lists archives newest-first, with checksum when present', async () => {
    fsState.existing.add('/repo/backups')
    fsState.dirFiles = ['claudeclaw-20260101-000000.tar.gz', 'claudeclaw-20260102-000000.tar.gz', 'ignore-me.txt']
    fsState.existing.add('/repo/backups/claudeclaw-20260102-000000.sha256')
    fsState.fileContents.set('/repo/backups/claudeclaw-20260102-000000.sha256', 'abc123  claudeclaw-20260102-000000.tar.gz\n')
    const { ctx, status, body } = makeCtx('GET', '/api/backups')
    await tryHandleBackups(ctx)
    expect(status()).toBe(200)
    const out = body()
    expect(out.backups).toHaveLength(2)
    expect(out.backups[0].name).toBe('claudeclaw-20260102-000000.tar.gz')
    expect(out.backups[0].has_checksum).toBe(true)
    expect(out.backups[0].checksum).toBe('abc123')
    expect(out.backups[1].has_checksum).toBe(false)
    expect(out.last_backup).toBe(out.backups[0].created_at)
  })
})

describe('POST /api/backups/run', () => {
  it('500s when the backup script is missing', async () => {
    const { ctx, status, body } = makeCtx('POST', '/api/backups/run')
    await tryHandleBackups(ctx)
    expect(status()).toBe(500)
    expect(body().error).toBe('internal_error')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns the backup script detached and returns immediately', async () => {
    fsState.existing.add('/repo/scripts/backup.sh')
    const { ctx, status, body } = makeCtx('POST', '/api/backups/run')
    await tryHandleBackups(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true, message: 'Backup started' })
    expect(spawnMock).toHaveBeenCalledWith('/usr/bin/env', ['bash', '/repo/scripts/backup.sh'], { detached: true, stdio: 'ignore' })
  })
})

describe('DELETE /api/backups/:name', () => {
  it('rejects a name that does not match the archive pattern (path traversal guard)', async () => {
    const { ctx, status, body } = makeCtx('DELETE', '/api/backups/..%2f..%2fetc%2fpasswd')
    await tryHandleBackups(ctx)
    expect(status()).toBe(400)
    expect(body().error).toBe('invalid_value')
    expect(fsState.unlinked).toHaveLength(0)
  })

  it('404s when the archive does not exist', async () => {
    const { ctx, status, body } = makeCtx('DELETE', '/api/backups/claudeclaw-20260101-000000.tar.gz')
    await tryHandleBackups(ctx)
    expect(status()).toBe(404)
    expect(body().error).toBe('not_found')
  })

  it('deletes the archive and its checksum sidecar when both exist', async () => {
    fsState.existing.add('/repo/backups/claudeclaw-20260101-000000.tar.gz')
    fsState.existing.add('/repo/backups/claudeclaw-20260101-000000.sha256')
    const { ctx, status, body } = makeCtx('DELETE', '/api/backups/claudeclaw-20260101-000000.tar.gz')
    await tryHandleBackups(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true })
    expect(fsState.unlinked).toEqual([
      '/repo/backups/claudeclaw-20260101-000000.tar.gz',
      '/repo/backups/claudeclaw-20260101-000000.sha256',
    ])
  })

  it('deletes the archive without erroring when there is no checksum sidecar', async () => {
    fsState.existing.add('/repo/backups/claudeclaw-20260101-000000.tar.gz')
    const { ctx, status } = makeCtx('DELETE', '/api/backups/claudeclaw-20260101-000000.tar.gz')
    await tryHandleBackups(ctx)
    expect(status()).toBe(200)
    expect(fsState.unlinked).toEqual(['/repo/backups/claudeclaw-20260101-000000.tar.gz'])
  })
})

describe('POST /api/backups/:name/verify', () => {
  it('rejects an invalid archive name', async () => {
    const { ctx, status, body } = makeCtx('POST', '/api/backups/not-an-archive/verify')
    await tryHandleBackups(ctx)
    expect(status()).toBe(400)
    expect(body().error).toBe('invalid_value')
  })

  it('404s when the archive does not exist', async () => {
    const { ctx, status, body } = makeCtx('POST', '/api/backups/claudeclaw-20260101-000000.tar.gz/verify')
    await tryHandleBackups(ctx)
    expect(status()).toBe(404)
    expect(body().error).toBe('not_found')
  })

  it('500s when the verify script is missing', async () => {
    fsState.existing.add('/repo/backups/claudeclaw-20260101-000000.tar.gz')
    const { ctx, status, body } = makeCtx('POST', '/api/backups/claudeclaw-20260101-000000.tar.gz/verify')
    await tryHandleBackups(ctx)
    expect(status()).toBe(500)
    expect(body().error).toBe('internal_error')
  })

  it('runs verify-restore.sh and reports success output', async () => {
    fsState.existing.add('/repo/backups/claudeclaw-20260101-000000.tar.gz')
    fsState.existing.add('/repo/scripts/verify-restore.sh')
    execFileImpl = (_file, _args, _opts, cb) => cb(null, { stdout: 'restore ok\n', stderr: '' })
    const { ctx, status, body } = makeCtx('POST', '/api/backups/claudeclaw-20260101-000000.tar.gz/verify')
    await tryHandleBackups(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true, output: 'restore ok' })
  })

  it('reports ok:false with combined output when the verify script exits non-zero', async () => {
    fsState.existing.add('/repo/backups/claudeclaw-20260101-000000.tar.gz')
    fsState.existing.add('/repo/scripts/verify-restore.sh')
    execFileImpl = (_file, _args, _opts, cb) => {
      const err = Object.assign(new Error('exit 1'), { stdout: 'partial\n', stderr: 'checksum mismatch\n' })
      cb(err)
    }
    const { ctx, status, body } = makeCtx('POST', '/api/backups/claudeclaw-20260101-000000.tar.gz/verify')
    await tryHandleBackups(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: false, output: 'partial\nchecksum mismatch' })
  })
})
