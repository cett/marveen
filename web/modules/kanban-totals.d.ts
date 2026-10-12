export interface ColumnPaging {
  offset: number
  total: number
}

export function kanbanColumnCount(
  renderedCount: number,
  paging: ColumnPaging | undefined,
  pagedMode: boolean,
): number

export function kanbanBoardTotals(p: {
  cards: Array<{ status: string }>
  pagedMode: boolean
  paging: Record<string, ColumnPaging>
  filtered: boolean
  visibleCount: number
}): { open: number; all: number; shown: number | null }
