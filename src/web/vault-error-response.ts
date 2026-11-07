import type http from 'node:http'
import { logger } from '../logger.js'
import { json } from './http-helpers.js'
import { VaultKeyError } from './vault.js'

// What a client sees when the vault cannot establish its master key safely
// (VaultKeyError: key missing, Keychain locked, key does not open vault.json,
// vault.json unreadable or an entry corrupt). A fixed text on purpose: the
// error's own message names key files, entry counts and, for a parse failure,
// a snippet of the file -- all of that stays in the server log, never in the
// response. No secret value, key material or store path can reach the client.
export const VAULT_KEY_UNAVAILABLE_HINT =
  'The vault master key is unavailable or does not open the vault. An operator must restore it (see the server log); retrying alone will not help.'

// Answers a VaultKeyError with 503 vault_key_unavailable instead of the
// generic 500 internal_error. Returns true when it answered, false when `err`
// is something else (the caller then falls through to its own handling).
// 503, not 500: the server is healthy, one dependency (the vault key) is not.
// Not 409: nothing the caller sent conflicts with anything.
export function answerVaultKeyError(err: unknown, res: http.ServerResponse): boolean {
  if (!(err instanceof VaultKeyError)) return false
  // The full error (message with paths/counts) goes to the log only.
  logger.error({ err, event: 'vault-key-unavailable' }, 'vault: master key unavailable, request answered 503')
  json(res, { error: 'vault_key_unavailable', hint: VAULT_KEY_UNAVAILABLE_HINT }, 503)
  return true
}
