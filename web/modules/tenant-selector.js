// Shared tenant-selector utility for global admin dashboard views.
//
// Only global admins (role=admin, tenant_id=null in /api/auth/status) see the
// selector; all other roles get null back and the container stays hidden.

let _authStatusPromise = null

function _fetchAuthStatus() {
  if (!_authStatusPromise) {
    _authStatusPromise = fetch('/api/auth/status')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  }
  return _authStatusPromise
}

/**
 * Enabled tenants, for a global admin only ([] for every other caller or on a
 * failed fetch). Not cached: a form that opens later should see a tenant that
 * was created since the page loaded.
 *
 * @returns {Promise<{id: string, display_name?: string}[]>}
 */
export async function fetchAdminTenants() {
  const auth = await _fetchAuthStatus()
  if (!(auth?.role === 'admin' && auth?.tenant_id === null)) return []
  try {
    const r = await fetch('/api/admin/tenants')
    if (r.ok) return (await r.json()).items ?? []
  } catch {}
  return []
}

/**
 * Insert a tenant-filter <select> into containerId and wire onChange.
 *
 * Returns a getter `() => string | null` for the current selection
 * (null = all tenants), or null if the current user is not a global admin.
 *
 * @param {string}   containerId   id of the wrapping <div> element
 * @param {Function} onChange      called with (tenantId: string|null) on change
 */
export async function initTenantSelector(containerId, onChange) {
  const container = document.getElementById(containerId)
  if (!container) return null

  const tenants = await fetchAdminTenants()
  if (!tenants.length) return null

  const bar = document.createElement('div')
  bar.className = 'tenant-selector-bar'

  const lbl = document.createElement('label')
  lbl.className = 'tenant-selector-label'
  lbl.htmlFor = containerId + '-sel'
  lbl.textContent = (typeof window.t === 'function' ? window.t('tenant.selector.label') : '') || 'Tenant:'

  const sel = document.createElement('select')
  sel.id = containerId + '-sel'
  sel.className = 'tenant-selector'

  const allOpt = document.createElement('option')
  allOpt.value = ''
  allOpt.textContent = (typeof window.t === 'function' ? window.t('tenant.selector.all') : '') || 'Összes tenant'
  sel.appendChild(allOpt)

  tenants.forEach(ten => {
    const opt = document.createElement('option')
    opt.value = ten.id
    opt.textContent = ten.display_name ? `${ten.display_name} (${ten.id})` : ten.id
    sel.appendChild(opt)
  })

  sel.addEventListener('change', () => onChange(sel.value || null))

  bar.append(lbl, sel)
  container.append(bar)
  container.hidden = false

  return () => sel.value || null
}
