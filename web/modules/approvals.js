import { escapeHtml, escapeAttr } from './util.js'
import { t, getLang } from './i18n.js'
import { showToast } from './toast.js'
import { getErrorMessage } from './error-message.js'
import { initTenantSelector } from './tenant-selector.js'
import { renderPaginator } from './paginator.js'
import { can } from './rbac-client.js'
import { isHumanOnlyRow, isHumanOnlyEnforced, isLockedForViewer, shouldShowHumanOnlyBanner } from './approval-human-only.js'
import { truncateDescription, shortHash, parseEmailPayload, approvalStateBadges, renderBadges, renderEmailPayload, renderTimeline } from './approval-email-view.js'



// ============================================================
// === Approvals ===
// ============================================================

const APPROVALS_PAGE_LIMIT = 25

let _approvalsCountdownInterval = null
const _approvalsState = { status: '', agent: '', category: '', offset: 0 }
let _approvalsPage = []
let _approvalsTenantGetter = null
// Who the viewer is, and whether the server enforces the human-only rule, from /api/auth/status (null
// when the probe failed). Decides which human-only rows would be a dead approve/reject button, but only
// while the rule is enforced; with it off (or unknown) nothing is locked. The server still refuses any
// non-session caller when it enforces.
let _viewerStatus = null
// Whether this role may decide a request (approvals:write). read_only and viewer only look at approvals, so
// they get no approve/reject buttons; the server refuses their PATCH with a 403 either way.
let _canDecide = true
// The use window in seconds, as the server reports it with the list (null until a list arrived, or
// when the server is older than the field): an approved, unused request older than this is lapsed.
let _consumeWindowS = null

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
// Ignores clicks that land on the approve/reject action buttons.
document.addEventListener('click', (e) => {
  if (e.target.closest('.approvals-decide')) return
  const row = e.target.closest('#approvalsTbody tr[data-approval-id]')
  if (row) openApprovalDetail(row.dataset.approvalId)
})

// Bumped on every open, so a journal answer that arrives after the modal moved on to another request
// (or was closed and reopened) is dropped instead of painted over the wrong one.
let _approvalsDetailSeq = 0

function openApprovalDetail(id) {
  const a = _approvalsPage.find(x => x.id === id)
  if (!a) return
  const bodyEl = document.getElementById('approvalsDetailBody')
  if (!bodyEl) return
  const row = (label, value) => rawRow(label, escapeHtml(value ?? ''))
  const rawRow = (label, html) => `
    <div class="approvals-detail-row">
      <span class="approvals-detail-label">${escapeHtml(label)}</span>
      <span class="approvals-detail-value">${html}</span>
    </div>`
  const fmt = (sec) => (sec ? new Date(sec * 1000).toLocaleString(getLang() === 'en' ? 'en-GB' : 'hu-HU') : '')
  const humanOnlyBadge = isHumanOnlyRow(a)
    ? ` <span class="approvals-humanonly-badge" title="${escapeAttr(t('approvals.humanonly.badge_title'))}">${escapeHtml(t('approvals.humanonly.badge'))}</span>`
    : ''
  const fingerprint = shortHash(a.content_hash)
  const badges = renderBadges(approvalStateBadges(a, { windowS: _consumeWindowS }))
  const isEmail = a.category === 'email_send'
  const parts = [
    row(t('approvals.detail.id'), a.id),
    row(t('approvals.detail.agent'), a.agent_id),
    rawRow(t('approvals.detail.category'), `${escapeHtml(a.category)}${humanOnlyBadge}`),
    row(t('approvals.detail.status'), t('approvals.status.' + a.status) || a.status),
  ]
  if (badges) parts.push(rawRow(t('approvals.detail.markers'), badges))
  if (fingerprint) parts.push(rawRow(t('approvals.detail.hash'), `<code class="approvals-hash" title="${escapeAttr(a.content_hash)}">${escapeHtml(fingerprint)}</code>`))
  parts.push(
    row(t('approvals.detail.requested'), fmt(a.requested_at)),
    row(t('approvals.detail.timeout'), fmt(a.timeout_at)),
    row(t('approvals.detail.resolved_by'), a.resolved_by || ''),
    row(t('approvals.detail.resolved_at'), fmt(a.resolved_at)),
    row(t('approvals.detail.description'), a.action_description),
  )
  if (isEmail) parts.push(renderEmailPayload(parseEmailPayload(a.action_payload)))
  parts.push(
    `<div class="approvals-detail-section">${escapeHtml(t('approvals.event.title'))}</div>`,
    `<div id="approvalsEventsBody" class="approvals-detail-row"><span class="approvals-detail-value approvals-email-none">${escapeHtml(t('approvals.event.loading'))}</span></div>`,
  )
  bodyEl.innerHTML = parts.join('')
  openModal('approvalsDetailModal')
  _loadApprovalEvents(a.id, ++_approvalsDetailSeq)
}

