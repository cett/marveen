// Agent detail modal (split out of agents.js for #773/#776).
// Owns currentChannelProvider (read from agents.js's eager loadAgents() and
// from agents-channels.js's provider dropdown, both via setCurrentChannelProvider
// -- see HANDOFF.md for why this lives here rather than in agents.js despite
// being read at page-load time). Excludes the Channel/MCP tab (agents-channels.js).

import { t, getLang } from './i18n.js'
import { showToast } from './toast.js'
import { escapeHtml, mainAgentId } from './util.js'
import { getErrorMessage } from './error-message.js'
import {
  AVATARS, _closeModal, _loadSkills, _openModal, _renderTeamEditor,
  agentDetailOverlay, agentName, agents, applyMarveenReadonlyMode,
  avatarBust, bumpAvatarEpoch, currentAgent, setCurrentAgent,
  getAvatarGradient, loadAgents, openMarveenDetail,
  setupAutoRestartUI, setupIdleFlushUI,
} from './agents.js'
import { populatePlanSelect, populateProfileSelect } from './agents-wizard.js'
import {
  agentIsConnected, loadMcpScope, refreshAllowedList, refreshChannelRequests,
  refreshInvites, refreshPendingPairings, updateChannelTab, updateProviderUI,
} from './agents-channels.js'

export function setCurrentChannelProvider(v) { currentChannelProvider = v }

// === Agent Detail ===
export async function openAgentDetail(agentName) {
  if (agentName === mainAgentId()) {
    return openMarveenDetail()
  }

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    if (!res.ok) throw new Error('Not found')
    setCurrentAgent(await res.json())
  } catch (err) {
    showToast(t('agents.toast.load_failed'))
    return
  }

  const detailLabel = currentAgent.displayName || currentAgent.name

  // Title
  document.getElementById('agentDetailTitle').textContent = detailLabel

  // Overview tab
  const initial = detailLabel.charAt(0).toUpperCase()
  const gradientClass = getAvatarGradient(currentAgent.name)
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar ' + gradientClass
  avatar.innerHTML = (currentAgent.hasImage || currentAgent.hasAvatar)
    ? `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar" alt="${escapeHtml(detailLabel)}">`
    : initial
  document.getElementById('agentDetailName').textContent = detailLabel
  document.getElementById('agentDetailDesc').textContent = currentAgent.description || ''
  document.getElementById('agentDetailModel').textContent = currentAgent.activeModel || currentAgent.model || 'inherit'
  document.getElementById('agentDetailModelRestarting').hidden = true

  const chConnected = agentIsConnected(currentAgent)
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot ${chConnected ? 'connected' : 'disconnected'}"></span>${chConnected ? t('agents.channel.connected') : t('agents.channel.disconnected')}</span>`

  // Settings tab - load Ollama + DeepSeek models then set value
  loadAvailableModels()
  loadOllamaModels().then(() => {
    const sel = document.getElementById('editAgentModel')
    const mv = currentAgent.activeModel || currentAgent.model || 'claude-opus-4-8[1m]'
    // The model <select> is one shared element reused per agent. A manual
    // OpenRouter id (or openrouter-auto:tier) may not be among the static/auto
    // options, so setting .value would silently show nothing. Inject THIS
    // agent's model as a selectable option (cleaning any stale injected ones
    // first) so every agent always displays its own model, per-agent.
    Array.from(sel.querySelectorAll('option.dynamic-model-opt')).forEach(o => o.remove())
    if (!Array.from(sel.options).some(o => o.value === mv)) {
      const opt = document.createElement('option')
      opt.value = mv
      opt.className = 'dynamic-model-opt'
      opt.textContent = mv.startsWith('openrouter-auto:') ? `🔀 ${mv}` : `🔀 ${mv}`
      sel.appendChild(opt)
    }
    sel.value = mv
  })
  populateProfileSelect(
    document.getElementById('editAgentProfile'),
    document.getElementById('editAgentProfileDesc'),
    currentAgent.securityProfile || 'default',
  )
  // The main agent's Claude login is managed via channels.sh, not the per-agent
  // config path, so plan selection does not apply to it. Hide the whole group.
  const planGroup = document.getElementById('claudePlanGroup')
  if (planGroup) planGroup.hidden = currentAgent.role === 'main'
  populatePlanSelect(
    document.getElementById('editAgentPlan'),
    document.getElementById('editAgentPlanDesc'),
    currentAgent.claudePlan || '',
  )
  _renderTeamEditor?.(currentAgent, agents)
  updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
  const memIsoToggle = document.getElementById('memoryIsolationToggle')
  if (memIsoToggle) memIsoToggle.checked = currentAgent.memoryIsolation === true
  loadVoiceConfig(currentAgent.name)
  document.getElementById('editClaudeMd').value = currentAgent.claudeMd || currentAgent.content || ''
  document.getElementById('editSoulMd').value = currentAgent.soulMd || ''
  document.getElementById('editMcpJson').value = currentAgent.mcpJson || ''

  // Auto-restart settings + live context size
  setupAutoRestartUI(currentAgent)
  setupIdleFlushUI(currentAgent)

  // Telegram tab
  updateChannelTab(currentAgent)

  // Skills tab
  await _loadSkills?.(currentAgent.name)

  // MCP scope tab -- wrapped so a render failure never blocks the modal
  try {
    await loadMcpScope(currentAgent)
  } catch (err) {
    console.error('MCP scope tab load failed:', err)
  }

  // Process control
  updateProcessControl(currentAgent)

  // Channels restart button is Marveen-only -- hide on normal agents.
  document.getElementById('marveenRestartBtn').hidden = true

  // Restore editable Settings (Marveen detail flips this to read-only).
  applyMarveenReadonlyMode(false)

  // Delete button (restore visibility for normal agents)
  document.getElementById('deleteAgentBtn').style.display = ''
  document.getElementById('deleteAgentBtn').onclick = async () => {
    if (!confirm(t('agents.confirm.delete', { name: currentAgent.name }))) return
    try {
      await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, { method: 'DELETE' })
      _closeModal?.(agentDetailOverlay)
      showToast(t('agents.toast.deleted'))
      loadAgents()
    } catch (err) {
      showToast(t('common.error_delete'))
    }
  }

  // Export button: download a portable .tar.gz bundle of this agent. Offers to
  // include channel tokens (off by default -- the safe-to-share variant).
  // The download goes through the auth-wrapped fetch (the global fetch shim
  // injects the Bearer header) and is turned into a Blob download, rather than
  // a plain navigation -- a window.location download cannot carry the
  // Authorization header and the API would 401 it.
  document.getElementById('exportAgentBtn').onclick = async () => {
    if (!currentAgent) return
    const withSecrets = confirm(
      'Belevegyük a titkokat (channel bot token, párosítási állapot)?\n\n' +
      'OK = igen, csak saját gépek közötti átvitelhez.\n' +
      'Mégse = nem, biztonságosan megosztható (csak identitás + viselkedés).'
    )
    const name = currentAgent.name
    const url = `/api/agents/${encodeURIComponent(name)}/export${withSecrets ? '?secrets=1' : ''}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(getErrorMessage(data, 'Hiba az exportálás során'))
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `marveen-agent-${name}.tar.gz`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
      showToast(`Ügynök exportálva${withSecrets ? ' (titkokkal)' : ''}`)
    } catch {
      showToast('Hiba az exportálás során')
    }
  }

  // Reset to first tab, hide avatar gallery
  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  _openModal?.(agentDetailOverlay)
}

// === Detail avatar gallery ===
function populateDetailAvatarGrid() {
  const grid = document.getElementById('detailAvatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', async () => {
      if (!currentAgent) return
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ galleryAvatar: avatar }),
        })
        if (!res.ok) throw new Error()
        showToast(t('agents.toast.avatar_updated'))
        bumpAvatarEpoch()
        // Update the detail avatar display
        document.getElementById('agentDetailAvatar').innerHTML = `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}" alt="">`
        document.getElementById('detailAvatarGallery').hidden = true
        loadAgents()
      } catch {
        showToast(t('agents.toast.avatar_error'))
      }
    })
    grid.appendChild(item)
  }
}

