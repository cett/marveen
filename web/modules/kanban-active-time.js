// "Time in progress" for the kanban card detail panel.
//
// Computed in the browser from the card's own status-change log
// (GET /api/kanban/:id/events), so no list query carries it and no new API field
// exists. Pure functions: no DOM, no fetch, the clock is a parameter.
//
// WHAT THE NUMBER IS NOT. It is wall-clock time the card has stood in the
// in_progress column, summed over every stay, not hours worked: nobody clocks in
// and out, so a card left in the column overnight counts the night. It is an
// upper bound, and the panel says so in a tooltip.

/**
 * Seconds the card has stood in in_progress, summed over every stay.
 *
 * A stay opens on an event whose to_status is 'in_progress' and closes on the
 * next event. A stay still open at the end of the log runs to `nowSec` while the
 * card is in progress; when the card is no longer in progress (a status change
 * that wrote no event, such as an edit of the card itself) it is closed at the
 * card's last update instead of being charged up to now.
 *
 * Returns null when the log is empty: the event table starts mid-history, so
 * "no history" (not measured) is different from a measured 0 (the card has
 * moved, and never stood in progress). Callers must keep that distinction.
 *
 * @param {Array<{ to_status: string, created_at: number, id?: number }>} events
 * @param {number} nowSec  current time, epoch seconds
 * @param {{ status?: string, updated_at?: number }} [card]
 * @returns {number | null}
 */
export function sumInProgressSeconds(events, nowSec, card) {
  if (!Array.isArray(events) || events.length === 0) return null
  const sorted = events.slice().sort((a, b) => (a.created_at - b.created_at) || ((a.id ?? 0) - (b.id ?? 0)))
  let total = 0
  let openedAt = null
  for (const ev of sorted) {
    if (openedAt !== null) {
      total += Math.max(0, ev.created_at - openedAt)
      openedAt = null
    }
    if (ev.to_status === 'in_progress') openedAt = ev.created_at
  }
  if (openedAt !== null) {
    const stillInProgress = !card || card.status === undefined || card.status === 'in_progress'
    const end = stillInProgress ? nowSec : Math.min(nowSec, card.updated_at ?? nowSec)
    total += Math.max(0, end - openedAt)
  }
  return total
}

/**
 * Human text for a sum from sumInProgressSeconds, or null when it was not
 * measured (null / undefined in, null out) -- never "0m" for an absent value.
 *
 * @param {number | null | undefined} sec
 * @param {(key: string, vars?: Record<string, unknown>) => string} t  the i18n lookup
 * @returns {string | null}
 */
export function formatActiveTime(sec, t) {
  if (sec === undefined || sec === null) return null
  const s = Math.max(0, Math.floor(sec))
  if (s === 0) return t('kanban.active.zero')
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d >= 1) return t('kanban.active.d_h', { d, h })
  if (h >= 1) return t('kanban.active.h_m', { h, m })
  return t('kanban.active.m', { m })
}
