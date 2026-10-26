// db/fleet-transfer.ts -- SQL behind the fleet export/import. The table list
// is a closed whitelist: the table and column names below are never taken from
// the fleet file, only the values are.

import { dbx } from './facade.js'

type Row = Record<string, unknown>
type RowLike = object

/** Tables dumped verbatim (SELECT *) into the fleet file. */
const EXPORT_TABLES = [
  'kanban_cards', 'kanban_comments', 'kanban_card_events', 'labels', 'kanban_card_labels',
  'idea_box', 'idea_comments', 'idea_status_log',
  'schedules', 'import_sources', 'vault_ssh_keys', 'vault_ssh_servers',
] as const

export type FleetExportTable = typeof EXPORT_TABLES[number]

export async function exportTableRows(table: FleetExportTable): Promise<Row[]> {
  if (!EXPORT_TABLES.includes(table)) throw new Error(`Fleet export: unknown table ${String(table)}`)
  return dbx.all<Row>(`SELECT * FROM ${table}`)
}

/**
 * Per importable table: the inserted columns, and the columns that identify an
 * already-present row. An empty `dedupeBy` means the table's own key
 * constraint decides (ON CONFLICT DO NOTHING); otherwise the row is skipped
 * when one with the same values in those columns exists.
 */
const IMPORT_TABLES = {
  labels: { columns: ['id', 'name', 'color', 'created_at'], dedupeBy: [] },
  kanban_cards: {
    columns: ['id', 'title', 'description', 'status', 'assignee', 'priority', 'project',
      'due_date', 'sort_order', 'created_at', 'updated_at', 'archived_at', 'parent_id', 'dispatched_at'],
    dedupeBy: [],
  },
  kanban_comments: { columns: ['card_id', 'author', 'content', 'created_at'], dedupeBy: ['card_id', 'content'] },
  kanban_card_events: {
    columns: ['card_id', 'from_status', 'to_status', 'actor', 'created_at'],
    dedupeBy: ['card_id', 'created_at', 'to_status'],
  },
  kanban_card_labels: { columns: ['card_id', 'label_id', 'created_at'], dedupeBy: [] },
  schedules: {
    columns: ['id', 'prompt', 'description', 'schedule', 'agent', 'type', 'enabled', 'tenant_id', 'skip_if_busy',
      'force_send', 'target_session', 'command', 'timeout_ms', 'fail_threshold', 'pre_check',
      'catch_up_max_age_minutes', 'stuck_after_minutes', 'requires', 'created_at', 'updated_at'],
    dedupeBy: [],
  },
  import_sources: {
    columns: ['id', 'type', 'path', 'label', 'interval_hours', 'enabled', 'last_run_at', 'created_at', 'updated_at',
      'tenant_id', 'vault_token_ref', 'confluence_email', 'base_url'],
    dedupeBy: [],
  },
  vault_ssh_keys: {
    columns: ['id', 'label', 'username', 'vault_key_id', 'public_key', 'fingerprint', 'key_type', 'created_at', 'tenant_id'],
    dedupeBy: [],
  },
  vault_ssh_servers: {
    columns: ['id', 'name', 'host', 'port', 'username', 'ssh_key_id', 'description', 'tenant_id', 'created_at', 'updated_at'],
    dedupeBy: [],
  },
  memories: {
    columns: ['chat_id', 'content', 'sector', 'salience', 'created_at', 'accessed_at', 'agent_id', 'category', 'auto_generated', 'keywords'],
    dedupeBy: ['agent_id', 'content'],
  },
  daily_logs: { columns: ['agent_id', 'date', 'content', 'created_at'], dedupeBy: ['agent_id', 'date', 'content'] },
  idea_box: {
    columns: ['id', 'title', 'description', 'category', 'status', 'source', 'kanban_id', 'impact', 'effort', 'created_at', 'updated_at'],
    dedupeBy: [],
  },
  idea_comments: { columns: ['idea_id', 'author', 'content', 'created_at'], dedupeBy: ['idea_id', 'created_at', 'content'] },
  idea_status_log: {
    columns: ['idea_id', 'from_status', 'to_status', 'actor', 'note', 'created_at'],
    dedupeBy: ['idea_id', 'created_at', 'to_status'],
  },
} as const satisfies Record<string, { columns: readonly string[]; dedupeBy: readonly string[] }>

