import { escapeHtml } from './util.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'
import { getErrorMessage } from './error-message.js'
import { initTenantSelector } from './tenant-selector.js'

let _openModal = null, _closeModal = null

// null for non-admin (tenant selector hidden); set to a getter for global admins.
let _vaultTenantGetter = null
export function initVault({ openModal, closeModal } = {}) {
  _openModal = openModal; _closeModal = closeModal
  initTenantSelector('vaultTenantSelectorContainer', () => loadVaultPage())
    .then(getter => { _vaultTenantGetter = getter })
}

// --- Vault add-modal tenant select (admin only) ---
// A non-admin never sees this: the backend always resolves their own tenant
// server-side regardless of what (if anything) the client sends.
let _vaultAuthCache = null
async function _fetchVaultAuth() {
  if (_vaultAuthCache) return _vaultAuthCache
  try {
    const r = await fetch('/api/auth/status')
    if (r.ok) _vaultAuthCache = await r.json()
  } catch {}
  return _vaultAuthCache
}
function _isVaultAdmin(auth) {
  return auth?.role === 'admin' && auth?.tenant_id === null
}

let _vaultTenantList = []  // [{id, display_name}]
async function _ensureVaultTenantList() {
  if (_vaultTenantList.length > 0) return
  try {
    const r = await fetch('/api/admin/tenants')
    if (r.ok) _vaultTenantList = (await r.json()).items ?? []
  } catch {}
}

