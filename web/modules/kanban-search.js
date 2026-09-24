// Kanban page card search (unified active + archived card lookup).
//
// Lives in the kanban page's view-switcher row (Tábla/Idővonal ... search ...
// Archiváltak), visible in all three kanban views. Debounced text/ID search
// against GET /api/kanban/search; clicking a result navigates to the kanban
// board (active card, opens the detail panel) or the archived view (archived
// card, highlighted in place).
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
    results.innerHTML = `<div class="kanban-search-empty">${escapeHtml(t('kanban.search.empty'))}</div>`
    results.hidden = false
    return
  }
  results.innerHTML = cards.map((card) => {
    const title = card.title.length > 60 ? card.title.slice(0, 60) + '…' : card.title
    const archivedBadge = card.archived
      ? `<span class="kanban-search-badge kanban-search-badge-archived">${escapeHtml(t('kanban.search.archived_badge'))}</span>`
      : ''
    return `<div class="kanban-search-result" data-id="${escapeHtml(card.id)}" data-archived="${card.archived ? '1' : '0'}">
      <span class="kanban-search-result-seq">#${card.seq}</span>
      <span class="kanban-search-result-title">${escapeHtml(title)}</span>
      <span class="kanban-search-result-status">${escapeHtml(statusLabel(card.status))}</span>
      ${archivedBadge}
    </div>`
  }).join('')
  results.hidden = false

  const byId = new Map(cards.map((c) => [c.id, c]))
  results.querySelectorAll('.kanban-search-result').forEach((el) => {
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

// "/" focuses the kanban search when the kanban page is visible and focus
// isn't already in a text field (matches the hint shown in the input).
function onGlobalKeydown(e) {
  if (e.key !== '/') return
  const active = document.activeElement
  const tag = active?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return
  if (document.getElementById('kanbanPage')?.hidden) return
  e.preventDefault()
  input?.focus()
}

export function initGlobalKanbanSearch() {
  input = document.getElementById('kanbanSearchInput')
  results = document.getElementById('kanbanSearchResults')
  if (!input || !results) return

  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKeydown)
  document.addEventListener('click', (e) => {
    if (!results.hidden && !e.target.closest('.kanban-search-wrap')) closeResults()
  })
  document.addEventListener('keydown', onGlobalKeydown)
}