document.getElementById('avatarChangeBtn').addEventListener('click', () => {
  const gallery = document.getElementById('detailAvatarGallery')
  gallery.hidden = !gallery.hidden
  if (!gallery.hidden) {
    const isMarveen = currentAgent && currentAgent.role === 'main'
    const avatarEndpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`

    const grid = document.getElementById('detailAvatarGrid')
    grid.innerHTML = ''
    for (const avatar of AVATARS) {
      const item = document.createElement('div')
      item.className = 'avatar-grid-item'
      item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
      item.addEventListener('click', async () => {
        try {
          const res = await fetch(avatarEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ galleryAvatar: avatar }),
          })
          if (!res.ok) throw new Error()
          showToast(t('agents.toast.avatar_updated'))
          bumpAvatarEpoch()
          const imgUrl = isMarveen ? `/api/marveen/avatar${avatarBust()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}`
          document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
          gallery.hidden = true
          loadAgents()
        } catch {
          showToast(t('agents.toast.avatar_error'))
        }
      })
      grid.appendChild(item)
    }
  }
})

// === Avatar file upload ===
;(() => {
  const zone = document.getElementById('avatarUploadZone')
  const fileInput = document.getElementById('avatarFileInput')
  const content = document.getElementById('avatarUploadContent')
  const preview = document.getElementById('avatarUploadPreview')
  const previewImg = document.getElementById('avatarPreviewImg')
  const clearBtn = document.getElementById('avatarPreviewClear')
  const MAX_SIZE = 1024 * 1024

  zone.addEventListener('click', (e) => {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return
    fileInput.click()
  })
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    resetAvatarUpload()
  })

  function resetAvatarUpload() {
    fileInput.value = ''
    content.hidden = false
    preview.hidden = true
  }

  async function handleAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
    await uploadAvatarFile(file)
  }

  async function uploadAvatarFile(file) {
    if (!currentAgent) return
    const isMarveen = currentAgent.role === 'main'
    const endpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`
    const form = new FormData()
    form.append('avatar', file, file.name)
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      showToast(t('agents.toast.avatar_uploaded'))
      bumpAvatarEpoch()
      const imgUrl = isMarveen ? `/api/marveen/avatar${avatarBust()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}`
      document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
      document.getElementById('detailAvatarGallery').hidden = true
      resetAvatarUpload()
      loadAgents()
    } catch {
      showToast(t('common.error_save'))
      resetAvatarUpload()
    }
  }
})()

// === Process control ===
function updateProcessControl(agent) {
  const running = agent.running || false
  const dot = document.getElementById('processDot')
  const label = document.getElementById('processLabel')
  const uptime = document.getElementById('processUptime')
  const startBtn = document.getElementById('agentStartBtn')
  const stopBtn = document.getElementById('agentStopBtn')

  dot.className = 'process-dot ' + (running ? 'running' : 'stopped')
  label.textContent = running ? t('agents.status.running') : t('agents.status.stopped')
  startBtn.hidden = running
  stopBtn.hidden = !running

  if (running && agent.session) {
    uptime.textContent = `tmux: ${agent.session}`
  } else {
    uptime.textContent = ''
  }
}

