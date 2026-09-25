// Coverage for readClaudeCodeOauthJson (src/web/claude-credentials.ts),
// previously untested. Existing heartbeat tests only mock this function or
// do source-text structural checks (heartbeat-unit.test.ts); none exercises
// its actual behaviour. execFileSync and os.userInfo are mocked so no real
// Keychain access happens.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, userInfo: vi.fn(actual.userInfo) }
})
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }))

import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { readClaudeCodeOauthJson } from '../web/claude-credentials.js'

describe('readClaudeCodeOauthJson', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset()
    vi.mocked(userInfo).mockReturnValue({ username: 'zed' } as ReturnType<typeof userInfo>)
    platformSpy = vi.spyOn(process, 'platform', 'get')
  })

  it('returns null off macOS without touching the Keychain', () => {
    platformSpy.mockReturnValue('linux')
    expect(readClaudeCodeOauthJson()).toBeNull()
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('returns the trimmed Keychain output on macOS', () => {
    platformSpy.mockReturnValue('darwin')
    vi.mocked(execFileSync).mockReturnValue('  {"access_token":"tok"}  \n')
    expect(readClaudeCodeOauthJson()).toBe('{"access_token":"tok"}')
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'zed', '-w'],
      expect.objectContaining({ timeout: 3000 }),
    )
  })

  it('returns null when the Keychain entry is empty', () => {
    platformSpy.mockReturnValue('darwin')
    vi.mocked(execFileSync).mockReturnValue('   \n')
    expect(readClaudeCodeOauthJson()).toBeNull()
  })

  it('returns null and logs a warning when the lookup throws (no entry / locked Keychain)', async () => {
    platformSpy.mockReturnValue('darwin')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('security: item not found') })
    expect(readClaudeCodeOauthJson()).toBeNull()
    const { logger } = await import('../logger.js')
    expect(logger.warn).toHaveBeenCalled()
  })
})
