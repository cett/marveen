// User triggers during the copy (P-G1, decided 2026-11-24). A PostgreSQL user trigger is application logic that
// re-derives data from the rows it sees (the homoglyph triggers add a finding per look-alike title). On a copy it would add
// rows that SQLite does not hold, so the write phase suspends the user triggers of the copied tables, and restores each one
// to its RECORDED state before the read-back. The foreign-key triggers are internal and stay on: the constraint is the net
// behind the orphan scan. DISABLE TRIGGER USER is DDL, so a rollback (a failure, or a dry run) restores them by itself.
//
// The restore is per trigger and never "enable all": O (origin) comes back by ENABLE, R (replica) by ENABLE REPLICA, A
// (always) by ENABLE ALWAYS, D (disabled) stays disabled. The catalog is read again and must equal the recorded state.

import type pg from 'pg'

/** A user trigger with its tgenabled code: O origin, R replica, A always, D disabled. */
export interface UserTrigger {
  table: string
  name: string
  enabled: string
}

/** The lock wait of the suspension: a live reader is waited for this long, then the run stops with a named error. */
export const TRIGGER_LOCK_TIMEOUT = '10s'

export class TriggerRestoreError extends Error {
  constructor(
    readonly table: string,
    readonly trigger: string,
    readonly reason: string,
  ) {
    super(`trigger ${trigger} on ${table}: ${reason}`)
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** The user (non-internal) triggers of the named public tables, in name order, with their recorded state. */
export async function readUserTriggers(q: Pick<pg.Client, 'query'>, tables: string[]): Promise<UserTrigger[]> {
  if (tables.length === 0) return []
  const r = await q.query<{ table_name: string; name: string; enabled: string }>(
    `SELECT c.relname::text AS table_name, t.tgname::text AS name, t.tgenabled::text AS enabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname = ANY($1::text[])
      ORDER BY c.relname, t.tgname`,
    [tables],
  )
  return r.rows.map((x) => ({ table: x.table_name, name: x.name, enabled: x.enabled }))
}

/**
 * Records the user triggers of the tables and suspends them, inside the open transaction. The lock wait is bounded (local to
 * the transaction): a surprise lock stops the run by name instead of hanging.
 */
export async function suspendUserTriggers(q: Pick<pg.Client, 'query'>, tables: string[]): Promise<UserTrigger[]> {
  const recorded = await readUserTriggers(q, tables)
  if (recorded.length === 0) return recorded
  await q.query({ text: "SELECT set_config('lock_timeout', $1, true)", values: [TRIGGER_LOCK_TIMEOUT] })
  for (const table of [...new Set(recorded.map((t) => t.table))]) {
    await q.query(`ALTER TABLE ${quote(table)} DISABLE TRIGGER USER`)
  }
  return recorded
}

/**
 * Puts every recorded trigger back to its recorded state, then reads the catalog again: it must equal the record. A difference
 * is a TriggerRestoreError (the caller's transaction rolls back).
 */
export async function restoreUserTriggers(q: Pick<pg.Client, 'query'>, recorded: UserTrigger[], tables: string[]): Promise<void> {
  for (const t of recorded) {
    const how =
      t.enabled === 'O' ? 'ENABLE TRIGGER' : t.enabled === 'R' ? 'ENABLE REPLICA TRIGGER' : t.enabled === 'A' ? 'ENABLE ALWAYS TRIGGER' : undefined
    if (how === undefined) continue
    await q.query(`ALTER TABLE ${quote(t.table)} ${how} ${quote(t.name)}`)
  }
  const after = await readUserTriggers(q, tables)
  const key = (t: UserTrigger): string => `${t.table}.${t.name}`
  const afterByKey = new Map(after.map((t) => [key(t), t.enabled]))
  for (const t of recorded) {
    const now = afterByKey.get(key(t))
    if (now === undefined) throw new TriggerRestoreError(t.table, t.name, 'the trigger is gone after the write')
    if (now !== t.enabled) throw new TriggerRestoreError(t.table, t.name, `the state is ${now}, recorded ${t.enabled}`)
  }
  if (after.length !== recorded.length) {
    const known = new Set(recorded.map(key))
    const extra = after.find((t) => !known.has(key(t)))!
    throw new TriggerRestoreError(extra.table, extra.name, 'a trigger that was not recorded appeared during the write')
  }
}

/** The report's form: the names per table (names, never values). */
export function suspendedByTable(recorded: UserTrigger[]): Array<{ table: string; triggers: string[] }> {
  const out = new Map<string, string[]>()
  for (const t of recorded) out.set(t.table, [...(out.get(t.table) ?? []), t.name])
  return [...out.entries()].map(([table, triggers]) => ({ table, triggers }))
}