// Shows (and populates) the tenant <select> in an add-modal for a global
// admin; hides the row and returns false for everyone else. Default
// selection mirrors whatever the page-level tenant selector is currently
// scoped to, but the modal's own choice is what actually gets submitted.
async function _showVaultTenantRowIfAdmin(rowId, selectId) {
  const row = document.getElementById(rowId)
  if (!row) return false
  const auth = await _fetchVaultAuth()
  if (!_isVaultAdmin(auth)) { row.hidden = true; return false }
  await _ensureVaultTenantList()
  const sel = document.getElementById(selectId)
  if (sel) {
    const current = _vaultTenantGetter?.() || 'default'
    sel.innerHTML = _vaultTenantList.map(ten =>
      `<option value="${escapeHtml(ten.id)}"${ten.id === current ? ' selected' : ''}>${escapeHtml(ten.display_name ? `${ten.display_name} (${ten.id})` : ten.id)}</option>`
    ).join('')
  }
  row.hidden = false
  return true
}
// --- Vault management ---
export async function loadVault() {
  try {
    const res = await fetch('/api/vault')
    const data = await res.json()
    const secrets = data.secrets || []
    document.getElementById('vaultCount').textContent = String(secrets.length)
    const list = document.getElementById('vaultList')
    list.innerHTML = ''
    for (const s of secrets) {
      const item = document.createElement('div')
      item.className = 'connector-external-item'
      const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
      item.innerHTML = `<div class="github-repo-info"><span class="github-repo-name">${escapeHtml(s.label)}</span><span class="github-repo-date">${escapeHtml(s.id)} &middot; ${date}</span></div><button title="Torles" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:2px 6px">&times;</button>`
      item.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Torlod: ${s.label}?`)) return
        const res = await fetch(`/api/vault/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
        if (!res.ok) { showToast('Törlés sikertelen'); return }
        loadVault()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireVault() {
  const toggle = document.getElementById('vaultToggle')
  const body = document.getElementById('vaultBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('vaultAddBtn')
  const idInput = document.getElementById('vaultIdInput')
  const valInput = document.getElementById('vaultValueInput')
  addBtn.addEventListener('click', async () => {
    const id = idInput.value.trim()
    const val = valInput.value
    if (!id || !val) return
    const res = await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label: id, value: val }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      showToast('Mentés sikertelen: ' + getErrorMessage(e, String(res.status)))
      return
    }
    idInput.value = ''
    valInput.value = ''
    loadVault()
  })
  valInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

// --- SSH Vault ---
let _sshServers = []
let _sshKeys = []
let _sshView = 'table'
let _sshEditingId = null

async function loadSshServers() {
  try {
    const res = await fetch('/api/vault/ssh-servers' + vaultTenantQuery())
    const data = await res.json()
    _sshServers = data.servers || []
    renderSshServers()
  } catch { /* ignore */ }
}

async function loadSshKeys() {
  try {
    const res = await fetch('/api/vault/ssh-keys' + vaultTenantQuery())
    if (!res.ok) return
    const data = await res.json()
    _sshKeys = data.keys || []
    renderSshKeys()
    _refreshKeySelects()
  } catch { /* ignore */ }
}

function renderSshKeys() {
  const tbody = document.getElementById('sshKeysTableBody')
  const keysView = document.getElementById('sshKeysView')
  const emptyEl = document.getElementById('sshKeysEmpty')
  if (!tbody) return
  if (_sshKeys.length === 0) {
    keysView.hidden = true
    emptyEl.hidden = false
    return
  }
  keysView.hidden = false
  emptyEl.hidden = true
  tbody.innerHTML = _sshKeys.map(k => `
    <tr>
      <td class="ssh-table-name">${escapeHtml(k.label || k.id)}</td>
      <td class="ssh-table-mono">${escapeHtml(k.username || '')}</td>
      <td class="ssh-table-mono">${escapeHtml(k.keyType || 'ed25519')}</td>
      <td class="ssh-table-mono" style="font-size:11px">${k.fingerprint ? escapeHtml(k.fingerprint.slice(0,28)) + '…' : ''}</td>
      <td class="ssh-table-mono">${k.createdAt ? new Date(k.createdAt).toLocaleDateString('hu-HU') : ''}</td>
      <td><div class="ssh-table-actions">
        <button class="btn ssh-key-copy-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(k.id)}" title="Publikus kulcs másolása">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn ssh-key-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(k.id)}" title="Törlés">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </div></td>
    </tr>
  `).join('')
  tbody.querySelectorAll('.ssh-key-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = _sshKeys.find(k => k.id === btn.dataset.id)
      if (!key) return
      try {
        const res = await fetch(`/api/vault/ssh-keys/${encodeURIComponent(btn.dataset.id)}/public-key`)
        if (res.ok) {
          const data = await res.json()
          await navigator.clipboard.writeText(data.publicKey || '')
          btn.textContent = '✓'
          setTimeout(() => { btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' }, 1500)
        }
      } catch { /* ignore */ }
    })
  })
  tbody.querySelectorAll('.ssh-key-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Biztosan törlöd ezt a kulcsot?')) return
      await fetch(`/api/vault/ssh-keys/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' })
      await loadSshKeys()
    })
  })
}

function _refreshKeySelects() {
  const opts = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
  ].join('')
  document.querySelectorAll('.ssh-key-select').forEach(sel => {
    const prev = sel.value
    sel.innerHTML = opts
    sel.value = prev
  })
}

function _sshKeyBadge(status) {
  const labels = { ok: 'OK', missing: 'Hiányzó', expired: 'Lejárt' }
  const icons = {
    ok: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    missing: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    expired: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  }
  return `<span class="ssh-key-badge ${status}">${icons[status] || ''} ${labels[status] || status}</span>`
}

function _sshKeyAssignSelect(s) {
  const currentKeyId = s.sshKeyId || s.assignedKeyId || s.vaultKeyId || ''
  const opts = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => {
      const sel = (currentKeyId && currentKeyId === k.id) ? ' selected' : ''
      return `<option value="${escapeHtml(k.id)}"${sel}>${escapeHtml(k.label || k.id)}</option>`
    })
  ].join('')
  return `<select class="ssh-key-assign ssh-key-select" data-id="${escapeHtml(s.id)}" title="Kulcs hozzárendelése">${opts}</select>`
}

function _sshInfoBtn(s) {
  return `<button class="ssh-info-btn" data-id="${escapeHtml(s.id)}" data-user="${escapeHtml(s.user)}" title="Telepítési útmutató">i</button>`
}

function renderSshServers() {
  const cardsEl = document.getElementById('sshCardsView')
  const tableView = document.getElementById('sshTableView')
  const tableBody = document.getElementById('sshTableBody')
  const emptyEl = document.getElementById('sshEmpty')
  if (!cardsEl || !tableBody || !emptyEl) return

  // Sync view state with _sshView
  const isTable = _sshView === 'table'
  cardsEl.hidden = isTable
  if (tableView) tableView.hidden = !isTable
  document.getElementById('sshViewCards')?.classList.toggle('active', !isTable)
  document.getElementById('sshViewTable')?.classList.toggle('active', isTable)

  if (_sshServers.length === 0) {
    cardsEl.innerHTML = ''
    tableBody.innerHTML = ''
    emptyEl.hidden = false
    return
  }
  emptyEl.hidden = true

  // Cards
  cardsEl.innerHTML = _sshServers.map(s => `
    <div class="ssh-card" data-id="${escapeHtml(s.id)}">
      <div class="ssh-card-head">
        <div class="ssh-card-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
        </div>
        <div class="ssh-card-title">
          <div class="ssh-card-name">${escapeHtml(s.name)}</div>
          ${s.desc ? `<div class="ssh-card-desc">${escapeHtml(s.desc)}</div>` : ''}
        </div>
      </div>
      <div class="ssh-card-meta">
        <div class="ssh-card-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span>${escapeHtml(s.host)}</span>
        </div>
        <div class="ssh-card-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>${escapeHtml(s.user)}${s.port !== 22 ? ` :${s.port}` : ''}</span>
        </div>
        ${s.fingerprint ? `<div class="ssh-card-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>${escapeHtml(s.keyType || '')} ${escapeHtml(s.fingerprint.slice(0,24))}…</span></div>` : ''}
      </div>
      <div class="ssh-card-footer">
        <div style="display:flex;align-items:center;gap:4px;width:100%">
          ${_sshKeyAssignSelect(s)}
          <div class="ssh-card-actions">
            <button class="btn ssh-edit-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Szerkesztés">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn ssh-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Törlés">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `).join('')

  // Table
  tableBody.innerHTML = _sshServers.map(s => `
    <tr data-id="${escapeHtml(s.id)}">
      <td class="ssh-table-name">${escapeHtml(s.name)}</td>
      <td class="ssh-table-mono">${escapeHtml(s.host)}</td>
      <td class="ssh-table-mono">${escapeHtml(s.user)}</td>
      <td class="ssh-table-mono">${s.port}</td>
      <td>${_sshKeyAssignSelect(s)}</td>
      <td style="color:var(--text-muted)">${escapeHtml(s.desc || '')}</td>
      <td><div class="ssh-table-actions">
        <button class="btn ssh-edit-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Szerkesztés">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn ssh-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Törlés">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div></td>
    </tr>
  `).join('')

  // Delete handlers
  document.querySelectorAll('.ssh-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      if (!confirm(`Törlöd: ${id}?`)) return
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
        await loadSshServers()
      } catch { showToast('Törlés sikertelen') }
    })
  })

  // Edit handlers -- open the add-server panel pre-filled, switch it to edit mode
  document.querySelectorAll('.ssh-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')
      const server = _sshServers.find(s => s.id === id)
      if (!server) return
      _sshEditingId = id

      document.getElementById('sshNameInput').value = server.name || ''
      document.getElementById('sshHostInput').value = server.host || ''
      document.getElementById('sshUserInput').value = server.user || ''
      document.getElementById('sshPortInput').value = server.port || 22
      document.getElementById('sshDescInput').value = server.desc || ''
      const keySel = document.getElementById('sshKeySelectInput')
      if (keySel) keySel.value = server.sshKeyId || server.assignedKeyId || server.vaultKeyId || ''

      const titleEl = document.getElementById('sshAddPanelTitle')
      if (titleEl) titleEl.textContent = `Szerver szerkesztése – ${server.name}`

      // Editing never reassigns the server's tenant (the PUT handler doesn't
      // accept tenant_id) -- hide the selector so it isn't shown as editable.
      const tenantRow = document.getElementById('sshAddTenantRow')
      if (tenantRow) tenantRow.hidden = true

      const panel = document.getElementById('sshAddPanel')
      panel.hidden = false
      document.getElementById('sshNameInput').focus()
    })
  })

  // Key assign select handlers
  document.querySelectorAll('.ssh-key-assign').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.getAttribute('data-id')
      const sshKeyId = sel.value || null
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sshKeyId }),
        })
        await loadSshServers()
      } catch { /* ignore */ }
    })
  })

}

