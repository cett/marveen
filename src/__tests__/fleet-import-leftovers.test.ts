// The leftover scan only reports. These tests use a throwaway tree and explicit roots; the link to the files the real
// import writes is tested in fleet-transfer-two-phase.test.ts.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  inProgress: false,
  roots: [] as { dir: string; maxDepth: number }[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../logger.js', () => ({ logger: mocks.logger }))
vi.mock('../web/fleet-transfer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/fleet-transfer.js')>()),
  isImportApplyInProgress: () => mocks.inProgress,
  importTargetRoots: () => mocks.roots,
}))

import { leftoverAction, logImportLeftovers, runBootImportLeftoverScan, scanImportLeftovers } from '../web/fleet-import-leftovers.js'
import { tryHandleFleet } from '../web/routes/fleet.js'
import { resolveRequiredPermission } from '../web/rbac.js'

const ROOT = mkdtempSync(join(tmpdir(), 'fleet-leftovers-test-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function put(rel: string, content = 'x'): string {
  const full = join(ROOT, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  mocks.inProgress = false
  mocks.roots = []
  for (const fn of Object.values(mocks.logger)) fn.mockClear()
})

describe('scanImportLeftovers', () => {
  it('reports an orphan staged file with its kind and age, and leaves it byte for byte alone', async () => {
    const path = put('a/CLAUDE.md.import-new', 'partial')
    // Whole seconds: a file system keeps a fractional mtime to its own precision (Linux rounds the milliseconds down).
    const old = new Date(Math.floor((Date.now() - 3600_000) / 1000) * 1000)
    utimesSync(path, old, old)
    const mtimeBefore = statSync(path).mtimeMs

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'a'), maxDepth: 1 }] })

    expect(scan.items).toHaveLength(1)
    expect(scan.items[0]).toMatchObject({ path, kind: 'orphan_new' })
    expect(scan.items[0].ageSeconds).toBeGreaterThanOrEqual(3599)
    expect(scan.items[0].mtime).toBe(old.toISOString())
    expect(readFileSync(path, 'utf-8')).toBe('partial')
    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
  })

  it('reports a stale backup with the recovery instruction, and leaves it alone', async () => {
    const path = put('b/SOUL.md.import-bak', 'original')

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'b'), maxDepth: 1 }] })

    expect(scan.items.map((i) => i.kind)).toEqual(['stale_bak'])
    expect(scan.items[0].action).toContain(`cp '${path}' '${join(ROOT, 'b', 'SOUL.md')}'`)
    expect(scan.items[0].action).toContain('refused (409)')
    expect(readFileSync(path, 'utf-8')).toBe('original')
  })

  it('an empty or missing tree gives an empty list, no error and no log line', async () => {
    mkdirSync(join(ROOT, 'empty'))
    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'empty'), maxDepth: 3 }, { dir: join(ROOT, 'missing'), maxDepth: 3 }] })
    expect(scan).toMatchObject({ items: [], truncated: false, truncatedReason: null, importInProgress: false })

    await runBootImportLeftoverScan({ roots: [{ dir: join(ROOT, 'empty'), maxDepth: 3 }] })
    expect(mocks.logger.warn).not.toHaveBeenCalled()
    expect(mocks.logger.error).not.toHaveBeenCalled()
  })

  it('stops at the depth limit: a file one level deeper is not looked at', async () => {
    const shallow = put('d/x/f.import-bak')
    put('d/x/y/g.import-bak')

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'd'), maxDepth: 2 }] })

    expect(scan.items.map((i) => i.path)).toEqual([shallow])
  })

  it('does not look into node_modules or .git, and does not match other file names', async () => {
    put('e/node_modules/p/f.import-bak')
    put('e/.git/f.import-new')
    put('e/plain.json')
    put('e/notes.import-bak.txt')

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'e'), maxDepth: 4 }] })

    expect(scan.items).toEqual([])
  })

  it('stops at the result limit and says so', async () => {
    for (const n of ['1', '2', '3', '4']) put(`f/${n}.import-new`)

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'f'), maxDepth: 1 }], maxResults: 2 })

    expect(scan.items).toHaveLength(2)
    expect(scan.truncated).toBe(true)
    expect(scan.truncatedReason).toBe('max_results')
  })

  it('stops at the time limit and says so', async () => {
    put('g/1.import-new')
    let t = 1_000_000
    const now = () => (t += 5_000) // every look at the clock costs 5 s

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'g'), maxDepth: 1 }], timeoutMs: 2000, now })

    expect(scan.truncated).toBe(true)
    expect(scan.truncatedReason).toBe('timeout')
  })

  it('reports nothing while an import is running: its own staged files are not leftovers', async () => {
    put('h/CLAUDE.md.import-new')
    mocks.inProgress = true

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'h'), maxDepth: 1 }] })

    expect(scan).toMatchObject({ items: [], importInProgress: true })
  })

  it('does not even walk while an import is running', async () => {
    mocks.inProgress = true
    const untouched = new Proxy([], { get() { throw new Error('the roots were read') } }) as never

    const scan = await scanImportLeftovers({ roots: untouched })

    expect(scan.importInProgress).toBe(true)
  })

  it('an import that starts during the walk empties the result: its staged files are not leftovers', async () => {
    put('h2/CLAUDE.md.import-new')
    let calls = 0
    const now = () => {
      calls++
      if (calls >= 3) mocks.inProgress = true // the apply begins after the scan started
      return 1_000_000
    }

    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'h2'), maxDepth: 1 }], now })

    expect(mocks.inProgress).toBe(true)
    expect(scan).toMatchObject({ items: [], importInProgress: true })
  })

  it('an unreadable root does not fail the scan', async () => {
    put('i/ok.import-bak')
    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'i', 'ok.import-bak'), maxDepth: 2 }, { dir: join(ROOT, 'i'), maxDepth: 1 }] })
    expect(scan.items).toHaveLength(1)
  })
})

