// Whether a failed card insert lost the race for its generated id (a clash of two 8-character ids), so the caller
// draws a new one. A module of its own (no database import): the route and its tests use it without the db layer.

/**
 * SQLite: the PRIMARY KEY / UNIQUE message names kanban_cards.id (the message is matched, not the bare code: a bare
 * PRIMARYKEY code would also accept another table's key). PostgreSQL: SQLSTATE 23505 (`code`) on the primary key of
 * kanban_cards (`constraint` kanban_cards_pkey, or `table` + `column`); any other 23505 is another constraint and
 * stays an error. Anything that is not an Error is not a clash.
 */
export function isKanbanIdTaken(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const e = err as Error & { code?: unknown; constraint?: unknown; table?: unknown; column?: unknown }
  if (e.code === '23505') return e.constraint === 'kanban_cards_pkey' || (e.table === 'kanban_cards' && e.column === 'id')
  return /UNIQUE constraint failed: kanban_cards\.id/i.test(e.message)
}
