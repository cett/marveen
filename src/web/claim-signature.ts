import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { STORE_DIR } from '../config.js'

// The signature on a successful claim answer.
//
// The send gate and the official sender spend an approval with POST /api/approvals/claim and only act on a
// 200. A listener on the dashboard's port that is not the dashboard (a mirror of the request, started where
// the real one is not) can echo the hash, the agent and the reference back in a 200 of its own. It cannot
// sign: the key lives in store/.claim-signing-key, which the server creates and the gate and the sender read.
// The key is never logged and never returned by any route.
//
// Signed text: v1|content_hash|category|agent_id|ref|consumed_at   (HMAC-SHA256, lowercase hex).
// The key is the 32 random bytes the file holds as 64 hex characters.

export const CLAIM_SIGNING_KEY_FILE = '.claim-signing-key'
const KEY_HEX = /^[0-9a-f]{64}$/

export class ClaimKeyError extends Error {}

export interface SignedClaim {
  content_hash: string
  category: string
  agent_id: string
  ref: string | null
  consumed_at: number
}

export function claimSigningKeyPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, CLAIM_SIGNING_KEY_FILE)
}

function parseKey(text: string): Buffer {
  const hex = text.trim()
  if (!KEY_HEX.test(hex)) throw new ClaimKeyError('the claim signing key file does not hold 64 lowercase hex characters')
  return Buffer.from(hex, 'hex')
}

/**
 * The signing key of storeDir: read from store/.claim-signing-key, created (mode 0600, from the first byte,
 * and only when it does not exist) when it is missing. Throws ClaimKeyError when it cannot be read or is not
 * a key; the message never holds the key.
 */
export function loadOrCreateClaimSigningKey(storeDir: string = STORE_DIR): Buffer {
  const path = claimSigningKeyPath(storeDir)
  try {
    return parseKey(readFileSync(path, 'utf-8'))
  } catch (err) {
    if (err instanceof ClaimKeyError) throw err
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ClaimKeyError('the claim signing key file cannot be read')
  }
  // Missing: write a private temp file, then link it into place. link() fails when the name exists, so of two
  // processes creating the key at once one wins and both read the winner's.
  const fresh = randomBytes(32)
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(tmp, fresh.toString('hex'), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* the mode above is already 0600 */ }
    try {
      linkSync(tmp, path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      return parseKey(readFileSync(path, 'utf-8'))
    }
    return fresh
  } catch (err) {
    if (err instanceof ClaimKeyError) throw err
    throw new ClaimKeyError('the claim signing key file cannot be created')
  } finally {
    try { unlinkSync(tmp) } catch { /* no temp file left, or never written */ }
  }
}

/** The text that is signed; exported so a test and the docs name one definition. */
export function claimSignatureInput(c: SignedClaim): string {
  return ['v1', c.content_hash, c.category, c.agent_id, c.ref ?? '', String(c.consumed_at)].join('|')
}

export function signClaim(c: SignedClaim, key: Buffer): string {
  return createHmac('sha256', key).update(claimSignatureInput(c), 'utf8').digest('hex')
}
