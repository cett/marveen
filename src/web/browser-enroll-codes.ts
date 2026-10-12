// One-time browser enrollment codes.
//
// A fresh browser used to be handed the shared dashboard token in the URL (`/?token=<shared>`),
// which made the shared token live in terminal scrollback, service logs, browser history and
// chat. The URL now carries a short-lived, single-use enrollment code instead (`/?enroll=<code>`).
// The browser trades the code for its OWN named, revocable admin token at
// POST /api/auth/enroll-browser (src/web/routes/browser-enroll.ts).
//
// In-memory on purpose: the codes are minutes-lived, a restart simply invalidates the unused ones
// (the operator asks for a new one), and nothing secret reaches the database. Only the sha256 of
// a code is kept, so a heap dump or a debug print of the store does not yield a usable code.
//
// Brute force: a code is 192 random bits, so guessing is not the realistic attack; the throttle
// below still caps the failed-attempt rate (a wrong code is a signal worth bounding): once it is
// tripped, a code that does not match gets 429 instead of 401. A code that matches is always
// accepted, so spraying wrong codes cannot lock a legitimate enrollment out.

import { createHash, randomBytes } from 'node:crypto'

export const ENROLL_CODE_TTL_MS = 10 * 60 * 1000
const MAX_LIVE_CODES = 20
const FAILURE_WINDOW_MS = 10 * 60 * 1000
const MAX_FAILURES_IN_WINDOW = 10

// sha256(code) -> expiry (epoch ms). Map iteration order is insertion order, so the first key is the oldest.
const live = new Map<string, number>()
let failures: number[] = []

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

function pruneExpired(now: number): void {
  for (const [hash, expiresAt] of live) if (expiresAt <= now) live.delete(hash)
}

function pruneFailures(now: number): void {
  const cutoff = now - FAILURE_WINDOW_MS
  if (failures.length && failures[0] < cutoff) failures = failures.filter((t) => t >= cutoff)
}

/** A fresh single-use code, valid for ENROLL_CODE_TTL_MS. The raw code is returned once and never stored. */
export function issueEnrollCode(now: number = Date.now()): { code: string; expiresAt: number } {
  pruneExpired(now)
  while (live.size >= MAX_LIVE_CODES) {
    const oldest = live.keys().next().value
    if (oldest === undefined) break
    live.delete(oldest)
  }
  const code = randomBytes(24).toString('base64url')
  const expiresAt = now + ENROLL_CODE_TTL_MS
  live.set(hashCode(code), expiresAt)
  return { code, expiresAt }
}

/** The URL a browser opens to enroll with `code`, on `base` (an origin, with or without a trailing slash). */
export function enrollUrl(base: string, code: string): string {
  return `${base.replace(/\/$/, '')}/?enroll=${encodeURIComponent(code)}`
}

export type EnrollAttempt =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'throttled'; retryAfterS: number }

/**
 * Spends a code. A code works exactly once: it is removed on the first match, before the caller
 * mints anything, so two concurrent requests with the same code cannot both succeed.
 */
export function consumeEnrollCode(code: string, now: number = Date.now()): EnrollAttempt {
  pruneExpired(now)
  // A live code is never refused by the throttle. The code is 192 random bits, so letting a
  // correct one through costs nothing against guessing, while a throttle that also refused it
  // would let anyone who can reach the port lock the legitimate enrollment out by spraying
  // wrong codes (the failure counter is global, there is no usable client address on loopback).
  const hash = hashCode(code)
  if (code && live.has(hash)) {
    live.delete(hash)
    return { ok: true }
  }
  pruneFailures(now)
  if (failures.length >= MAX_FAILURES_IN_WINDOW) {
    const retry = Math.ceil((failures[0] + FAILURE_WINDOW_MS - now) / 1000)
    return { ok: false, reason: 'throttled', retryAfterS: Math.max(1, retry) }
  }
  failures.push(now)
  return { ok: false, reason: 'invalid' }
}

// Test seam.
export function _resetEnrollCodesForTest(): void {
  live.clear()
  failures = []
}
