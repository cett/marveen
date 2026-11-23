// The bootstrap (src/index.ts, the process entry) loads the PostgreSQL system_config snapshot before the application (main.ts)
// is imported. In-process cells: main.js and the snapshot loader are mocked, and the order of the calls is recorded. Plus two
// source pins: the bootstrap imports no config.ts (a weak pin, named as such), and the launchers still start dist/index.js.
// Privacy: placeholder URL and values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const calls = vi.hoisted(() => ({
  order: [] as string[],
  url: undefined as string | undefined,
  loaderThrows: false,
}))

const PG_URL = 'postgres://user:placeholder@db.invalid:5432/marveen'

// vi.resetModules() does not re-run a mock's factory, so the mocks are registered again for every cell (doMock): each cell
// then records its own call order.
beforeEach(() => {
  calls.order = []
  calls.url = undefined
  calls.loaderThrows = false
  vi.resetModules()
  vi.doMock('../main.js', () => { calls.order.push('main'); return {} })
  vi.doMock('../config-snapshot-loader.js', () => ({
    loadSystemConfigSnapshot: (url: string) => {
      calls.order.push('loader')
      calls.url = url
      if (calls.loaderThrows) throw new Error('system_config snapshot could not be read (no error code)')
      return { SCHEDULER_TZ: 'Asia/Tokyo' }
    },
  }))
})

describe('the bootstrap (src/index.ts) on the process boot', () => {
  it('an install on SQLite imports the application and reads no snapshot', async () => {
    vi.stubEnv('MARVEEN_PG_URL', '')
    await import('../index.js')
    expect(calls.order).toEqual(['main'])
    const snapshot = await import('../config-snapshot.js')
    expect(snapshot.getConfigSnapshot()).toBeUndefined()
  })

  it('a PostgreSQL URL: the snapshot is loaded from that URL and set before the application is imported', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    await import('../index.js')
    expect(calls.order).toEqual(['loader', 'main'])
    expect(calls.url).toBe(PG_URL)
    const snapshot = await import('../config-snapshot.js')
    expect(snapshot.getConfigSnapshot()).toEqual({ SCHEDULER_TZ: 'Asia/Tokyo' })
  })

  it('a failed snapshot read ends the boot before the application is imported', async () => {
    vi.stubEnv('MARVEEN_PG_URL', PG_URL)
    calls.loaderThrows = true
    await expect(import('../index.js')).rejects.toThrow('system_config snapshot could not be read')
    expect(calls.order).toEqual(['loader'])
  })
})

describe('the bootstrap and the launchers (source pins, weak by design: they name the shape, not the behaviour)', () => {
  const ROOT = new URL('../../', import.meta.url)

  it('index.ts imports no config.ts (a static import would evaluate config.ts before the snapshot is set)', () => {
    const src = readFileSync(new URL('src/index.ts', ROOT), 'utf8')
    // any reference to the module, a side-effect import included (import './config.js' has no "from")
    expect(src).not.toContain("'./config.js'")
    expect(src).not.toContain("'./config-registry.js'")
  })

  // each launcher names the entry in the form it uses: the watchdog matches the process command line, setup builds the path
  it.each([
    ['package.json', 'dist/index.js'],
    ['scripts/start.sh', 'dist/index.js'],
    ['scripts/watchdog.sh', 'node dist/index.js'],
    ['scripts/setup.ts', "'dist', 'index.js'"],
  ])('%s still starts the entry dist/index.js (the rename keeps the launchers and the watchdog pattern)', (path, needle) => {
    expect(readFileSync(new URL(path, ROOT), 'utf8')).toContain(needle)
  })
})
