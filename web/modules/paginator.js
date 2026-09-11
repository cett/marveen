// Shared, framework-free "◄ n-m / N ►" pager control.
//
// Two independent consumption models share this same renderer:
//   - server-side paging: re-fetch the next page with a new offset every
//     page turn (see audit-log.js)
//   - client-side paging: slice a page out of an already-fully-fetched array
//     (see approvals.js's own hand-rolled version, kanban archive planned)
// The component only renders the control and wires the prev/next buttons; it
// has no opinion on where the data for the next page comes from -- that is
// entirely the caller's `onPrev`/`onNext` callbacks.

/**
 * @param {HTMLElement | null} container element the pager is rendered into
 * @param {{ offset: number, limit: number, total: number, onPrev: () => void, onNext: () => void }} opts
 */
export function renderPaginator(container, opts) {
  if (!container) return
  const { offset, limit, total, onPrev, onNext } = opts

  if (total <= limit) {
    container.innerHTML = ''
    return
  }

  const hasPrev = offset > 0
  const hasNext = offset + limit < total
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + limit, total)

  container.innerHTML = `
    <button class="btn" data-variant="secondary" data-size="compact" ${hasPrev ? '' : 'disabled'} data-paginator-prev>&#8592; Előző</button>
    <span style="font-size:12px;color:var(--text-muted)">${from}-${to} / ${total}</span>
    <button class="btn" data-variant="secondary" data-size="compact" ${hasNext ? '' : 'disabled'} data-paginator-next>Következő &#8594;</button>
  `

  if (hasPrev) container.querySelector('[data-paginator-prev]')?.addEventListener('click', onPrev)
  if (hasNext) container.querySelector('[data-paginator-next]')?.addEventListener('click', onNext)
}
