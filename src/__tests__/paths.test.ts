// The path roots (src/paths.ts): the leaf module that holds PROJECT_ROOT and STORE_DIR. config.ts re-exports them, so both
// names must be the same values; the store directory follows MARVEEN_STORE_DIR (isolated instances keep their own vault).
// A source pin (weak, named as such) keeps the vault off config.ts; the closure cell of the entry test is the strong check.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url)
// the cells unset MARVEEN_STORE_DIR (an empty value is a value for ?? , so the variable is deleted, not blanked)
let savedStoreDir: string | undefined

beforeEach(() => {
  vi.resetModules()
  savedStoreDir = process.env['MARVEEN_STORE_DIR']
  delete process.env['MARVEEN_STORE_DIR']
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (savedStoreDir === undefined) delete process.env['MARVEEN_STORE_DIR']
  else process.env['MARVEEN_STORE_DIR'] = savedStoreDir
})

describe('paths.ts (the path roots)', () => {
  it('PROJECT_ROOT is the repository root (it holds package.json)', async () => {
    const paths = await import('../paths.js')
    expect(readFileSync(join(paths.PROJECT_ROOT, 'package.json'), 'utf8')).toContain('"name"')
  })

  it('STORE_DIR is PROJECT_ROOT/store by default', async () => {
    const paths = await import('../paths.js')
    expect(paths.STORE_DIR).toBe(join(paths.PROJECT_ROOT, 'store'))
  })

  it('STORE_DIR follows MARVEEN_STORE_DIR (an isolated instance keeps its own vault under its own directory)', async () => {
    vi.stubEnv('MARVEEN_STORE_DIR', '/tmp/carl-isolated-store-placeholder')
    const paths = await import('../paths.js')
    expect(paths.STORE_DIR).toBe('/tmp/carl-isolated-store-placeholder')
  })

  it('config.ts re-exports the same two values (no importer changes)', async () => {
    const paths = await import('../paths.js')
    const config = await import('../config.js')
    expect(config.STORE_DIR).toBe(paths.STORE_DIR)
    expect(config.PROJECT_ROOT).toBe(paths.PROJECT_ROOT)
  })

  it('the vault reads its store through paths.ts, not config.ts (weak source pin: the closure cell is the strong one)', () => {
    const src = readFileSync(new URL('src/web/vault.ts', ROOT), 'utf8')
    expect(src).toContain("from '../paths.js'")
    expect(src).not.toContain("from '../config.js'")
  })
})
