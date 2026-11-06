import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

const SECURITY = '/usr/bin/security'
const SERVICE = 'com.marveen.vault'
const ACCOUNT = 'master-key'

// A locked keychain makes `security` pop a GUI unlock prompt and block
// indefinitely; without a timeout that freezes the whole dashboard (measured
// 2026-08-22: 48-minute HTTP outage from exactly this, VAULTKEY822). The
// timeout turns a hung call into a loud 'unavailable' instead.
const SECURITY_TIMEOUT_MS = 5000

// errSecItemNotFound: the keychain ANSWERED and the item does not exist.
// Everything else (timeout, locked keychain, auth failure) means the keychain
// did not answer -- callers must treat that as unavailable, never as "no key".
const EXIT_ITEM_NOT_FOUND = 44

// An isolated instance (MARVEEN_STORE_DIR set) keeps every FILE store of its own, but the Keychain item
// above is one per user and does not depend on the store directory. Left on, an isolated instance would
// read the REAL master key and, in the migration branch of getMasterKey, overwrite it with the key of the
// isolated vault: the live vault.json would no longer decrypt. So in isolated mode the Keychain is off
// and the vault uses its file key under the isolated store.
//
// This is the same definition as IS_ISOLATED_MODE in config.ts (Boolean of the same variable). It is read
// here from the environment instead of imported: config.ts reaches the vault through the secret resolver,
// so importing it from here would be a cycle. A test pins that the two agree. It is read at each call,
// not once at load, so the answer cannot go stale.
function isIsolatedStore(): boolean {
  return Boolean(process.env['MARVEEN_STORE_DIR'])
}

export function isKeychainAvailable(): boolean {
  // The one gate for every caller. Isolated store: never (see above). Otherwise a platform gate only:
  // whether the keychain actually answers is decided by keychainRetrieveStatus() at each decision point
  // -- a platform check alone said "available" on a locked keychain and enabled the silent key swap
  // (VAULTUJKULCS822).
  if (isIsolatedStore()) return false
  return platform() === 'darwin'
}

export type KeychainReadStatus = 'ok' | 'empty' | 'unavailable'
export interface KeychainReadResult {
  status: KeychainReadStatus
  value: string | null
}

export function keychainRetrieveStatus(): KeychainReadResult {
  try {
    const out = execFileSync(SECURITY, [
      'find-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SECURITY_TIMEOUT_MS })
    const value = out.trim()
    return value ? { status: 'ok', value } : { status: 'empty', value: null }
  } catch (err: any) {
    if (err?.status === EXIT_ITEM_NOT_FOUND) return { status: 'empty', value: null }
    return { status: 'unavailable', value: null }
  }
}

export function keychainRetrieve(): string | null {
  return keychainRetrieveStatus().value
}

// Thrown by the two WRITERS below in an isolated instance. The gate above keeps the vault away from the
// Keychain, but the protection must not rest on every caller remembering to ask it: a future caller that
// forgets would overwrite or delete the real master key. The message names no value.
export class KeychainIsolatedError extends Error {
  constructor(action: 'store' | 'delete') {
    super(`Keychain ${action} refused: this is an isolated instance (MARVEEN_STORE_DIR is set) and must not touch the real master key`)
    this.name = 'KeychainIsolatedError'
  }
}

export function keychainStore(value: string): void {
  if (isIsolatedStore()) throw new KeychainIsolatedError('store')
  execFileSync(SECURITY, [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', value,
    '-A',
  ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: SECURITY_TIMEOUT_MS })
}

export function keychainDelete(): boolean {
  // Before the try: a refusal must reach the caller, not turn into the "false" of a failed delete.
  if (isIsolatedStore()) throw new KeychainIsolatedError('delete')
  try {
    execFileSync(SECURITY, [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: SECURITY_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