document.getElementById('marveenRestartBtn').addEventListener('click', async () => {
  if (!confirm(t('agents.confirm.hard_restart'))) return
  const btn = document.getElementById('marveenRestartBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/marveen/restart', { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    showToast(t('agents.toast.marveen_restarted'))
  } catch (err) {
    showToast(getErrorMessage(err.apiData, t('agents.toast.restart_failed')))
  } finally {
    btn.disabled = false
  }
})

document.getElementById('agentStartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('agentStartBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/start`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    showToast(t('agents.toast.started'))
    // Refresh
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      setCurrentAgent(await detailRes.json())
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, t('agents.toast.start_failed')))
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('agentStopBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  if (!confirm(t('agents.confirm.stop'))) return

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/stop`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    showToast(t('agents.toast.stopped'))
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      setCurrentAgent(await detailRes.json())
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, t('agents.toast.stop_failed')))
  }
})

// === Tab switching ===
document.getElementById('agentTabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn')
  if (!btn) return
  switchAgentTab(btn.dataset.tab)
})

export let currentChannelProvider = 'telegram'
// Az induláskor a backend CHANNEL_PROVIDER-jét lekérjük, és a dropdown +
// state default-ot ahhoz igazitjuk -- igy ha a backend discord-on van,
// a UI nem hardcode-olt 'telegram'-mal indul barmelyik oldalra is navigal a user.
;(async function initChannelProviderDefault() {
  try {
    const res = await fetch('/api/marveen')
    if (!res.ok) return
    const data = await res.json()
    if (!data.channelProvider || data.channelProvider === currentChannelProvider) return
    currentChannelProvider = data.channelProvider
    const sel = document.getElementById('chProviderSelect')
    if (sel) sel.value = currentChannelProvider
    if (typeof updateProviderUI === 'function') updateProviderUI()
  } catch { /* ignore -- a kepernyo default-on marad */ }
})()
let channelAutoPollTimer = null
function startChannelAutoPoll() {
  if (channelAutoPollTimer) return
  channelAutoPollTimer = setInterval(() => {
    if (!currentAgent) return
    if (document.getElementById('tabChannel').hidden) return
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }, 4000)
}
function stopChannelAutoPoll() {
  if (channelAutoPollTimer) { clearInterval(channelAutoPollTimer); channelAutoPollTimer = null }
}

export function channelApiBase() {
  return `/api/agents/${encodeURIComponent(currentAgent.name)}/channels/${currentChannelProvider}`
}

export function switchAgentTab(tab) {
  document.querySelectorAll('#agentTabNav .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  document.getElementById('tabOverview').hidden = tab !== 'overview'
  document.getElementById('tabSettings').hidden = tab !== 'settings'
  document.getElementById('tabChannel').hidden = tab !== 'channel'
  document.getElementById('tabSkills').hidden = tab !== 'skills'
  document.getElementById('tabTeam').hidden = tab !== 'team'
  document.getElementById('tabMcpScope').hidden = tab !== 'mcp-scope'
  if (tab === 'channel') startChannelAutoPoll()
  else stopChannelAutoPoll()
}

// === Settings save buttons ===
async function loadOllamaModels() {
  const group = document.getElementById('ollamaModelGroup')
  if (!group) return
  group.innerHTML = ''
  try {
    const res = await fetch('/api/ollama/models')
    const models = await res.json()
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.name
      opt.textContent = `${m.name} (${m.size})`
      group.appendChild(opt)
    }
  } catch { /* Ollama not available */ }
}

// Populates the DeepSeek optgroups in both the wizard and the agent edit
// panel. Backend gates the list behind a vault entry, so an empty array
// here means the operator has not configured an API key yet -- in that
// case we hide the optgroup and surface a hint pointing to the Vault page.
export async function loadAvailableModels() {
  try {
    const res = await fetch('/api/models/available')
    if (!res.ok) return
    const data = await res.json()
    const deepseekModels = Array.isArray(data.deepseek) ? data.deepseek : []
    const editGroup = document.getElementById('deepseekModelGroup')
    const wizardGroup = document.getElementById('agentModelDeepseekGroup')
    const hint = document.getElementById('deepseekHint')
    for (const group of [editGroup, wizardGroup]) {
      if (!group) continue
      group.innerHTML = ''
      if (deepseekModels.length === 0) {
        group.style.display = 'none'
        continue
      }
      group.style.display = ''
      for (const m of deepseekModels) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = m.label
        group.appendChild(opt)
      }
    }
    if (hint) hint.style.display = deepseekModels.length === 0 ? 'block' : 'none'

    // OpenRouter: two optgroups per select (Auto = weekly-fresh tier
    // recommendation, value `openrouter-auto:<tier>`; Manual = the 2 concrete
    // ids per tier). Backend gates the whole block behind the vault key, so a
    // null payload means OpenRouter is not connected -> keep the groups hidden.
    const or = data.openrouter
    const orTiers = or && Array.isArray(or.tiers) ? or.tiers : []
    // Auto = one entry per tier in the dropdown (weekly-fresh recommendation).
    const autoGroups = [document.getElementById('openrouterAutoGroup'), document.getElementById('agentModelOpenrouterAutoGroup')]
    for (const g of autoGroups) {
      if (!g) continue
      g.innerHTML = ''
      if (orTiers.length === 0) { g.style.display = 'none'; continue }
      g.style.display = ''
      for (const t of orTiers) {
        const opt = document.createElement('option')
        opt.value = t.autoId
        opt.textContent = `${t.label} - auto (${t.auto})`
        g.appendChild(opt)
      }
    }
    // Manual = the user-curated list -> "OpenRouter - kézi" optgroup in every
    // select. Curated once (main agent's browse popup, checkboxes); assignable
    // per agent here. Empty list -> group hidden.
    const orManual = Array.isArray(data.openrouterManual) ? data.openrouterManual : []
    openrouterCurated = new Set(orManual.map(m => m.id))
    const manualGroups = [document.getElementById('openrouterManualGroup'), document.getElementById('agentModelOpenrouterManualGroup')]
    for (const g of manualGroups) {
      if (!g) continue
      g.innerHTML = ''
      if (orManual.length === 0) { g.style.display = 'none'; continue }
      g.style.display = ''
      for (const m of orManual) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = `🔀 ${m.name || m.id}`
        g.appendChild(opt)
      }
    }
    // Browse popup = the curation UI (tick/untick which manual models exist).
    // MAIN AGENT ONLY -- sub-agents just pick from the curated dropdown above.
    // Keep the name checks for compatibility with legacy /api/marveen payloads
    // that predate the explicit role field.
    const mid = (typeof mainAgentId === 'function') ? mainAgentId() : ''
    const isMainAgent = !!currentAgent && (
      currentAgent.role === 'main' ||
      currentAgent.name === mid ||
      currentAgent.agentId === mid
    )
    const orBtn = document.getElementById('openrouterBrowseBtn')
    if (orBtn) orBtn.style.display = (data.openrouterConfigured && isMainAgent) ? '' : 'none'
  } catch { /* dashboard not available */ }
}

