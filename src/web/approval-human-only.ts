// Human-only approval categories: the ones an agent may never decide for itself. A request in such a
// category is only resolved by a person logged in to the dashboard (a global admin session), never by a
// bearer token, the main agent's included.
//
// The set is a floor kept in code (an API call cannot lower it) plus the keys marked human_only in
// autonomy_categories (an admin can add to it). Whether any of this binds is APPROVAL_HUMAN_ONLY_ENFORCE;
// the helpers here only classify.

import type http from 'node:http'
import { listHumanOnlyCategoryKeys, getDashboardUserAuthRow } from '../db.js'
import { logger } from '../logger.js'
import { parseCookies, SESSION_COOKIE_NAME } from './auth-gate.js'
import { resolveSession } from './auth-sessions.js'

/** Categories that are human-only whatever the table says. */
export const HUMAN_ONLY_FLOOR: readonly string[] = ['email_send', 'email_standing_recipient']

const MAX_CATEGORY_LENGTH = 64

// Control, format and zero-width code points: they render as nothing, so they must not make two names
// differ. Ranges are listed as numbers so the source carries no invisible character itself.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
]

export function stripInvisible(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (!INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) out += ch
  }
  return out
}

/** NFKC, invisible characters removed, trimmed, lower case. The shape a category is compared in. */
function normalize(raw: string): string {
  return stripInvisible(raw.normalize('NFKC')).trim().toLowerCase()
}

/** The name without its underscores: `email_send`, `emailsend` and `email__send` are one skeleton. */
function skeleton(canonical: string): string {
  return canonical.replace(/_/g, '')
}

export type CategoryCheck =
  | { ok: true; category: string }
  | { ok: false; error: 'invalid_value' | 'category_alias_of_human_only'; hint: string }

/**
 * The category as it is stored: normalized, and made of [a-z0-9_] only (1-64 characters). Anything else
 * is refused, and so is a spelling that is not a human-only key itself but reads as one (another case,
 * a stray space or zero-width character, a missing or doubled underscore): a name that looks like the
 * gated category and is not it would be an unguarded twin of it.
 */
export function checkCategory(raw: string, humanOnlyKeys: readonly string[] = humanOnlyKeysNow()): CategoryCheck {
  if (humanOnlyKeys.includes(raw)) return { ok: true, category: raw }
  const canonical = normalize(raw)
  const skel = skeleton(canonical)
  for (const key of humanOnlyKeys) {
    if (skel !== '' && skeleton(key) === skel) {
      return { ok: false, error: 'category_alias_of_human_only', hint: `category is a variant spelling of the human-only category "${key}"` }
    }
  }
  if (!/^[a-z0-9_]+$/.test(canonical) || canonical.length > MAX_CATEGORY_LENGTH) {
    return { ok: false, error: 'invalid_value', hint: `category must be 1-${MAX_CATEGORY_LENGTH} characters of a-z, 0-9 and _` }
  }
  return { ok: true, category: canonical }
}

/** The human-only keys now: the code's floor and the table's column. A table that cannot be read leaves the floor. */
export function humanOnlyKeysNow(): string[] {
  const keys = new Set(HUMAN_ONLY_FLOOR)
  try {
    for (const k of listHumanOnlyCategoryKeys()) keys.add(k)
  } catch (err) {
    logger.warn({ err }, 'Human-only category lookup failed, using the built-in floor')
  }
  return [...keys]
}

/** True when a request in this category is human-only. Compares the normalized name, so a twin spelling counts too. */
export function isHumanOnly(category: string): boolean {
  const canonical = normalize(category)
  return humanOnlyKeysNow().some((k) => k === canonical || skeleton(k) === skeleton(canonical))
}

/** True for a key an API call may not take out of the human-only set. */
export function isHumanOnlyFloorKey(key: string): boolean {
  return HUMAN_ONLY_FLOOR.includes(key)
}

/**
 * The person behind this request: a valid dashboard session cookie of an enabled user who is a GLOBAL
 * admin (role admin, no tenant). Null for anything else. The cookie is judged on its own, whatever the
 * Authorization header says: a browser that sends both is still the person, and a script with a token
 * and no cookie is not.
 */
export function humanSessionOf(req: http.IncomingMessage): { user: string } | null {
  try {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
    if (!cookie) return null
    const session = resolveSession(cookie)
    if (!session) return null
    const row = getDashboardUserAuthRow(session.username)
    if (!row || row.role !== 'admin' || row.tenant_id !== null) return null
    return { user: session.username }
  } catch (err) {
    logger.warn({ err }, 'Human session lookup failed, treating the request as not human')
    return null
  }
}
