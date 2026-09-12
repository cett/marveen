// Fleet-audit "Teljes audit trail" page.
//
// Merges two backend sources through the existing GET /api/audit-log endpoint
// (src/web/routes/audit-log.ts -> queryAuditLog in src/db.ts):
//   - 'agent'  -- agent_audit_log (memory/message/blackboard/approval writes,
//                 written best-effort by writeAgentAuditLog() at the write site)
//   - 'hook'   -- hook_audit_log (PreToolUse/PostToolUse/PreCompact/Stop verdicts)
// Both sources already share one merged, time-sorted shape server-side; this
// module is display-only. Server-side offset pagination (shared
// web/modules/paginator.js component) replaces the old hard 200-row cutoff,
// which used to silently hide everything older than the newest 200 entries.

import { escapeHtml } from './util.js'
import { renderPaginator } from './paginator.js'

const AUDIT_LOG_LIMIT = 200
const AUDIT_LOG_EXPORT_LIMIT = 10000

const _state = { agent: '', q: '', offset: 0 }
let _lastEntries = []

// .modal-overlay is opacity:0/visibility:hidden by default (modal.css) and
// only becomes visible via the .active class -- [hidden] alone toggles
// display:none/block but never restores visibility. Both must be set.
function openModal(id) { const m = document.getElementById(id); if (m) { m.hidden = false; m.classList.add('active') } }
function closeModal(id) { const m = document.getElementById(id); if (m) { m.classList.remove('active'); m.hidden = true } }

// [data-close] delegation for this module's own modal.
document.addEventListener('click', (e) => {
  const closeId = e.target.closest('[data-close]')?.dataset.close
  if (closeId) closeModal(closeId)
})

// Row click -> detail modal, delegated so it survives table re-renders.
document.addEventListener('click', (e) => {
  const row = e.target.closest('#auditLogTbody tr[data-entry-idx]')
  if (row) openAuditLogDetail(Number(row.dataset.entryIdx))
})

function openAuditLogDetail(idx) {
  const entry = _lastEntries[idx]
  if (!entry) return
  const titleEl = document.getElementById('auditLogDetailModalTitle')
  const bodyEl = document.getElementById('auditLogDetailBody')
  if (!titleEl || !bodyEl) return
  const label = entry.source === 'hook' ? `Hook -- ${entry.hook_type ?? ''}` : `${entry.agent_id ?? ''} -- ${entry.action ?? ''}`
  titleEl.textContent = label
  bodyEl.textContent = JSON.stringify(entry, null, 2)
  openModal('auditLogDetailModal')
}

