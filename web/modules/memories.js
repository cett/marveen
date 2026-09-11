import { escapeHtml, highlightJson, mainAgentId } from './util.js'
import { renderMarkdown } from './docs-research.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'
import { getErrorMessage } from './error-message.js'
import { initTenantSelector } from './tenant-selector.js'
import { can } from './rbac-client.js'
import { renderPaginator } from './paginator.js'
import {
  loadMemoryGraph, stopGraphSimulation, initGlowSprites, setGraphCanvas,
  graphCanvas, graphCtx, graphGlowSprites, graphParticleSprite,
  GRAPH_TIER_COLORS, GRAPH_TIER_GLOW, GRAPH_REDUCED_MOTION, graphEaseOutBack,
  updateGraphSearch, openEditMemory,
} from './memory-graph.js'

let _openModal = null, _closeModal = null
let _memTenantGetter = null
let _canWriteMemories = true

export async function initMemories({ openModal, closeModal } = {}) {
  _openModal = openModal; _closeModal = closeModal
  _memTenantGetter = await initTenantSelector('memoriesTenantSelectorContainer', () => {
    memOffset = 0
    loadMemories(); loadMemStats()
    // #809: tenant switch left the graph/timeline tab showing the previous
    // tenant's data (only the card list reloaded) -- reload whichever of the
    // two is currently visible.
    if (currentMemTier === 'graph') {
      if (tlMode === 'timeline') loadTimeline(); else loadMemoryGraph()
    }
  })
  // The actual gate check lives in loadMemStats()/loadMemories(), which
  // app.js always calls right after this (see the notes there) -- no need
  // to duplicate it here.
}

// #809/#811: memory-graph.js needs the current tenant to scope its own
// /api/memories/graph fetch, but it doesn't have access to _memTenantGetter
// (set here after initTenantSelector resolves).
export function getMemTenant() {
  return _memTenantGetter?.() ?? null
}

// ============================================================
// ============================================================
// === Memories (Tier System + Daily Log) ===
// ============================================================

const memList = document.getElementById('memList')
const memEmpty = document.getElementById('memEmpty')
const memStats = document.getElementById('memStats')
const memSearchInput = document.getElementById('memSearchInput')
const memModalOverlay = document.getElementById('memModalOverlay')

let memSearchTimer = null
let currentMemTier = 'hot'
let currentLogDate = new Date().toISOString().split('T')[0]
let logDates = []

// Server-side offset pagination (#861), same shared paginator.js component
// and shape as the audit trail (#860 ST1). Only meaningful for the plain
// (no-search) listing -- a hybrid/keyword search response has no `total`,
// so the pager is cleared whenever one is in effect (see loadMemories()).
const MEM_LIMIT = 50
let memOffset = 0

const tierLabels = { hot: '\u{1F525} Hot', warm: '\u{1F321}\uFE0F Warm', cold: '\u2744\uFE0F Cold', shared: '\u{1F517} Shared', import: '\u{1F4E5} Import' }
const tierColors = { hot: '#dc3c3c', warm: '#d97757', cold: '#6a9bcc', shared: '#9a8a30', import: '#39FF14' }
const TIER_TO_VARIANT = { hot: 'danger', warm: 'accent', cold: 'info', shared: 'warning' }

// Populate agent dropdowns from API
export async function loadMemAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const sel = document.getElementById('memAgentFilter')
    const memSel = document.getElementById('memAgent')
    sel.innerHTML = `<option value="">${t('memories.agent_all')}</option>`
    memSel.innerHTML = ''
    for (const a of agents) {
      sel.innerHTML += `<option value="${a.name}">${a.label}</option>`
      memSel.innerHTML += `<option value="${a.name}">${a.label}</option>`
    }
  } catch {}
}

// Node-limit slider
;(function() {
  const slider = document.getElementById('graphNodeLimit')
  const valEl = document.getElementById('graphNodeLimitVal')
  if (slider && valEl) {
    slider.addEventListener('input', () => {
      valEl.textContent = slider.value
    })
    slider.addEventListener('change', () => {
      valEl.textContent = slider.value
      if (currentMemTier === 'graph') loadMemoryGraph()
    })
  }
})()

// Agent filter change
document.getElementById('memAgentFilter')?.addEventListener('change', () => {
  memOffset = 0
  if (currentMemTier === 'graph') {
    loadMemoryGraph()
  } else if (currentMemTier === 'log') {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Search with debounce
memSearchInput?.addEventListener('input', () => {
  memOffset = 0
  clearTimeout(memSearchTimer)
  memSearchTimer = setTimeout(loadMemories, 300)
})

// Enter to search immediately
memSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    memOffset = 0
    clearTimeout(memSearchTimer)
    loadMemories()
  }
})

