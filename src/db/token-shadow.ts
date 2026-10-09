// Persistence for the Phase T2 token-usage shadow counter (table token_usage_shadow, migration
// 0079). An aggregate: one row per shape of request, a counter on it. The policy (what counts, the
// per-day row cap, the retention) lives in web/token-shadow.ts; this file is only the SQL.

import { db } from './connection.js'

export type TokenShadowCallerSource = 'self_declared' | 'token' | 'none'

export interface TokenShadowKey {
  day: string
  category: string
  method: string
  route: string
  caller: string
  callerSource: TokenShadowCallerSource
  client: string
  target: string
}

export interface TokenShadowRow {
  day: string
  category: string
  method: string
  route: string
  caller: string
  caller_source: TokenShadowCallerSource
  client: string
  target: string
  count: number
  last_ts: number
}

/** Adds one to the counter of this shape, creating the row on first sight. */
export function bumpTokenShadow(key: TokenShadowKey, nowSec: number): void {
  db.prepare(
    `INSERT INTO token_usage_shadow
       (day, category, method, route, caller, caller_source, client, target, count, last_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (day, category, method, route, caller, caller_source, client, target)
     DO UPDATE SET count = count + 1, last_ts = excluded.last_ts`,
  ).run(key.day, key.category, key.method, key.route, key.caller, key.callerSource, key.client, key.target, nowSec)
}

export function tokenShadowKeyExists(key: TokenShadowKey): boolean {
  return db.prepare(
    `SELECT 1 FROM token_usage_shadow
      WHERE day = ? AND category = ? AND method = ? AND route = ? AND caller = ?
        AND caller_source = ? AND client = ? AND target = ?`,
  ).get(key.day, key.category, key.method, key.route, key.caller, key.callerSource, key.client, key.target) !== undefined
}

export function countTokenShadowRowsForDay(day: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM token_usage_shadow WHERE day = ?').get(day) as { n: number }).n
}

/** Deletes the rows of days before `day` (YYYY-MM-DD, compared as text). Returns the number removed. */
export function deleteTokenShadowRowsBefore(day: string): number {
  return db.prepare('DELETE FROM token_usage_shadow WHERE day < ?').run(day).changes
}

export interface TokenShadowFilter {
  fromDay: string
  category?: string
  caller?: string
  route?: string
  limit: number
}

function whereOf(f: Pick<TokenShadowFilter, 'fromDay' | 'category' | 'caller' | 'route'>): { sql: string; params: string[] } {
  const clauses = ['day >= ?']
  const params: string[] = [f.fromDay]
  if (f.category) { clauses.push('category = ?'); params.push(f.category) }
  if (f.caller) { clauses.push('caller = ?'); params.push(f.caller) }
  // A route filter is a literal substring: '%', '_' and the escape char itself are escaped, so they are not wildcards.
  if (f.route) { clauses.push("route LIKE ? ESCAPE '\\'"); params.push(`%${f.route.replace(/[\\%_]/g, '\\$&')}%`) }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params }
}

/** The counter rows, newest day first and busiest first within a day. */
export function queryTokenShadow(f: TokenShadowFilter): TokenShadowRow[] {
  const { sql, params } = whereOf(f)
  return db
    .prepare(`SELECT * FROM token_usage_shadow ${sql} ORDER BY day DESC, count DESC, route ASC LIMIT ?`)
    .all(...params, f.limit) as TokenShadowRow[]
}

/** Total hits per category over the same window. */
export function totalsByTokenShadowCategory(f: Pick<TokenShadowFilter, 'fromDay' | 'category' | 'caller' | 'route'>): Array<{ category: string; count: number }> {
  const { sql, params } = whereOf(f)
  return db
    .prepare(`SELECT category, SUM(count) AS count FROM token_usage_shadow ${sql} GROUP BY category ORDER BY count DESC, category ASC`)
    .all(...params) as Array<{ category: string; count: number }>
}