// --- SSH Keygen modal (standalone key creation for Kulcstároló) ---
let _sshKeygenCallback = null  // called with new key after successful generation

function openSshKeygenModal(callback) {
  const overlay = document.getElementById('sshKeygenOverlay')
  document.getElementById('sshKeygenLabelInput').value = ''
  document.getElementById('sshKeygenUserInput').value = ''
  document.getElementById('sshKeygenSpinner').hidden = true
  document.getElementById('sshKeygenResult').hidden = true
  document.getElementById('sshKeygenFooter').hidden = false
  document.getElementById('sshKeygenForm').hidden = false
  document.getElementById('sshKeygenPubkeyBox').value = ''
  _sshKeygenCallback = callback || null
  _showVaultTenantRowIfAdmin('sshKeygenTenantRow', 'sshKeygenTenantSelect')
  _openModal?.(overlay)
  document.getElementById('sshKeygenLabelInput').focus()
}

;(function wireSshKeygenModal() {
  const overlay = document.getElementById('sshKeygenOverlay')
  const closeBtn = document.getElementById('sshKeygenClose')
  const submitBtn = document.getElementById('sshKeygenSubmitBtn')
  const copyBtn = document.getElementById('sshKeygenCopyBtn')
  if (!overlay) return

  overlay.addEventListener('click', e => { if (e.target === overlay) _closeModal?.(overlay) })
  closeBtn.addEventListener('click', () => _closeModal?.(overlay))

  submitBtn.addEventListener('click', async () => {
    const label = document.getElementById('sshKeygenLabelInput').value.trim()
    const username = document.getElementById('sshKeygenUserInput').value.trim()
    if (!label || !username) { showToast('Cimke és felhasználónév megadása kötelező'); return }

    document.getElementById('sshKeygenForm').hidden = true
    document.getElementById('sshKeygenSpinner').hidden = false
    document.getElementById('sshKeygenResult').hidden = true
    document.getElementById('sshKeygenFooter').hidden = true

    try {
      const tenantRow = document.getElementById('sshKeygenTenantRow')
      const tenant_id = (tenantRow && !tenantRow.hidden)
        ? (document.getElementById('sshKeygenTenantSelect')?.value || undefined)
        : (_vaultTenantGetter?.() || undefined)
      const res = await fetch('/api/vault/ssh-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, username, tenant_id }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(getErrorMessage(data, 'Generálás sikertelen')); resetKeygenForm(); return }

      const pubkey = data.publicKey || (data.key && data.key.publicKey) || ''
      document.getElementById('sshKeygenPubkeyBox').value = pubkey
      document.getElementById('sshKeygenSpinner').hidden = true
      document.getElementById('sshKeygenResult').hidden = false

      await loadSshKeys()
      if (_sshKeygenCallback) _sshKeygenCallback(data.key || data)
    } catch { showToast('Hálózati hiba'); resetKeygenForm() }
  })

  copyBtn?.addEventListener('click', () => {
    const val = document.getElementById('sshKeygenPubkeyBox').value
    navigator.clipboard.writeText(val).then(() => {
      copyBtn.textContent = 'Másolva!'
      setTimeout(() => { copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Másolás' }, 2000)
    }).catch(() => {})
  })

  function resetKeygenForm() {
    document.getElementById('sshKeygenForm').hidden = false
    document.getElementById('sshKeygenSpinner').hidden = true
    document.getElementById('sshKeygenResult').hidden = true
    document.getElementById('sshKeygenFooter').hidden = false
  }
})()

// --- SSH Info modal ---
let _sshInfoServerId = null

async function _sshInfoLoadKey(keyId, serverUser) {
  const installSection = document.getElementById('sshInfoInstallSection')
  const noKeyEl = document.getElementById('sshInfoNoKey')
  if (!keyId) {
    installSection.hidden = true
    noKeyEl.hidden = false
    return
  }
  installSection.hidden = false
  noKeyEl.hidden = true

  let pubkey = ''
  try {
    const res = await fetch(`/api/vault/ssh-keys/${encodeURIComponent(keyId)}/public-key`)
    if (res.ok) { const d = await res.json(); pubkey = d.publicKey || '' }
  } catch {}

  const targetUser = serverUser || 'root'
  document.getElementById('sshInfoUser').textContent = targetUser

  // root always exists -- only show the "create user" step for a real,
  // non-root target user (e.g. a fresh server that needs the account first).
  const step0 = document.getElementById('sshInfoStep0')
  if (targetUser === 'root') {
    step0.hidden = true
  } else {
    step0.hidden = false
    document.getElementById('sshInfoCmd0').textContent = `useradd -m -s /bin/bash ${targetUser}`
  }

  const cmd2text = pubkey
    ? `echo "${pubkey}" >> ~/.ssh/authorized_keys`
    : `echo "<publikus kulcs ide>" >> ~/.ssh/authorized_keys`
  document.getElementById('sshInfoCmd2').textContent = cmd2text
  document.getElementById('sshInfoPubkey').textContent = pubkey || '(kulcs nem elérhető)'

  const overlay = document.getElementById('sshInfoOverlay')
  overlay.querySelectorAll('.ssh-code-copy').forEach(btn => {
    const clone = btn.cloneNode(true)
    btn.parentNode.replaceChild(clone, btn)
    clone.addEventListener('click', () => {
      const text = document.getElementById(clone.getAttribute('data-target'))?.textContent || ''
      navigator.clipboard.writeText(text).then(() => {
        clone.classList.add('copied')
        setTimeout(() => clone.classList.remove('copied'), 2000)
      }).catch(() => {})
    })
  })
}

function _sshInfoLoadServer(serverId) {
  _sshInfoServerId = serverId
  const server = _sshServers.find(s => s.id === serverId)

  document.getElementById('sshInfoServerName').textContent = server ? server.name : (serverId || '')

  const keySel = document.getElementById('sshInfoKeySelect')
  keySel.innerHTML = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
  ].join('')
  const assignedKeyId = (server && (server.sshKeyId || server.assignedKeyId || server.vaultKeyId)) || ''
  keySel.value = assignedKeyId
  return { server, assignedKeyId }
}

function openSshInfoModal(preselectedServerId, { keyOnly = false } = {}) {
  const overlay = document.getElementById('sshInfoOverlay')
  const serverSection = overlay.querySelector('.ssh-info-server-section')

  if (keyOnly) {
    // Key-only mode: hide server selector, reset server context
    serverSection.hidden = true
    _sshInfoServerId = null
    document.getElementById('sshInfoServerName').textContent = 'Új szerver'

    // Populate key selector without a pre-selected key
    const keySel = document.getElementById('sshInfoKeySelect')
    keySel.innerHTML = ['<option value="">-- Válassz kulcsot --</option>',
      ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
    ].join('')
    // Pre-select whatever is chosen in the form's key dropdown
    const formKeyId = document.getElementById('sshKeySelectInput')?.value || ''
    keySel.value = formKeyId

    // Use the username typed into the new-server form, not a hardcoded root
    const formUser = document.getElementById('sshUserInput')?.value.trim() || 'root'

    _openModal?.(overlay)
    _sshInfoLoadKey(formKeyId, formUser)
  } else {
    // Normal mode: show server selector, pick first server by default
    serverSection.hidden = false
    const serverSel = document.getElementById('sshInfoServerSelect')
    serverSel.innerHTML = ['<option value="">-- Válassz szervert --</option>',
      ..._sshServers.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.host)})</option>`)
    ].join('')

    const firstId = preselectedServerId || (_sshServers[0] && _sshServers[0].id) || ''
    serverSel.value = firstId

    const { server, assignedKeyId } = _sshInfoLoadServer(firstId)
    const targetUser = (server && server.user) || 'root'

    _openModal?.(overlay)
    _sshInfoLoadKey(assignedKeyId, targetUser)
  }
}

;(function wireSshInfoModal() {
  const overlay = document.getElementById('sshInfoOverlay')
  const closeBtn = document.getElementById('sshInfoClose')
  const serverSel = document.getElementById('sshInfoServerSelect')
  const keySel = document.getElementById('sshInfoKeySelect')
  if (!overlay) return

  overlay.addEventListener('click', e => { if (e.target === overlay) _closeModal?.(overlay) })
  closeBtn.addEventListener('click', () => _closeModal?.(overlay))

  serverSel?.addEventListener('change', () => {
    const { server, assignedKeyId } = _sshInfoLoadServer(serverSel.value)
    _sshInfoLoadKey(assignedKeyId, (server && server.user) || 'root')
  })

  keySel?.addEventListener('change', async () => {
    const keyId = keySel.value || null
    // Key-only mode (new-server flow) has no _sshInfoServerId -- read the
    // username from the new-server form instead of falling back to root.
    const targetUser = _sshInfoServerId
      ? ((_sshServers.find(s => s.id === _sshInfoServerId) || {}).user || 'root')
      : (document.getElementById('sshUserInput')?.value.trim() || 'root')

    if (_sshInfoServerId) {
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(_sshInfoServerId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sshKeyId: keyId }),
        })
        await loadSshServers()
      } catch { /* ignore */ }
    }
    await _sshInfoLoadKey(keyId, targetUser)
  })
})()

;(function wireSshSection() {
  const newBtn = document.getElementById('sshNewBtn')
  const panel = document.getElementById('sshAddPanel')
  const closeBtn = document.getElementById('sshAddPanelClose')
  const addBtn = document.getElementById('sshAddBtn')
  const cardViewBtn = document.getElementById('sshViewCards')
  const tableViewBtn = document.getElementById('sshViewTable')
  const cardsView = document.getElementById('sshCardsView')
  const tableView = document.getElementById('sshTableView')

  if (!newBtn) return

  function resetSshAddForm() {
    _sshEditingId = null
    const titleEl = document.getElementById('sshAddPanelTitle')
    if (titleEl) titleEl.textContent = 'Szerver hozzáadása'
    document.getElementById('sshNameInput').value = ''
    document.getElementById('sshHostInput').value = ''
    document.getElementById('sshUserInput').value = ''
    document.getElementById('sshPortInput').value = '22'
    document.getElementById('sshDescInput').value = ''
    if (document.getElementById('sshKeySelectInput')) document.getElementById('sshKeySelectInput').value = ''
  }

  newBtn.addEventListener('click', () => {
    if (panel.hidden) resetSshAddForm()
    panel.hidden = !panel.hidden
    if (!panel.hidden) {
      document.getElementById('sshNameInput').focus()
      _showVaultTenantRowIfAdmin('sshAddTenantRow', 'sshAddTenantSelect')
    }
  })
  closeBtn?.addEventListener('click', () => { panel.hidden = true; resetSshAddForm() })

  // (i) install guide button inside the "new server" form -- key-only mode
  document.getElementById('sshKeyInstallFromFormBtn')?.addEventListener('click', () => {
    openSshInfoModal(null, { keyOnly: true })
  })

  // "+ Új kulcs" button inside the "new server" form
  document.getElementById('sshKeyNewFromFormBtn')?.addEventListener('click', () => {
    openSshKeygenModal(newKey => {
      // After key created, select it in the form dropdown
      if (newKey && newKey.id) {
        const sel = document.getElementById('sshKeySelectInput')
        if (sel) sel.value = newKey.id
      }
    })
  })

  addBtn?.addEventListener('click', async () => {
    const name = document.getElementById('sshNameInput').value.trim()
    const host = document.getElementById('sshHostInput').value.trim()
    const user = document.getElementById('sshUserInput').value.trim()
    const port = parseInt(document.getElementById('sshPortInput').value, 10) || 22
    const desc = document.getElementById('sshDescInput').value.trim()
    const sshKeyId = document.getElementById('sshKeySelectInput')?.value || null
    if (!name || !host || !user) { showToast('Név, IP és felhasználó megadása kötelező'); return }
    const isEdit = !!_sshEditingId
    const tenantRow = document.getElementById('sshAddTenantRow')
    const tenant_id = (!isEdit && tenantRow && !tenantRow.hidden)
      ? (document.getElementById('sshAddTenantSelect')?.value || undefined)
      : undefined
    try {
      const res = await fetch(
        isEdit ? `/api/vault/ssh-servers/${encodeURIComponent(_sshEditingId)}` : '/api/vault/ssh-servers',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, host, user, port, desc, sshKeyId: sshKeyId || undefined, tenant_id }),
        }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        showToast(getErrorMessage(err, 'Hiba a mentéskor')); return
      }
      resetSshAddForm()
      panel.hidden = true
      await loadSshServers()
      showToast(isEdit ? 'Szerver frissítve' : 'Szerver hozzáadva')
    } catch { showToast('Hálózati hiba') }
  })

  cardViewBtn?.addEventListener('click', () => {
    _sshView = 'cards'
    cardViewBtn.classList.add('active')
    tableViewBtn.classList.remove('active')
    cardsView.hidden = false
    tableView.hidden = true
  })

  tableViewBtn?.addEventListener('click', () => {
    _sshView = 'table'
    tableViewBtn.classList.add('active')
    cardViewBtn.classList.remove('active')
    cardsView.hidden = true
    tableView.hidden = false
  })

  // Kulcstároló "Új kulcs generálása" button
  document.getElementById('sshKeyNewBtn')?.addEventListener('click', () => {
    openSshKeygenModal()
  })

  // Global (i) info button in section header
  document.getElementById('sshInfoGlobalBtn')?.addEventListener('click', () => {
    openSshInfoModal()
  })
})()

// --- Vault Page ---
let _vaultSecrets = []

let _vaultBindings = []

function vaultTenantQuery() {
  const tenant = _vaultTenantGetter?.()
  return tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''
}

export async function loadVaultPage() {
  try {
    const [secretsRes, bindingsRes] = await Promise.all([
      fetch('/api/vault' + vaultTenantQuery()),
      fetch('/api/vault/bindings'),
    ])
    const secretsData = await secretsRes.json()
    const bindingsData = await bindingsRes.json()
    _vaultSecrets = secretsData.secrets || []
    _vaultBindings = bindingsData.bindings || []
    document.getElementById('vaultStatTotal').textContent = String(_vaultSecrets.length)
    document.getElementById('vaultStatBindings').textContent = String(_vaultBindings.length)
    renderVaultGrid(_vaultSecrets)
    await Promise.all([loadSshKeys(), loadSshServers()])
  } catch { /* ignore */ }
}

function renderVaultGrid(secrets) {
  const list = document.getElementById('vaultPageList')
  const empty = document.getElementById('vaultPageEmpty')
  list.innerHTML = ''
  if (secrets.length === 0) { empty.hidden = false; return }
  empty.hidden = true
  for (const s of secrets) {
    const card = document.createElement('div')
    card.className = 'vault-card'
    const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
    const bindingCount = _vaultBindings.filter(b => b.vaultSecretId === s.id).length
    const bindingBadge = bindingCount > 0 ? `<span class="vault-binding-badge" title="${bindingCount} kotes">${bindingCount} kotes</span>` : ''
    // Tenant badge only makes sense for a global admin, who can see secrets
    // across tenants; a scoped user only ever sees their own tenant's rows.
    const tenantBadge = _vaultTenantGetter && s.tenant_id
      ? `<span class="badge" data-variant="neutral" data-size="sm">${escapeHtml(s.tenant_id)}</span>`
      : ''
    card.innerHTML = `<div class="vault-card-header"><div class="vault-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div><div class="vault-card-title"><div class="vault-card-id">${escapeHtml(s.id)} ${bindingBadge} ${tenantBadge}</div>${s.label !== s.id ? `<div class="vault-card-label">${escapeHtml(s.label)}</div>` : ''}</div><div class="vault-card-meta">${date}</div></div><div class="vault-card-actions"><button class="btn vault-card-reveal" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${t('vault.btn.show')}</button><button class="btn vault-card-edit" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" data-label="${escapeHtml(s.label)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${t('vault.btn.edit')}</button><button class="btn vault-card-delete" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>${t('vault.btn.delete')}</button></div>`
    list.appendChild(card)
  }
  list.querySelectorAll('.vault-card-reveal').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-value')
      if (existing) { existing.remove(); btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${t('vault.btn.show')}`; return }
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (data.value) {
        const valEl = document.createElement('div')
        valEl.className = 'vault-card-value'
        valEl.textContent = data.value
        card.appendChild(valEl)
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> ${t('vault.btn.hide')}`
      }
    })
  })
  list.querySelectorAll('.vault-card-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const label = btn.getAttribute('data-label')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-edit-form')
      if (existing) { existing.remove(); return }
      card.querySelector('.vault-card-value')?.remove()
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (!data.value) return
      const form = document.createElement('div')
      form.className = 'vault-card-edit-form'
      form.innerHTML = `<input type="password" class="input vault-edit-value" value="${escapeHtml(data.value)}" style="font-size:13px;margin-bottom:6px"><button class="btn vault-edit-save" data-variant="primary" data-size="compact" >${t('vault.btn.save')}</button> <button class="btn vault-edit-cancel" data-variant="secondary" data-size="compact" >${t('vault.btn.cancel')}</button>`
      card.appendChild(form)
      const input = form.querySelector('.vault-edit-value')
      input.focus()
      input.select()
      form.querySelector('.vault-edit-cancel').addEventListener('click', () => form.remove())
      form.querySelector('.vault-edit-save').addEventListener('click', async () => {
        const newVal = input.value
        if (!newVal) return
        const saveBtn = form.querySelector('.vault-edit-save')
        saveBtn.disabled = true
        saveBtn.textContent = '...'
        // Target the entry's OWN tenant, not whatever the selector currently
        // shows -- an admin viewing "All tenants" must not accidentally
        // re-home an edited secret onto 'default'.
        const tenant_id = _vaultSecrets.find(s => s.id === id)?.tenant_id || undefined
        const res = await fetch('/api/vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label, value: newVal, tenant_id }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          showToast('Frissítés sikertelen: ' + getErrorMessage(e, String(res.status)))
          saveBtn.disabled = false
          saveBtn.textContent = 'Mentés'
          return
        }
        form.remove()
        showToast('Kulcs frissitve es szinkronizalva')
        loadVaultPage()
        loadVault()
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') form.querySelector('.vault-edit-save').click()
        if (e.key === 'Escape') form.remove()
      })
    })
  })
  list.querySelectorAll('.vault-card-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      if (!confirm(`Torlod: ${id}?`)) return
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) { showToast('Törlés sikertelen'); return }
      loadVaultPage()
      loadVault()
    })
  })
}