// The journal of one request (consumed, refused, deduplicated, ...). The route answers 403 to an agent
// token and 404 to a login that may not see the row; both read as "not available to this login".
async function _loadApprovalEvents(id, seq) {
  const paint = (html) => {
    if (seq !== _approvalsDetailSeq) return
    const el = document.getElementById('approvalsEventsBody')
    if (el) el.innerHTML = html
  }
  const note = (key) => `<span class="approvals-detail-value approvals-email-none">${escapeHtml(t(key))}</span>`
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/events`)
    if (res.status === 403 || res.status === 404) return paint(note('approvals.event.forbidden'))
    if (!res.ok) return paint(note('approvals.event.error'))
    const data = await res.json()
    paint(renderTimeline(data?.items))
  } catch {
    paint(note('approvals.event.error'))
  }
}

// ============================================================
// === Sidebar badge polling (mirrors updates.js pollUpdatesBadge) ===
// Keeps the nav badge current on every tab, not just when the (lazy)
// Approvals page has actually been opened. limit=1 keeps the items payload
// minimal -- the count comes from the server-computed (tenant-scoped,
// filter-independent) `counts.pending`, not from the returned items.
// ============================================================
export async function pollApprovalsBadge() {
  try {
    const res = await fetch('/api/approvals?limit=1')
    if (!res.ok) return
    const data = await res.json()
    const badge = document.getElementById('approvalsPendingBadge')
    if (!badge) return
    const count = data.counts?.pending ?? 0
    badge.textContent = String(count)
    badge.hidden = count === 0
  } catch {}
}

export async function loadApprovalsPage() {
  _approvalsState.offset = 0
  await _loadApprovalsPageInternal()
}

async function _loadApprovalsPageInternal() {
  const tbody = document.getElementById('approvalsTbody')
  const statsEl = document.getElementById('approvalsStats')
  tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);padding:24px;text-align:center">${t('approvals.loading')}</td></tr>`
  statsEl.innerHTML = ''
  if (_approvalsCountdownInterval) { clearInterval(_approvalsCountdownInterval); _approvalsCountdownInterval = null }

  try {
    const { status, agent, category, offset } = _approvalsState
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (agent) params.set('agent', agent)
    if (category) params.set('category', category)
    const tenant = _approvalsTenantGetter?.()
    if (tenant) params.set('tenant', tenant)
    params.set('limit', String(APPROVALS_PAGE_LIMIT))
    params.set('offset', String(offset))

    const [res, viewer, canDecide] = await Promise.all([fetch(`/api/approvals?${params}`), _fetchViewerStatus(), can('approvals:write')])
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    _viewerStatus = viewer
    _canDecide = canDecide
    _approvalsPage = data.items ?? []
    _consumeWindowS = typeof data.window_s === 'number' ? data.window_s : null
    _renderApprovalsStats(data.counts ?? { pending: 0, approved: 0, rejected: 0, timeout: 0 }, data.oldest_pending ?? null)
    _renderApprovalsTable(data.total ?? _approvalsPage.length)
    _approvalsCountdownInterval = setInterval(_updateCountdowns, 1000)
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--danger);padding:24px;text-align:center">${t('approvals.error')}</td></tr>`
  }
}

// The probe goes out with the same credential as the decision does, so it describes the caller the
// server will see. A failure is "unknown viewer", which also means "rule not known to be enforced": the
// page then behaves as it did before the rule existed (badge only), and the server remains the gate.
async function _fetchViewerStatus() {
  try {
    const r = await fetch('/api/auth/status')
    return r.ok ? await r.json() : null
  } catch { return null }
}

function _renderHumanOnlyBanner() {
  const banner = document.getElementById('approvalsHumanOnlyBanner')
  if (banner) banner.hidden = !shouldShowHumanOnlyBanner(_approvalsPage, _viewerStatus, isHumanOnlyEnforced(_viewerStatus))
}

