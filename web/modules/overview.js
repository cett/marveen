import { escapeHtml } from './util.js'
import { t } from './i18n.js'
import { initTenantSelector } from './tenant-selector.js'


// ============================================================
// === Overview page ===
// ============================================================

let _ovLoadGen = 0
let _ovActiveAgentFilter = null
let _bbPollTimer = null
let _ovTenantGetter = null
let _ovInited = false

async function _ensureOverviewInited() {
  if (_ovInited) return
  _ovInited = true
  _ovTenantGetter = await initTenantSelector('overviewTenantSelectorContainer', () => loadOverview())
}

function formatRelative(ts) {
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('common.time.now_abbr')
  if (min < 60) return t('common.time.min_abbr', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('common.time.hour_abbr', { h: hr })
  const day = Math.floor(hr / 24)
  return t('common.time.day_abbr', { n: day })
}

// Forward-looking duration, reusing the same abbreviations formatRelative uses
// so the strip does not invent a second time vocabulary.
function formatDurationShort(sec) {
  if (sec < 60) return t('common.time.min_abbr', { n: 1 })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('common.time.min_abbr', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('common.time.hour_abbr', { h: hr })
  return t('common.time.day_abbr', { n: Math.floor(hr / 24) })
}

// Same thresholds as scripts/statusline-ratelimit.sh's own rl_pct() convention:
// >=80 danger, >=60 caution. The dashboard palette has no yellow token, so the
// accent stands in for it rather than adding a global token for one strip.
function quotaLevelClass(pct) {
  if (pct >= 80) return 'danger'
  if (pct >= 60) return 'warn'
  return ''
}

// Render the subscription quota strip from /api/overview's admin-only `quota`
// field. Fleet-level data (there is one shared quota pool, not one per
// tenant) -- a non-admin response never carries `quota` at all, and this
// function hides the strip outright rather than falling back to upstream's
// "still show a quiet missing-data note" behaviour, which would otherwise
// leak the mere existence of a fleet quota to a non-admin viewer.
function renderQuotaStrip(isAdminView, q) {
  const strip = document.getElementById('quotaStrip')
  if (!strip) return
  if (!isAdminView) { strip.hidden = true; return }
  const bars = document.getElementById('quotaBars')
  const note = document.getElementById('quotaStripNote')
  const age = document.getElementById('quotaStripAge')
  if (!bars || !note || !age) return
  strip.hidden = false
  bars.innerHTML = ''
  note.hidden = true
  note.className = 'quota-strip-note'
  age.textContent = ''

  if (!q || q.status === 'missing') {
    const reason = q && q.reason ? q.reason : 'no-file'
    note.textContent = t('overview.quota.none.' + reason.replace(/-/g, '_'))
    note.hidden = false
    return
  }

  const stale = q.status === 'stale'
  const nowSec = Math.floor(Date.now() / 1000)
  const windows = [
    ['overview.quota.five_hour', q.fiveHour],
    ['overview.quota.seven_day', q.sevenDay],
  ]
  for (const [labelKey, w] of windows) {
    if (!w) continue
    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercentage)))
    const muted = stale || w.expired
    const row = document.createElement('div')
    row.className = 'quota-bar' + (muted ? ' muted' : '')
    let tail = ''
    if (w.expired) {
      tail = ' · ' + t('overview.quota.expired')
    } else if (typeof w.resetsAt === 'number' && w.resetsAt > nowSec) {
      tail = ' · ' + t('overview.quota.resets_in', { d: formatDurationShort(w.resetsAt - nowSec) })
    }
    row.innerHTML = `
      <div class="quota-bar-label">${escapeHtml(t(labelKey))}</div>
      <div class="quota-bar-track"><div class="quota-bar-fill ${muted ? '' : quotaLevelClass(pct)}" style="width:${pct}%"></div></div>
      <div class="quota-bar-value">${pct}%<span class="quota-bar-reset">${escapeHtml(tail)}</span></div>
    `
    bars.appendChild(row)
  }

  if (typeof q.ageSec === 'number') {
    age.textContent = t('overview.quota.measured', { age: formatRelative(Date.now() - q.ageSec * 1000) })
  }
  if (stale) {
    note.textContent = t('overview.quota.stale')
    note.className = 'quota-strip-note warn'
    note.hidden = false
  }
}