// --- OpenRouter manual-list curation (tick models into the shared dropdown) ---
let openrouterAllModels = null
let openrouterCurated = new Set()  // ids currently in the curated manual list

async function openOpenrouterModal() {
  const modal = document.getElementById('openrouterModal')
  const listEl = document.getElementById('openrouterModalList')
  const agentEl = document.getElementById('openrouterModalAgent')
  const searchEl = document.getElementById('openrouterModalSearch')
  const freeEl = document.getElementById('openrouterModalFreeOnly')
  if (!modal || !listEl) return
  // The modal markup lives inside the (hidden) connectors page; reparent it to
  // <body> so it renders full-viewport regardless of which tab is active.
  if (modal.parentElement !== document.body) document.body.appendChild(modal)
  if (agentEl) agentEl.textContent = (currentAgent && (currentAgent.displayName || currentAgent.name)) || 'ágens'
  // Two competing .modal-overlay CSS rules: one hides via [hidden], the other
  // via opacity/visibility (toggled by .active). Set both so the modal shows
  // regardless of which rule wins the cascade.
  modal.hidden = false
  modal.classList.add('active')
  listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px">Modellek betöltése…</div>'
  if (searchEl) searchEl.value = ''
  if (freeEl) freeEl.checked = false
  try {
    // Load the full model list (cached) and the current curated set in parallel
    // so the checkboxes render already ticked for the manual models in the list.
    const [allRes, curRes] = await Promise.all([
      openrouterAllModels ? Promise.resolve(null) : fetch('/api/openrouter/models'),
      fetch('/api/openrouter/manual'),
    ])
    if (allRes) {
      if (!allRes.ok) throw new Error('fetch failed')
      const data = await allRes.json()
      openrouterAllModels = Array.isArray(data.models) ? data.models : []
    }
    if (curRes && curRes.ok) {
      const cur = await curRes.json()
      openrouterCurated = new Set((Array.isArray(cur.models) ? cur.models : []).map(m => m.id))
    }
    renderOpenrouterList()
  } catch {
    listEl.innerHTML = '<div style="padding:14px;color:var(--danger,#dc2626);font-size:13px">Nem sikerült betölteni az OpenRouter modelleket.</div>'
  }
}

function renderOpenrouterList() {
  const listEl = document.getElementById('openrouterModalList')
  const countEl = document.getElementById('openrouterModalCount')
  const q = (document.getElementById('openrouterModalSearch')?.value || '').toLowerCase().trim()
  const freeOnly = !!document.getElementById('openrouterModalFreeOnly')?.checked
  if (!listEl || !openrouterAllModels) return
  const rows = openrouterAllModels.filter(m => {
    if (freeOnly && !m.free) return false
    if (!q) return true
    return (m.id + ' ' + m.name).toLowerCase().includes(q)
  })
  // Ticked (curated) models float to the top so the current selection is visible.
  rows.sort((a, b) => {
    const ca = openrouterCurated.has(a.id), cb = openrouterCurated.has(b.id)
    if (ca !== cb) return ca ? -1 : 1
    return a.id.localeCompare(b.id)
  })
  if (countEl) countEl.textContent = `${rows.length} modell · ${openrouterCurated.size} kézi listán`
  listEl.innerHTML = ''
  for (const m of rows.slice(0, 400)) {
    const checked = openrouterCurated.has(m.id)
    const row = document.createElement('label')
    row.className = 'openrouter-model-row'
    row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px'
    const price = m.free ? '<span style="color:var(--success,#16a34a);font-weight:600">ingyenes</span>'
      : `$${m.promptPrice.toFixed(2)}/$${m.completionPrice.toFixed(2)} /M`
    const ctx = m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : ''
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = checked
    cb.style.cssText = 'margin-top:3px;flex:0 0 auto'
    cb.addEventListener('change', () => toggleCuratedModel(m.id, m.name, cb.checked))
    const info = document.createElement('div')
    info.style.cssText = 'flex:1 1 auto;min-width:0'
    info.innerHTML = `<div style="font-weight:600">${escapeHtml(m.name)}</div>`
      + `<div style="color:var(--text-muted);font-size:11.5px"><code>${escapeHtml(m.id)}</code> · ${price}${ctx}</div>`
    row.appendChild(cb)
    row.appendChild(info)
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface-hover, #f1f5f9)' })
    row.addEventListener('mouseleave', () => { row.style.background = '' })
    listEl.appendChild(row)
  }
  if (rows.length === 0) listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px">Nincs találat.</div>'
}

