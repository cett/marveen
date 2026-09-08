// Agent create-wizard (split out of agents.js for #773/#776).
// Owns the wizard step/profile/personality-generation state; only ever
// mutated from within this file. Lazy in the functional sense: this code
// path only runs during the create-agent flow.

import { t } from './i18n.js'
import { showToast } from './toast.js'
import { getErrorMessage } from './error-message.js'
import {
  _closeModal, agentDesc, agentModel, agentName, agentWizardOverlay,
  agents, loadAgents, populateAvatarGrid,
  selectedAvatar, selectedAvatarFile, setSelectedAvatar, setSelectedAvatarFile,
} from './agents.js'
import { loadAvailableModels, openAgentDetail, switchAgentTab } from './agents-detail.js'

let wizardStep = 1
let generatedClaudeMd = ''
let generatedSoulMd = ''
let wizardCreatedName = ''
// Set from the POST /api/agents response when the backend fell back to a template
// because personality generation failed. It answers 200 in that case (the agent
// EXISTS and works), so `res.ok` alone cannot tell the operator anything -- without
// reading this field the wizard would look exactly like a full success.
let wizardPersonalityPending = null
// === Wizard logic ===
let cachedProfiles = null
async function loadProfiles() {
  if (cachedProfiles) return cachedProfiles
  try {
    const res = await fetch('/api/profiles')
    if (res.ok) cachedProfiles = await res.json()
  } catch {}
  return cachedProfiles || []
}

export function populateProfileSelect(selectEl, descEl, selected) {
  loadProfiles().then((profiles) => {
    selectEl.innerHTML = ''
    for (const p of profiles) {
      const opt = document.createElement('option')
      opt.value = p.id
      const tag = p.permissionMode === 'strict' ? ` (${t('agents.strict_mode')})` : ''
      opt.textContent = `${p.label}${tag}`
      if (p.id === selected) opt.selected = true
      selectEl.appendChild(opt)
    }
    const updateDesc = () => {
      const p = profiles.find(x => x.id === selectEl.value)
      descEl.textContent = p ? p.description : ''
    }
    selectEl.onchange = updateDesc
    updateDesc()
  })
}

// Populate the per-agent Claude subscription plan dropdown from the named
// registry (/api/claude-plans). The empty value means "no named plan" -> the
// agent keeps its raw config-dir / host default. The description line shows the
// plan type + config dir and flags a Channels-forbidden plan so the operator
// sees the guardrail context before saving.
export function populatePlanSelect(selectEl, descEl, selected) {
  if (!selectEl) return
  fetch('/api/claude-plans')
    .then(res => (res.ok ? res.json() : []))
    .catch(() => [])
    .then((plans) => {
      const known = plans.some(p => p.id === selected)
      const opts = [`<option value="">${escapeHtml(t('agents.settings.plan_default'))}</option>`]
      for (const p of plans) {
        opts.push(`<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
      }
      // Preserve an already-assigned plan id that is NOT in the loaded registry
      // (registry edited/renamed, OR /api/claude-plans transiently failed and
      // returned []). Without this the dropdown would resolve to '' and a save
      // would silently wipe the real assignment.
      if (selected && !known) {
        opts.push(`<option value="${escapeHtml(selected)}">${escapeHtml(selected)}${escapeHtml(t('agents.settings.plan_not_found_suffix'))}</option>`)
      }
      selectEl.innerHTML = opts.join('')
      selectEl.value = selected || ''
      const updateDesc = () => {
        if (!descEl) return
        const val = selectEl.value
        if (!val) {
          descEl.textContent = t('agents.settings.plan_default_desc')
          return
        }
        const p = plans.find(x => x.id === val)
        if (!p) {
          descEl.textContent = t('agents.settings.plan_unresolved_desc', { id: val })
          return
        }
        const warn = p.channelsAllowed ? '' : t('agents.settings.plan_no_channels')
        descEl.textContent = `${p.planType} · ${p.configDir}${warn}`
      }
      selectEl.onchange = updateDesc
      updateDesc()
    })
}

export function resetWizard() {
  wizardStep = 1
  agentName.value = ''
  agentDesc.value = ''
  agentModel.value = 'inherit'
  loadAvailableModels()
  setSelectedAvatar(null)
  setSelectedAvatarFile(null)
  document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
  resetCreateAvatarUpload()
  generatedClaudeMd = ''
  generatedSoulMd = ''
  wizardCreatedName = ''
  wizardPersonalityPending = null
  renderWizardPendingBanner()
  document.getElementById('wizardClaudeMd').value = ''
  document.getElementById('wizardSoulMd').value = ''
  populateProfileSelect(
    document.getElementById('agentProfile'),
    document.getElementById('agentProfileDesc'),
    'default',
  )
  updateWizardUI()
}

// Paints (or clears) the step-3 notice from wizardPersonalityPending. Called from
// resetWizard() too, so a later successful run can never inherit a stale banner.
function renderWizardPendingBanner() {
  const banner = document.getElementById('wizardPendingBanner')
  if (!banner) return
  if (!wizardPersonalityPending) {
    banner.hidden = true
    return
  }
  document.getElementById('wizardPendingTitle').textContent = t('agents.wizard.pending_title')
  document.getElementById('wizardPendingBody').textContent = t('agents.wizard.pending_body')
  const detailEl = document.getElementById('wizardPendingDetail')
  const detail = wizardPersonalityPending.detail
  // The cause is shown, but only when the server actually sent one: an empty
  // string here would render "A hiba oka: " with nothing after it, which reads
  // like the UI lost something.
  if (detail) {
    detailEl.textContent = t('agents.wizard.pending_detail', { detail })
    detailEl.hidden = false
  } else {
    detailEl.textContent = ''
    detailEl.hidden = true
  }
  banner.hidden = false
}

function updateWizardUI() {
  // Steps indicator
  document.querySelectorAll('#wizardSteps .wizard-step').forEach((s) => {
    const step = parseInt(s.dataset.step)
    s.classList.toggle('active', step === wizardStep)
    s.classList.toggle('done', step < wizardStep)
  })
  // Panels
  document.getElementById('wizardStep1').hidden = wizardStep !== 1
  document.getElementById('wizardStep2').hidden = wizardStep !== 2
  document.getElementById('wizardStep3').hidden = wizardStep !== 3
}

// Step 1 -> Step 2 (generate)
document.getElementById('wizardNextBtn').addEventListener('click', async () => {
  const name = agentName.value.trim()
  const desc = agentDesc.value.trim()
  if (!name) { agentName.focus(); return }
  if (!desc) { agentDesc.focus(); return }

  wizardStep = 2
  updateWizardUI()

  const statusEl = document.getElementById('wizardGenStatus')
  statusEl.textContent = t('agents.claude_md_generating')

  try {
    // Create agent via API (returns generated content)
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: desc,
        model: agentModel.value,
        profile: document.getElementById('agentProfile').value,
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }

    const result = await res.json()
    // 200 + personalityPending means the agent was created but its personality
    // came from a template. Captured here and painted when step 3 opens, where
    // the operator both sees the placeholder text and can rewrite it.
    wizardPersonalityPending = result.personalityPending
      ? { detail: result.detail || '', warning: result.warning || '' }
      : null
    // Backend sanitizes the name (lowercase ASCII, NFD-stripped accents).
    // Use the sanitized form for every follow-up request so accented input
    // like "étrendíró" still resolves to the real agent dir "etrendiro".
    const createdName = result.name || name
    wizardCreatedName = createdName
    statusEl.textContent = t('agents.soul_md_generating')

    // Fetch full agent details to get generated content
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(createdName)}`)
    if (detailRes.ok) {
      const detail = await detailRes.json()
      generatedClaudeMd = detail.claudeMd || detail.content || ''
      generatedSoulMd = detail.soulMd || ''
    }

    statusEl.textContent = t('kanban.breakdown.running')

    // Apply the chosen avatar. Custom upload wins over a gallery pick; both go
    // to the same endpoint (FormData for a file, JSON for a gallery name).
    if (selectedAvatarFile) {
      const form = new FormData()
      form.append('avatar', selectedAvatarFile, selectedAvatarFile.name)
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
        method: 'POST',
        body: form,
      })
    } else if (selectedAvatar) {
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ galleryAvatar: selectedAvatar }),
      })
    }

    // Auto-advance to step 3
    setTimeout(() => {
      wizardStep = 3
      document.getElementById('wizardClaudeMd').value = generatedClaudeMd
      document.getElementById('wizardSoulMd').value = generatedSoulMd
      renderWizardPendingBanner()
      updateWizardUI()
    }, 600)
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Ismeretlen hiba'))
    wizardStep = 1
    updateWizardUI()
  }
})