;(function wireVaultPage() {
  const newBtn = document.getElementById('vaultPageNewBtn')
  const panel = document.getElementById('vaultAddPanel')
  const closeBtn = document.getElementById('vaultAddPanelClose')
  const addBtn = document.getElementById('vaultPageAddBtn')
  if (!newBtn || !panel) return

  newBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    if (!panel.hidden) {
      document.getElementById('vaultPageIdInput').focus()
      _showVaultTenantRowIfAdmin('vaultAddTenantRow', 'vaultAddTenantSelect')
    }
  })
  closeBtn?.addEventListener('click', () => { panel.hidden = true })

  addBtn.addEventListener('click', async () => {
    const id = document.getElementById('vaultPageIdInput').value.trim()
    const label = document.getElementById('vaultPageLabelInput').value.trim() || id
    const value = document.getElementById('vaultPageValueInput').value
    if (!id || !value) return
    addBtn.disabled = true
    // Admin: the modal's own explicit tenant select wins over the page-level
    // selector. Non-admin never sends this -- the backend ignores it for them
    // anyway and always uses their own tenant.
    const tenantRow = document.getElementById('vaultAddTenantRow')
    const tenant_id = (tenantRow && !tenantRow.hidden)
      ? (document.getElementById('vaultAddTenantSelect')?.value || undefined)
      : (_vaultTenantGetter?.() || undefined)
    await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label, value, tenant_id }),
    })
    document.getElementById('vaultPageIdInput').value = ''
    document.getElementById('vaultPageLabelInput').value = ''
    document.getElementById('vaultPageValueInput').value = ''
    addBtn.disabled = false
    panel.hidden = true
    loadVaultPage()
    loadVault()
  })
  document.getElementById('vaultPageValueInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })

  document.getElementById('vaultSearchInput')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim()
    if (!q) { renderVaultGrid(_vaultSecrets); return }
    renderVaultGrid(_vaultSecrets.filter(s => s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)))
  })
})()

