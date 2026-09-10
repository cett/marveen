import { escapeHtml } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'
import { getErrorMessage } from './error-message.js'

// ============================================================
// === Fleet Migration ===
// ============================================================

// Holds the last successfully parsed fleet JSON text (for apply after dry-run)
let fleetLastBody = null

export function initMigrate() {
  document.getElementById('fleetExportBtn').addEventListener('click', async () => {
    const btn = document.getElementById('fleetExportBtn')
    const password = document.getElementById('fleetExportPassword').value.trim()

    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    try {
      const headers = {}
      if (password) headers['X-Vault-Password'] = password

      const res = await fetch('/api/fleet/export', { headers })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(getErrorMessage(data, t('fleet.export.error')))
        return
      }

      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const nameMatch = cd.match(/filename="?([^";\s]+)"?/)
      const filename = nameMatch ? nameMatch[1] : `fleet-export-${new Date().toISOString().slice(0, 10)}.json`

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      showToast(t('fleet.export.success'))
    } catch (err) {
      showToast(`${t('fleet.export.error')}: ${err.message}`)
    } finally {
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })

  document.getElementById('fleetDryRunBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('fleetImportFile')
    if (!fileInput.files.length) {
      showToast(t('fleet.import.no_file'))
      return
    }

    const btn = document.getElementById('fleetDryRunBtn')
    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    const applyBtn = document.getElementById('fleetApplyBtn')
    applyBtn.disabled = true
    fleetLastBody = null

    const resultEl = document.getElementById('fleetDryRunResult')
    resultEl.hidden = true
    resultEl.innerHTML = ''

    try {
      const text = await fileInput.files[0].text()
      // Validate JSON client-side first
      try { JSON.parse(text) } catch { showToast(t('fleet.import.invalid_json')); return }

      const password = document.getElementById('fleetImportPassword').value.trim()
      const headers = { 'Content-Type': 'application/json' }
      if (password) headers['X-Vault-Password'] = password

      const res = await fetch('/api/fleet/import', { method: 'POST', headers, body: text })
      const data = await res.json()

      const wc = data.wouldCreate || {}
      const hasErrors = data.errors && data.errors.length > 0
      const hasWarnings = data.warnings && data.warnings.length > 0

      resultEl.className = `fleet-dry-run-result ${hasErrors ? 'has-errors' : 'ok'}`
      resultEl.hidden = false

      const agentNames = Array.isArray(wc.agents) ? wc.agents : []
      const agentLabel = agentNames.length
        ? `${agentNames.length} (${agentNames.join(', ')})`
        : '0'

      resultEl.innerHTML = `
        <div class="fleet-dry-run-title">${hasErrors ? '❌ ' + t('fleet.import.dryrun_errors') : '✅ ' + t('fleet.import.dryrun_ok')}</div>
        ${!hasErrors ? `
        <div class="fleet-dry-run-grid">
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.mainAgent ? '✓' : '—'}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.main_agent')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${agentNames.length}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.agents')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.memories ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.memories')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.kanbanCards ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.kanban')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.globalSkills ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.skills')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.scheduledTasks ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.tasks')}</div>
          </div>
        </div>
        ${agentNames.length ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${t('fleet.stat.agent_names')}: ${escapeHtml(agentNames.join(', '))}</div>` : ''}
        ` : ''}
        ${hasErrors ? `<div class="fleet-dry-run-errors">${data.errors.map(e => escapeHtml(e)).join('<br>')}</div>` : ''}
        ${hasWarnings ? `<div class="fleet-dry-run-warnings">⚠️ ${data.warnings.map(w => escapeHtml(w)).join('<br>')}</div>` : ''}
      `

      if (!hasErrors) {
        fleetLastBody = text
        applyBtn.disabled = false
      }
    } catch (err) {
      showToast(`${t('fleet.import.error')}: ${err.message}`)
    } finally {
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })

  document.getElementById('fleetApplyBtn').addEventListener('click', async () => {
    if (!fleetLastBody) return

    if (!confirm(t('fleet.import.apply_confirm'))) return

    const btn = document.getElementById('fleetApplyBtn')
    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    const resultEl = document.getElementById('fleetDryRunResult')

    try {
      const password = document.getElementById('fleetImportPassword').value.trim()
      const headers = { 'Content-Type': 'application/json' }
      if (password) headers['X-Vault-Password'] = password

      const res = await fetch('/api/fleet/import?apply=true', { method: 'POST', headers, body: fleetLastBody })
      const data = await res.json()

      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      if (!res.ok) throw Object.assign(new Error('api call failed'), { apiData: data })

      const imp = data.imported || {}
      const agentNames = Array.isArray(imp.agents) ? imp.agents : []

      resultEl.className = 'fleet-apply-result'
      resultEl.hidden = false
      resultEl.innerHTML = `
        <div class="fleet-apply-result-title">✅ ${t('fleet.import.apply_success')}</div>
        <div>
          ${imp.mainAgent ? `<div>${t('fleet.stat.main_agent')}: ✓</div>` : ''}
          ${agentNames.length ? `<div>${t('fleet.stat.agents')}: ${escapeHtml(agentNames.join(', '))}</div>` : ''}
          <div>${t('fleet.stat.memories')}: ${imp.memories ?? 0}</div>
          <div>${t('fleet.stat.kanban')}: ${imp.kanbanCards ?? 0}</div>
          <div>${t('fleet.stat.skills')}: ${imp.globalSkills ?? 0}</div>
          <div>${t('fleet.stat.tasks')}: ${imp.scheduledTasks ?? 0}</div>
        </div>
      `

      fleetLastBody = null
      btn.disabled = true
    } catch (err) {
      showToast(getErrorMessage(err.apiData, t('fleet.import.error')))
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    } finally {
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })
}