export type FleetImportTable = keyof typeof IMPORT_TABLES

/** Tables whose rows are matched by `id` in the fleet diff report. */
const ID_TABLES = ['kanban_cards', 'labels', 'schedules', 'import_sources', 'vault_ssh_keys', 'vault_ssh_servers'] as const
export type FleetIdTable = typeof ID_TABLES[number]

/** True when the table already has a row with this id. */
export async function fleetRowIdExists(table: FleetIdTable, id: unknown): Promise<boolean> {
  if (!ID_TABLES.includes(table)) throw new Error(`Fleet diff: unknown table ${String(table)}`)
  return !!await dbx.get(`SELECT 1 FROM ${table} WHERE id = ?`, id)
}

/** True when the table already has a row matching `dedupeBy` of the given row. */
export async function fleetRowExists(table: FleetImportTable, row: RowLike): Promise<boolean> {
  const { dedupeBy } = IMPORT_TABLES[table]
  if (dedupeBy.length === 0) throw new Error(`Fleet import: ${table} has no natural key`)
  const where = dedupeBy.map((c) => `${c} = ?`).join(' AND ')
  return !!await dbx.get(`SELECT 1 FROM ${table} WHERE ${where}`, ...dedupeBy.map((c) => (row as Row)[c]))
}

/**
 * Insert the rows the destination does not have yet. Values come straight from
 * `row[column]` (undefined -> NULL): defaults and forced values (a disabled
 * schedule, a cleared last_run_at) are the caller's to put in the row.
 * Returns how many rows were inserted.
 *
 * The loop is one transaction of its own (a savepoint when the caller already holds one): the "does a row like
 * this exist" read and the insert after it must not be split by another caller's write, which the synchronous
 * version could not be. Without it two overlapping imports both see "absent" and insert the same memory twice.
 */
export async function importFleetRows(table: FleetImportTable, rows: readonly RowLike[]): Promise<number> {
  const { columns, dedupeBy } = IMPORT_TABLES[table]
  const sql =
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})` +
    (dedupeBy.length === 0 ? ' ON CONFLICT DO NOTHING' : '')
  return dbx.tx(async () => {
    let inserted = 0
    for (const row of rows) {
      if (dedupeBy.length > 0 && await fleetRowExists(table, row)) continue
      inserted += (await dbx.run(sql, ...columns.map((c) => (row as Row)[c] ?? null))).changes
    }
    return inserted
  })
}

/** Everything in `memories`, across every agent_id, oldest first per agent. */
export async function exportMemoryRows<T>(): Promise<T[]> {
  return dbx.all<T>(`SELECT agent_id, content, sector, salience, created_at, accessed_at,
            category, auto_generated, keywords
     FROM memories ORDER BY agent_id ASC, created_at ASC`)
}

export async function exportDailyLogRows<T>(): Promise<T[]> {
  return dbx.all<T>('SELECT agent_id, date, content, created_at FROM daily_logs ORDER BY agent_id ASC, date ASC')
}

/** Ids of the tenants that are not disabled. */
export async function listEnabledTenantIds(): Promise<string[]> {
  return ((await dbx.all('SELECT id FROM tenants WHERE disabled_at IS NULL')) as { id: string }[]).map((r) => r.id)
}

export async function rebuildMemoriesFts(): Promise<void> {
  await dbx.run("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
}

/**
 * Run `fn` in one transaction; any throw or rejection rolls every write back. The body holds the connection's
 * transaction lock from BEGIN to COMMIT: only `dbx` calls and pure row policy in it, no other I/O. The calls
 * inside join the open transaction through the facade's transaction scope, so `fn` takes no handle.
 */
export async function inFleetImportTransaction(fn: () => Promise<void>): Promise<void> {
  await dbx.tx(async () => { await fn() })
}