// Tab switching
document.getElementById('memTabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.mem-tab')
  if (!tab) return
  document.querySelectorAll('.mem-tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  currentMemTier = tab.dataset.tier
  memOffset = 0

  const isLog   = currentMemTier === 'log'
  const isGraph = currentMemTier === 'graph'

  document.getElementById('memTierView').hidden  = isLog || isGraph
  document.getElementById('memLogView').hidden   = !isLog
  document.getElementById('memGraphView').hidden = !isGraph

  if (isGraph) {
    loadMemoryGraph()
  } else if (isLog) {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Add memory button
document.getElementById('memAddBtn')?.addEventListener('click', () => {
  document.getElementById('memModalTitle').textContent = t('memories.modal.title_new')
  document.getElementById('memContent').value = ''
  document.getElementById('memTier').value = (currentMemTier === 'log' || currentMemTier === 'graph') ? 'warm' : currentMemTier
  document.getElementById('memKeywords').value = ''
  document.getElementById('memEditId').value = ''
  // New memory: hide Előzmények tab, reset to edit
  document.getElementById('memHistoryTabBtn').hidden = true
  switchMemModalTab('edit')
  _openModal?.(memModalOverlay)
  setTimeout(() => document.getElementById('memContent').focus(), 200)
})

// Close memory modal
document.getElementById('memModalClose')?.addEventListener('click', () => _closeModal?.(memModalOverlay))
memModalOverlay?.addEventListener('click', (e) => { if (e.target === memModalOverlay) _closeModal?.(memModalOverlay) })

// Save memory (create or edit)
document.getElementById('saveMemBtn')?.addEventListener('click', async () => {
  const content = document.getElementById('memContent').value.trim()
  if (!content) { document.getElementById('memContent').focus(); return }

  const editId = document.getElementById('memEditId').value
  const tier = document.getElementById('memTier').value
  const agentId = document.getElementById('memAgent').value
  const keywords = document.getElementById('memKeywords').value.trim()

  try {
    if (editId) {
      await fetch(`/api/memories/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, tier, agent_id: agentId, keywords }),
      })
      showToast(t('memories.toast.updated'))
    } else {
      await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, content, tier, keywords }),
      })
      showToast(t('memories.toast.created'))
    }
    _closeModal?.(memModalOverlay)
    loadMemories()
    loadMemStats()
  } catch {
    showToast(t('common.error_save'))
  }
})

export async function loadMemStats() {
  try {
    // Re-checked here (not just in initMemories): app.js fires initMemories()
    // without awaiting it, so on the very first page-enter this call can race
    // ahead of that check. can()'s underlying fetch is cached/shared, so this
    // costs nothing once resolved.
    _canWriteMemories = await can('memories:write')
    const tenant = _memTenantGetter?.()
    const tenantParam = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''
    const [statsRes, ovRes] = await Promise.all([
      fetch('/api/memories/stats' + tenantParam),
      fetch('/api/overview' + tenantParam),
    ])
    const stats = await statsRes.json()
    const ov = await ovRes.json()
    const embCount = stats.withEmbedding || 0
    const embPct = stats.total > 0 ? Math.round(embCount / stats.total * 100) : 0
    const artifactCount = ov.artifacts?.count ?? 0
    const importCount = stats.importCount ?? 0
    memStats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">${t('memories.stat.total')}</div></div>
      ${Object.entries(stats.byTier || {}).map(([tier, count]) =>
        `<div class="stat-card"><div class="stat-value" style="color:${tierColors[tier] || 'var(--accent)'}">${count}</div><div class="stat-label">${tierLabels[tier] || tier}</div></div>`
      ).join('')}
      <div class="stat-card"><div class="stat-value">${embCount}</div><div class="stat-label">${t('memories.stat.vectors_pct', { pct: embPct })}</div></div>
      <div class="stat-card"><div class="stat-value">${artifactCount}</div><div class="stat-label">${t('memories.stat.artifacts')}</div></div>
      <div class="stat-card" title="${t('memories.stat.import_title')}"><div class="stat-value" style="color:#39FF14">${importCount}</div><div class="stat-label">${t('memories.stat.import')}</div></div>
      <button class="btn" data-variant="secondary" data-size="compact" id="memBackfillBtn" style="margin-left:auto;font-size:11px;padding:6px 12px;align-self:center" ${_canWriteMemories ? '' : 'disabled'}>${t('memories.stat.vectors_btn')}</button>
    `
    document.getElementById('memBackfillBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('memBackfillBtn')
      if (btn) { btn.textContent = t('memories.stat.vectors_gen'); btn.disabled = true }
      try {
        const r = await fetch('/api/memories/backfill', { method: 'POST' })
        const data = await r.json()
        showToast(t('memories.toast.vector_count', { count: data.count }))
        loadMemStats()
      } catch { showToast(t('memories.toast.vector_error')) }
    })
  } catch (err) {
    console.error('Stats hiba:', err)
  }
}

export async function loadMemories() {
  if (currentMemTier === 'log' || currentMemTier === 'graph') return
  _canWriteMemories = await can('memories:write')
  document.getElementById('memAddBtn')?.toggleAttribute('hidden', !_canWriteMemories)
  document.getElementById('memImportOpenBtn')?.toggleAttribute('hidden', !_canWriteMemories)
  document.getElementById('saveMemBtn')?.toggleAttribute('disabled', !_canWriteMemories)
  document.getElementById('memImportSaveBtn')?.toggleAttribute('disabled', !_canWriteMemories)
  const q = memSearchInput.value.trim()
  const agent = document.getElementById('memAgentFilter').value
  const searchMode = document.getElementById('memSearchMode')?.value || 'hybrid'
  const params = new URLSearchParams()
  if (q) {
    params.set('q', q)
    params.set('mode', searchMode)
    // Only meaningful alongside a search query -- the backend only combines
    // workspace_docs into the response when both q and this flag are present;
    // without q it would be a no-op anyway, so skip sending it for a plain listing.
    params.set('include_docs', '1')
  }
  if (agent) params.set('agent', agent)
  if (currentMemTier) params.set('tier', currentMemTier)
  params.set('limit', String(MEM_LIMIT))
  params.set('offset', String(memOffset))
  const tenant = _memTenantGetter?.()
  if (tenant) params.set('tenant', tenant)

  try {
    const [memoriesRes, staleRes] = await Promise.all([
      fetch(`/api/memories?${params}`),
      agent ? fetch(`/api/memories/stale?agent_id=${encodeURIComponent(agent)}`) : Promise.resolve(null),
    ])
    const body = await memoriesRes.json()
    // Plain listing (no q) stays a raw array only for the unpaginated 'import'
    // pseudo-tier edge case; otherwise it now comes back as
    // { memories, total, offset, limit }. A search with include_docs=1 comes
    // back as { memories, workspace_docs } (no `total`) -- see GET /api/memories.
    const isArray = Array.isArray(body)
    const memories = isArray ? body : body.memories
    const workspaceDocs = isArray ? [] : (body.workspace_docs || [])
    const total = isArray ? undefined : body.total
    const staleIds = staleRes
      ? new Set((await staleRes.json()).map(m => m.id))
      : new Set()
    renderMemories(memories, staleIds, workspaceDocs)

    const pager = document.getElementById('memPagination')
    if (total !== undefined) {
      renderPaginator(pager, {
        offset: memOffset,
        limit: MEM_LIMIT,
        total,
        onPrev: () => { memOffset = Math.max(0, memOffset - MEM_LIMIT); loadMemories() },
        onNext: () => { memOffset += MEM_LIMIT; loadMemories() },
      })
    } else {
      pager?.replaceChildren()
    }
  } catch (err) {
    console.error('Memória betöltés hiba:', err)
  }
}

// Munkadokumentum típus-jelölés a keresési találatok listájában (kanban
// 9156e583) -- a memória-badge-ekkel azonos mintát követve, de vizuálisan
// megkülönböztethetően (típus-badge, "Munkadok" jelölés, a snippet mint
// tartalom-előnézet).
const WORKSPACE_DOC_TYPE_LABELS = { plan: 'Terv', brief: 'Brief', report: 'Riport', notes: 'Jegyzet' }

function renderMemories(memories, staleIds = new Set(), workspaceDocs = []) {
  memList.innerHTML = ''
  memEmpty.hidden = memories.length > 0 || workspaceDocs.length > 0

  for (const mem of memories) {
    const item = document.createElement('div')
    item.className = 'mem-item'

    const tier = mem.tier || mem.category || 'warm'
    const tierBadge = tierLabels[tier] || tier
    const tierVariant = TIER_TO_VARIANT[tier] || 'neutral'
    const shortContent = mem.content.length > 120 ? mem.content.slice(0, 120) + '...' : mem.content
    const agentLabel = mem.agent_id || mainAgentId()
    const isStale = staleIds.has(mem.id)

    // Build keywords HTML
    let keywordsHtml = ''
    if (mem.keywords) {
      const kws = typeof mem.keywords === 'string' ? mem.keywords.split(',').map(k => k.trim()).filter(Boolean) : mem.keywords
      if (kws.length > 0) {
        keywordsHtml = `<div class="mem-keywords">${kws.map(k => `<span class="mem-keyword-tag">${escapeHtml(k)}</span>`).join('')}</div>`
      }
    }

    item.innerHTML = `
      <div class="mem-item-header">
        <span class="badge" data-variant="${tierVariant}">${tierBadge}</span>
        <span class="mem-agent-badge">${escapeHtml(agentLabel)}</span>
        <span class="mem-date">${escapeHtml(mem.created_label || '')}</span>
        ${isStale ? '<span class="mem-stale-badge" title="Frissult mióta az ágens utoljára olvasta">elavult</span>' : ''}
        ${typeof mem.salience === 'number' ? `<span class="mem-salience" title="Relevancia ertek">S: ${mem.salience.toFixed(2)}</span>` : ''}
      </div>
      <div class="mem-content-short">${escapeHtml(shortContent)}</div>
      <div class="mem-content-full">${escapeHtml(mem.content)}</div>
      ${keywordsHtml}
      <div class="mem-item-footer">
        <button class="btn" data-variant="secondary" data-edit-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">${t('common.btn.edit')}</button>
        <button class="btn" data-variant="danger" data-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">${t('common.btn.delete')}</button>
      </div>
    `

    // Toggle expand
    item.addEventListener('click', (e) => {
      if (e.target.closest('[data-variant="danger"]') || e.target.closest('[data-variant="secondary"]')) return
      item.classList.toggle('expanded')
    })

    // Edit
    const editBtn = item.querySelector('[data-edit-memid]')
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openMemEditModal(mem, tier)
    })

    // Delete
    const delBtn = item.querySelector('[data-variant="danger"]')
    if (!_canWriteMemories) delBtn.disabled = true
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Biztosan torlod ezt az emleket?')) return
      try {
        await fetch(`/api/memories/${mem.id}`, { method: 'DELETE' })
        showToast(t('memories.toast.deleted'))
        loadMemories()
        loadMemStats()
      } catch {
        showToast(t('common.error_delete'))
      }
    })

    memList.appendChild(item)
  }

  for (const doc of workspaceDocs) {
    const item = document.createElement('div')
    item.className = 'mem-item mem-item-workspace-doc'

    const typeBadge = WORKSPACE_DOC_TYPE_LABELS[doc.type] || doc.type
    const agentLabel = doc.agent_id || mainAgentId()
    const dateLabel = doc.updated_at ? new Date(doc.updated_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }) : ''

    item.innerHTML = `
      <div class="mem-item-header">
        <span class="badge" data-variant="info">Munkadok</span>
        <span class="badge" data-variant="neutral">${escapeHtml(typeBadge)}</span>
        <span class="mem-agent-badge">${escapeHtml(agentLabel)}</span>
        <span class="mem-date">${escapeHtml(dateLabel)}</span>
      </div>
      <div class="mem-content-short"><strong>${escapeHtml(doc.title)}</strong></div>
      <div class="mem-content-short">${doc.snippet ? doc.snippet.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>') : ''}</div>
    `

    memList.appendChild(item)
  }
}

// === Memory modal tab management ===

function switchMemModalTab(tabName) {
  document.querySelectorAll('#memModalTabNav .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.memTab === tabName)
  })
  document.getElementById('memEditPanel').hidden = tabName !== 'edit'
  document.getElementById('memHistoryPanel').hidden = tabName !== 'history'
}

document.getElementById('memModalTabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn[data-mem-tab]')
  if (!btn) return
  const tab = btn.dataset.memTab
  switchMemModalTab(tab)
  if (tab === 'history') {
    const editId = document.getElementById('memEditId').value
    if (editId) loadMemVersions(parseInt(editId, 10))
  }
})