function _renderApprovalsStats(counts, oldestPending) {
  const statsEl = document.getElementById('approvalsStats')
  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-value" style="color:var(--warning)">${counts.pending}</div><div class="stat-label">${t('approvals.stat.pending')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--success)">${counts.approved}</div><div class="stat-label">${t('approvals.stat.approved')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--danger)">${counts.rejected}</div><div class="stat-label">${t('approvals.stat.rejected')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--text-muted)">${counts.timeout}</div><div class="stat-label">${t('approvals.stat.timeout')}</div></div>
  `

  // Sidebar badge: show pending count, hidden when zero
  const badge = document.getElementById('approvalsPendingBadge')
  if (badge) {
    badge.textContent = counts.pending
    badge.hidden = counts.pending === 0
  }

  // Pending notice banner above stat cards
  const banner = document.getElementById('approvalsPendingBanner')
  if (banner) {
    if (counts.pending === 0 || !oldestPending) {
      banner.hidden = true
    } else {
      const ageMin = Math.round((Date.now() / 1000 - oldestPending.requested_at) / 60)
      const timeoutMin = oldestPending.timeout_at ? Math.max(0, Math.round((oldestPending.timeout_at - Date.now() / 1000) / 60)) : null
      const timeoutPart = timeoutMin !== null ? ` ${t('approvals.banner.timeout', { n: timeoutMin })}` : ''
      banner.hidden = false
      banner.textContent = `${t('approvals.banner.notice', { n: counts.pending, age: ageMin, agent: oldestPending.agent_id, category: oldestPending.category })}${timeoutPart}`
    }
  }
}

function _renderApprovalsTable(total) {
  const page = _approvalsPage
  const tbody = document.getElementById('approvalsTbody')
  _renderHumanOnlyBanner()

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);padding:24px;text-align:center">${t('approvals.empty')}</td></tr>`
    _renderApprovalsPagination(total)
    return
  }

  tbody.innerHTML = page.map(a => {
    const isPending = a.status === 'pending'
    const rowStyle = isPending ? 'background:color-mix(in srgb, var(--warning) 8%, transparent)' : ''
    const time = a.requested_at ? new Date(a.requested_at * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' }) : '-'
    const badge = _approvalBadge(a.status)
    const countdown = isPending && a.timeout_at ? `<span class="approvals-countdown" data-timeout="${a.timeout_at}" id="cd-${a.id}"></span>` : (a.timeout_at ? '-' : '')
    // While the server enforces the rule, a human-only request this viewer cannot decide keeps its
    // buttons visible but disabled, with the reason as a tooltip (the banner above explains how to
    // sign in). With the rule off the buttons stay active.
    const locked = isLockedForViewer(a, _viewerStatus, isHumanOnlyEnforced(_viewerStatus))
    const lockAttrs = locked ? ` disabled title="${escapeAttr(t('approvals.humanonly.locked'))}"` : ''
    const humanOnlyBadge = isHumanOnlyRow(a)
      ? ` <span class="approvals-humanonly-badge" title="${escapeAttr(t('approvals.humanonly.badge_title'))}">${escapeHtml(t('approvals.humanonly.badge'))}</span>`
      : ''
    const stateBadges = renderBadges(approvalStateBadges(a, { compact: true, windowS: _consumeWindowS }))
    const actions = isPending && !_canDecide
      ? ''
      : isPending
      ? `<div style="display:flex;gap:4px">
           <button class="btn approvals-decide" data-variant="primary" data-size="compact" data-id="${escapeAttr(a.id)}" data-decision="approved" style="font-size:11px"${lockAttrs}>${t('approvals.btn.approve')}</button>
           <button class="btn approvals-decide" data-variant="danger" data-size="compact" data-id="${escapeAttr(a.id)}" data-decision="rejected" style="font-size:11px"${lockAttrs}>${t('approvals.btn.reject')}</button>
         </div>`
      : (() => {
          const resolvedBy = escapeHtml(a.resolved_by || '')
          if (!a.resolved_at) return `<span style="font-size:12px;color:var(--text-muted)">${resolvedBy}</span>`
          const resolvedDate = new Date(a.resolved_at * 1000)
          const requestedDate = a.requested_at ? new Date(a.requested_at * 1000) : null
          const sameDay = requestedDate && resolvedDate.toDateString() === requestedDate.toDateString()
          const resolvedStr = resolvedDate.toLocaleString('hu-HU', sameDay ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' })
          return `<span style="font-size:12px;color:var(--text-muted)">${resolvedBy}<br><span style="font-size:11px;opacity:0.7">${escapeHtml(resolvedStr)}</span></span>`
        })()
    return `<tr class="approvals-row-clickable" data-approval-id="${escapeAttr(a.id)}" title="${escapeAttr(t('approvals.row.hint'))}" style="${rowStyle}">
      <td style="white-space:nowrap;font-size:12px">${escapeHtml(time)}</td>
      <td><code style="font-size:12px">${escapeHtml(a.agent_id)}</code></td>
      <td style="font-size:12px">${escapeHtml(a.category)}${humanOnlyBadge}</td>
      <td style="max-width:280px;font-size:12px" title="${escapeAttr(a.action_description)}">${escapeHtml(truncateDescription(a.action_description, 80))}</td>
      <td>${badge}${stateBadges ? ` ${stateBadges}` : ''}</td>
      <td style="font-size:12px;white-space:nowrap">${countdown}</td>
      <td>${actions}</td>
    </tr>`
  }).join('')

  _updateCountdowns()
  _renderApprovalsPagination(total)

  tbody.querySelectorAll('.approvals-decide').forEach(btn => {
    btn.addEventListener('click', () => _resolveApproval(btn.dataset.id, btn.dataset.decision))
  })
}

function _approvalBadge(status) {
  const colors = { pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)', timeout: 'var(--text-muted)' }
  const color = colors[status] || 'var(--text-muted)'
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:color-mix(in srgb,${color} 15%,transparent);color:${color}">${t('approvals.status.' + status) || status}</span>`
}

function _updateCountdowns() {
  const now = Math.floor(Date.now() / 1000)
  document.querySelectorAll('.approvals-countdown[data-timeout]').forEach(el => {
    const timeout = parseInt(el.dataset.timeout, 10)
    const diff = timeout - now
    if (diff <= 0) {
      el.textContent = t('approvals.countdown.expired')
      el.style.color = 'var(--danger)'
    } else {
      const h = Math.floor(diff / 3600)
      const m = Math.floor((diff % 3600) / 60)
      const s = diff % 60
      el.textContent = h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
      el.style.color = diff < 300 ? 'var(--danger)' : 'var(--text-muted)'
    }
  })
}

function _renderApprovalsPagination(total) {
  renderPaginator(document.getElementById('approvalsPagination'), {
    offset: _approvalsState.offset,
    limit: APPROVALS_PAGE_LIMIT,
    total,
    onPrev: () => { _approvalsState.offset = Math.max(0, _approvalsState.offset - APPROVALS_PAGE_LIMIT); _loadApprovalsPageInternal() },
    onNext: () => { _approvalsState.offset += APPROVALS_PAGE_LIMIT; _loadApprovalsPageInternal() },
  })
}

async function _resolveApproval(id, decision) {
  try {
    const res = await fetch(`/api/approvals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: decision, resolved_by: 'dashboard' }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(t('approvals.toast.error', { msg: getErrorMessage(data, 'HTTP ' + res.status) })); return }
    showToast(t(decision === 'approved' ? 'approvals.toast.approved' : 'approvals.toast.rejected'))
    // Refetch rather than patch in-place: resolving changes the server-side
    // counts/oldest-pending banner and (if a status filter is active) may
    // remove this row from the current page entirely.
    await _loadApprovalsPageInternal()
  } catch (err) {
    showToast(t('approvals.toast.error', { msg: String(err.message || err) }))
  }
}

// Agent/category filters now hit the server (LIKE-filtered, per-page) instead
// of re-slicing an already-fetched array, so debounce keystrokes to avoid a
// DB round trip per character.
let _approvalsFilterDebounce = null
function _debouncedFilterReload() {
  clearTimeout(_approvalsFilterDebounce)
  _approvalsFilterDebounce = setTimeout(loadApprovalsPage, 300)
}

export async function initApprovals() {
  document.getElementById('refreshApprovalsBtn').addEventListener('click', loadApprovalsPage)
  document.getElementById('approvalsSignInBtn')?.addEventListener('click', () => window.showLoginOverlay?.())
  document.getElementById('approvalsFilterStatus').addEventListener('change', (e) => {
    _approvalsState.status = e.target.value
    loadApprovalsPage()
  })
  document.getElementById('approvalsFilterAgent').addEventListener('input', (e) => {
    _approvalsState.agent = e.target.value.trim()
    _debouncedFilterReload()
  })
  document.getElementById('approvalsFilterCategory').addEventListener('input', (e) => {
    _approvalsState.category = e.target.value.trim()
    _debouncedFilterReload()
  })
  _approvalsTenantGetter = await initTenantSelector('approvalsTenantSelectorContainer', () => loadApprovalsPage())
}