// Tick/untick a model into the curated manual list. Persists server-side, then
// refreshes the shared dropdown so the "kézi" optgroup reflects the change.
async function toggleCuratedModel(id, name, checked) {
  // Optimistic local update so the checkbox + counter feel instant.
  if (checked) openrouterCurated.add(id); else openrouterCurated.delete(id)
  const countEl = document.getElementById('openrouterModalCount')
  if (countEl) {
    const total = countEl.textContent.split('·')[0].trim()
    countEl.textContent = `${total} · ${openrouterCurated.size} kézi listán`
  }
  try {
    const res = await fetch('/api/openrouter/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, checked }),
    })
    if (!res.ok) throw new Error('save failed')
    const data = await res.json()
    openrouterCurated = new Set((Array.isArray(data.models) ? data.models : []).map(m => m.id))
    // Repopulate the dropdown "kézi" optgroups without disturbing selections.
    loadAvailableModels()
  } catch {
    // Roll back the optimistic change on failure.
    if (checked) openrouterCurated.delete(id); else openrouterCurated.add(id)
    renderOpenrouterList()
  }
}

function closeOpenrouterModal() {
  const modal = document.getElementById('openrouterModal')
  if (modal) { modal.hidden = true; modal.classList.remove('active') }
}

document.getElementById('openrouterBrowseBtn')?.addEventListener('click', openOpenrouterModal)
document.getElementById('openrouterModalClose')?.addEventListener('click', closeOpenrouterModal)
document.getElementById('openrouterModalCancel')?.addEventListener('click', closeOpenrouterModal)
document.getElementById('openrouterModalSearch')?.addEventListener('input', renderOpenrouterList)
document.getElementById('openrouterModalFreeOnly')?.addEventListener('change', renderOpenrouterList)

let modelRestartPollTimer = null
let modelRestartPollName = null

function stopModelRestartPolling() {
  if (modelRestartPollTimer) { clearInterval(modelRestartPollTimer); modelRestartPollTimer = null }
  modelRestartPollName = null
}

function startModelRestartPolling(name, expectedModel, triggeredAt) {
  stopModelRestartPolling()
  modelRestartPollName = name
  const badge = document.getElementById('agentDetailModelRestarting')
  const display = document.getElementById('agentDetailModel')
  const processLabel = document.getElementById('processLabel')
  const processDot = document.getElementById('processDot')
  const deadline = Date.now() + 60000
  modelRestartPollTimer = setInterval(async () => {
    if (modelRestartPollName !== name || !currentAgent || currentAgent.name !== name) {
      stopModelRestartPolling(); return
    }
    if (Date.now() > deadline) {
      stopModelRestartPolling()
      badge.hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.toast.restart_state_error'))
      return
    }
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(name)}`)
      if (!r.ok) return
      const data = await r.json()
      // The new tmux session's creation timestamp is the reliable "restart
      // complete" signal. Claude Code writes the "model" field into the
      // session jsonl only when it answers a message, so activeModel may
      // stay null/old until the agent receives its first prompt -- waiting
      // for that match would time out on idle agents. The configured model
      // is what the agent was just started with via --model.
      const restarted = data.runningSince && data.runningSince >= triggeredAt
      if (restarted) {
        const displayModel = data.activeModel || data.model
        if (currentAgent && currentAgent.name === name) {
          currentAgent.activeModel = data.activeModel
          currentAgent.runningSince = data.runningSince
          currentAgent.model = data.model
          currentAgent.running = !!data.running
          currentAgent.session = data.session
          display.textContent = displayModel
        }
        badge.hidden = true
        processDot.className = 'process-dot running'
        processLabel.textContent = t('agents.status.running')
        stopModelRestartPolling()
        const liveMatched = data.activeModel === expectedModel
        showToast(liveMatched
          ? t('agents.model.toast_active', { model: displayModel })
          : t('agents.model.toast_restarted', { model: displayModel }))
      }
    } catch { /* network blip, keep polling */ }
  }, 2000)
}

document.getElementById('saveModelBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const newModel = document.getElementById('editAgentModel').value
  const name = currentAgent.name
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newModel }),
    })
    if (!res.ok) throw new Error()
    currentAgent.model = newModel
    const triggeredAt = Math.floor(Date.now() / 1000)
    document.getElementById('agentDetailModelRestarting').hidden = false
    document.getElementById('processLabel').textContent = t('agents.process_label')
    document.getElementById('processDot').className = 'process-dot restarting'
    showToast(t('agents.toast.model_save_restart'))
    loadAgents()
    const restartRes = await fetch(`/api/agents/${encodeURIComponent(name)}/restart`, { method: 'POST' })
    if (!restartRes.ok) {
      document.getElementById('agentDetailModelRestarting').hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.restart_failed'))
      return
    }
    startModelRestartPolling(name, newModel, triggeredAt)
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('modelSuggestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const resultDiv = document.getElementById('modelSuggestionResult')
  resultDiv.style.display = 'block'
  resultDiv.textContent = t('agents.model.analyzing')
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const entry = results.find(r => r.agent === currentAgent.name)
    if (!entry) {
      resultDiv.textContent = t('agents.model.no_data')
      return
    }
    resultDiv.style.color = entry.changeAdvised ? 'var(--warning, #e6a817)' : 'var(--success)'
    resultDiv.style.whiteSpace = 'pre-wrap'
    resultDiv.style.fontFamily = 'monospace'
    resultDiv.style.fontSize = '12px'
    resultDiv.textContent = entry.reason
  } catch { resultDiv.textContent = t('agents.model.error') }
})

document.getElementById('analyzeAllModelsBtn').addEventListener('click', async () => {
  const panel = document.getElementById('agentsModelAnalysis')
  panel.style.display = 'block'
  panel.innerHTML = '<p style="color:var(--text-muted);font-size:13px">' + t('agents.model.analyzing_all') + '</p>'
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const changes = results.filter(r => r.changeAdvised)
    const ok = results.filter(r => !r.changeAdvised)
    let html = '<div style="font-size:13px;padding:12px 14px;background:var(--surface-hover);border-radius:8px;border:1px solid var(--border)">'
    html += `<p style="margin:0 0 8px;font-weight:600">${t('agents.model.title', { n: results.length })}</p>`
    if (changes.length === 0) {
      html += '<p style="color:var(--success);margin:0">' + t('agents.model.all_ok') + '</p>'
    } else {
      html += `<p style="color:var(--warning, #e6a817);margin:0 0 8px">${t('agents.model.changes_n', { n: changes.length })}</p>`
      html += '<ul style="margin:0 0 10px;padding-left:18px">'
      for (const r of changes) {
        const safeReason = r.reason.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        html += `<li style="margin-bottom:6px"><strong>${r.agent}</strong>: ${r.currentModel} &rarr; ${r.suggestedModel}`
        html += ` <details style="display:inline-block;vertical-align:top;margin-left:4px"><summary style="cursor:pointer;font-size:11px;color:var(--text-muted)">${t('agents.model.details')}</summary>`
        html += `<pre style="white-space:pre-wrap;font-size:11px;margin:4px 0 0;background:var(--surface);padding:6px 8px;border-radius:4px;color:var(--text-muted)">${safeReason}</pre></details></li>`
      }
      html += '</ul>'
      if (ok.length > 0) {
        html += `<p style="color:var(--text-muted);margin:0;font-size:12px">${t('agents.model.ok_agents', { list: ok.map(r => r.agent).join(', ') })}</p>`
      }
      html += `<button class="btn" data-variant="secondary" data-size="compact" id="createModelChangeCardsBtn" style="margin-top:10px">${t('agents.model.create_cards_btn')}</button>`
    }
    html += '</div>'
    panel.innerHTML = html
    const createBtn = document.getElementById('createModelChangeCardsBtn')
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        if (!confirm(t('agents.model.cards_confirm', { n: changes.length }))) return
        createBtn.disabled = true
        createBtn.textContent = t('agents.model.creating_cards')
        let created = 0
        for (const r of changes) {
          try {
            await fetch('/api/kanban', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: t('agents.model.card_title', { agent: r.agent }),
                description: t('agents.model.card_desc', { current: r.currentModel, suggested: r.suggestedModel, reason: r.reason }),
                assignee: mainAgentId(),
                priority: 'normal',
                status: 'planned',
              }),
            })
            created++
          } catch { /* skip failed card */ }
        }
        showToast(t('agents.model.cards_created', { n: created }))
        createBtn.textContent = t('agents.model.cards_created', { n: created })
      })
    }
  } catch { panel.innerHTML = '<p style="color:var(--error);font-size:13px">' + t('agents.model.error') + '</p>' }
})

// === Export ALL agents (whole fleet) into one .tar.gz bundle ===
const exportAllAgentsBtn = document.getElementById('exportAllAgentsBtn')
if (exportAllAgentsBtn) {
  exportAllAgentsBtn.addEventListener('click', async () => {
    const withSecrets = confirm(
      'Belevegyük a titkokat (channel bot tokenek, párosítási állapot) MINDEN ügynöknél?\n\n' +
      'OK = igen, csak saját gépek közötti átvitelhez.\n' +
      'Mégse = nem, biztonságosan megosztható (csak identitás + viselkedés).'
    )
    const url = `/api/agents/export-all${withSecrets ? '?secrets=1' : ''}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(getErrorMessage(data, 'Hiba az exportálás során'))
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = 'marveen-fleet.tar.gz'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
      showToast(`Flotta exportálva${withSecrets ? ' (titkokkal)' : ''}`)
    } catch {
      showToast('Hiba az exportálás során')
    }
  })
}