function fmtTokensShort(n) {
  if (!n || n === 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'M'
  if (n >= 1_000) return Math.round(n / 1000) + 'k'
  return String(n)
}

function ovActivityIcon(type) {
  if (type === 'delegate') return '\u{1F4AC}'
  if (type === 'approval') return '\u{2705}'
  return '\u{1F4A1}'
}

function _ovRenderActivityFeed() {
  const feed = document.getElementById('ovActivityFeed')
  if (!feed) return
  feed.querySelectorAll('.ov-activity-row').forEach(r => {
    r.hidden = _ovActiveAgentFilter !== null && r.dataset.agent !== _ovActiveAgentFilter
  })
}

export async function loadOverview() {
  await _ensureOverviewInited()
  const gen = ++_ovLoadGen
  try {
    const tenant = _ovTenantGetter?.()
    const res = await fetch(tenant ? `/api/overview?tenant=${encodeURIComponent(tenant)}` : '/api/overview')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    if (gen !== _ovLoadGen) return
    const d = await res.json()

    // === Zone 1: shared health counters (admin-only fields, feed the Attention panel) ===
    const isAdminView = 'agents' in d
    const pendingApprovals = d.pendingApprovals || 0
    const errors4h = d.errors4h || 0
    const unread = d.unreadMessages || 0
    const stuck = d.stuckTasks || 0

    // === Zone 2: Attention Required ===
    const attSection = document.getElementById('attentionSection')
    const attBody = document.getElementById('attentionBody')
    const attBadge = document.getElementById('attentionBadge')
    const attItems = []

    if (isAdminView && pendingApprovals > 0) attItems.push({ icon: '⏳', text: pendingApprovals + ' üggő jóváhagyás vár', href: '#approvals', label: 'Megnyitás' })
    if (unread > 0) attItems.push({ icon: '\u{1F4AC}', text: unread + ' kézbesítetlen inter-agent üzenet', href: '#messages', label: 'Üzenetek' })
    if (isAdminView && stuck > 0) attItems.push({ icon: '⏰', text: stuck + ' ütemezett feladat elakadt', href: '#tasks', label: 'Feladatok' })
    if (isAdminView && errors4h > 0) attItems.push({ icon: '⚠', text: errors4h + ' hiba az elmúlt 4 órában', href: '#status', label: 'Státusz' })
    const stoppedAgents = isAdminView ? (d.agents.list || []).filter(function(a) { return !a.running && a.role !== 'main' }) : []
    if (stoppedAgents.length > 0) attItems.push({ icon: '\u{1F534}', text: stoppedAgents.length + ' ágens nem fut (' + stoppedAgents.map(function(a) { return a.label }).join(', ') + ')', href: '#agents', label: 'Ágensek' })

    if (attItems.length > 0) {
      attSection.hidden = false
      attBadge.textContent = attItems.length
      attBody.innerHTML = attItems.map(function(item) {
        return '<div class="attention-item"><span>' + escapeHtml(item.icon) + '</span><span>' + escapeHtml(item.text) + '</span><a href="' + escapeHtml(item.href) + '">' + escapeHtml(item.label) + '</a></div>'
      }).join('')
      const toggle = document.getElementById('attentionToggle')
      const header = document.getElementById('attentionHeader')
      header.onclick = function() {
        const collapsed = attBody.classList.toggle('collapsed')
        toggle.classList.toggle('collapsed', collapsed)
      }
    } else {
      attSection.hidden = true
    }

    // === Zone 3: Compact agents grid (admin-only) ===
    const grid = document.getElementById('agentsMiniGrid')
    if (grid) grid.hidden = !isAdminView
    if (grid && isAdminView && d.agents.list) {
      grid.innerHTML = ''
      for (const a of d.agents.list) {
        const card = document.createElement('div')
        card.className = 'agent-mini-card ' + (a.running ? 'running' : 'stopped')
        card.title = a.running ? 'Fut' : 'Nem fut'
        card.onclick = function() { location.hash = 'agents' }
        const lastActiveMs = a.lastActive ? a.lastActive * 1000 : null
        const lastActiveText = lastActiveMs ? formatRelative(lastActiveMs) : (a.running ? 'fut' : 'inaktív')
        card.innerHTML = '<div class="agent-mini-avatar"><img src="' + escapeHtml(a.avatarUrl) + '" alt="" onerror="this.style.display=\'none\'"></div>'
          + '<div class="agent-mini-info">'
          + '<div class="agent-mini-name">' + escapeHtml(a.label) + '</div>'
          + '<div class="agent-mini-meta ' + (a.running ? '' : 'stopped') + '"><span class="dot"></span>' + (a.running ? 'fut' : 'áll') + ' &middot; ' + escapeHtml(lastActiveText) + '</div>'
          + '</div>'
        grid.appendChild(card)
      }
    }

    // === Zone 4: Activity feed with agent filter pills ===
    const feed = document.getElementById('ovActivityFeed')
    const pillsEl = document.getElementById('ovActivityPills')
    _ovActiveAgentFilter = null
    if (feed) {
      feed.innerHTML = ''
      if (!d.activity || d.activity.length === 0) {
        feed.innerHTML = '<div class="ov-activity-empty">Nincs aktivitás az elmúlt 4 órában.</div>'
      } else {
        const agentSet = new Set()
        for (const a of d.activity) if (a.agent) agentSet.add(a.agent)
        const agentList = Array.from(agentSet)

        if (pillsEl && agentList.length > 1) {
          pillsEl.innerHTML = ''
          const allPill = document.createElement('button')
          allPill.className = 'ov-pill active'
          allPill.textContent = 'Mind'
          allPill.onclick = function() {
            _ovActiveAgentFilter = null
            pillsEl.querySelectorAll('.ov-pill').forEach(function(p) { p.classList.remove('active') })
            allPill.classList.add('active')
            _ovRenderActivityFeed()
          }
          pillsEl.appendChild(allPill)
          for (const ag of agentList) {
            const pill = document.createElement('button')
            pill.className = 'ov-pill'
            pill.textContent = ag
            pill.onclick = function() {
              _ovActiveAgentFilter = ag
              pillsEl.querySelectorAll('.ov-pill').forEach(function(p) { p.classList.remove('active') })
              pill.classList.add('active')
              _ovRenderActivityFeed()
            }
            pillsEl.appendChild(pill)
          }
        } else if (pillsEl) {
          pillsEl.innerHTML = ''
        }

        for (const a of d.activity) {
          const row = document.createElement('div')
          row.className = 'ov-activity-row'
          row.dataset.agent = a.agent || ''
          row.innerHTML = '<span class="ov-activity-icon">' + ovActivityIcon(a.icon) + '</span>'
            + '<span class="ov-activity-agent">' + escapeHtml(a.agent || '') + '</span>'
            + '<span class="ov-activity-text" title="' + escapeHtml(a.text) + '">' + escapeHtml(a.text) + '</span>'
            + '<span class="ov-activity-time">' + formatRelative(a.at) + '</span>'
          feed.appendChild(row)
        }
      }
    }

    // === Zone 5: KPI strip ===
    // kpiMemories is tenant-scoped (always shown); fleet KPIs are admin-only.
    document.getElementById('kpiMemories').textContent = d.memories.count.toLocaleString('hu-HU').replace(/,/g, ' ')
    ;['kpiTasks', 'kpiCost', 'kpiArtifacts', 'kpiSkills', 'kpiTokens'].forEach(function(id) {
      const el = document.getElementById(id)
      if (el && el.closest('.kpi-item')) el.closest('.kpi-item').hidden = !isAdminView
    })
    if (isAdminView) {
      const taskDiff = d.tasksToday - d.tasksYesterday
      document.getElementById('kpiTasks').textContent = d.tasksToday
      const trendEl = document.getElementById('kpiTasksTrend')
      if (trendEl) {
        if (taskDiff > 0) { trendEl.textContent = '+' + taskDiff; trendEl.className = 'kpi-trend up' }
        else if (taskDiff < 0) { trendEl.textContent = String(taskDiff); trendEl.className = 'kpi-trend down' }
        else { trendEl.textContent = ''; trendEl.className = 'kpi-trend' }
      }
      document.getElementById('kpiCost').textContent = d.costTodayUsd > 0 ? '$' + d.costTodayUsd.toFixed(2) : '—'
      document.getElementById('kpiArtifacts').textContent = (d.artifacts?.count ?? 0).toLocaleString('hu-HU').replace(/,/g, ' ')
      document.getElementById('kpiSkills').textContent = d.skills.count
      document.getElementById('kpiTokens').textContent = fmtTokensShort(d.tokensToday)
    }
    renderQuotaStrip(isAdminView, d.quota)

  } catch (err) {
    const feed = document.getElementById('ovActivityFeed')
    if (feed) feed.innerHTML = '<div class="ov-activity-empty" style="color:var(--danger)">Hiba: ' + escapeHtml(String(err.message || err)) + '</div>'
  }

  // Start blackboard polling on first load; restart timer on every loadOverview call.
  if (_bbPollTimer) clearInterval(_bbPollTimer)
  loadBlackboard()
  _bbPollTimer = setInterval(loadBlackboard, 15000)
}

const BB_STATUS_LABEL = { active: 'aktív', done: 'kész', blocked: 'blokkolt', stale: 'elavult', assigned: 'kiosztva' }
const BB_STATUS_CLASS = { active: 'bb-active', done: 'bb-done', blocked: 'bb-blocked', stale: 'bb-stale', assigned: 'bb-assigned' }

// Signal A = forgot to update (orange ⚠), B = stuck/lost completion (red 🔴), AB = both.
const BB_SIGNAL_ICON  = { a: '⚠️', b: '🔴', ab: '🔴⚠️' }
const BB_SIGNAL_CLASS = { a: 'bb-signal-a', b: 'bb-signal-b', ab: 'bb-signal-ab' }

function bbSignalBadge(signal) {
  if (!signal) return ''
  const icon    = BB_SIGNAL_ICON[signal]  || ''
  const cls     = BB_SIGNAL_CLASS[signal] || ''
  const labelKey   = 'bb.signal.' + signal + '.label'
  const tooltipKey = 'bb.signal.' + signal + '.tooltip'
  return '<span class="bb-signal ' + cls + '" title="' + escapeHtml(t(tooltipKey)) + '">'
    + escapeHtml(icon + ' ' + t(labelKey))
    + '</span>'
}

async function loadBlackboard() {
  const tbody = document.getElementById('ovBlackboardBody')
  if (!tbody) return
  try {
    const res = await fetch('/api/blackboard')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const rows = await res.json()
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="ov-activity-empty">Nincs adat.</td></tr>'
      return
    }
    tbody.innerHTML = ''
    for (const r of rows) {
      const tr = document.createElement('tr')
      tr.classList.add('bb-row-clickable')
      tr.dataset.agentId = r.agent_id
      tr.title = t('bb.history.row_hint')
      const statusLabel = BB_STATUS_LABEL[r.status] || r.status
      const statusCls = BB_STATUS_CLASS[r.status] || ''
      const signalHtml = bbSignalBadge(r.signal)
      if (signalHtml) tr.classList.add('bb-row-flagged')
      tr.innerHTML = '<td class="bb-agent">' + escapeHtml(r.agent_id) + '</td>'
        + '<td><span class="bb-status ' + statusCls + '">' + escapeHtml(statusLabel) + '</span>'
        + (signalHtml ? ' ' + signalHtml : '') + '</td>'
        + '<td class="bb-summary">' + escapeHtml(r.summary) + '</td>'
        + '<td class="bb-ref">' + escapeHtml(r.task_ref || '') + '</td>'
        + '<td class="bb-time">' + formatRelative(r.updated_at * 1000) + '</td>'
      tbody.appendChild(tr)
    }
  } catch (_err) {
    tbody.innerHTML = '<tr><td colspan="5" class="ov-activity-empty" style="color:var(--danger)">Blackboard hiba.</td></tr>'
  }
}