function openMemEditModal(mem, tier) {
  document.getElementById('memModalTitle').textContent = t('memories.modal.title_edit')
  document.getElementById('memContent').value = mem.content
  document.getElementById('memTier').value = tier
  document.getElementById('memKeywords').value = mem.keywords || ''
  document.getElementById('memEditId').value = mem.id
  if (mem.agent_id) document.getElementById('memAgent').value = mem.agent_id
  // Show Előzmények tab for existing memories
  document.getElementById('memHistoryTabBtn').hidden = false
  switchMemModalTab('edit')
  _openModal?.(memModalOverlay)
}

async function loadMemVersions(memId) {
  const list = document.getElementById('memVersionList')
  list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Betöltés...</p>'
  try {
    const res = await fetch(`/api/memories/${memId}/versions`)
    const versions = await res.json()
    if (!versions.length) {
      list.innerHTML = '<p class="mem-version-empty">Nincs korábbi verzió.</p>'
      return
    }
    list.innerHTML = versions.map((v, i) => {
      const date = new Date(v.changed_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
      const changeLabel = { update: 'tartalom', category_change: 'kategória', create: 'létrehozás' }[v.change_type] || v.change_type
      return `
        <div class="mem-version-item">
          <div class="mem-version-meta">
            <span class="mem-version-num">#${versions.length - i}</span>
            <span class="mem-version-date">${escapeHtml(date)}</span>
            <span class="mem-version-by">${escapeHtml(v.changed_by || '')}</span>
            <span class="mem-version-type">${escapeHtml(changeLabel)}</span>
          </div>
          <div class="mem-version-content">${escapeHtml(v.content)}</div>
          ${v.category ? `<div class="mem-version-cat"><span class="badge" data-variant="${TIER_TO_VARIANT[v.category] || 'neutral'}">${escapeHtml(v.category)}</span></div>` : ''}
        </div>
      `
    }).join('')
  } catch {
    list.innerHTML = '<p class="mem-version-empty">Nem sikerült betölteni az előzményeket.</p>'
  }
}

export { openEditMemory }

// Search integration: listen to existing search input (graph mode) --
// kept here (not in memory-graph.js) so it reads memSearchInput/currentMemTier
// as plain in-module state instead of a circular import.
memSearchInput.addEventListener('input', () => {
  if (currentMemTier === 'graph') {
    updateGraphSearch(memSearchInput.value)
  }
})
memSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && currentMemTier === 'graph') {
    updateGraphSearch(memSearchInput.value)
  }
})

// === Daily Log ===

export async function loadDailyLog() {
  // "Minden ügynök" (empty value) falls back to the first agent in the
  // filter dropdown, which is the main agent on any BOT_NAME -- avoids a
  // hardcoded "marveen" slug that would 404 on zino/haver/etc installs.
  const sel = document.getElementById('memAgentFilter')
  const agent = sel.value || (sel.options[1] ? sel.options[1].value : '')
  if (!agent) {
    renderLogEntries([])
    return
  }

  try {
    const datesRes = await fetch(`/api/daily-log/dates?agent=${agent}`)
    logDates = await datesRes.json()
  } catch {
    logDates = []
  }

  document.getElementById('logCurrentDate').textContent = formatLogDate(currentLogDate)

  try {
    const res = await fetch(`/api/daily-log?agent=${agent}&date=${currentLogDate}`)
    const entries = await res.json()
    renderLogEntries(entries)
  } catch {
    renderLogEntries([])
  }
}

function renderLogEntries(entries) {
  const el = document.getElementById('logEntries')
  const empty = document.getElementById('logEmpty')
  el.innerHTML = ''
  empty.hidden = entries.length > 0

  for (const entry of entries) {
    const time = new Date(entry.created_at * 1000).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
    const div = document.createElement('div')
    div.className = 'log-entry'
    div.innerHTML = `
      <div class="log-entry-time">${time}</div>
      <div class="log-entry-content">${escapeHtml(entry.content)}</div>
    `
    el.appendChild(div)
  }
}

function formatLogDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

// Date navigation
document.getElementById('logPrevDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() - 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})
document.getElementById('logNextDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() + 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})


// ============================================================
// === Memory Import ===
// ============================================================

const memImportOverlay = document.getElementById('memImportOverlay')
const memImportFileInput = document.getElementById('memImportFile')
const memImportFileArea = document.getElementById('memImportFileArea')
const memImportFileNames = document.getElementById('memImportFileNames')
const memImportSaveBtn = document.getElementById('memImportSaveBtn')
const memImportProgress = document.getElementById('memImportProgress')
const memImportStatus = document.getElementById('memImportStatus')
const memImportResult = document.getElementById('memImportResult')
let memImportFiles = []

// Open import modal
document.getElementById('memImportOpenBtn').addEventListener('click', () => {
  memImportFiles = []
  memImportFileInput.value = ''
  memImportFileNames.textContent = ''
  memImportProgress.hidden = true
  memImportResult.hidden = true
  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = !_canWriteMemories

  // Populate agent dropdown from existing agents
  const importAgentSel = document.getElementById('memImportAgent')
  const memAgentSel = document.getElementById('memAgent')
  importAgentSel.innerHTML = memAgentSel.innerHTML
  _openModal?.(memImportOverlay)
})

// Close import modal
document.getElementById('memImportClose').addEventListener('click', () => _closeModal?.(memImportOverlay))
memImportOverlay.addEventListener('click', (e) => { if (e.target === memImportOverlay) _closeModal?.(memImportOverlay) })

// File area click -> trigger file input
memImportFileArea.addEventListener('click', () => memImportFileInput.click())

// Drag and drop
memImportFileArea.addEventListener('dragover', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = 'var(--accent)'
})
memImportFileArea.addEventListener('dragleave', () => {
  memImportFileArea.style.borderColor = ''
})
memImportFileArea.addEventListener('drop', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = ''
  const files = Array.from(e.dataTransfer.files).filter(f =>
    f.name.endsWith('.md') || f.name.endsWith('.txt') || f.name.endsWith('.json')
  )
  if (files.length) {
    memImportFiles = files
    memImportFileNames.textContent = files.map(f => f.name).join(', ')
  }
})

// File input change
memImportFileInput.addEventListener('change', () => {
  memImportFiles = Array.from(memImportFileInput.files)
  memImportFileNames.textContent = memImportFiles.map(f => f.name).join(', ')
})

