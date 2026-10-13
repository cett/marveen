// Column order for the kanban board.
//
// Pure functions: no DOM, no fetch. "manual" is the board's own drag order
// (sort_order); the others order a column by a card field. A card with no
// value for the field (no seq, no timestamp) goes last, in either direction.

export const KANBAN_SORT_MODES = ['manual', 'number_asc', 'number_desc', 'created', 'updated']

/** Unknown or missing stored value falls back to the manual order. */
export function normalizeKanbanSort(value) {
  return KANBAN_SORT_MODES.includes(value) ? value : 'manual'
}

/** Cards can be dragged (and so reordered by hand) only in the manual order. */
export function isManualSort(mode) {
  return normalizeKanbanSort(mode) === 'manual'
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Compare two possibly-missing numbers; a missing one sorts after any real one.
function cmp(a, b, dir) {
  const x = num(a)
  const y = num(b)
  if (x === null && y === null) return 0
  if (x === null) return 1
  if (y === null) return -1
  return dir * (x - y)
}

/**
 * Comparator for the given sort mode. Ties fall back to the manual order so the
 * result is stable and does not jump between refreshes.
 */
export function kanbanCardSorter(mode) {
  const m = normalizeKanbanSort(mode)
  const manual = (a, b) => cmp(a.sort_order, b.sort_order, 1)
  if (m === 'manual') return manual
  const field = m === 'created' ? 'created_at' : m === 'updated' ? 'updated_at' : 'seq'
  const dir = m === 'number_asc' ? 1 : -1
  return (a, b) => cmp(a[field], b[field], dir) || manual(a, b)
}