// === Agent import (upload a .tar.gz bundle exported from another machine) ===
// Accepts both a single-agent bundle and a whole-fleet bundle -- the backend
// auto-detects the format from the manifest.
const importAgentBtn = document.getElementById('importAgentBtn')
const importAgentFile = document.getElementById('importAgentFile')
if (importAgentBtn && importAgentFile) {
  importAgentBtn.addEventListener('click', () => importAgentFile.click())
  importAgentFile.addEventListener('change', async () => {
    const file = importAgentFile.files && importAgentFile.files[0]
    if (!file) return
    // Reset the input so picking the same file again re-fires change.
    const upload = async (overwrite) => {
      const form = new FormData()
      form.append('file', file)
      if (overwrite) form.append('overwrite', '1')
      const res = await fetch('/api/agents/import', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      return { res, data }
    }
    try {
      let { res, data } = await upload(false)
      if (res.status === 409) {
        const prompt = data.kind === 'fleet'
          ? 'Néhány ügynök már létezik ezen a gépen. Felülírjuk az ütközőket?'
          : `Már létezik "${data.name || ''}" nevű ügynök. Felülírjuk?`
        if (confirm(prompt)) {
          ;({ res, data } = await upload(true))
        } else {
          return
        }
      }
      if (!res.ok) { showToast(getErrorMessage(data, 'Hiba az importálás során')); return }
      const note = data.includedSecrets ? ' (titkokkal)' : ''
      if (data.kind === 'fleet') {
        const n = (data.imported || []).length
        const skipped = (data.skipped || []).length
        showToast(`Flotta importálva: ${n} ügynök${note}${skipped ? ` (${skipped} kihagyva)` : ''}`)
      } else {
        showToast(`Ügynök importálva: ${data.name}${note}${data.overwritten ? ' (felülírva)' : ''}`)
      }
      loadAgents()
    } catch {
      showToast('Hiba az importálás során')
    } finally {
      importAgentFile.value = ''
    }
  })
}

document.getElementById('saveAutoRestartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  // Auto-restart applies to the main session too, so (unlike model/profile) we
  // do NOT skip role === 'main'. The store key is autoRestartId for the main
  // session, the sanitized name for sub-agents.
  const id = currentAgent.autoRestartId || currentAgent.name
  const schedKind = document.getElementById('arSchedKind').value
  const cfg = {
    enabled: document.getElementById('arEnabled').checked,
    mode: document.getElementById('arMode').value === 'fresh' ? 'fresh' : 'continue',
    dailyTime: schedKind === 'daily' ? document.getElementById('arDailyTime').value : null,
    intervalHours: schedKind === 'interval' ? Number(document.getElementById('arIntervalHours').value) : null,
    handoff: false,
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/auto-restart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    if (currentAgent) currentAgent.autoRestart = body.autoRestart
    showToast(t('agents.toast.auto_restart_saved'))
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveIdleFlushBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  // Like auto-restart, this applies to the main session too, so role === 'main'
  // is NOT skipped. The context-guard store is keyed by the same id.
  const id = currentAgent.autoRestartId || currentAgent.name
  // Send the WHOLE config, not just the three idle fields. The endpoint
  // normalizes the body into a complete config, so a fragment would silently
  // reset actPct/hardPct/saturationRestart/enabled to their defaults -- saving
  // an idle-flush preference would disarm the wedge tiers on an agent that had
  // them on. Re-read rather than trusting the cached detail: not every path
  // that opens this pane populates contextGuard, and an empty object here is
  // indistinguishable from a genuinely default config.
  let current = {}
  try {
    const cur = await fetch(`/api/agents/${encodeURIComponent(id)}/context-guard`)
    if (!cur.ok) throw new Error()
    current = (await cur.json()).contextGuard || {}
  } catch { showToast(t('common.error_save')); return }
  const cfg = Object.assign({}, current, {
    idleFlushEnabled: document.getElementById('ifEnabled').checked,
    idleFlushTokens: Math.round(Number(document.getElementById('ifTokens').value) * 1000),
    idleMinutes: Number(document.getElementById('ifMinutes').value),
  })
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/context-guard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    if (currentAgent) currentAgent.contextGuard = body.contextGuard
    showToast(t('agents.toast.idle_flush_saved'))
  } catch { showToast(t('common.error_save')) }
})