// Parse file into chunks (client-side)
async function parseFileToChunks(file) {
  const text = await file.text()
  const ext = file.name.split('.').pop().toLowerCase()

  if (ext === 'json') {
    try {
      const data = JSON.parse(text)
      if (Array.isArray(data)) {
        return data.map(item => {
          if (typeof item === 'object' && item !== null) return item.content || item.text || item.value || JSON.stringify(item)
          return String(item)
        }).filter(s => s.length > 20).map(s => s.slice(0, 2000))
      }
      return Object.entries(data).map(([k, v]) => `${k}: ${v}`).filter(s => s.length > 20).map(s => s.slice(0, 2000))
    } catch { return [text.slice(0, 2000)] }
  }

  if (ext === 'md') {
    return text.split(/\n(?=##?\s)/).map(s => s.trim()).filter(s => s.length > 20).map(s => s.slice(0, 2000))
  }

  // txt: split by paragraphs
  return text.split(/\n\n+/).map(s => s.trim()).filter(s => s.length > 20).map(s => s.slice(0, 2000))
}

// Import button click
memImportSaveBtn.addEventListener('click', async () => {
  if (!memImportFiles.length) {
    showToast(t('memories.toast.select_files'))
    return
  }

  memImportSaveBtn.querySelector('.btn-text').hidden = true
  memImportSaveBtn.querySelector('.btn-loading').hidden = false
  memImportSaveBtn.disabled = true
  memImportProgress.hidden = false
  memImportResult.hidden = true
  memImportStatus.textContent = t('memories.import.processing')

  try {
    // Parse all files into chunks
    let allChunks = []
    for (const file of memImportFiles) {
      const chunks = await parseFileToChunks(file)
      allChunks = allChunks.concat(chunks)
    }

    if (allChunks.length === 0) {
      memImportProgress.hidden = true
      memImportSaveBtn.querySelector('.btn-text').hidden = false
      memImportSaveBtn.querySelector('.btn-loading').hidden = true
      memImportSaveBtn.disabled = false
      showToast(t('memories.toast.no_content'))
      return
    }

    memImportStatus.textContent = t('memories.import.importing', { n: allChunks.length })

    const agentId = document.getElementById('memImportAgent').value || mainAgentId()
    const resp = await fetch('/api/memories/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, chunks: allChunks }),
    })
    const data = await resp.json()

    memImportProgress.hidden = true

    if (data.ok) {
      const s = data.stats || {}
      memImportResult.hidden = false
      memImportResult.innerHTML = `
        <div style="color:var(--text-primary);font-weight:600;margin-bottom:8px">${t('memories.import.done_title')}</div>
        <div style="font-size:13px;color:var(--text-secondary)">
          ${t('memories.import.done_sub', { n: `<strong>${data.imported}</strong>` })}<br>
          Hot: ${s.hot || 0} | Warm: ${s.warm || 0} | Cold: ${s.cold || 0} | Shared: ${s.shared || 0}
        </div>
      `
      showToast(t('memories.toast.imported', { n: data.imported }))
      loadMemories()
      loadMemStats()
    } else {
      showToast('Hiba: ' + getErrorMessage(data, 'Ismeretlen'))
    }
  } catch (err) {
    memImportProgress.hidden = true
    showToast(t('memories.toast.import_error'))
  }

  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = false
})

// (Artifacts tab removed -- redundant with the dedicated Artifacts sidebar page)

// === PHASE 2: Timeline Mode (Idővonal) ===

let tlMode = 'strukt'
let tlLayoutNodes = []   // nodes with geometry + animation state
let tlEvents = []        // sorted event stream [{type,nodeId,ts}]
let tlT0 = 0
let tlT1 = 0
let tlSimTime = 0
let tlPlaying = false
let tlLastWall = 0
let tlRaf = null
let tlParticles = []    // [{type:'limb'|'sub', tier, nodeIdx, t, speed, size, alpha}]
let tlBursts = []       // active burst animations
let tlBurstQueue = []   // pending burst fires [{node, wallTime}] for 90ms stagger
let tlRootX = 0
let tlRootY = 0
let tlScrubDragging = false
let tlScrubWasPlaying = false
let tlNodeMap = {}      // id -> tlLayoutNodes[i]
let tlPlaybackSpeed = 1  // (t1-t0)/30s computed at load
let tlRecording = false
let tlMediaRecorder = null
let tlRecordedChunks = []
let tlFpsSamples = []    // recent frame deltas (ms) for FPS guardrail, capped at 15

const TL_LIMB_ANGLES = { hot: -0.55, warm: 0.25, cold: 1.55, shared: 2.85, import: 4.1 }
const TL_TIERS = ['hot', 'warm', 'cold', 'shared', 'import']
const HU_MONTHS = ['jan','feb','már','ápr','máj','jún','júl','aug','szep','okt','nov','dec']

// Deterministic hash for a node id - avoids Math.random() for layout stability
function tlIdHash(id, salt) {
  let h = ((id * 2654435761) ^ (salt * 40503)) >>> 0
  h = ((h ^ (h >>> 16)) * 2246822519) >>> 0
  h = ((h ^ (h >>> 13)) * 3266489917) >>> 0
  return (h >>> 0) / 4294967295
}

async function loadTimeline() {
  const agent = document.getElementById('memAgentFilter').value
  const params = new URLSearchParams({ weight_min: '0.75' })
  if (agent) params.set('agent', agent)
  const tenant = _memTenantGetter?.()
  if (tenant) params.set('tenant', tenant)
  try {
    const res = await fetch(`/api/memories/graph/timeline?${params}`)
    const data = await res.json()
    if (data.error) { console.error('Timeline API error:', data.error); return }
    buildTimeline(data)
  } catch (err) {
    console.error('Timeline load error:', err)
  }
}

function tlQuadBezierPoint(t, x0, y0, cx, cy, x1, y1) {
  const u = 1 - t
  return { x: u*u*x0 + 2*u*t*cx + t*t*x1, y: u*u*y0 + 2*u*t*cy + t*t*y1 }
}

function buildTimeline(data) {
  initGlowSprites()

  const canvas = document.getElementById('memGraphCanvas')
  const rect = canvas.parentElement.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = rect.width + 'px'
  canvas.style.height = rect.height + 'px'
  setGraphCanvas(canvas, canvas.getContext('2d'))
  graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const W = rect.width
  const H = rect.height
  tlRootX = W * 0.42
  tlRootY = H * 0.48
  const minDim = Math.min(W, H)

  // Group nodes by tier, sorted by created_at
  const byTier = {}
  for (const tier of TL_TIERS) byTier[tier] = []
  for (const n of data.nodes) {
    const tier = n.tier || 'warm'
    byTier[tier] ? byTier[tier].push({ ...n }) : (byTier[tier] = [{ ...n }])
  }
  for (const tier of TL_TIERS) {
    byTier[tier].sort((a, b) => a.created_at - b.created_at)
    byTier[tier].forEach((n, i) => { n._rankInTier = i; n._totalInTier = byTier[tier].length })
  }

  tlLayoutNodes = []
  tlNodeMap = {}

  for (const tier of TL_TIERS) {
    const group = byTier[tier]
    if (!group.length) continue
    const limbAngle = TL_LIMB_ANGLES[tier]
    const limbLength = Math.min(minDim * 0.45, 180 + 22 * Math.sqrt(group.length))

    for (const n of group) {
      const total = n._totalInTier
      const bt = 0.35 + 0.65 * (total > 1 ? n._rankInTier / (total - 1) : 0.5)
      const ax = tlRootX + Math.cos(limbAngle) * limbLength * bt
      const ay = tlRootY + Math.sin(limbAngle) * limbLength * bt

      const jitter = (tlIdHash(n.id, 1) - 0.5) * 2.2  // ±1.1 rad
      const subAngle = limbAngle + jitter
      const subLength = 70 + tlIdHash(n.id, 2) * 130   // 70-200px
      const tx = ax + Math.cos(subAngle) * subLength
      const ty = ay + Math.sin(subAngle) * subLength
      const cpAngle = subAngle + 0.4
      const cpDist = subLength * 0.5
      const cpx = ax + Math.cos(cpAngle) * cpDist
      const cpy = ay + Math.sin(cpAngle) * cpDist

      const node = {
        id: n.id, label: n.label, tier, created_at: n.created_at,
        _limbAngle: limbAngle, _limbLength: limbLength, _bt: bt,
        _ax: ax, _ay: ay, _cpx: cpx, _cpy: cpy, _tx: tx, _ty: ty,
        _subAngle: subAngle, _subLength: subLength,
        // animation state
        _phase: 'waiting',  // 'waiting'|'branching'|'popping'|'alive'
        _animStart: 0,
        _branchProgress: 0,
        _nodeScale: 0,
        _haloAlpha: 0,
        _halospikeT: 0,  // burst halo spike progress 0-1
        _halospikeStart: 0,
        // tier-change animation (§5.6)
        _tierChangeActive: false,
        _tierChangePrevTier: tier,
        _tierChangeStart: 0,
      }
      tlLayoutNodes.push(node)
      tlNodeMap[n.id] = node
    }
  }

  // 60-iteration collision relaxation (y-weight 0.7, min 46px)
  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < tlLayoutNodes.length; i++) {
      for (let j = i + 1; j < tlLayoutNodes.length; j++) {
        const a = tlLayoutNodes[i], b = tlLayoutNodes[j]
        const dx = b._tx - a._tx
        const dy = b._ty - a._ty
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 46 && dist > 0.01) {
          const push = (46 - dist) / 2
          const nx = dx / dist, ny = dy / dist
          a._tx -= nx * push; a._ty -= ny * push * 0.7
          b._tx += nx * push; b._ty += ny * push * 0.7
        }
      }
    }
  }

  // Recompute control points after relaxation: tips moved, curves must follow
  for (const n of tlLayoutNodes) {
    const adx = n._tx - n._ax, ady = n._ty - n._ay
    const actualAngle = Math.atan2(ady, adx)
    const actualLen = Math.sqrt(adx * adx + ady * ady)
    n._cpx = n._ax + Math.cos(actualAngle + 0.6) * actualLen * 0.5
    n._cpy = n._ay + Math.sin(actualAngle + 0.6) * actualLen * 0.5
  }

  // Scale-to-fit: compute bounding box of the full tree, scale uniformly so
  // 40px of padding exists on every side, then center on the canvas. Never
  // scales up (scale capped at 1); only shrinks when tree exceeds safe area.
  if (tlLayoutNodes.length) {
    const PAD = 40
    let minX = tlRootX, maxX = tlRootX, minY = tlRootY, maxY = tlRootY
    for (const n of tlLayoutNodes) {
      if (n._tx < minX) minX = n._tx; if (n._tx > maxX) maxX = n._tx
      if (n._ty < minY) minY = n._ty; if (n._ty > maxY) maxY = n._ty
      if (n._ax < minX) minX = n._ax; if (n._ax > maxX) maxX = n._ax
      if (n._ay < minY) minY = n._ay; if (n._ay > maxY) maxY = n._ay
    }
    const treeW = maxX - minX || 1
    const treeH = maxY - minY || 1
    const safeW = W - 2 * PAD
    const safeH = H - 2 * PAD
    const scale = Math.min(1, safeW / treeW, safeH / treeH)
    // Bounding-box center → canvas center
    const bbCx = (minX + maxX) / 2
    const bbCy = (minY + maxY) / 2
    const canvasCx = W / 2
    const canvasCy = H / 2
    const applyFit = (px, py) => ({
      x: canvasCx + (px - bbCx) * scale,
      y: canvasCy + (py - bbCy) * scale,
    })
    const r = applyFit(tlRootX, tlRootY)
    tlRootX = r.x; tlRootY = r.y
    for (const n of tlLayoutNodes) {
      const a = applyFit(n._ax, n._ay); n._ax = a.x; n._ay = a.y
      const c = applyFit(n._cpx, n._cpy); n._cpx = c.x; n._cpy = c.y
      const t = applyFit(n._tx, n._ty); n._tx = t.x; n._ty = t.y
    }
  }

  // Build event stream
  tlEvents = (data.events || []).slice().sort((a, b) => a.ts - b.ts)

  // Edge animation states (§5.4b). Sort heaviest first so the 250-edge cap
  // always keeps the strongest connections regardless of DB insertion order.
  tlEdgeStates = (data.edges || [])
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map(e => ({ edge: e, _phase: 'waiting', _animStart: 0, _drawProgress: 0 }))

  tlT0 = data.time_range.min_ts || 0
  tlT1 = data.time_range.max_ts || (tlT0 + 1)
  const span = Math.max(1, tlT1 - tlT0)
  tlPlaybackSpeed = span / 30  // virtual seconds per wall second

  // Start paused at t1 (full tree visible)
  tlSimTime = tlT1
  tlPlaying = false
  tlParticles = []
  tlBursts = []
  tlBurstQueue = []

  // Rebuild all nodes as alive at t1
  tlRebuildAtTime(tlT1)

  updateScrubber()
  buildMonthAxis()
  startTimelineLoop()
}

