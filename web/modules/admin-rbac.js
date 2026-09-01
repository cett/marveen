// RBAC admin UI (kanban 722-B): API tokens, partner-senders and skill
// grant/revoke management -- global admin only. All three are existing
// backend endpoints (tokens.ts, admin-b2b.ts, skills.ts) that previously had
// no UI. Entry is gated with rbac-client's can('admin:all'), consistent with
// the 722 Part A client gating (web/modules/rbac-client.js).

import { escapeHtml as esc } from './util.js'
import { showToast } from './toast.js'
import { can } from './rbac-client.js'

const $ = (id) => document.getElementById(id)

// .modal-overlay is opacity:0/visibility:hidden by default (modal.css) and
// only becomes visible via the .active class -- [hidden] alone toggles
// display:none/block but never restores visibility. Both must be set.
function openModal(id) { const m = $(id); if (m) { m.hidden = false; m.classList.add('active') } }
function closeModal(id) { const m = $(id); if (m) { m.classList.remove('active'); m.hidden = true } }

// [data-close] delegation for this module's own modals -- admin-b2b.js
// registers an equivalent listener, but only once that module has been
// lazy-loaded; a session that only ever visits the RBAC admin page must not
// depend on that.
document.addEventListener('click', (e) => {
  const closeId = e.target.closest('[data-close]')?.dataset.close
  if (closeId) closeModal(closeId)
})

