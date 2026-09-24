// Global sidebar kanban search (unified active + archived card lookup).
//
// Lives at the top of the sidebar, independent of the currently active page.
// Debounced text/ID search against GET /api/kanban/search; clicking a result
// navigates to the kanban board (active card, opens the detail panel) or the
// archived view (archived card, highlighted in place).
import { t } from './i18n.js'
import { escapeHtml } from './util.js'
import { switchPage } from './app-core.js'
import { showCardDetail } from './kanban.js'

const DEBOUNCE_MS = 300
const MIN_QUERY_LEN = 2

let input, results
let debounceTimer = null

function statusLabel(status) {
  return t(`kanban.status.${status}`) || status
}

function renderResults(cards) {
  if (!results) return
  if (cards.length === 0) {
    results.innerHTML = `<div class="sidebar-search-empty">${escapeHtml(t('kanban.search.empty'))}</div>`
    results.hidden = false
    return
  }
  results.innerHTML = cards.map((card) => {
    const title = card.title.length > 60 ? card.title.slice(0, 60) + '…' : card.title
    const archivedBadge = card.archived
      ? `<span class="sidebar-search-badge sidebar-search-badge-archived">${escapeHtml(t('kanban.search.archived_badge'))}</span>`
      : ''
    return `<div class="sidebar-search-result" data-id="${escapeHtml(card.id)}" data-archived="${card.archived ? '1' : '0'}">
      <span class="sidebar-search-result-seq">#${card.seq}</span>
      <span class="sidebar-search-result-title">${escapeHtml(title)}</span>
      <span class="sidebar-search-result-status">${escapeHtml(statusLabel(card.status))}</span>
      ${archivedBadge}
    </div>`
  }).join('')
  results.hidden = false

  const byId = new Map(cards.map((c) => [c.id, c]))
  results.querySelectorAll('.sidebar-search-result').forEach((el) => {
    el.addEventListener('click', () => {
      const card = byId.get(el.dataset.id)
      if (card) selectResult(card)
    })
  })
}

function selectResult(card) {
  closeResults()
  input.value = ''
  if (card.archived) {
    switchPage('archived')
    // web/app.js's archived-view IIFE exposes this hook so cross-module
    // navigation does not need to reach into its private render state --
    // same pattern as the existing window.loadArchivedPage.
    window.openArchivedCard?.(card.id)
  } else {
    switchPage('kanban')
    showCardDetail(card)
  }
}

function closeResults() {
  if (results) { results.hidden = true; results.innerHTML = '' }
}

async function runSearch(q) {
  try {
    const r = await fetch('/api/kanban/search?' + new URLSearchParams({ q, limit: '50' }))
    if (!r.ok) { closeResults(); return }
    const data = await r.json()
    renderResults(data.cards || [])
  } catch { closeResults() }
}

function onInput() {
  clearTimeout(debounceTimer)
  const q = input.value.trim()
  if (q.length < MIN_QUERY_LEN) { closeResults(); return }
  debounceTimer = setTimeout(() => runSearch(q), DEBOUNCE_MS)
}

function onKeydown(e) {
  if (e.key === 'Enter') {
    clearTimeout(debounceTimer)
    const q = input.value.trim()
    if (q.length >= MIN_QUERY_LEN) runSearch(q)
  } else if (e.key === 'Escape') {
    closeResults()
  }
}

export function initGlobalKanbanSearch() {
  input = document.getElementById('globalKanbanSearch')
  results = document.getElementById('globalKanbanSearchResults')
  if (!input || !results) return

  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKeydown)
  document.addEventListener('click', (e) => {
    if (!results.hidden && !e.target.closest('.sidebar-search-wrap')) closeResults()
  })
}