function tlRebuildAtTime(targetSimTime) {
  // Instant state rebuild: no animations, just set alive/waiting
  for (const n of tlLayoutNodes) {
    if (n.created_at <= targetSimTime) {
      n._phase = 'alive'
      n._branchProgress = 1
      n._nodeScale = 1
      n._haloAlpha = 1
      n._halospikeT = 0
    } else {
      n._phase = 'waiting'
      n._branchProgress = 0
      n._nodeScale = 0
      n._haloAlpha = 0
      n._halospikeT = 0
    }
  }
  // Rebuild edge states instantly (§5.4b, scrub=no animation)
  let aliveEdgeCount = 0
  for (const es of tlEdgeStates) {
    const visible = es.edge.weight >= 0.75 && es.edge.created_at <= targetSimTime
    if (visible && aliveEdgeCount < 250) {
      es._phase = 'alive'; es._drawProgress = 1
      aliveEdgeCount++
    } else {
      es._phase = 'waiting'; es._drawProgress = 0
    }
  }
  tlParticles = []
  tlBursts = []
  tlBurstQueue = []
}

function startTimelineLoop() {
  if (tlRaf) cancelAnimationFrame(tlRaf)
  tlLastWall = performance.now()

  function tick(now) {
    tlRaf = requestAnimationFrame(tick)
    if (document.hidden) return

    const dt = Math.min(now - tlLastWall, 100)  // cap to 100ms
    tlLastWall = now

    // Collect FPS samples for video guardrail (uncapped dt excluded)
    if (dt > 0 && dt < 100) {
      tlFpsSamples.push(dt)
      if (tlFpsSamples.length > 15) tlFpsSamples.shift()
    }

    if (tlPlaying && !GRAPH_REDUCED_MOTION) {
      tlSimTime = Math.min(tlT1, tlSimTime + dt * 0.001 * tlPlaybackSpeed)
      if (tlSimTime >= tlT1) {
        tlSimTime = tlT1
        tlPlaying = false
        updatePlayBtn()
        // Stop recording when playback reaches the end
        if (tlRecording && tlMediaRecorder && tlMediaRecorder.state === 'recording') {
          tlMediaRecorder.stop()
        }
        // Pop the most recently created node(s) so a visual gap before them
        // doesn't make the replay look like it stopped early.
        tlEmphasiseLatestArrivals(now)
        // Ensure the final static state matches what buildTimeline() and manual
        // scrubbing show: edges that arrived via 'flash' during playback must be
        // promoted to 'alive' now that we are paused at t1.
        tlRebuildAtTime(tlT1)
      }
      // Fire events that fall within the new simTime window
      tlCheckAndFireEvents(tlSimTime - dt * 0.001 * tlPlaybackSpeed, tlSimTime, now)
    }

    // Process burst stagger queue
    tlProcessBurstQueue(now)

    // Advance particles
    if (!GRAPH_REDUCED_MOTION) tlTickTimelineParticles(dt)

    renderTimeline(now, dt)
    updateScrubberFill()
  }

  tlRaf = requestAnimationFrame(tick)
}

function stopTimelineLoop() {
  if (tlRaf) { cancelAnimationFrame(tlRaf); tlRaf = null }
}

let tlLastFiredEventIdx = 0  // track which events have been fired
let tlEdgeStates = []       // [{edge, _phase, _animStart, _drawProgress}]

function tlCheckAndFireEvents(prevSim, curSim, wallNow) {
  for (let i = 0; i < tlEvents.length; i++) {
    const ev = tlEvents[i]
    if (ev.ts > prevSim && ev.ts <= curSim) {
      if (ev.type === 'created') {
        const n = tlNodeMap[ev.memory_id]
        if (n && n._phase === 'waiting') {
          n._phase = 'branching'
          n._animStart = wallNow
          n._branchProgress = 0
          n._nodeScale = 0
          n._haloAlpha = 0
          // Queue burst with stagger (cap 12)
          if (tlBurstQueue.length < 12) {
            tlBurstQueue.push({ node: n, wallTime: wallNow + tlBurstQueue.length * 90 })
          }
          // Event feed
          tlUpdateEventFeed(n, 'created')
        }
      }
      if (ev.type === 'tier_changed' && ev.to_tier) {
        const n = tlNodeMap[ev.memory_id]
        if (n && n._phase === 'alive') {
          n._tierChangePrevTier = n.tier
          n.tier = ev.to_tier
          n._tierChangeActive = true
          n._tierChangeStart = wallNow
          // Mini-burst at node position with new tier color
          tlFireBurst(n, wallNow)
        }
      }
    }
  }
  // Fire semantic edge animations (§5.4b): keyed by edge.created_at
  for (const es of tlEdgeStates) {
    if (es._phase !== 'waiting') continue
    if (es.edge.created_at <= prevSim || es.edge.created_at > curSim) continue
    const srcNode = tlNodeMap[es.edge.src_id]
    const dstNode = tlNodeMap[es.edge.dst_id]
    if (!srcNode || !dstNode) continue
    if (es.edge.weight < 0.80) {
      es._phase = 'flash'
      es._animStart = wallNow
      es._drawProgress = 0
    } else {
      const aliveCount = tlEdgeStates.filter(s => s._phase === 'alive').length
      if (aliveCount < 250) {
        es._phase = 'drawing'
        es._animStart = wallNow
        es._drawProgress = 0
      }
    }
    // Feed event: only weight >= 0.90
    if (es.edge.weight >= 0.90 && srcNode && dstNode) {
      tlUpdateEventFeed(srcNode, 'linked', dstNode, es.edge)
    }
  }
}

function tlProcessBurstQueue(wallNow) {
  const ready = tlBurstQueue.filter(q => wallNow >= q.wallTime)
  tlBurstQueue = tlBurstQueue.filter(q => wallNow < q.wallTime)
  for (const q of ready) {
    tlFireBurst(q.node, wallNow)
  }
}

function tlFireBurst(node, wallNow) {
  if (GRAPH_REDUCED_MOTION) return
  const rayCount = 10 + Math.floor(tlIdHash(node.id, 3) * 3)
  const sparkCount = 12 + Math.floor(tlIdHash(node.id, 4) * 3)
  const rays = []
  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2 + tlIdHash(node.id * 100 + i, 5) * 0.5
    rays.push({
      angle,
      length: 10 + tlIdHash(node.id + i * 37, 6) * 16,
      alpha: 0.35 + tlIdHash(node.id + i * 53, 7) * 0.4,
    })
  }
  const sparks = []
  const glowColor = GRAPH_TIER_GLOW[node.tier] || '#ffffff'
  for (let i = 0; i < sparkCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const vel = 40 + Math.random() * 50
    sparks.push({
      x: node._tx, y: node._ty,
      vx: Math.cos(angle) * vel,
      vy: Math.sin(angle) * vel,
      size: 2 + Math.random() * 2,
      life: 700,
      elapsed: 0,
    })
  }
  tlBursts.push({
    x: node._tx, y: node._ty,
    startWall: wallNow,
    rays,
    sparks,
    glowColor,
    tier: node.tier,
  })
  // Halo spike
  node._halospikeStart = wallNow
  node._halospikeT = 1
}

