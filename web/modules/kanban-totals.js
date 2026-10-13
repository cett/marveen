// Board totals and column counts for the kanban page.
//
// Pure functions: no DOM, no fetch. In paged mode the browser holds only the
// first page of every column, so a count taken from the loaded cards would be
// wrong; the server-reported per-status total (tenant-scoped like the list
// itself) is the source of truth for what is not loaded yet.

/**
 * The cards each column renders as standalone cards: visible, not embedded
 * under a parent, and not lifted into the Ongoing band. A column counter and a
 * WIP badge built on this never count a banded card.
 *
 * Paged mode stays exact for the same reason: a loaded banded card is in the
 * column's `offset` (loaded) but not in `rendered`, and `total - offset` only
 * covers cards that are not loaded yet. The one error left is a card the page
 * has not loaded that will turn out to be ongoing: the header counts it until
 * it loads, then it leaves for the band.
 *
 * @param {Array<{id:string,status:string}>} cards  loaded cards
 * @param {{visible:Set<string>, embedded:Set<string>, ongoing:Set<string>}} sets
 * @param {string[]} statuses  the board's columns
 */
export function kanbanColumnGroups(cards, { visible, embedded, ongoing }, statuses) {
  const grouped = {}
  for (const s of statuses) grouped[s] = []
  for (const card of cards) {
    if (embedded.has(card.id)) continue
    if (!visible.has(card.id)) continue
    if (ongoing.has(card.id)) continue
    if (grouped[card.status]) grouped[card.status].push(card)
  }
  return grouped
}

/**
 * Number a column header shows: the top-level cards rendered in the column plus
 * the ones the server still holds for that status but the page has not loaded.
 *
 * @param {number} renderedCount  cards rendered as standalone cards in the column
 * @param {{offset:number,total:number}|undefined} paging  loaded count and server total
 * @param {boolean} pagedMode  true while the board is on the paged, unfiltered load
 */
export function kanbanColumnCount(renderedCount, paging, pagedMode) {
  if (!pagedMode || !paging) return renderedCount
  return renderedCount + Math.max(0, paging.total - paging.offset)
}

/**
 * Totals shown beside the view switcher.
 *
 * open = every card not in the done column, all = every card on the board.
 * `shown` is set only while a filter is narrowing the board (null otherwise).
 *
 * @param {object} p
 * @param {Array<{status:string}>} p.cards  loaded cards (the whole board when not paged)
 * @param {boolean} p.pagedMode
 * @param {Record<string,{offset:number,total:number}>} p.paging  per-status paging
 * @param {boolean} p.filtered  a project/assignee/label filter is active
 * @param {number} p.visibleCount  loaded cards that pass the active filters
 * @returns {{open:number, all:number, shown:number|null}}
 */
export function kanbanBoardTotals({ cards, pagedMode, paging, filtered, visibleCount }) {
  let all
  let done
  if (pagedMode) {
    all = 0
    for (const p of Object.values(paging || {})) all += p?.total || 0
    done = paging?.done?.total || 0
  } else {
    all = cards.length
    done = cards.filter((c) => c.status === 'done').length
  }
  return { open: all - done, all, shown: filtered ? visibleCount : null }
}