// --- Vault Binding modal ---
;(function wireVaultBind() {
  const bindBtn = document.getElementById('vaultBindBtn')
  const overlay = document.getElementById('vaultBindOverlay')
  const closeBtn = document.getElementById('vaultBindClose')
  const saveBtn = document.getElementById('vaultBindSaveBtn')
  const secretSelect = document.getElementById('vaultBindSecret')
  const serverSelect = document.getElementById('vaultBindServer')
  const envVarInput = document.getElementById('vaultBindEnvVar')
  const statusEl = document.getElementById('vaultBindStatus')
  if (!bindBtn || !overlay) return

  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeModal?.(overlay) })
  closeBtn.addEventListener('click', () => { _closeModal?.(overlay) })

  bindBtn.addEventListener('click', async () => {
    try {
      statusEl.hidden = true
      envVarInput.value = ''

      const [secretsRes, connectorsRes] = await Promise.all([
        fetch('/api/vault'),
        fetch('/api/connectors'),
      ])
      const secrets = (await secretsRes.json()).secrets || []
      const connectors = await connectorsRes.json()

      secretSelect.innerHTML = ''
      for (const s of secrets) {
        const opt = document.createElement('option')
        opt.value = s.id
        opt.textContent = s.label !== s.id ? `${s.id} (${s.label})` : s.id
        secretSelect.appendChild(opt)
      }
      if (secrets.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs vault kulcs --'
        opt.disabled = true
        secretSelect.appendChild(opt)
      }

      const mcpConnectors = connectors.filter(c => c.source !== 'plugin' && c.source !== 'claude.ai')
      serverSelect.innerHTML = ''
      for (const c of mcpConnectors) {
        const opt = document.createElement('option')
        opt.value = c.name
        opt.textContent = c.scope !== 'global' ? `${c.name} (${c.scope})` : c.name
        serverSelect.appendChild(opt)
      }
      if (mcpConnectors.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs MCP szerver --'
        opt.disabled = true
        serverSelect.appendChild(opt)
      }

      _openModal?.(overlay)
    } catch (err) {
      console.error('Vault bind modal error:', err)
      showToast('Hiba a hozzarendeles betoltesekor: ' + err.message)
    }
  })

  saveBtn.addEventListener('click', async () => {
    const vaultSecretId = secretSelect.value
    const serverName = serverSelect.value
    const envVar = envVarInput.value.trim()
    if (!vaultSecretId || !serverName || !envVar) {
      statusEl.textContent = 'Minden mezo kitoltese kotelezo'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = t('connectors.save_btn')
    try {
      const res = await fetch('/api/vault/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultSecretId, envVar, serverName }),
      })
      const data = await res.json()
      if (data.ok) {
        statusEl.textContent = `Hozzarendelve! ${data.synced || 0} fajl frissitve.`
        statusEl.className = 'vault-bind-status success'
        statusEl.hidden = false
        loadVaultPage()
        loadVault()
        setTimeout(() => { _closeModal?.(overlay) }, 1500)
      } else {
        statusEl.textContent = getErrorMessage(data, 'Hiba tortent')
        statusEl.className = 'vault-bind-status error'
        statusEl.hidden = false
      }
    } catch (err) {
      statusEl.textContent = 'Halozati hiba'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = 'Hozzarendeles'
    }
  })
})()