// Fire an extra burst + ring-pulse on node(s) that arrived last in the replay.
// Called once when playback reaches tlT1; handles the perception issue where a
// long gap before the newest node makes the replay look like it stopped early.
function tlEmphasiseLatestArrivals(wallNow) {
  if (GRAPH_REDUCED_MOTION) return
  const alive = tlLayoutNodes.filter(n => n._phase === 'alive' && n.created_at != null)
  if (!alive.length) return
  const maxTs = Math.max(...alive.map(n => n.created_at))
  // Nodes within the last 5% of the span (or at least 24 h) count as "latest".
  const window = Math.max(86400, (tlT1 - tlT0) * 0.05)
  const recent = alive.filter(n => n.created_at >= maxTs - window)
  recent.forEach((n, i) => {
    setTimeout(() => {
      if (n._phase !== 'alive') return
      const t = performance.now()
      tlFireBurst(n, t)
      n._latestPulseStart = t
    }, 300 + i * 150)
  })
}

function tlTickTimelineParticles(dt) {
  const dtS = dt / 1000

  // Advance existing particles
  for (const p of tlParticles) {
    p.t += p.speed * dtS
    if (p.t >= 1) p.t -= 1  // respawn at root
  }

  // Update burst sparks
  for (const burst of tlBursts) {
    for (const sp of burst.sparks) {
      sp.elapsed += dt
      sp.x += sp.vx * dtS
      sp.y += sp.vy * dtS
    }
  }
  // Remove expired bursts
  tlBursts = tlBursts.filter(b => {
    const age = tlLastWall - b.startWall
    return age < 900
  })

  // Spawn particles: 7 per alive limb spine, 3 per alive sub-branch
  // Rebuild particle pool based on alive nodes
  if (tlParticles.length < 140) {
    // Limb particles: one pool per tier limb that has alive nodes
    const aliveTiers = new Set()
    for (const n of tlLayoutNodes) {
      if (n._phase === 'alive' || n._phase === 'popping') aliveTiers.add(n.tier)
    }
    for (const tier of aliveTiers) {
      const limbCount = tlParticles.filter(p => p.type === 'limb' && p.tier === tier).length
      for (let i = limbCount; i < 7 && tlParticles.length < 140; i++) {
        tlParticles.push({
          type: 'limb', tier,
          t: i / 7,
          speed: 0.22 * (0.85 + tlIdHash(tier.charCodeAt(0) + i * 17, 8) * 0.30),
          size: 2.5 + tlIdHash(tier.charCodeAt(0) + i, 9) * 4.5,
          alpha: 0.5 + tlIdHash(tier.charCodeAt(0) + i * 3, 10) * 0.5,
        })
      }
    }
    // Sub-branch particles
    const aliveNodes = tlLayoutNodes.filter(n => n._phase === 'alive' && tlParticles.length < 140)
    for (const n of aliveNodes) {
      const subCount = tlParticles.filter(p => p.type === 'sub' && p.nodeId === n.id).length
      for (let i = subCount; i < 3 && tlParticles.length < 140; i++) {
        tlParticles.push({
          type: 'sub', tier: n.tier, nodeId: n.id,
          nodeIdx: tlLayoutNodes.indexOf(n),
          t: i / 3,
          speed: 0.35 * (0.85 + Math.random() * 0.30),
          size: 2.5 + Math.random() * 4.5,
          alpha: 0.5 + Math.random() * 0.5,
        })
      }
    }
  }

  // Remove sub-branch particles for nodes no longer alive
  tlParticles = tlParticles.filter(p => {
    if (p.type !== 'sub') return true
    const n = tlLayoutNodes[p.nodeIdx]
    return n && (n._phase === 'alive' || n._phase === 'popping')
  })
}

