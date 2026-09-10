import { escapeHtml } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'
import { getErrorMessage } from './error-message.js'
import { initTenantSelector } from './tenant-selector.js'

// ============================================================
// === Import Memories -- external file sources ===
// ============================================================

let sourcesCache = []
// null for non-admin (tenant selector hidden); set to a getter for global admins.
let _importTenantGetter = null

function formatTs(unix) {
  if (!unix) return '-'
  return new Date(unix * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', hour12: false })
}

function intervalLabel(h) {
  return h === 1 ? '1h' : h === 2 ? '2h' : h === 4 ? '4h' : h === 24 ? '24h' : `${h}h`
}

function typeLabel(type) {
  if (type === 'local') return t('import.type.local')
  if (type === 'gdrive') return t('import.type.gdrive')
  if (type === 'sharepoint') return t('import.type.sharepoint')
  if (type === 'confluence') return t('import.type.confluence')
  return type
}

function typeIcon(type) {
  if (type === 'local') return '💾'
  if (type === 'gdrive') return '☁️'
  if (type === 'sharepoint') return '🏢'
  if (type === 'confluence') return '📘'
  return '📂'
}

function renderSources(sources) {
  const el = document.getElementById('importSourcesList')
  if (!el) return
  if (!sources.length) {
    el.innerHTML = `<p class="empty-state">${escapeHtml(t('import.sources.empty'))}</p>`
    return
  }

  const statusBadge = (enabled) => enabled
    ? `<span class="import-status-badge active">${escapeHtml(t('import.status.active'))}</span>`
    : `<span class="import-status-badge inactive">${escapeHtml(t('import.status.inactive'))}</span>`

  // Tenant column only makes sense for a global admin, who can see sources
  // across tenants; scoped users only ever see their own tenant's rows.
  const isAdmin = !!_importTenantGetter
  const tenantHeader = isAdmin ? `<th>${escapeHtml(t('import.col.tenant'))}</th>` : ''
  const tenantCell = (s) => isAdmin
    ? `<td><span class="badge" data-variant="neutral" data-size="sm">${escapeHtml(s.tenant_id)}</span></td>`
    : ''

  el.innerHTML = `
    <div class="table-wrap import-sources-table-wrap">
      <table class="table import-sources-table">
        <thead>
          <tr>
            <th>${escapeHtml(t('import.col.type'))}</th>
            <th>${escapeHtml(t('import.col.name'))}</th>
            ${tenantHeader}
            <th>${escapeHtml(t('import.col.interval'))}</th>
            <th>${escapeHtml(t('import.col.last_sync'))}</th>
            <th>${escapeHtml(t('import.col.status'))}</th>
            <th style="text-align:right">${escapeHtml(t('import.col.actions'))}</th>
          </tr>
        </thead>
        <tbody>
          ${sources.map(s => `
            <tr data-id="${escapeHtml(s.id)}">
              <td><span class="isrc-type">${typeIcon(s.type)} ${escapeHtml(typeLabel(s.type))}</span></td>
              <td>
                ${s.label ? `<span class="isrc-label">${escapeHtml(s.label)}</span><br>` : ''}
                <span class="isrc-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</span>
              </td>
              ${tenantCell(s)}
              <td>${escapeHtml(intervalLabel(s.interval_hours))}</td>
              <td style="white-space:nowrap;color:var(--text-muted);font-size:12px">${formatTs(s.last_run_at)}</td>
              <td>${statusBadge(s.enabled)}</td>
              <td>
                <div class="isrc-actions">
                  <button class="btn import-sync-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}">${t('import.btn.sync')}</button>
                  <button class="btn import-log-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}">${t('import.btn.log')}</button>
                  <button class="btn import-toggle-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" data-enabled="${s.enabled ? '1' : '0'}">${s.enabled ? t('import.btn.disable') : t('import.btn.enable')}</button>
                  <button class="btn import-wipe-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}">${t('import.btn.wipe_source')}</button>
                  <button class="btn import-delete-btn" data-variant="danger" data-size="compact" data-id="${escapeHtml(s.id)}">${t('import.btn.delete')}</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `

  // Event handlers
  el.querySelectorAll('.import-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const nowEnabled = btn.dataset.enabled === '0'
      await fetch(`/api/import/sources/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nowEnabled }),
      })
      loadImportSources()
    })
  })

  el.querySelectorAll('.import-sync-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      btn.disabled = true; btn.textContent = t('import.btn.syncing')
      try {
        await fetch(`/api/import/sources/${id}/sync`, { method: 'POST' })
        showToast(t('import.toast.sync_queued'))
      } catch { showToast(t('import.toast.error')) }
      finally { btn.disabled = false; btn.textContent = t('import.btn.sync') }
    })
  })

  el.querySelectorAll('.import-log-btn').forEach(btn => {
    btn.addEventListener('click', () => loadSourceLog(btn.dataset.id))
  })

  el.querySelectorAll('.import-wipe-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('import.confirm.wipe_source'))) return
      await fetch(`/api/import/sources/${btn.dataset.id}/memories`, { method: 'DELETE' })
      showToast(t('import.toast.wiped'))
    })
  })

  el.querySelectorAll('.import-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('import.confirm.delete_source'))) return
      await fetch(`/api/import/sources/${btn.dataset.id}`, { method: 'DELETE' })
      showToast(t('import.toast.deleted'))
      loadImportSources()
    })
  })
}