// ---- voice config UI -------------------------------------------------------

async function loadVoiceConfig(agentName) {
  const voiceModelSel = document.getElementById('editAgentVoiceModel')
  if (!voiceModelSel) return
  const banner = document.getElementById('voiceNotInstalledBanner')
  const controls = document.getElementById('voiceInstalledControls')
  try {
    // Check toolkit installation first
    const statusR = await fetch('/api/voice/status')
    if (!statusR.ok) return
    const status = await statusR.json()

    if (!status.installed) {
      if (banner) banner.hidden = false
      if (controls) controls.hidden = true
      return
    }
    if (banner) banner.hidden = true
    if (controls) controls.hidden = false

    const r = await fetch(`/api/agents/${encodeURIComponent(agentName)}/voice-config`)
    if (!r.ok) return
    const cfg = await r.json()
    voiceModelSel.innerHTML = (cfg.availableVoices || []).map(v =>
      `<option value="${v}"${v === cfg.voiceModel ? ' selected' : ''}>${v}</option>`
    ).join('')
    const modeInput = document.querySelector(`input[name="voiceResponseMode"][value="${cfg.responseMode || 'text'}"]`)
    if (modeInput) modeInput.checked = true
  } catch { /* silent */ }
}

let _voiceInstallPollTimer = null

document.getElementById('voiceInstallBtn').addEventListener('click', async () => {
  const btn = document.getElementById('voiceInstallBtn')
  const sudoHint = document.getElementById('voiceInstallSudoHint')
  const progress = document.getElementById('voiceInstallProgress')

  if (sudoHint) sudoHint.hidden = true
  btn.disabled = true
  btn.textContent = 'Indítás...'

  try {
    const r = await fetch('/api/voice/install', { method: 'POST' })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()

    if (data.needsSudo) {
      // Show sudo command -- user must run it then click again
      if (sudoHint) {
        sudoHint.hidden = false
        sudoHint.innerHTML = 'A rendszercsomagok telepítéséhez futtasd terminálon:<br><code style="display:block;margin-top:4px;word-break:break-all">' + escapeHtml(data.sudoCommand) + '</code><br>Ezután kattints újra a Telepítés gombra.'
      }
      btn.disabled = false
      btn.textContent = 'Telepítés'
      return
    }

    if (data.alreadyInstalled) {
      if (currentAgent) loadVoiceConfig(currentAgent.name)
      return
    }

    // Install started -- poll /api/voice/status until installed=true.
    // Max 4 minutes (80 × 3s); on timeout show a hint and re-enable the button
    // so the user can retry (the only failure signal from a fire-and-forget spawn).
    if (progress) progress.hidden = false
    btn.textContent = 'Telepítés...'
    clearInterval(_voiceInstallPollTimer)
    let _voiceInstallPollCount = 0
    const VOICE_INSTALL_MAX_POLLS = 80 // 80 × 3s = 4 min
    _voiceInstallPollTimer = setInterval(async () => {
      _voiceInstallPollCount++
      try {
        const sr = await fetch('/api/voice/status')
        const s = await sr.json()
        if (s.installed) {
          clearInterval(_voiceInstallPollTimer)
          _voiceInstallPollTimer = null
          if (progress) progress.hidden = true
          if (currentAgent) loadVoiceConfig(currentAgent.name)
          return
        }
      } catch { /* keep polling */ }
      if (_voiceInstallPollCount >= VOICE_INSTALL_MAX_POLLS) {
        clearInterval(_voiceInstallPollTimer)
        _voiceInstallPollTimer = null
        if (progress) progress.hidden = true
        if (sudoHint) {
          sudoHint.hidden = false
          sudoHint.textContent = 'A telepítés tovább tart vagy elakadt. Ellenőrizd a dashboard logjait, majd próbáld újra.'
        }
        btn.disabled = false
        btn.textContent = 'Újrapróbálás'
      }
    }, 3000)
  } catch {
    btn.disabled = false
    btn.textContent = 'Telepítés'
    showToast('Hiba a telepítés során')
  }
})