function tlUpdateEventFeed(node, type, dstNode = null, edge = null) {
  const feed = document.getElementById('tlEventFeed')
  if (!feed) return

  // Determine timestamp and text for this event type
  let ts, text
  if (type === 'linked' && dstNode && edge) {
    ts = edge.created_at
    const lblA = (node.label || '').slice(0, 16)
    const lblB = (dstNode.label || '').slice(0, 16)
    text = `${lblA} <-> ${lblB}`
  } else {
    ts = node.created_at
    const lbl = (node.label || '').slice(0, 25)
    const tierWord = node.tier || 'warm'
    text = `+ ${lbl} (${tierWord})`
  }
  const d = new Date(ts * 1000)
  const dateStr = `${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

  // Cap total rows (live + fading) at 12 so dense playback can't pile up.
  // Oldest fading rows are removed immediately; oldest live rows start fading.
  feed.querySelectorAll('.tl-feed-row.newest').forEach(r => r.classList.remove('newest'))
  const allRows = Array.from(feed.querySelectorAll('.tl-feed-row'))
  allRows.slice(0, Math.max(0, allRows.length - 11)).forEach(r => {
    if (r.classList.contains('fading-out')) {
      r.remove()
    } else {
      r.classList.add('fading-out')
      setTimeout(() => r.remove(), 260)
    }
  })

  const row = document.createElement('div')
  row.className = 'tl-feed-row newest'
  const dateSpan = document.createElement('span')
  dateSpan.className = 'tl-feed-date'
  dateSpan.textContent = dateStr
  const textSpan = document.createElement('span')
  textSpan.className = 'tl-feed-text'
  textSpan.textContent = text
  row.appendChild(dateSpan)
  row.appendChild(textSpan)
  feed.appendChild(row)
}

function buildMonthAxis() {
  const axis = document.getElementById('tlMonthAxis')
  if (!axis || tlT1 <= tlT0) return
  axis.innerHTML = ''

  const span = tlT1 - tlT0
  // Collect month-start timestamps in range
  const d0 = new Date(tlT0 * 1000)
  const d1 = new Date(tlT1 * 1000)
  const ticks = []
  const cur = new Date(d0.getFullYear(), d0.getMonth(), 1)
  while (cur <= d1 && ticks.length < 8) {
    const ts = cur.getTime() / 1000
    if (ts >= tlT0) ticks.push({ ts, label: HU_MONTHS[cur.getMonth()] })
    cur.setMonth(cur.getMonth() + 1)
  }

  for (const tick of ticks) {
    const pct = (tick.ts - tlT0) / span * 100
    const el = document.createElement('span')
    el.className = 'tl-month-tick'
    el.style.left = pct + '%'
    el.textContent = tick.label
    axis.appendChild(el)
  }
}

function updateScrubber() {
  updateScrubberFill()
  const chip = document.getElementById('tlDateChip')
  if (chip) {
    const d = new Date(tlSimTime * 1000)
    chip.textContent = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }
}

function updateScrubberFill() {
  const span = Math.max(1, tlT1 - tlT0)
  const pct = Math.max(0, Math.min(100, (tlSimTime - tlT0) / span * 100))
  const fill = document.getElementById('tlTrackFill')
  const knob = document.getElementById('tlKnob')
  if (fill) fill.style.width = pct + '%'
  if (knob) knob.style.left = pct + '%'

  const chip = document.getElementById('tlDateChip')
  if (chip) {
    const d = new Date(tlSimTime * 1000)
    chip.textContent = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }
}

function updatePlayBtn() {
  const btn = document.getElementById('tlPlayBtn')
  if (!btn) return
  btn.innerHTML = tlPlaying ? '&#9646;&#9646;' : '&#9654;'
  btn.setAttribute('aria-label', tlPlaying ? 'Szünet' : 'Lejátszás')
}

function updateRecordBtn() {
  const btn = document.getElementById('tlRecordBtn')
  if (!btn) return
  btn.disabled = tlRecording
  if (tlRecording) {
    btn.classList.add('recording')
    btn.innerHTML = '&#9679; Rögzítés...'
  } else {
    btn.classList.remove('recording')
    btn.innerHTML = '&#9210; Videó'
  }
}

function tlStartRecording() {
  if (tlRecording) return
  if (!graphCanvas) return

  // FPS guardrail: warn if recent average < 25 fps
  if (tlFpsSamples.length >= 5) {
    const avgDt = tlFpsSamples.reduce((a, b) => a + b, 0) / tlFpsSamples.length
    const fps = Math.round(1000 / avgDt)
    if (fps < 25) {
      const ok = confirm(`A renderelés jelenleg ~${fps} fps-sel fut (ajánlott min. 25 fps). A mentett videó akadozhat. Folytatod?`)
      if (!ok) return
    }
  }

  // Reset timeline to start
  tlSimTime = tlT0
  tlRebuildAtTime(tlT0)
  tlPlaying = false
  updatePlayBtn()

  // Init MediaRecorder on the canvas stream
  const stream = graphCanvas.captureStream(30)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm'
  tlRecordedChunks = []
  tlMediaRecorder = new MediaRecorder(stream, { mimeType })

  tlMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) tlRecordedChunks.push(e.data)
  }

  tlMediaRecorder.onstop = () => {
    const blob = new Blob(tlRecordedChunks, { type: 'video/webm' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    a.download = `memoria-fa-${dateStr}.webm`
    a.href = url
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    tlRecording = false
    tlMediaRecorder = null
    tlRecordedChunks = []
    updateRecordBtn()
  }

  tlMediaRecorder.onerror = () => {
    tlRecording = false
    tlMediaRecorder = null
    tlRecordedChunks = []
    updateRecordBtn()
  }

  tlRecording = true
  updateRecordBtn()
  tlMediaRecorder.start(250)  // emit chunks every 250ms

  // Start playback from the beginning
  tlLastWall = performance.now()
  tlPlaying = true
  updatePlayBtn()
}

function renderTimeline(wallNow, dt) {
  if (!graphCtx || !graphCanvas) return
  const ctx = graphCtx
  const dpr = window.devicePixelRatio || 1
  const W = graphCanvas.width / dpr
  const H = graphCanvas.height / dpr

  // Dark cinematic background (always, §5.10)
  ctx.fillStyle = '#0d0d0b'
  ctx.fillRect(0, 0, W, H)

  // Root halo (layered, blend 'lighter')
  const rootSprite = graphGlowSprites['white']
  if (rootSprite) {
    const haloRadius = 90
    const haloSize = haloRadius * 2
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.8
    ctx.drawImage(rootSprite, tlRootX - haloRadius, tlRootY - haloRadius, haloSize, haloSize)
    ctx.globalAlpha = 0.53
    ctx.drawImage(rootSprite, tlRootX - haloRadius * 0.6, tlRootY - haloRadius * 0.6, haloSize * 0.6, haloSize * 0.6)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
  // Root core: white 7px circle
  ctx.beginPath()
  ctx.arc(tlRootX, tlRootY, 7, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  // Limb spines
  for (const tier of TL_TIERS) {
    const hasAlive = tlLayoutNodes.some(n => n.tier === tier && (n._phase === 'alive' || n._phase === 'popping' || n._phase === 'branching'))
    if (!hasAlive) continue
    const angle = TL_LIMB_ANGLES[tier]
    const group = tlLayoutNodes.filter(n => n.tier === tier)
    if (!group.length) continue
    const limbLength = group[0]._limbLength
    const glowCol = GRAPH_TIER_GLOW[tier] || '#ffffff'
    const baseCol = GRAPH_TIER_COLORS[tier] || '#888'
    const lx = tlRootX + Math.cos(angle) * limbLength
    const ly = tlRootY + Math.sin(angle) * limbLength
    const grad = ctx.createLinearGradient(tlRootX, tlRootY, lx, ly)
    grad.addColorStop(0, baseCol + '30')
    grad.addColorStop(1, glowCol + '18')
    ctx.beginPath()
    ctx.moveTo(tlRootX, tlRootY)
    ctx.lineTo(lx, ly)
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.5
    ctx.globalAlpha = 0.6
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Limb particles
  if (!GRAPH_REDUCED_MOTION) {
    for (const p of tlParticles) {
      if (p.type !== 'limb') continue
      const angle = TL_LIMB_ANGLES[p.tier]
      const group = tlLayoutNodes.filter(n => n.tier === p.tier)
      if (!group.length) continue
      const limbLength = group[0]._limbLength
      const px = tlRootX + Math.cos(angle) * limbLength * p.t
      const py = tlRootY + Math.sin(angle) * limbLength * p.t
      const sprite = graphGlowSprites[p.tier] || graphParticleSprite
      if (sprite) {
        const sz = p.size * 4
        ctx.globalAlpha = p.alpha * 0.7
        ctx.globalCompositeOperation = 'lighter'
        ctx.drawImage(sprite, px - sz / 2, py - sz / 2, sz, sz)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
    }
  }

  // Semantic edge layer (§5.4b): whisper-web lines between alive nodes
  ctx.lineWidth = 0.7
  for (const es of tlEdgeStates) {
    if (es._phase === 'waiting') continue
    const srcNode = tlNodeMap[es.edge.src_id]
    const dstNode = tlNodeMap[es.edge.dst_id]
    if (!srcNode || !dstNode) continue
    if (srcNode._phase === 'waiting' || dstNode._phase === 'waiting') continue

    let drawProg = 0
    if (es._phase === 'alive') {
      drawProg = 1
    } else if (es._phase === 'drawing') {
      const elapsed = wallNow - es._animStart
      drawProg = Math.min(1, elapsed / 450)
      es._drawProgress = drawProg
      if (elapsed >= 450) es._phase = 'alive'
    } else if (es._phase === 'flash') {
      const elapsed = wallNow - es._animStart
      if (elapsed >= 350) { es._phase = 'waiting'; continue }
      // Triangle wave: rise 175ms, fall 175ms
      drawProg = elapsed < 175 ? elapsed / 175 : (350 - elapsed) / 175
    }
    if (drawProg < 0.005) continue

    const x0 = srcNode._tx, y0 = srcNode._ty
    const x1 = dstNode._tx, y1 = dstNode._ty
    // Partial line draw-in from src toward dst
    const ex = x0 + (x1 - x0) * drawProg
    const ey = y0 + (y1 - y0) * drawProg

    const w = es.edge.weight
    const baseAlpha = w >= 0.90 ? 0.12 + 0.25 * w : 0.08 + 0.15 * w
    const alpha = es._phase === 'flash'
      ? Math.min(1, baseAlpha * 4 * drawProg)  // flash: brighter, fades with wave
      : baseAlpha * drawProg
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(ex, ey)
    ctx.strokeStyle = '#ffffff'
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Branches and nodes
  const now400 = wallNow
  for (const n of tlLayoutNodes) {
    if (n._phase === 'waiting') continue

    // Advance animation phase
    if (n._phase === 'branching') {
      const elapsed = now400 - n._animStart
      const branchDuration = 400
      const progress = Math.min(1, elapsed / branchDuration)
      // ease-out: 1 - (1-t)^2
      n._branchProgress = 1 - Math.pow(1 - progress, 2)
      if (elapsed >= branchDuration) {
        n._phase = 'popping'
        n._animStart = wallNow
      }
    } else if (n._phase === 'popping') {
      const elapsed = wallNow - n._animStart
      const popDuration = 300
      const haloDuration = 250
      const haloDelay = 80
      const popT = Math.min(1, elapsed / popDuration)
      n._nodeScale = graphEaseOutBack(popT)
      n._haloAlpha = elapsed >= haloDelay ? Math.min(1, (elapsed - haloDelay) / haloDuration) : 0
      n._branchProgress = 1
      if (elapsed >= popDuration + haloDelay) {
        n._phase = 'alive'
        n._nodeScale = 1
        n._haloAlpha = 1
      }
    }

    // Draw sub-branch (partial bezier with tapered gradient)
    const prog = n._branchProgress
    if (prog > 0.01) {
      const steps = Math.max(3, Math.ceil(prog * 20))
      const tipT = prog
      const tipPt = tlQuadBezierPoint(tipT, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
      const glowCol = GRAPH_TIER_GLOW[n.tier] || '#ffffff'
      const baseCol = GRAPH_TIER_COLORS[n.tier] || '#888'

      ctx.beginPath()
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * tipT
        const pt = tlQuadBezierPoint(t, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
        if (i === 0) ctx.moveTo(pt.x, pt.y)
        else ctx.lineTo(pt.x, pt.y)
      }
      // Glow underlay
      const grad = ctx.createLinearGradient(n._ax, n._ay, tipPt.x, tipPt.y)
      grad.addColorStop(0, baseCol + '30')
      grad.addColorStop(0.5, baseCol + '8F')
      grad.addColorStop(1, glowCol + 'DE')
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineWidth = 1.5 * 3.4
      ctx.strokeStyle = glowCol + '12'
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineWidth = 1.5
      ctx.strokeStyle = grad
      ctx.stroke()
    }

    // Draw node with fly-in (last 30% of sub-branch during pop)
    if (n._nodeScale > 0.01) {
      let nx = n._tx, ny = n._ty
      if (n._phase === 'popping') {
        const popT = Math.min(1, (wallNow - n._animStart) / 300)
        // fly from 70% of sub-branch to tip
        const flyT = 0.7 + popT * 0.3
        const flyPt = tlQuadBezierPoint(flyT, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
        nx = flyPt.x; ny = flyPt.y
      }

      const tier = n.tier

      // §5.6 tier-change crossfade: cross-fade glow from prev tier to new tier over 600ms
      let tcProg = 1  // 1 = fully new tier
      if (n._tierChangeActive) {
        const tcElapsed = wallNow - n._tierChangeStart
        if (tcElapsed >= 600) {
          n._tierChangeActive = false
        } else {
          tcProg = tcElapsed / 600  // 0→1 linear
        }
      }
      const glowCol = GRAPH_TIER_GLOW[tier] || '#ffffff'
      const baseCol = GRAPH_TIER_COLORS[tier] || '#888'

      const scale = n._nodeScale
      const baseRadius = 5

      // Burst halo spike
      let haloMult = 3.4
      if (n._halospikeT > 0) {
        const spikeElapsed = wallNow - n._halospikeStart
        const spikeProgress = Math.min(1, spikeElapsed / 900)
        const eased = 1 - Math.pow(1 - spikeProgress, 2)  // ease-out
        n._halospikeT = 1 - eased
        haloMult = 3.4 + n._halospikeT * (7 - 3.4)
      }

      // Halo sprite (with §5.6 crossfade: blend prev tier out while new tier fades in)
      if (n._haloAlpha > 0.01) {
        const haloRadius = baseRadius * haloMult * scale
        const sz = haloRadius * 2
        ctx.globalCompositeOperation = 'lighter'
        // Outgoing tier halo fades out (only during crossfade)
        if (tcProg < 1 && graphGlowSprites[n._tierChangePrevTier]) {
          ctx.globalAlpha = n._haloAlpha * (1 - tcProg)
          ctx.drawImage(graphGlowSprites[n._tierChangePrevTier], nx - haloRadius, ny - haloRadius, sz, sz)
        }
        // Incoming tier halo fades in
        if (graphGlowSprites[tier]) {
          ctx.globalAlpha = n._haloAlpha * (tcProg < 1 ? tcProg : 1)
          ctx.drawImage(graphGlowSprites[tier], nx - haloRadius, ny - haloRadius, sz, sz)
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }

      // Latest-arrival ring pulse: expands + fades over 2500ms after playback ends
      if (n._latestPulseStart) {
        const pulseElapsed = wallNow - n._latestPulseStart
        if (pulseElapsed < 2500) {
          const prog = pulseElapsed / 2500
          const pulseR = baseRadius * scale * (2 + prog * 5)
          ctx.beginPath()
          ctx.arc(nx, ny, pulseR, 0, Math.PI * 2)
          ctx.strokeStyle = GRAPH_TIER_GLOW[tier] || '#ffffff'
          ctx.lineWidth = 2
          ctx.globalAlpha = (1 - prog) * 0.65
          ctx.stroke()
          ctx.globalAlpha = 1
        } else {
          n._latestPulseStart = null
        }
      }

      // Node core circle
      ctx.beginPath()
      ctx.arc(nx, ny, baseRadius * scale, 0, Math.PI * 2)
      ctx.fillStyle = baseCol
      ctx.fill()
      ctx.beginPath()
      ctx.arc(nx, ny, baseRadius * 0.4 * scale, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.globalAlpha = 0.8
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  // Sub-branch particles
  if (!GRAPH_REDUCED_MOTION) {
    for (const p of tlParticles) {
      if (p.type !== 'sub') continue
      const n = tlLayoutNodes[p.nodeIdx]
      if (!n || n._phase === 'waiting') continue
      const pt = tlQuadBezierPoint(p.t, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
      const sprite = graphGlowSprites[p.tier] || graphParticleSprite
      if (sprite) {
        const sz = p.size * 4
        ctx.globalAlpha = p.alpha * 0.7
        ctx.globalCompositeOperation = 'lighter'
        ctx.drawImage(sprite, pt.x - sz / 2, pt.y - sz / 2, sz, sz)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
    }
  }

  // Burst rays and sparks
  if (!GRAPH_REDUCED_MOTION) {
    for (const burst of tlBursts) {
      const elapsed = wallNow - burst.startWall
      // Rays (600ms)
      if (elapsed < 600) {
        const prog = elapsed / 600
        const eased = 1 - Math.pow(1 - prog, 2)
        ctx.globalCompositeOperation = 'lighter'
        for (const ray of burst.rays) {
          const curLen = ray.length * eased
          const curAlpha = ray.alpha * (1 - prog)
          ctx.beginPath()
          ctx.moveTo(burst.x, burst.y)
          ctx.lineTo(burst.x + Math.cos(ray.angle) * curLen, burst.y + Math.sin(ray.angle) * curLen)
          ctx.strokeStyle = burst.glowColor
          ctx.lineWidth = 1.1
          ctx.globalAlpha = curAlpha
          ctx.stroke()
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
      // Sparks (700ms)
      if (elapsed < 700) {
        ctx.globalCompositeOperation = 'lighter'
        for (const sp of burst.sparks) {
          const life = 700
          const t = sp.elapsed / life
          if (t >= 1) continue
          const alpha = Math.pow(1 - t, 2)
          const sprite = graphParticleSprite
          if (sprite) {
            const sz = sp.size * 4
            ctx.globalAlpha = alpha * 0.8
            ctx.drawImage(sprite, sp.x - sz / 2, sp.y - sz / 2, sz, sz)
          }
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
    }
  }
}

// === Mode toggle logic ===

const graphModeToggle = document.getElementById('graphModeToggle')
if (graphModeToggle) {
  graphModeToggle.addEventListener('click', (e) => {
    const seg = e.target.closest('.mode-seg')
    if (!seg) return
    const newMode = seg.dataset.mode
    if (newMode === tlMode) return
    switchGraphMode(newMode)
  })
}

function switchGraphMode(newMode) {
  const crossfade = document.getElementById('graphCrossfade')
  const scrubber = document.getElementById('tlScrubber')
  const feed = document.getElementById('tlEventFeed')
  const limitBar = document.getElementById('graphLimitBar')

  function applyModeSwitch() {
    tlMode = newMode
    document.querySelectorAll('.mode-seg').forEach(s => {
      s.classList.toggle('active', s.dataset.mode === newMode)
    })
    // Controls hint is strukt-only (Drag/Dbl-click don't apply in timeline)
    const hint = document.querySelector('.graph-controls-hint')
    if (hint) hint.hidden = newMode === 'timeline'
    if (newMode === 'timeline') {
      stopGraphSimulation()
      if (scrubber) scrubber.hidden = false
      if (feed) feed.hidden = false
      if (limitBar) limitBar.hidden = true
      loadTimeline()
    } else {
      stopTimelineLoop()
      if (scrubber) scrubber.hidden = true
      if (feed) feed.hidden = true
      if (limitBar) limitBar.hidden = false
      loadMemoryGraph()
    }
  }

  if (crossfade) {
    crossfade.classList.add('fading')
    setTimeout(() => {
      applyModeSwitch()
      setTimeout(() => { crossfade.classList.remove('fading') }, 130)
    }, 120)
  } else {
    applyModeSwitch()
  }
}

// === Scrubber play/pause ===
document.getElementById('tlPlayBtn')?.addEventListener('click', () => {
  if (tlSimTime >= tlT1 && !tlPlaying) {
    // Replay from start
    tlSimTime = tlT0
    tlRebuildAtTime(tlT0)
  }
  tlPlaying = !tlPlaying
  tlLastWall = performance.now()
  updatePlayBtn()
})

document.getElementById('tlRecordBtn')?.addEventListener('click', () => {
  tlStartRecording()
})

// === Scrubber drag and click ===
;(function () {
  const track = document.getElementById('tlTrack')
  const knob = document.getElementById('tlKnob')
  if (!track || !knob) return

  function scrubToX(clientX) {
    const rect = track.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const span = Math.max(1, tlT1 - tlT0)
    tlSimTime = tlT0 + frac * span
    tlRebuildAtTime(tlSimTime)
    updateScrubber()
  }

  track.addEventListener('mousedown', (e) => {
    tlScrubDragging = true
    tlScrubWasPlaying = tlPlaying
    tlPlaying = false
    updatePlayBtn()
    scrubToX(e.clientX)
  })
  knob.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    tlScrubDragging = true
    tlScrubWasPlaying = tlPlaying
    tlPlaying = false
    updatePlayBtn()
  })
  document.addEventListener('mousemove', (e) => {
    if (!tlScrubDragging) return
    scrubToX(e.clientX)
  })
  document.addEventListener('mouseup', () => {
    if (!tlScrubDragging) return
    tlScrubDragging = false
    if (tlScrubWasPlaying) {
      tlPlaying = true
      tlLastWall = performance.now()
      updatePlayBtn()
    }
  })
})()

// === Keyboard shortcuts (Space, arrows) when graph view focused ===
document.getElementById('memGraphView')?.addEventListener('keydown', (e) => {
  if (tlMode !== 'timeline') return
  if (e.code === 'Space') {
    e.preventDefault()
    document.getElementById('tlPlayBtn')?.click()
  } else if (e.code === 'ArrowRight') {
    e.preventDefault()
    const days = e.shiftKey ? 7 : 1
    tlSimTime = Math.min(tlT1, tlSimTime + days * 86400)
    tlRebuildAtTime(tlSimTime)
    updateScrubber()
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault()
    const days = e.shiftKey ? 7 : 1
    tlSimTime = Math.max(tlT0, tlSimTime - days * 86400)
    tlRebuildAtTime(tlSimTime)
    updateScrubber()
  }
}, { passive: false })

// Make the graph view focusable for keyboard events
document.getElementById('memGraphView')?.setAttribute('tabindex', '0')
