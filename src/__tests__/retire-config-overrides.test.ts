// retireConfigOverridesFile() (S8B) unit tests, fully isolated with a mocked
// node:fs. db-system-config.test.ts already covers migrateConfigOverridesToSystemConfig()
// against this worktree's REAL, shared STORE_DIR (an accepted pre-existing
// pattern there, since that function only READS the file). This function
// RENAMES it -- doing that against the real shared store/ directory would
// race every other concurrently-running test file that also touches
// config-overrides.json (multiple test files already read/write that exact
// physical path from separate worker processes). Mocking node:fs sidesteps
// that entirely: no real I/O, no cross-file race, deterministic.

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
  const { retireConfigOverridesFile } = await import('../db/system-config.js')
  return retireConfigOverridesFile
}

describe('retireConfigOverridesFile', () => {
  it('is a no-op when config-overrides.json does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const retireConfigOverridesFile = await load()

    expect(() => retireConfigOverridesFile()).not.toThrow()

    expect(mockRenameSync).not.toHaveBeenCalled()
    expect(mockLoggerInfo).not.toHaveBeenCalled()
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })

  it('renames config-overrides.json to config-overrides.json.deprecated and logs it', async () => {
    mockExistsSync.mockReturnValue(true)
    const retireConfigOverridesFile = await load()

    retireConfigOverridesFile()

    expect(mockRenameSync).toHaveBeenCalledWith(
      '/mock/store/config-overrides.json',
      '/mock/store/config-overrides.json.deprecated',
    )
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ overridesPath: '/mock/store/config-overrides.json' }),
      expect.stringContaining('retired'),
    )
  })

  it('is idempotent: existsSync false on a second call is a no-op, no second rename', async () => {
    const retireConfigOverridesFile = await load()

    mockExistsSync.mockReturnValueOnce(true)
    retireConfigOverridesFile()
    expect(mockRenameSync).toHaveBeenCalledTimes(1)

    mockExistsSync.mockReturnValueOnce(false)
    retireConfigOverridesFile()
    expect(mockRenameSync).toHaveBeenCalledTimes(1)
  })

  it('a renameSync failure is caught and logged as a warning, not thrown', async () => {
    mockExistsSync.mockReturnValue(true)
    mockRenameSync.mockImplementation(() => { throw new Error('EPERM') })
    const retireConfigOverridesFile = await load()

    expect(() => retireConfigOverridesFile()).not.toThrow()

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), overridesPath: '/mock/store/config-overrides.json' }),
      expect.stringContaining('failed to rename'),
    )
    expect(mockLoggerInfo).not.toHaveBeenCalled()
  })
})