document.getElementById('saveVoiceConfigBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const modeEl = document.querySelector('input[name="voiceResponseMode"]:checked')
  const modelEl = document.getElementById('editAgentVoiceModel')
  if (!modeEl || !modelEl) return
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/voice-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseMode: modeEl.value, voiceModel: modelEl.value }),
    })
    if (!r.ok) throw new Error()
    showToast('Hangbeállítás mentve')
  } catch { showToast('Hiba a mentés során') }
})

document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const profile = document.getElementById('editAgentProfile').value
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/security`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    showToast(body.requiresRestart ? t('agents.toast.profile_saved_restart') : t('agents.toast.profile_saved'))
    loadAgents()
  } catch { showToast(t('agents.toast.profile_error')) }
})

document.getElementById('savePlanBtn').addEventListener('click', async () => {
  // The main agent's login comes up via channels.sh, not this path, so its
  // plan is not settable here (the selector is hidden for it anyway).
  if (!currentAgent || currentAgent.role === 'main') return
  const claudePlan = document.getElementById('editAgentPlan').value
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudePlan }),
    })
    if (!res.ok) throw new Error()
    currentAgent.claudePlan = claudePlan || null
    showToast(t('agents.toast.plan_saved'))
    loadAgents()
  } catch { showToast(t('agents.toast.plan_error')) }
})

// === Auth Mode ===
function selectAuthModeCard(mode) {
  document.querySelectorAll('.auth-mode-card').forEach(c => {
    const isSelected = c.dataset.mode === mode
    c.classList.toggle('selected', isSelected)
    c.querySelector('input[type="radio"]').checked = isSelected
  })
  document.getElementById('authModeSharedSection').hidden = mode !== 'shared'
  document.getElementById('authModeApiKeySection').hidden = mode !== 'api'
  document.getElementById('authModeOwnTeamSection').hidden = mode !== 'own_team'
  document.getElementById('authFlowResult').hidden = true
  document.getElementById('authFlowError').hidden = true
  document.getElementById('authSharedError').hidden = true
}

function updateAuthModeUI(mode, hasApiKey) {
  selectAuthModeCard(mode)
  const keyInput = document.getElementById('editAgentApiKey')
  keyInput.value = ''
  if (mode === 'api') {
    const statusEl = document.getElementById('authModeApiKeyStatus')
    statusEl.textContent = hasApiKey ? t('agents.api_key.ok') : t('agents.api_key.missing')
    statusEl.style.color = hasApiKey ? 'var(--success)' : 'var(--warning)'
  }
}

document.querySelectorAll('.auth-mode-card').forEach(card => {
  card.addEventListener('click', () => {
    selectAuthModeCard(card.dataset.mode)
  })
})

document.getElementById('authSharedApplyBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authSharedApplyBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const errorDiv = document.getElementById('authSharedError')
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const base = `/api/agents/${encodeURIComponent(currentAgent.name)}`
    const saveRes = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMode: 'shared' }),
    })
    if (!saveRes.ok) throw new Error('Save failed')
    if (currentAgent.running) {
      await fetch(`${base}/stop`, { method: 'POST' })
      await new Promise(r => setTimeout(r, 2000))
      const startRes = await fetch(`${base}/start`, { method: 'POST' })
      const startData = await startRes.json()
      if (!startRes.ok) {
        errorDiv.textContent = getErrorMessage(startData, t('agents.error.restart'))
        errorDiv.hidden = false
        return
      }
    }
    showToast(t('agents.toast.host_oauth_restart'))
    loadAgents()
    const detailRes = await fetch(base)
    if (detailRes.ok) {
      setCurrentAgent(await detailRes.json())
      updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
      updateProcessControl(currentAgent)
    }
  } catch {
    errorDiv.textContent = t('agents.error.apply')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowInitBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authFlowInitBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const resultDiv = document.getElementById('authFlowResult')
  const errorDiv = document.getElementById('authFlowError')
  resultDiv.hidden = true
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (data.ok && data.authUrl) {
      const urlEl = document.getElementById('authFlowUrl')
      urlEl.href = data.authUrl
      urlEl.textContent = data.authUrl
      resultDiv.hidden = false
    } else {
      errorDiv.textContent = getErrorMessage(data, 'Auth URL nem talalhato')
      errorDiv.hidden = false
    }
  } catch {
    errorDiv.textContent = t('agents.error.auth_network')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowCopyBtn').addEventListener('click', () => {
  const url = document.getElementById('authFlowUrl').textContent
  navigator.clipboard.writeText(url).then(() => showToast('URL masolva'))
})

document.getElementById('memoryIsolationToggle').addEventListener('change', async (e) => {
  if (!currentAgent || currentAgent.role === 'main') return
  const enabled = e.target.checked
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryIsolation: enabled }),
    })
    if (!res.ok) throw new Error()
    currentAgent.memoryIsolation = enabled
    showToast(t(enabled ? 'agents.toast.memory_isolation_on' : 'agents.toast.memory_isolation_off'))
  } catch {
    e.target.checked = !enabled
    showToast(t('common.error_save'))
  }
})

document.getElementById('saveAuthModeBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const mode = document.querySelector('input[name="authMode"]:checked')?.value || 'shared'
  const payload = { authMode: mode }
  if (mode === 'api') {
    const key = document.getElementById('editAgentApiKey').value.trim()
    if (key) payload.apiKey = key
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.toast.auth_mode_saved'))
    loadAgents()
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      const updated = await detailRes.json()
      setCurrentAgent(updated)
      updateAuthModeUI(updated.authMode || 'shared', updated.hasApiKey || false)
    }
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveClaudeMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd: document.getElementById('editClaudeMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.claude_md_saved'))
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveSoulMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soulMd: document.getElementById('editSoulMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.soul_md_saved'))
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveMcpJsonBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpJson: document.getElementById('editMcpJson').value }),
    })
    if (!res.ok) throw new Error()
    showToast('.mcp.json mentve')
  } catch { showToast(t('common.error_save')) }
})