async function exportAuditLog() {
  const sources = []
  if (document.getElementById('auditLogSourceAgent')?.checked) sources.push('agent')
  if (document.getElementById('auditLogSourceHook')?.checked) sources.push('hook')
  if (sources.length === 0) return

  const params = new URLSearchParams({ source: sources.join(','), limit: String(AUDIT_LOG_EXPORT_LIMIT), offset: '0' })
  if (_state.agent) params.set('agent', _state.agent)
  if (_state.q) params.set('q', _state.q)

  const btn = document.getElementById('auditLogExportBtn')
  if (btn) btn.disabled = true
  try {
    const res = await fetch(`/api/audit-log?${params.toString()}`)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data.entries ?? [], null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-log-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (_err) {
    // Export failure is non-critical (the table itself already shows the error state).
  } finally {
    if (btn) btn.disabled = false
  }
}

export function initAuditLog() {
  document.getElementById('auditLogRefreshBtn')?.addEventListener('click', () => { _state.offset = 0; loadAuditLogPage() })
  document.getElementById('auditLogExportBtn')?.addEventListener('click', () => { exportAuditLog() })
  document.getElementById('auditLogSourceAgent')?.addEventListener('change', () => { _state.offset = 0; loadAuditLogPage() })
  document.getElementById('auditLogSourceHook')?.addEventListener('change', () => { _state.offset = 0; loadAuditLogPage() })

  const agentInput = document.getElementById('auditLogFilterAgent')
  const qInput = document.getElementById('auditLogFilterQuery')
  let debounceHandle = null
  const debouncedReload = () => {
    clearTimeout(debounceHandle)
    debounceHandle = setTimeout(() => {
      _state.agent = agentInput?.value.trim() ?? ''
      _state.q = qInput?.value.trim() ?? ''
      _state.offset = 0
      loadAuditLogPage()
    }, 300)
  }
  agentInput?.addEventListener('input', debouncedReload)
  qInput?.addEventListener('input', debouncedReload)
}

export async function loadAuditLogPage() {
  const tbody = document.getElementById('auditLogTbody')
  if (!tbody) return
  tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);padding:24px;text-align:center">Betöltés...</td></tr>`

  const sources = []
  if (document.getElementById('auditLogSourceAgent')?.checked) sources.push('agent')
  if (document.getElementById('auditLogSourceHook')?.checked) sources.push('hook')
  if (sources.length === 0) {
    document.getElementById('auditLogPagination')?.replaceChildren()
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);padding:24px;text-align:center">Válassz legalább egy forrást.</td></tr>`
    return
  }

  const params = new URLSearchParams({ source: sources.join(','), limit: String(AUDIT_LOG_LIMIT), offset: String(_state.offset) })
  if (_state.agent) params.set('agent', _state.agent)
  if (_state.q) params.set('q', _state.q)

  try {
    const res = await fetch(`/api/audit-log?${params.toString()}`)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    _renderAuditLogTable(data.entries ?? [])
    renderPaginator(document.getElementById('auditLogPagination'), {
      offset: _state.offset,
      limit: AUDIT_LOG_LIMIT,
      total: data.total ?? (data.entries?.length ?? 0),
      onPrev: () => { _state.offset = Math.max(0, _state.offset - AUDIT_LOG_LIMIT); loadAuditLogPage() },
      onNext: () => { _state.offset += AUDIT_LOG_LIMIT; loadAuditLogPage() },
    })
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);padding:24px;text-align:center">Nem sikerült betölteni az audit trailt.</td></tr>`
  }
}

function _formatTime(createdAt) {
  if (!createdAt) return ''
  return new Date(createdAt * 1000).toLocaleString('hu-HU')
}

function _sourceLabel(source) {
  return source === 'hook' ? 'Hook' : 'Ügynök'
}

function _entityCell(entry) {
  if (entry.source === 'hook') return escapeHtml(entry.hook_type ?? '')
  return escapeHtml(entry.entity ?? '')
}

function _actionCell(entry) {
  if (entry.source === 'hook') {
    const verdictColor = entry.verdict === 'deny' ? 'var(--danger)' : entry.verdict === 'defer' ? 'var(--warning)' : 'var(--success)'
    return `<span style="color:${verdictColor}">${escapeHtml(entry.verdict ?? '')}</span>`
  }
  return escapeHtml(entry.action ?? '')
}

function _detailCell(entry) {
  if (entry.source === 'hook') {
    const parts = []
    if (entry.tool_name) parts.push(entry.tool_name)
    if (entry.reason) parts.push(entry.reason)
    if (entry.session_id) parts.push(`session:${entry.session_id}`)
    return escapeHtml(parts.join(' -- '))
  }
  let detail = null
  if (entry.detail) {
    try { detail = JSON.parse(entry.detail) } catch { detail = null }
  }
  const parts = []
  if (entry.entity_id) parts.push(`#${entry.entity_id}`)
  if (detail && typeof detail === 'object') {
    for (const [k, v] of Object.entries(detail)) {
      if (v === null || v === undefined || v === '') continue
      parts.push(`${k}=${v}`)
    }
  }
  return escapeHtml(parts.join(' -- '))
}

function _renderAuditLogTable(entries) {
  const tbody = document.getElementById('auditLogTbody')
  if (!tbody) return
  _lastEntries = entries
  if (entries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);padding:24px;text-align:center">Nincs találat.</td></tr>`
    return
  }
  tbody.innerHTML = entries.map((entry, idx) => `
    <tr data-entry-idx="${idx}" class="audit-log-row-clickable" title="Kattints a részletekért">
      <td>${_formatTime(entry.created_at)}</td>
      <td>${_sourceLabel(entry.source)}</td>
      <td>${escapeHtml(entry.agent_id ?? '')}</td>
      <td>${_entityCell(entry)}</td>
      <td>${_actionCell(entry)}</td>
      <td>${_detailCell(entry)}</td>
    </tr>
  `).join('')
}
