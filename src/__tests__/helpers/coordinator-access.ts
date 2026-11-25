// A throwaway access.json for the coordinator's sender gate: the plugin's state directory (TELEGRAM_STATE_DIR) is pointed at a
// temp directory for each test, so the real access list of the machine is never read. Call at the top level of a test file, next
// to useTestDb(); `write` replaces the file (an object is JSON-encoded, a string is written as it is, null removes the file).
// Neutral ids only.
import { afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetSenderGateForTests } from '../../channel-coordinator/sender-gate.js'

export const OWNER_CHAT = 1001

export interface AccessFile {
  path: string
  write(content: object | string | null): void
}

/** The default list lets the owner chat (1001) through, as an allowlist install. */
export function useAccessFile(initial: object | string | null = { dmPolicy: 'allowlist', allowFrom: [String(OWNER_CHAT)], groups: {}, pending: {} }): AccessFile {
  const state = { dir: '', path: '' }
  const handle: AccessFile = {
    get path() { return state.path },
    write(content) {
      if (content === null) { try { unlinkSync(state.path) } catch { /* already gone */ } return }
      writeFileSync(state.path, typeof content === 'string' ? content : JSON.stringify(content))
    },
  }
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'coord-access-'))
    state.path = join(state.dir, 'access.json')
    vi.stubEnv('TELEGRAM_STATE_DIR', state.dir)
    resetSenderGateForTests()
    handle.write(initial)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(state.dir, { recursive: true, force: true })
  })
  return handle
}