// --- Vault Scan & Import ---
;(function wireVaultScan() {
  const scanBtn = document.getElementById('vaultScanBtn')
  const syncBtn = document.getElementById('vaultSyncBtn')
  const overlay = document.getElementById('vaultScanOverlay')
  const closeBtn = document.getElementById('vaultScanClose')
  const importBtn = document.getElementById('vaultScanImportBtn')
  if (!scanBtn || !overlay) return

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true
    scanBtn.textContent = 'Kereses...'
    try {
      const res = await fetch('/api/vault/scan')
      const data = await res.json()
      const findings = data.findings || []
      renderScanResults(findings)
      _openModal?.(overlay)
    } finally {
      scanBtn.disabled = false
      scanBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan &amp; Import'
    }
  })

  closeBtn?.addEventListener('click', () => { _closeModal?.(overlay) })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeModal?.(overlay) })

  syncBtn?.addEventListener('click', async () => {
    syncBtn.disabled = true
    syncBtn.textContent = 'Szinkron...'
    try {
      const res = await fetch('/api/vault/sync', { method: 'POST' })
      const data = await res.json()
      if (data.updated > 0) {
        showToast(`${data.updated} .mcp.json frissitve`)
      } else {
        showToast('Nincs szinkronizalando kotes')
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      syncBtn.disabled = false
      syncBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Szinkron'
    }
  })

  function renderScanResults(findings) {
    const results = document.getElementById('vaultScanResults')
    const empty = document.getElementById('vaultScanEmpty')
    const footer = document.getElementById('vaultScanFooter')
    results.innerHTML = ''

    const actionable = findings.filter(f => !f.alreadyInVault)
    if (actionable.length === 0) {
      empty.hidden = false
      footer.hidden = true
      if (findings.length > 0) {
        empty.textContent = `${findings.length} erzekeny ertek talalva, de mind mar a Vault-ban van.`
      }
      return
    }
    empty.hidden = true
    footer.hidden = false

    const grouped = new Map()
    for (const f of actionable) {
      const key = `${f.serverName}|${f.envVar}`
      if (!grouped.has(key)) grouped.set(key, { ...f, allTargets: [] })
      grouped.get(key).allTargets.push({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })
    }

    for (const [key, f] of grouped) {
      const row = document.createElement('div')
      row.className = 'vault-scan-row'
      row.innerHTML = `
        <label class="vault-scan-check">
          <input type="checkbox" checked data-key="${escapeHtml(key)}">
        </label>
        <div class="vault-scan-info">
          <div class="vault-scan-server">${escapeHtml(f.serverName)}</div>
          <div class="vault-scan-env">${escapeHtml(f.envVar)} = <code>${escapeHtml(f.maskedValue)}</code></div>
          <div class="vault-scan-targets">${f.allTargets.length} fajlban</div>
        </div>
        <div class="vault-scan-id">
          <input type="text" class="input vault-scan-vault-id" value="${escapeHtml(f.suggestedVaultId)}" data-key="${escapeHtml(key)}" style="font-size:12px;width:180px">
        </div>
      `
      results.appendChild(row)
    }
  }

  importBtn?.addEventListener('click', async () => {
    const results = document.getElementById('vaultScanResults')
    const rows = results.querySelectorAll('.vault-scan-row')
    const imports = []

    const scanRes = await fetch('/api/vault/scan')
    const scanData = await scanRes.json()
    const allFindings = scanData.findings || []

    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]')
      if (!cb?.checked) continue
      const key = cb.getAttribute('data-key')
      const [serverName, envVar] = key.split('|')
      const vaultIdInput = row.querySelector('.vault-scan-vault-id')
      const vaultId = vaultIdInput?.value?.trim() || key

      const matchingFindings = allFindings.filter(
        f => f.serverName === serverName && f.envVar === envVar && !f.alreadyInVault,
      )
      if (matchingFindings.length === 0) continue

      imports.push({
        serverName,
        envVar,
        vaultId,
        label: `${envVar} (${serverName})`,
        createBinding: true,
        targets: matchingFindings.map(f => ({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })),
      })
    }

    if (imports.length === 0) { showToast('Nincs kivalasztott elem'); return }

    importBtn.disabled = true
    importBtn.textContent = 'Importalas...'

    try {
      const res = await fetch('/api/vault/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imports }),
      })
      const data = await res.json()
      if (data.imported > 0) {
        showToast(`${data.imported} kulcs importalva, ${data.bound} kotes letrehozva`)
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      importBtn.disabled = false
      importBtn.textContent = 'Kivalasztottak importalasa'
    }
    _closeModal?.(overlay)
    loadVaultPage()
    loadVault()
  })
})()

