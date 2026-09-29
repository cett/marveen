// retireGroup5StateFiles() (#985 group 5/8's un-retired trio) unit tests,
// fully isolated with a mocked node:fs -- same rationale as
// retire-config-overrides.test.ts: this function RENAMES files, so it must
// not touch this worktree's real, shared STORE_DIR (other test files read/
// write the same physical paths from separate worker processes).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExistsSync = vi.hoisted(() => vi.fn())
const mockRenameSync = vi.hoisted(() => vi.fn())
const mockLoggerInfo = vi.hoisted(() => vi.fn())
const mockLoggerWarn = vi.hoisted(() => vi.fn())

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: mockExistsSync, renameSync: mockRenameSync }
})

vi.mock('../config.js', () => ({ STORE_DIR: '/mock/store' }))

vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, debug: vi.fn() },
}))

beforeEach(() => {
  vi.resetModules()
  mockExistsSync.mockReset()
  mockRenameSync.mockReset()
  mockLoggerInfo.mockReset()
  mockLoggerWarn.mockReset()
})

async function load() {
  const { retireGroup5StateFiles } = await import('../db/system-config.js')
  return retireGroup5StateFiles
}

const FILES = ['model-fallback.json', 'agents-desired.json', 'terminal-input.json']

describe('retireGroup5StateFiles', () => {
  it('is a no-op when none of the three files exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const retireGroup5StateFiles = await load()

    expect(() => retireGroup5StateFiles()).not.toThrow()

    expect(mockRenameSync).not.toHaveBeenCalled()
    expect(mockLoggerInfo).not.toHaveBeenCalled()
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })

  it('renames all three files to .deprecated and logs each one', async () => {
    mockExistsSync.mockReturnValue(true)
    const retireGroup5StateFiles = await load()

    retireGroup5StateFiles()

    expect(mockRenameSync).toHaveBeenCalledTimes(3)
    for (const name of FILES) {
      expect(mockRenameSync).toHaveBeenCalledWith(
        `/mock/store/${name}`,
        `/mock/store/${name}.deprecated`,
      )
    }
    expect(mockLoggerInfo).toHaveBeenCalledTimes(3)
  })

  it('only renames the files that exist -- a partial install (e.g. only agents-desired.json ever written) is handled per-file', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('agents-desired.json'))
    const retireGroup5StateFiles = await load()

    retireGroup5StateFiles()

    expect(mockRenameSync).toHaveBeenCalledTimes(1)
    expect(mockRenameSync).toHaveBeenCalledWith(
      '/mock/store/agents-desired.json',
      '/mock/store/agents-desired.json.deprecated',
    )
  })

  it('a renameSync failure on one file is caught and logged, and the loop continues to the remaining files', async () => {
    mockExistsSync.mockReturnValue(true)
    mockRenameSync.mockImplementation((from: string) => {
      if (from.endsWith('agents-desired.json')) throw new Error('EPERM')
    })
    const retireGroup5StateFiles = await load()

    expect(() => retireGroup5StateFiles()).not.toThrow()

    expect(mockRenameSync).toHaveBeenCalledTimes(3)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: '/mock/store/agents-desired.json' }),
      expect.stringContaining('failed to rename'),
    )
    // The other two files still succeeded and logged info.
    expect(mockLoggerInfo).toHaveBeenCalledTimes(2)
  })
})
