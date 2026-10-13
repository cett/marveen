export type KanbanSortMode = 'manual' | 'number_asc' | 'number_desc' | 'created' | 'updated'

export const KANBAN_SORT_MODES: KanbanSortMode[]

export function normalizeKanbanSort(value: unknown): KanbanSortMode

export function isManualSort(mode: unknown): boolean

export interface SortableCard {
  sort_order?: number | null
  seq?: number | null
  created_at?: number | null
  updated_at?: number | null
}

export function kanbanCardSorter<T extends SortableCard>(mode: unknown): (a: T, b: T) => number
