// Persistence for the Phase T2 token-usage shadow counter (table token_usage_shadow, migration
// 0079). An aggregate: one row per shape of request, a counter on it. The policy (what counts, the
// per-day row cap, the retention) lives in web/token-shadow.ts; this file is only the SQL.

import { dbx } from './facade.js'

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
export async function bumpTokenShadow(key: TokenShadowKey, nowSec: number): Promise<void> {
  await dbx.run(`INSERT INTO token_usage_shadow
       (day, category, method, route, caller, caller_source, client, target, count, last_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (day, category, method, route, caller, caller_source, client, target)
     DO UPDATE SET count = count + 1, last_ts = excluded.last_ts`, key.day, key.category, key.method, key.route, key.caller, key.callerSource, key.client, key.target, nowSec)
}

export async function tokenShadowKeyExists(key: TokenShadowKey): Promise<boolean> {
  return await dbx.get(`SELECT 1 FROM token_usage_shadow
      WHERE day = ? AND category = ? AND method = ? AND route = ? AND caller = ?
        AND caller_source = ? AND client = ? AND target = ?`, key.day, key.category, key.method, key.route, key.caller, key.callerSource, key.client, key.target) !== undefined
}

export async function countTokenShadowRowsForDay(day: string): Promise<number> {
  return ((await dbx.get('SELECT COUNT(*) AS n FROM token_usage_shadow WHERE day = ?', day)) as { n: number }).n
}

/** Deletes the rows of days before `day` (YYYY-MM-DD, compared as text). Returns the number removed. */
export async function deleteTokenShadowRowsBefore(day: string): Promise<number> {
  return (await dbx.run('DELETE FROM token_usage_shadow WHERE day < ?', day)).changes
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
export async function queryTokenShadow(f: TokenShadowFilter): Promise<TokenShadowRow[]> {
  const { sql, params } = whereOf(f)
  return dbx.all<TokenShadowRow>(`SELECT * FROM token_usage_shadow ${sql} ORDER BY day DESC, count DESC, route ASC LIMIT ?`, ...params, f.limit)
}

/** Total hits per category over the same window. */
export async function totalsByTokenShadowCategory(f: Pick<TokenShadowFilter, 'fromDay' | 'category' | 'caller' | 'route'>): Promise<Array<{ category: string; count: number }>> {
  const { sql, params } = whereOf(f)
  return (await dbx.all(`SELECT category, SUM(count) AS count FROM token_usage_shadow ${sql} GROUP BY category ORDER BY count DESC, category ASC`, ...params)) as Array<{ category: string; count: number }>
}