describe('logging', () => {
  it('one warn per leftover, with kind and age, and one summary', async () => {
    put('j/a.import-new')
    put('j/b.import-bak')
    put('j/c.import-bak')
    const scan = await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'j'), maxDepth: 1 }] })

    logImportLeftovers(scan)

    const calls = mocks.logger.warn.mock.calls
    expect(calls).toHaveLength(4)
    expect(calls.slice(0, 3).map(([o]) => (o as { kind: string }).kind).sort()).toEqual(['orphan_new', 'stale_bak', 'stale_bak'])
    expect(calls[0][0]).toHaveProperty('ageSeconds')
    expect(calls[0][0]).toHaveProperty('action')
    expect(calls[3][0]).toEqual({ orphans: 1, staleBackups: 2 })
    expect(calls[3][1]).toContain('nothing was deleted')
  })

  it('a truncated scan logs that the list is incomplete', async () => {
    for (const n of ['1', '2']) put(`k/${n}.import-new`)
    logImportLeftovers(await scanImportLeftovers({ roots: [{ dir: join(ROOT, 'k'), maxDepth: 1 }], maxResults: 1 }))
    expect(mocks.logger.warn.mock.calls[0][1]).toContain('stopped at a limit')
  })

  it('the stale backup text names the file to restore', () => {
    expect(leftoverAction('stale_bak', '/p/CLAUDE.md.import-bak')).toContain("cp '/p/CLAUDE.md.import-bak' '/p/CLAUDE.md'")
  })

  it('a path cannot break out of the quoted restore command', () => {
    const hostile = "/p/a'; touch /tmp/x; '.import-bak"
    // each quote is closed, escaped and reopened, so the whole path stays one literal word
    expect(leftoverAction('stale_bak', hostile)).toContain("cp '/p/a'\\''; touch /tmp/x; '\\''.import-bak' '/p/a'\\''; touch /tmp/x; '\\'''")
    const newline = leftoverAction('stale_bak', '/p/a\nrm -rf x.import-bak')
    expect(newline).not.toContain('cp ')
    expect(newline).toContain('control character')
  })
})

describe('the boot scan', () => {
  it('swallows a failure and only logs it, so the boot never stops on it', async () => {
    // iterating this list throws, so the scan itself throws
    const exploding = new Proxy([], { get() { throw new Error('roots exploded') } }) as never
    await expect(runBootImportLeftoverScan({ roots: exploding })).resolves.toBeUndefined()
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'roots exploded' }), expect.stringContaining('failed'))
  })
})

describe('the boot wiring (source pin)', () => {
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8')

  it('starts the scan after the database is up, without awaiting it, with a catch', () => {
    const call = index.match(/^(.*runBootImportLeftoverScan\(\).*)$/m)
    expect(call, 'the boot scan is called from index.ts').not.toBeNull()
    expect(call![1]).not.toMatch(/await/)
    expect(call![1]).toContain('.catch(')
    expect(index.indexOf('runBootImportLeftoverScan()')).toBeGreaterThan(index.indexOf('  initDatabase()'))
  })
})

describe('GET /api/fleet/import-leftovers', () => {
  function getCtx(): { ctx: RouteContext; status: () => number; body: () => any } {
    const req = new EventEmitter() as never
    let code = 200
    let sent = ''
    const res = {
      writeHead: (c: number) => { code = c },
      end: (b?: string) => { sent = b ?? '' },
      setHeader: vi.fn(),
    } as never
    const url = new URL('http://localhost:3420/api/fleet/import-leftovers')
    return { ctx: { req, res, path: url.pathname, method: 'GET', url } as RouteContext, status: () => code, body: () => JSON.parse(sent) }
  }

  it('answers with the list in the API shape, and is read-only', async () => {
    const path = put('r/vault.json.import-bak', 'previous')
    mocks.roots = [{ dir: join(ROOT, 'r'), maxDepth: 1 }]
    const { ctx, status, body } = getCtx()

    expect(await tryHandleFleet(ctx)).toBe(true)

    expect(status()).toBe(200)
    expect(body()).toMatchObject({ truncated: false, truncated_reason: null, import_in_progress: false })
    expect(body().items).toHaveLength(1)
    expect(body().items[0]).toMatchObject({ path, kind: 'stale_bak' })
    expect(Object.keys(body().items[0]).sort()).toEqual(['action', 'age_seconds', 'kind', 'mtime', 'path'])
    expect(readFileSync(path, 'utf-8')).toBe('previous')
  })

  it('answers import_in_progress while an import runs', async () => {
    mocks.inProgress = true
    const { ctx, body } = getCtx()
    await tryHandleFleet(ctx)
    expect(body()).toMatchObject({ items: [], import_in_progress: true })
  })

  it('needs admin:all (no weaker permission entry), like the other fleet routes', () => {
    expect(resolveRequiredPermission('GET', '/api/fleet/import-leftovers') ?? 'admin:all').toBe('admin:all')
  })
})
