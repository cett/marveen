import { describe, it, expect, beforeEach, vi } from 'vitest'

const { execFileSyncMock, platformMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  platformMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('node:os', () => ({ platform: platformMock }))

import {
  isKeychainAvailable,
  keychainRetrieveStatus,
  keychainRetrieve,
  keychainStore,
  keychainDelete,
} from '../web/keychain.js'

beforeEach(() => {
  execFileSyncMock.mockReset()
  platformMock.mockReset().mockReturnValue('darwin')
})

describe('isKeychainAvailable', () => {
  it('is true on darwin', () => {
    platformMock.mockReturnValue('darwin')
    expect(isKeychainAvailable()).toBe(true)
  })

  it('is false on any other platform', () => {
    platformMock.mockReturnValue('linux')
    expect(isKeychainAvailable()).toBe(false)
  })
})

describe('keychainRetrieveStatus / keychainRetrieve', () => {
  it('returns ok with the trimmed value on success', () => {
    execFileSyncMock.mockReturnValue('  secret-value\n')
    expect(keychainRetrieveStatus()).toEqual({ status: 'ok', value: 'secret-value' })
    expect(keychainRetrieve()).toBe('secret-value')
  })

  it('returns empty when the command succeeds but yields a blank value', () => {
    execFileSyncMock.mockReturnValue('   \n')
    expect(keychainRetrieveStatus()).toEqual({ status: 'empty', value: null })
    expect(keychainRetrieve()).toBeNull()
  })

  it('returns empty (not unavailable) on the item-not-found exit code', () => {
    execFileSyncMock.mockImplementation(() => {
      const err: any = new Error('not found')
      err.status = 44
      throw err
    })
    expect(keychainRetrieveStatus()).toEqual({ status: 'empty', value: null })
  })

  it('returns unavailable on a locked keychain / timeout / any other failure', () => {
    execFileSyncMock.mockImplementation(() => {
      const err: any = new Error('timeout')
      err.status = 1
      throw err
    })
    expect(keychainRetrieveStatus()).toEqual({ status: 'unavailable', value: null })
  })

  it('treats an error with no status code as unavailable, not empty', () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('generic failure') })
    expect(keychainRetrieveStatus()).toEqual({ status: 'unavailable', value: null })
  })
})

describe('keychainStore', () => {
  it('invokes security add-generic-password with the given value', () => {
    keychainStore('my-secret')
    expect(execFileSyncMock).toHaveBeenCalledWith(
      '/usr/bin/security',
      expect.arrayContaining(['add-generic-password', '-w', 'my-secret']),
      expect.objectContaining({ timeout: 5000 }),
    )
  })

  it('propagates a failure (caller must handle it)', () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('store failed') })
    expect(() => keychainStore('x')).toThrow('store failed')
  })
})

describe('keychainDelete', () => {
  it('returns true on success', () => {
    execFileSyncMock.mockReturnValue('')
    expect(keychainDelete()).toBe(true)
  })

  it('returns false on failure instead of throwing', () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('delete failed') })
    expect(keychainDelete()).toBe(false)
  })
})
