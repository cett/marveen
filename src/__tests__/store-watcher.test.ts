import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// store-watcher uses STORE_DIR from config.js. We mock config.js so the
// watcher operates in a temp dir and never touches the real store.
const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'store-watcher-test-'))
  const dir = join(root, 'store')
  mkdirSync(dir, { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: dir }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))

// Also stub out the DB call so the watcher can run without a real DB.
vi.mock('../db.js', async (orig) => {
  const actual = await orig<typeof import('../db.js')>()
  return { ...actual, logStoreFileEvent: vi.fn() }
})

import * as storeWatcher from '../store-watcher.js'
import {
  startStoreWatcher,
  stopStoreWatcher,
} from '../store-watcher.js'

afterEach(() => stopStoreWatcher())

// The file audit records a new store file without an actor (see docs/db-facade.md, Known limits).
// These pins make a future store-file writer a deliberate act: nothing the three request routes
// that once announced themselves write through can reach the file system, and the watcher offers
// no setter that would bring the process-wide slot back.
describe('the store file audit is unattributed on purpose', () => {
  it('exports no write-actor setter', () => {
    expect(Object.keys(storeWatcher).filter(k => /actor|tenant/i.test(k))).toEqual([])
    expect(Object.keys(storeWatcher).sort()).toEqual(['startStoreWatcher', 'stopStoreWatcher'])
  })

  // settings POST -> setOverride; auto-restart and context-guard PUT -> their config writers.
  const WRITE_MODULES = [
    '../settings-store.ts',
    '../web/auto-restart-store.ts',
    '../web/context-guard-store.ts',
    '../db/system-config.ts',
    '../db/agent-settings.ts',
  ]
  const FS_WRITER = /\b(writeFileSync|writeFile|appendFile|appendFileSync|atomicWriteFile|atomicWriteFileSync|renameSync|rename|copyFile|copyFileSync|createWriteStream|mkdirSync|openSync|symlinkSync|truncateSync|unlinkSync|rmSync)\s*\(/

  // The one file-system writer in these modules is the boot-time retirement of the old side-car files
  // (a rename to .deprecated, called from src/index.ts), at the end of system-config.ts. It is not on
  // the path of a request: the pin cuts it off and checks that nothing else follows it.
  const BOOT_TAIL_MARKER = 'export function retireGroup5StateFiles'
  const BOOT_TAIL_FUNCTIONS = ['retireConfigOverridesFile', 'retireGroup5StateFiles']

  function readWithoutComments(rel: string): string {
    const here = dirname(fileURLToPath(import.meta.url))
    return readFileSync(join(here, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it.each(WRITE_MODULES)('%s contains no file-system writer on a request path', (rel) => {
    let src = readWithoutComments(rel)
    const cut = src.indexOf(BOOT_TAIL_MARKER)
    if (cut !== -1) {
      const tail = src.slice(cut)
      const exported = [...tail.matchAll(/export (?:async )?function (\w+)/g)].map(m => m[1]).sort()
      expect(exported).toEqual(BOOT_TAIL_FUNCTIONS)
      src = src.slice(0, cut)
    }
    expect(src).not.toMatch(FS_WRITER)
    expect(src).not.toMatch(/retireGroup5StateFiles|retireConfigOverridesFile/)
  })

  it('the pinned modules are the ones the three routes call', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const settings = readFileSync(join(here, '../web/routes/settings.ts'), 'utf8')
    const process_ = readFileSync(join(here, '../web/routes/agents-process.ts'), 'utf8')
    expect(settings).toMatch(/setOverride\(/)
    expect(process_).toMatch(/writeAutoRestartConfig\(/)
    expect(process_).toMatch(/writeContextGuardConfig\(/)
    expect(settings + process_).not.toMatch(/store-watcher/)
  })
})

describe('startStoreWatcher / stopStoreWatcher', () => {
  it('starts without throwing', () => {
    expect(() => startStoreWatcher()).not.toThrow()
  })

  it('is idempotent -- calling start twice does not throw', () => {
    startStoreWatcher()
    expect(() => startStoreWatcher()).not.toThrow()
  })

  it('stop is idempotent -- calling stop when not started does not throw', () => {
    expect(() => stopStoreWatcher()).not.toThrow()
  })

  it('stop after start closes cleanly', () => {
    startStoreWatcher()
    expect(() => stopStoreWatcher()).not.toThrow()
  })
})