function fmtDate(unixSeconds) {
  if (unixSeconds == null) return '—'
  return new Date(unixSeconds * 1000).toLocaleString('hu-HU')
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

let _activeTab = 'tokens'

function switchTab(tab) {
  _activeTab = tab
  document.querySelectorAll('#adminRbacTabs .admin-b2b-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })
  ;['tokens', 'partnerSenders', 'skillAccess'].forEach(p => {
    const panel = $('adminRbacPanel' + p.charAt(0).toUpperCase() + p.slice(1))
    if (panel) panel.hidden = p !== tab
  })
  if (tab === 'tokens') loadTokens()
  if (tab === 'partnerSenders') loadPartnerSenders()
  if (tab === 'skillAccess') loadSkillList()
}

// ── Shared: tenant list (for selects across all three tabs) ───────────────────

let _tenants = []

async function loadTenantsForRbac() {
  try {
    const r = await fetch('/api/admin/tenants?include_disabled=false')
    if (!r.ok) return
    const data = await r.json()
    _tenants = data.items ?? []
  } catch {}
}

function tenantOptions(selectedId) {
  return _tenants.map(t =>
    `<option value="${esc(t.id)}" ${t.id === selectedId ? 'selected' : ''}>${esc(t.display_name)} (${esc(t.id)})</option>`
  ).join('')
}

// ── Tokens ───────────────────────────────────────────────────────────────────

let _tokens = []

async function loadTokens() {
  const list = $('tokenList')
  if (!list) return
  list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Betöltés...</p>'
  try {
    const r = await fetch('/api/admin/tokens')
    if (!r.ok) throw new Error(r.status)
    _tokens = await r.json()
    renderTokenList()
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">Hiba: ${esc(String(err))}</p>`
  }
}

function renderTokenList() {
  const list = $('tokenList')
  if (!list) return
  if (!_tokens.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Nincs token.</p>'
    return
  }
  list.innerHTML = _tokens.map(tok => {
    const revoked = tok.revoked_at !== null
    return `
    <div class="admin-b2b-row ${revoked ? 'admin-b2b-row--disabled' : ''}">
      <div class="admin-b2b-row-main" style="flex-wrap:wrap;gap:6px">
        <span class="admin-b2b-row-name">${esc(tok.name)}</span>
        <span class="badge" data-variant="${tok.role === 'admin' ? 'info' : 'neutral'}">${esc(tok.role)}</span>
        <code class="admin-b2b-row-id">${esc(tok.tenant_id)}</code>
        <span class="admin-b2b-row-meta">Lejár: ${fmtDate(tok.expires_at)}</span>
        <span class="admin-b2b-row-meta">Utoljára használva: ${fmtDate(tok.last_used_at)}</span>
        ${revoked ? '<span class="badge" data-variant="neutral">visszavonva</span>' : ''}
      </div>
      <div class="admin-b2b-row-actions">
        <button class="btn" data-variant="secondary" data-size="compact" data-action="rotate-token" data-id="${tok.id}" data-name="${esc(tok.name)}" ${revoked ? 'disabled' : ''}>
          Rotálás
        </button>
        <button class="btn" data-variant="secondary" data-size="compact" data-action="revoke-token" data-id="${tok.id}" data-name="${esc(tok.name)}" ${revoked ? 'disabled' : ''} style="color:var(--danger)">
          Visszavonás
        </button>
      </div>
    </div>
  `}).join('')
}

function showTokenReveal(rawToken) {
  const input = $('tokenRevealInput')
  if (input) input.value = rawToken
  openModal('tokenRevealModal')
}

function wireTokenReveal() {
  $('tokenRevealInput')?.addEventListener('click', (e) => e.target.select())
  $('tokenRevealCopyBtn')?.addEventListener('click', () => {
    const input = $('tokenRevealInput')
    if (!input) return
    navigator.clipboard?.writeText(input.value).then(
      () => showToast('Vágólapra másolva'),
      () => { input.select() },
    )
  })
}

async function createToken() {
  const name = $('newTokenName')?.value.trim()
  const role = $('newTokenRole')?.value
  const tenantId = $('newTokenTenant')?.value.trim() || 'default'
  const expiresRaw = $('newTokenExpiresDays')?.value.trim()
  const expiresInDays = expiresRaw ? Number(expiresRaw) : undefined

  if (!name) { showToast('Név szükséges', 'error'); return }
  try {
    const r = await fetch('/api/admin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role, tenant_id: tenantId, expires_in_days: expiresInDays }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.hint || data.error)
    closeModal('tokenAddModal')
    if ($('newTokenName')) $('newTokenName').value = ''
    if ($('newTokenExpiresDays')) $('newTokenExpiresDays').value = ''
    showToast('Token létrehozva')
    showTokenReveal(data.token)
    await loadTokens()
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

async function rotateToken(id, name) {
  if (!confirm(`Biztosan rotálod a(z) "${name}" tokent? A régi azonnal érvénytelen lesz.`)) return
  try {
    const r = await fetch(`/api/admin/tokens/${id}/rotate`, { method: 'POST' })
    const data = await r.json()
    if (!r.ok) throw new Error(data.hint || data.error)
    showToast('Token rotálva')
    showTokenReveal(data.token)
    await loadTokens()
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

async function revokeToken(id, name) {
  if (!confirm(`Biztosan visszavonod a(z) "${name}" tokent?`)) return
  try {
    const r = await fetch(`/api/admin/tokens/${id}/revoke`, { method: 'DELETE' })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    showToast('Token visszavonva')
    await loadTokens()
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

// ── Partner Senders ───────────────────────────────────────────────────────────

let _partnerSenders = []

async function loadPartnerSenders(tenantFilter) {
  const list = $('partnerSenderList')
  if (!list) return
  list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Betöltés...</p>'
  try {
    const params = tenantFilter ? '?tenant_id=' + encodeURIComponent(tenantFilter) : ''
    const r = await fetch('/api/admin/partner-senders' + params)
    if (!r.ok) throw new Error(r.status)
    const data = await r.json()
    _partnerSenders = data.items ?? []
    renderPartnerSenderList()
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">Hiba: ${esc(String(err))}</p>`
  }
}

function renderPartnerSenderList() {
  const list = $('partnerSenderList')
  if (!list) return
  if (!_partnerSenders.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Nincs partner-küldő.</p>'
    return
  }
  list.innerHTML = _partnerSenders.map(s => `
    <div class="admin-b2b-row ${s.disabled_at ? 'admin-b2b-row--disabled' : ''}">
      <div class="admin-b2b-row-main" style="flex-wrap:wrap;gap:6px">
        <span class="admin-b2b-row-name">${esc(s.display_name || s.sender_id)}</span>
        <code class="admin-b2b-row-id">${esc(s.sender_id)}</code>
        <code class="admin-b2b-row-id">${esc(s.tenant_id)}</code>
        ${s.disabled_at ? '<span class="badge" data-variant="neutral">letiltva</span>' : ''}
      </div>
      <div class="admin-b2b-row-actions">
        <button class="btn" data-variant="secondary" data-size="compact" data-action="delete-partner-sender"
          data-sender-id="${esc(s.sender_id)}" data-tenant-id="${esc(s.tenant_id)}"
          ${s.disabled_at ? 'disabled' : ''} style="color:var(--danger)">
          Törlés
        </button>
      </div>
    </div>
  `).join('')
}

function populateNewPartnerSenderTenantSelect() {
  const sel = $('newPartnerSenderTenant')
  if (sel) sel.innerHTML = tenantOptions()
}

function populatePartnerSenderTenantFilter() {
  const sel = $('partnerSenderTenantFilter')
  if (!sel) return
  sel.innerHTML = '<option value="">Mind a tenantok</option>' + tenantOptions()
}

async function addPartnerSender() {
  const senderId = $('newPartnerSenderId')?.value.trim()
  const tenantId = $('newPartnerSenderTenant')?.value
  const displayName = $('newPartnerSenderDisplayName')?.value.trim() || ''
  if (!senderId || !tenantId) { showToast('Sender ID és tenant szükséges', 'error'); return }
  try {
    const r = await fetch('/api/admin/partner-senders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender_id: senderId, tenant_id: tenantId, display_name: displayName }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.hint || data.error)
    closeModal('partnerSenderAddModal')
    if ($('newPartnerSenderId')) $('newPartnerSenderId').value = ''
    if ($('newPartnerSenderDisplayName')) $('newPartnerSenderDisplayName').value = ''
    showToast('Partner-küldő létrehozva')
    await loadPartnerSenders($('partnerSenderTenantFilter')?.value || undefined)
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

async function deletePartnerSender(senderId, tenantId) {
  if (!confirm(`Biztosan törlöd a(z) "${senderId}" partner-küldőt (${tenantId})?`)) return
  try {
    const r = await fetch(`/api/admin/partner-senders/${encodeURIComponent(senderId)}?tenant_id=${encodeURIComponent(tenantId)}`, { method: 'DELETE' })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    showToast('Partner-küldő törölve')
    await loadPartnerSenders($('partnerSenderTenantFilter')?.value || undefined)
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

// ── Skill Access ───────────────────────────────────────────────────────────────

let _skills = []
let _selectedSkillId = null

async function loadSkillList() {
  const sel = $('skillAccessSkillSelect')
  if (!sel) return
  try {
    const r = await fetch('/api/skills/sql')
    if (!r.ok) throw new Error(r.status)
    const data = await r.json()
    _skills = data.skills ?? []
    const current = sel.value
    sel.innerHTML = '<option value="">-- Válassz skillt --</option>' + _skills.map(s =>
      `<option value="${esc(s.id)}" ${s.id === current ? 'selected' : ''}>${esc(s.name)} (${esc(s.tenant_id)}${s.is_global ? ', global' : ''})</option>`
    ).join('')
    if (current && _skills.some(s => s.id === current)) {
      _selectedSkillId = current
      await loadSkillAccess(current)
    }
  } catch (err) {
    showToast('Hiba a skill-lista betöltésekor: ' + err.message, 'error')
  }
}

async function loadSkillAccess(skillId) {
  _selectedSkillId = skillId
  const list = $('skillAccessList')
  const grantBtn = $('skillAccessGrantBtn')
  if (!list) return
  if (!skillId) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Válassz egy skillt a hozzáférések kezeléséhez.</p>'
    if (grantBtn) grantBtn.disabled = true
    return
  }
  if (grantBtn) grantBtn.disabled = false
  list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Betöltés...</p>'
  try {
    const r = await fetch(`/api/skills/sql/${encodeURIComponent(skillId)}/access`)
    if (!r.ok) throw new Error(r.status)
    const data = await r.json()
    renderSkillAccessList(data.access ?? [])
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">Hiba: ${esc(String(err))}</p>`
  }
}

function renderSkillAccessList(access) {
  const list = $('skillAccessList')
  if (!list) return
  if (!access.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Ez a skill egyetlen tenantnak sincs explicit megosztva.</p>'
    return
  }
  list.innerHTML = access.map(a => `
    <div class="admin-b2b-row">
      <div class="admin-b2b-row-main" style="flex-wrap:wrap;gap:6px">
        <code class="admin-b2b-row-id">${esc(a.tenant_id)}</code>
        <span class="admin-b2b-row-meta">Megosztva: ${fmtDate(a.granted_at)}</span>
        ${a.granted_by ? `<span class="admin-b2b-row-meta">${esc(a.granted_by)}</span>` : ''}
      </div>
      <div class="admin-b2b-row-actions">
        <button class="btn" data-variant="secondary" data-size="compact" data-action="revoke-skill-access" data-tenant-id="${esc(a.tenant_id)}" style="color:var(--danger)">
          Visszavonás
        </button>
      </div>
    </div>
  `).join('')
}

function populateSkillGrantTenantSelect() {
  const sel = $('skillGrantTenant')
  if (sel) sel.innerHTML = tenantOptions()
}

async function grantSkillAccess() {
  if (!_selectedSkillId) return
  const tenantId = $('skillGrantTenant')?.value
  if (!tenantId) { showToast('Tenant szükséges', 'error'); return }
  try {
    const r = await fetch(`/api/skills/sql/${encodeURIComponent(_selectedSkillId)}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId }),
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    closeModal('skillGrantModal')
    showToast('Hozzáférés megadva')
    await loadSkillAccess(_selectedSkillId)
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

async function revokeSkillAccessFor(tenantId) {
  if (!_selectedSkillId) return
  if (!confirm(`Biztosan visszavonod a(z) "${tenantId}" tenant hozzáférését ehhez a skillhez?`)) return
  try {
    const r = await fetch(`/api/skills/sql/${encodeURIComponent(_selectedSkillId)}/access/${encodeURIComponent(tenantId)}`, { method: 'DELETE' })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    showToast('Hozzáférés visszavonva')
    await loadSkillAccess(_selectedSkillId)
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

// ── Init & event delegation ───────────────────────────────────────────────────

let _inited = false

export async function initAdminRbac() {
  if (_inited) return
  _inited = true

  if (!(await can('admin:all'))) return

  const navLink = $('navAdminRbac')
  if (navLink) navLink.hidden = false

  $('adminRbacTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-b2b-tab')
    if (btn) switchTab(btn.dataset.tab)
  })

  // Tokens
  $('tokenAddBtn')?.addEventListener('click', () => openModal('tokenAddModal'))
  $('tokenAddConfirmBtn')?.addEventListener('click', createToken)
  $('tokenList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    if (btn.dataset.action === 'rotate-token') await rotateToken(Number(btn.dataset.id), btn.dataset.name)
    if (btn.dataset.action === 'revoke-token') await revokeToken(Number(btn.dataset.id), btn.dataset.name)
  })
  wireTokenReveal()

  // Partner senders
  $('partnerSenderAddBtn')?.addEventListener('click', () => openModal('partnerSenderAddModal'))
  $('partnerSenderAddConfirmBtn')?.addEventListener('click', addPartnerSender)
  $('partnerSenderTenantFilter')?.addEventListener('change', (e) => loadPartnerSenders(e.target.value || undefined))
  $('partnerSenderList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="delete-partner-sender"]')
    if (!btn) return
    await deletePartnerSender(btn.dataset.senderId, btn.dataset.tenantId)
  })

  // Skill access
  $('skillAccessSkillSelect')?.addEventListener('change', (e) => loadSkillAccess(e.target.value || null))
  $('skillAccessGrantBtn')?.addEventListener('click', () => {
    populateSkillGrantTenantSelect()
    openModal('skillGrantModal')
  })
  $('skillGrantConfirmBtn')?.addEventListener('click', grantSkillAccess)
  $('skillAccessList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="revoke-skill-access"]')
    if (!btn) return
    await revokeSkillAccessFor(btn.dataset.tenantId)
  })
}

export async function loadAdminRbac() {
  if (!(await can('admin:all'))) return
  await loadTenantsForRbac()
  populateNewPartnerSenderTenantSelect()
  populatePartnerSenderTenantFilter()
  if (_activeTab === 'tokens') await loadTokens()
  if (_activeTab === 'partnerSenders') await loadPartnerSenders()
  if (_activeTab === 'skillAccess') await loadSkillList()
}