// Step 3 -> back to step 1
document.getElementById('wizardBackBtn').addEventListener('click', () => {
  wizardStep = 1
  updateWizardUI()
})

// Step 3 -> Create (finalize with edits)
document.getElementById('wizardCreateBtn').addEventListener('click', async () => {
  // Use the backend-sanitized name stored in wizardCreatedName, not the raw
  // input field -- accents in the input would miss the real agent dir.
  const name = wizardCreatedName || agentName.value.trim()
  const claudeMd = document.getElementById('wizardClaudeMd').value
  const soulMd = document.getElementById('wizardSoulMd').value
  const createBtn = document.getElementById('wizardCreateBtn')

  createBtn.disabled = true
  createBtn.querySelector('.btn-text').hidden = true
  createBtn.querySelector('.btn-loading').hidden = false

  try {
    // Update with edited content
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd, soulMd }),
    })

    if (!res.ok) {
      const err = await res.json()
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }

    _closeModal?.(agentWizardOverlay)
    showToast('Ugynok letrehozva. Kosd be a csatornat a parosatashoz.')
    await loadAgents()
    // Drop the operator straight into the Telegram tab of the new agent so
    // the pairing step is in front of them -- easy to miss otherwise.
    try {
      await openAgentDetail(name)
      switchAgentTab('channel')
    } catch { /* detail open failed, list refresh already happened */ }
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Ismeretlen hiba'))
  } finally {
    createBtn.disabled = false
    createBtn.querySelector('.btn-text').hidden = false
    createBtn.querySelector('.btn-loading').hidden = true
  }
})

// showToast is imported from web/modules/toast.js (S-1 POC, issue #3)

// === Create-wizard avatar upload ===
// Mirrors the detail-modal uploader, but the agent does not exist yet, so the
// file is held in `selectedAvatarFile` and POSTed after creation (see the
// wizard create flow). Hoisted so populateAvatarGrid()/resetWizard() can reset.
export function resetCreateAvatarUpload() {
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  if (!fileInput || !content || !preview) return
  fileInput.value = ''
  content.hidden = false
  preview.hidden = true
}
;(() => {
  const zone = document.getElementById('createAvatarUploadZone')
  if (!zone) return
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  const previewImg = document.getElementById('createAvatarPreviewImg')
  const clearBtn = document.getElementById('createAvatarPreviewClear')
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
    if (file) handleCreateAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleCreateAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    setSelectedAvatarFile(null)
    resetCreateAvatarUpload()
  })

  function handleCreateAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    // Custom upload and gallery pick are mutually exclusive.
    setSelectedAvatar(null)
    document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
    setSelectedAvatarFile(file)
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
  }
})()