// === Blackboard history modal ===
// .modal-overlay is opacity:0/visibility:hidden by default (modal.css) and
// only becomes visible via the .active class -- [hidden] alone toggles
// display:none/block but never restores visibility. Both must be set.
function bbOpenModal(id) { const m = document.getElementById(id); if (m) { m.hidden = false; m.classList.add('active') } }
function bbCloseModal(id) { const m = document.getElementById(id); if (m) { m.classList.remove('active'); m.hidden = true } }

document.addEventListener('click', (e) => {
  const closeId = e.target.closest('[data-close="bbHistoryModal"]')?.dataset.close
  if (closeId) bbCloseModal(closeId)
})

document.addEventListener('click', (e) => {
  const row = e.target.closest('#ovBlackboardBody tr[data-agent-id]')
  if (row) openBlackboardHistory(row.dataset.agentId)
})

async function openBlackboardHistory(agentId) {
  const titleEl = document.getElementById('bbHistoryModalTitle')
  const listEl = document.getElementById('bbHistoryList')
  if (!titleEl || !listEl) return
  titleEl.textContent = t('bb.history.title', { agent: agentId })
  listEl.innerHTML = '<div class="ov-activity-empty">' + escapeHtml(t('common.loading')) + '</div>'
  bbOpenModal('bbHistoryModal')
  try {
    const res = await fetch('/api/blackboard/history?agent_id=' + encodeURIComponent(agentId) + '&limit=30')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const rows = await res.json()
    if (!rows.length) {
      listEl.innerHTML = '<div class="ov-activity-empty">' + escapeHtml(t('bb.history.empty')) + '</div>'
      return
    }
    listEl.innerHTML = ''
    for (const r of rows) {
      const statusLabel = BB_STATUS_LABEL[r.status] || r.status
      const statusCls = BB_STATUS_CLASS[r.status] || ''
      const item = document.createElement('div')
      item.className = 'bb-history-item'
      item.innerHTML = '<div class="bb-history-item-head">'
        + '<span class="bb-status ' + statusCls + '">' + escapeHtml(statusLabel) + '</span>'
        + '<span class="bb-time">' + formatRelative(r.created_at * 1000) + '</span>'
        + '</div>'
        + '<div class="bb-summary">' + escapeHtml(r.summary) + '</div>'
        + (r.task_ref ? '<div class="bb-ref">' + escapeHtml(r.task_ref) + '</div>' : '')
      listEl.appendChild(item)
    }
  } catch (_err) {
    listEl.innerHTML = '<div class="ov-activity-empty" style="color:var(--danger)">' + escapeHtml(t('bb.history.error')) + '</div>'
  }
}
