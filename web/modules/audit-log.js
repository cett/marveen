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

const _state = { agent: '', q: '', offset: 0 }

export function initAuditLog() {
  document.getElementById('auditLogRefreshBtn')?.addEventListener('click', () => { _state.offset = 0; loadAuditLogPage() })
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
  if (entries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);padding:24px;text-align:center">Nincs találat.</td></tr>`
    return
  }
  tbody.innerHTML = entries.map(entry => `
    <tr>
      <td>${_formatTime(entry.created_at)}</td>
      <td>${_sourceLabel(entry.source)}</td>
      <td>${escapeHtml(entry.agent_id ?? '')}</td>
      <td>${_entityCell(entry)}</td>
      <td>${_actionCell(entry)}</td>
      <td>${_detailCell(entry)}</td>
    </tr>
  `).join('')
}
