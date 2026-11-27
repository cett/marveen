import type http from 'node:http'
import { noteRlsRefusal } from '../db/context.js'
import { logger } from '../logger.js'
import { json } from './http-helpers.js'

// What a client sees when the DATABASE refuses a write (SQLSTATE 42501, insufficient_privilege: a row-level policy's
// WITH CHECK or a missing grant) and no route handled it. It used to fall through to the generic 500 internal_error, which
// told the caller the server was broken when the truth is "this scope may not do that". It is now 403 forbidden with a
// FIXED hint: the PostgreSQL message names the table and the policy, and all of that stays in the server log, never in the
// response (no SQL text, table, column or policy name can reach the client).
//
// This only fixes the code of the answer (500 -> 403); it grants nothing. A refusal is still a defect somewhere (a caller in a
// context too narrow for its write), so it is logged at warn with the route and the SQLSTATE and counted per route
// (`rlsRefusals` of the db-context measurement view): the answer must not hide it, the way a lost ledger turn once was.
export const RLS_REFUSAL_HINT = 'The database refused this operation for the caller\'s scope.'

const INSUFFICIENT_PRIVILEGE = '42501'
const MAX_CAUSE_DEPTH = 4

interface PgLikeError { code?: unknown; table?: unknown; cause?: unknown }

/** The 42501 error in `err` or in its `cause` chain (a wrapper may carry the driver error), or undefined. */
function findRefusal(err: unknown): PgLikeError | undefined {
  let cur: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof cur === 'object' && cur !== null; depth++) {
    const e = cur as PgLikeError
    if (e.code === INSUFFICIENT_PRIVILEGE) return e
    cur = e.cause
  }
  return undefined
}

/**
 * The route as the counter and the log name it: the method and the first three path segments (`DELETE /api/skills/sql`),
 * so an id, a tenant or a file name in the path never becomes a key. A path with fewer segments is used as it is.
 */
export function refusalRouteKey(method: string, path: string): string {
  const segs = path.split('?')[0].split('/').filter(Boolean).slice(0, 3)
  return `${method} /${segs.join('/')}`
}

/**
 * Answers a 42501 with 403 forbidden instead of the generic 500. Returns true when it answered, false when `err` is
 * something else (the caller then falls through to its own handling).
 */
export function answerRlsRefusal(err: unknown, res: http.ServerResponse, method: string, path: string): boolean {
  const refusal = findRefusal(err)
  if (!refusal) return false
  const route = refusalRouteKey(method, path)
  noteRlsRefusal(route)
  // The log keeps the detail the client must not get: the full error, and the table the driver names.
  logger.warn({ err, event: 'rls-refusal', route, sqlstate: INSUFFICIENT_PRIVILEGE, table: typeof refusal.table === 'string' ? refusal.table : undefined }, 'db: a write was refused by the database (42501), request answered 403')
  json(res, { error: 'forbidden', hint: RLS_REFUSAL_HINT }, 403)
  return true
}