async function loadSourceLog(sourceId) {
  const logEl = document.getElementById('importLog')
  if (!logEl) return
  try {
    const res = await fetch(`/api/import/sources/${sourceId}/log`)
    const rows = await res.json()
    // Admin viewing across tenants: show which tenant this source (and its
    // log) belongs to, since the run log itself carries no per-row tenant info.
    const source = sourcesCache.find(s => s.id === sourceId)
    const tenantHeading = (_importTenantGetter && source)
      ? `<p class="import-log-tenant"><span class="badge" data-variant="neutral" data-size="sm">${escapeHtml(source.tenant_id)}</span></p>`
      : ''
    if (!rows.length) { logEl.innerHTML = tenantHeading + `<p class="empty-state">${escapeHtml(t('import.log.empty'))}</p>`; return }
    logEl.innerHTML = tenantHeading + `<div class="table-wrap"><table class="table import-log-table" data-variant="compact"><thead><tr>
      <th>${t('import.log.run_at')}</th>
      <th>${t('import.log.scanned')}</th>
      <th>${t('import.log.added')}</th>
      <th>${t('import.log.updated')}</th>
      <th>${t('import.log.skipped')}</th>
      <th>${t('import.log.error')}</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td>${formatTs(r.run_at)}</td>
      <td>${r.files_scanned}</td>
      <td>${r.files_added}</td>
      <td>${r.files_updated}</td>
      <td>${r.files_skipped_hash + r.files_skipped_secret + r.files_skipped_size + r.files_skipped_type}</td>
      <td>${r.error ? `<span class="error-text">${escapeHtml(r.error.slice(0, 80))}</span>` : '-'}</td>
    </tr>`).join('')}</tbody></table></div>`
  } catch { logEl.innerHTML = '<p class="empty-state">Hiba</p>' }
}

export async function loadImportSources() {
  try {
    const tenant = _importTenantGetter?.()
    const tenantParam = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''
    const res = await fetch('/api/import/sources' + tenantParam)
    sourcesCache = await res.json()
    renderSources(sourcesCache)
  } catch (err) {
    const el = document.getElementById('importSourcesList')
    if (el) el.innerHTML = `<p class="empty-state">${escapeHtml(t('import.sources.load_error'))}</p>`
  }
}

// Populates the admin-only "assign to tenant" select in the add-source form.
// Hidden entirely for non-admins (initTenantSelector already returned null).
async function initSourceTenantSelect() {
  const group = document.getElementById('importSourceTenantGroup')
  const sel = document.getElementById('importSourceTenant')
  if (!group || !sel || !_importTenantGetter) return
  try {
    const r = await fetch('/api/admin/tenants')
    if (!r.ok) return
    const tenants = (await r.json()).items ?? []
    if (!tenants.length) return
    sel.innerHTML = tenants.map(ten =>
      `<option value="${escapeHtml(ten.id)}">${escapeHtml(ten.display_name ? `${ten.display_name} (${ten.id})` : ten.id)}</option>`
    ).join('')
    group.hidden = false
  } catch {}
}

export function initImportMemories() {
  // Tenant selector (list view); admin-only "assign to tenant" select in the
  // add-source form reuses the same admin check. Not awaited here so the
  // synchronous form-wiring below runs immediately; app.js calls
  // loadImportSources() right after initImportMemories() regardless (see the
  // notes in memories.js's initMemories) -- the first render can race ahead
  // of this resolving, which is benign for the same reason it is there.
  initTenantSelector('importTenantSelectorContainer', () => loadImportSources())
    .then(getter => { _importTenantGetter = getter; initSourceTenantSelect() })

  // SharePoint disclaimer + Confluence fields toggle (mutually exclusive
  // with each other, shown only for their own source type). Declared before
  // the form handler below so the submit handler can re-apply it after
  // form.reset() (which does not fire a 'change' event on the type select).
  const spInfo = document.getElementById('importSharePointInfo')
  const confluenceInfo = document.getElementById('importConfluenceInfo')
  const typeSelect = document.getElementById('importSourceType')
  const applyTypeVisibility = () => {
    if (!typeSelect) return
    if (spInfo) spInfo.hidden = typeSelect.value !== 'sharepoint'
    if (confluenceInfo) confluenceInfo.hidden = typeSelect.value !== 'confluence'
  }
  if (typeSelect) {
    typeSelect.addEventListener('change', applyTypeVisibility)
    applyTypeVisibility()
  }

  // Add source form
  const form = document.getElementById('importAddSourceForm')
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const type = document.getElementById('importSourceType').value
      const path = document.getElementById('importSourcePath').value.trim()
      const label = document.getElementById('importSourceLabel').value.trim()
      const interval = parseInt(document.getElementById('importSourceInterval').value, 10)
      const tenantSel = document.getElementById('importSourceTenant')
      const tenantId = _importTenantGetter && tenantSel && !tenantSel.closest('[hidden]') ? tenantSel.value : undefined

      if (!path) { showToast(t('import.toast.path_required')); return }

      const body = { type, path, label: label || undefined, interval_hours: interval, tenant_id: tenantId }
      if (type === 'confluence') {
        body.base_url = document.getElementById('importSourceBaseUrl').value.trim()
        body.confluence_email = document.getElementById('importSourceConfluenceEmail').value.trim()
        body.vault_token_ref = document.getElementById('importSourceVaultTokenRef').value.trim()
      }

      const btn = form.querySelector('button[type="submit"]')
      if (btn) { btn.disabled = true }
      try {
        const res = await fetch('/api/import/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Hiba' }))
          showToast(getErrorMessage(err, t('import.toast.error')))
          return
        }
        showToast(t('import.toast.source_added'))
        form.reset()
        applyTypeVisibility() // form.reset() doesn't fire 'change' on the type select
        loadImportSources()
      } catch { showToast(t('import.toast.error')) }
      finally { if (btn) btn.disabled = false }
    })
  }

  // Wipe all button
  const wipeAllBtn = document.getElementById('importWipeAllBtn')
  if (wipeAllBtn) {
    wipeAllBtn.addEventListener('click', async () => {
      if (!confirm(t('import.confirm.wipe_all'))) return
      await fetch('/api/import/memories', { method: 'DELETE' })
      showToast(t('import.toast.all_wiped'))
    })
  }
}
