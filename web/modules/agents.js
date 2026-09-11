// Agents view hub (S-6, issue #3; split into 5 files for #773/#776).
//
// This file holds the Elements/Avatar-Gallery declarations, the Agents API
// (load/render/federation), and the live-tint Terminal-button poller. The
// create-wizard, detail-modal, channel-config and org-chart pieces live in
// their own modules (agents-wizard.js / agents-detail.js /
// agents-channels.js / agents-org-chart.js) and are always loaded alongside
// this one (native ES module static imports, same as the rest of this
// directory) -- "lazy" in the split plan describes when each piece's code
// PATHS activate at runtime (wizard open, modal open, tab click, view
// toggle), not a deferred network fetch.
//
// Exports:
//   initAgents(opts)           -- inject DI callbacks from app.js
//   loadAgents()               -- fetch + render agent grid
//   startAgentsBusyPoll()      -- terminal-busy tint poller (page enter)
//   stopAgentsBusyPoll()       -- stop poller (page leave)
//   openMarveenDetail()        -- open main-agent detail modal
//   setAgentsView(view)        -- switch grid/tree, triggers DOM update (re-exported from agents-org-chart.js)
//   getAgentsActiveView()      -- current view name (for registerPage enter)
//   setAgentsActiveView(v)     -- set view without DOM (for alias callback)
//   getFederatedPeerStatus()   -- read access for Messages page
//   setFederatedPeerStatus(p)  -- updated by loadAgents + loadChatAgentList
//   federatedAgentEntries()    -- used by Messages page sidebar
//   avatarBust()               -- cache-buster query string for avatar URLs
//   loadAvailableModels()      -- re-exported from agents-detail.js (app.js compat)
//   agents, currentAgent, selectedAvatar, selectedAvatarFile -- shared state,
//   read via live-binding import; write via setCurrentAgent/setSelectedAvatar/
//   setSelectedAvatarFile (owned here, mutated from agents-wizard.js / agents-detail.js)

import { escapeHtml, mainAgentId } from './util.js'
import { showToast } from './toast.js'
import { t, getLang } from './i18n.js'
import { switchPage } from './app-core.js'
import { getErrorMessage } from './error-message.js'
import { resetCreateAvatarUpload, resetWizard } from './agents-wizard.js'
import {
  currentChannelProvider, loadAvailableModels, openAgentDetail, setCurrentChannelProvider, switchAgentTab,
} from './agents-detail.js'
import { agentIsConnected, updateChannelTab, updateProviderUI } from './agents-channels.js'
import { setAgentsView } from './agents-org-chart.js'
import { can } from './rbac-client.js'

export { loadAvailableModels, setAgentsView }

export function setCurrentAgent(v) { currentAgent = v }
export function setSelectedAvatar(v) { selectedAvatar = v }
export function setSelectedAvatarFile(v) { selectedAvatarFile = v }

// ─── Avatar cache-busting epoch ─────────────────────────────────────────────
// Owned here; bumpAvatarEpoch() called only from agents section.
// avatarBust() exported so app.js (skills, memories) uses the same epoch.
let _avatarEpoch = 0
export function bumpAvatarEpoch() { _avatarEpoch = Date.now() }
export function avatarBust() { return _avatarEpoch ? `?t=${_avatarEpoch}` : '' }

// ─── Local utilities ─────────────────────────────────────────────────────────


// ─── DI callbacks (injected by initAgents) ───────────────────────────────────
export let _openModal = null
export let _closeModal = null
export let _loadSkills = null
let _openTerminalModal = null
let _openConversationModal = null
let _setChatSelectedAgent = null
export let _showSudoModal = null
export let _renderTeamEditor = null

export function initAgents({
  openModal, closeModal, loadSkills,
  openTerminalModal, openConversationModal, setChatSelectedAgent,
  showSudoModal, renderTeamEditor,
} = {}) {
  _openModal = openModal
  _closeModal = closeModal
  _loadSkills = loadSkills
  _openTerminalModal = openTerminalModal
  _openConversationModal = openConversationModal
  _setChatSelectedAgent = setChatSelectedAgent
  _showSudoModal = showSudoModal
  _renderTeamEditor = renderTeamEditor
}

// ─── Federated peer status ────────────────────────────────────────────────────
// Populated by loadAgents() and by the Messages page loadChatAgentList().
// Messages page accesses it via the exported get/set below.
let federatedPeerStatus = []
// Gates the admin-only tenant-visibility chip (renderAgents reads this
// synchronously; loadAgents refreshes it on every fetch). Defaults true,
// matching can()'s own fail-open default for a null/legacy-token role.
let _isAdminView = true
export function getFederatedPeerStatus() { return federatedPeerStatus }
export function setFederatedPeerStatus(peers) { federatedPeerStatus = peers }

// ─── Agents page view state ───────────────────────────────────────────────────
let _agentsActiveView = 'grid'
export function getAgentsActiveView() { return _agentsActiveView }
// Set view name without triggering DOM update (used by team->agents alias).
export function setAgentsActiveView(v) { _agentsActiveView = v }

// === Elements: Agents ===
const agentsGrid = document.getElementById('agentsGrid')
const addBtn = document.getElementById('addAgentBtn')
export const agentWizardOverlay = document.getElementById('agentWizardOverlay')
export const agentDetailOverlay = document.getElementById('agentDetailOverlay')
const skillModalOverlay = document.getElementById('skillModalOverlay')
export const agentName = document.getElementById('agentName')
export const agentDesc = document.getElementById('agentDesc')
export const agentModel = document.getElementById('agentModel')
// toast DOM ref moved to web/modules/toast.js (S-1 POC)

export const AVATARS = [
  '01_robot.png', '02_wizard_girl.png', '03_knight.png', '04_ninja.png',
  '05_pirate.png', '06_scientist_girl.png', '07_astronaut.png', '08_viking.png',
  '09_cowgirl.png', '10_detective.png', '11_chef.png', '12_witch.png',
  '13_samurai.png', '14_fairy_girl.png', '15_firefighter.png', '16_punk_girl.png',
  '17_explorer.png', '18_dj.png', '19_princess.png', '20_alien.png'
]

export let selectedAvatar = null
export let selectedAvatarFile = null // custom upload chosen in the create wizard (deferred until the agent exists)
export let agents = []
export let currentAgent = null
// API-safe agent id for the currently open detail modal. Sub-agents key off
// their name; the main agent's detail object carries name:'marveen' for legacy
// UI checks but its real agent-dir id is agentId (MAIN_AGENT_ID, e.g.
// 'gorcsevivan') -- the /api/agents/<id>/skills endpoints need that real id.
export function agentApiName() {
  return currentAgent ? (currentAgent.agentId || currentAgent.name) : ''
}


// Wizard open
addBtn.addEventListener('click', () => {
  resetWizard()
  _openModal?.(agentWizardOverlay)
  setTimeout(() => agentName.focus(), 200)
})

// Close buttons
document.getElementById('wizardClose').addEventListener('click', () => _closeModal?.(agentWizardOverlay))
document.getElementById('agentDetailClose').addEventListener('click', () => _closeModal?.(agentDetailOverlay))
document.getElementById('skillModalClose').addEventListener('click', () => _closeModal?.(skillModalOverlay))

// Click-outside-to-close
agentWizardOverlay.addEventListener('click', (e) => { if (e.target === agentWizardOverlay) _closeModal?.(agentWizardOverlay) })
agentDetailOverlay.addEventListener('click', (e) => { if (e.target === agentDetailOverlay) _closeModal?.(agentDetailOverlay) })
skillModalOverlay.addEventListener('click', (e) => { if (e.target === skillModalOverlay) _closeModal?.(skillModalOverlay) })

// Close all modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((o) => _closeModal?.(o))
  }
})

// === Avatar Gallery ===
export function populateAvatarGrid() {
  const grid = document.getElementById('avatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', () => {
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      selectedAvatar = avatar
      // Gallery pick and custom upload are mutually exclusive.
      selectedAvatarFile = null
      resetCreateAvatarUpload()
    })
    grid.appendChild(item)
  }
}

// === Agents API ===
export async function loadAgents() {
  try {
    // The federation status fetch is deliberately failure-proof (.catch ->
    // null): it must NEVER take down the Agents page -- including on an
    // older backend where the route 404s.
    const [agentsRes, marveenRes, fedStatus, isAdminView] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/marveen'),
      fetch('/api/federation/status').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      can('admin:all'),
    ])
    _isAdminView = isAdminView
    agents = await agentsRes.json()
    if (fedStatus && Array.isArray(fedStatus.peers)) federatedPeerStatus = fedStatus.peers
    if (marveenRes.ok) {
      window._marveen = await marveenRes.json()
      // A backend CHANNEL_PROVIDER-éhez igazitsuk a kliens-default-ot,
      // hogy ne 'telegram' jelenjen meg amikor a backend discord-on van.
      if (window._marveen?.channelProvider) {
        setCurrentChannelProvider(window._marveen.channelProvider)
        const sel = document.getElementById('chProviderSelect')
        if (sel) sel.value = currentChannelProvider
        if (typeof updateProviderUI === 'function') updateProviderUI()
      }
    }
    renderAgents()
  } catch (err) {
    console.error('Betöltés hiba:', err)
  }
}

// Format a context-token count for display (e.g. 699884 -> "≈700k token").
function formatContextTokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '-'
  if (n < 1000) return `${n} token`
  const k = n / 1000
  return `≈${k < 10 ? k.toFixed(1) : Math.round(k)}k token`
}

// Populate the auto-restart controls + context display from an agent payload.
// Works for sub-agents (agent.name) and the main session (agent.autoRestartId).
export function setupAutoRestartUI(agent) {
  const ctxEl = document.getElementById('agentDetailContext')
  if (ctxEl) ctxEl.textContent = formatContextTokens(agent && agent.contextTokens)

  const ar = (agent && agent.autoRestart) || { enabled: false, mode: 'continue', dailyTime: null, intervalHours: null }
  const enabled = document.getElementById('arEnabled')
  const mode = document.getElementById('arMode')
  const schedKind = document.getElementById('arSchedKind')
  const dailyWrap = document.getElementById('arDailyWrap')
  const dailyTime = document.getElementById('arDailyTime')
  const intervalWrap = document.getElementById('arIntervalWrap')
  const intervalHours = document.getElementById('arIntervalHours')
  if (!enabled || !mode || !schedKind) return

  enabled.checked = ar.enabled === true
  mode.value = ar.mode === 'fresh' ? 'fresh' : 'continue'
  if (ar.intervalHours) {
    schedKind.value = 'interval'
    intervalHours.value = ar.intervalHours
  } else {
    schedKind.value = 'daily'
    if (ar.dailyTime) dailyTime.value = ar.dailyTime
  }
  const syncSched = () => {
    const isInterval = schedKind.value === 'interval'
    intervalWrap.hidden = !isInterval
    dailyWrap.hidden = isInterval
  }
  syncSched()
  // Attach the show/hide listener once.
  if (schedKind.dataset.wired !== '1') {
    schedKind.addEventListener('change', syncSched)
    schedKind.dataset.wired = '1'
  }
}

// Populate the idle-flush controls from an agent payload. Same source as
// setupAutoRestartUI (the agent detail carries contextGuard alongside
// autoRestart), so the settings pane needs no extra fetch.
//
// The tokens field is shown in THOUSANDS: the stored value is an absolute
// token count, and asking an operator to type 500000 into a box invites the
// 500 that normalizeContextGuardConfig has to defend against.
export function setupIdleFlushUI(agent) {
  const cg = (agent && agent.contextGuard) || { idleFlushEnabled: false, idleFlushTokens: 400000, idleMinutes: 20 }
  const enabled = document.getElementById('ifEnabled')
  const tokens = document.getElementById('ifTokens')
  const minutes = document.getElementById('ifMinutes')
  if (!enabled || !tokens || !minutes) return
  enabled.checked = cg.idleFlushEnabled === true
  tokens.value = Math.round((cg.idleFlushTokens || 400000) / 1000)
  minutes.value = cg.idleMinutes || 20
  showIdleFlushScheduleWarning(agent)
}

// Warn when this agent has ANY scheduled task, because the idle clock is the
// transcript mtime and every scheduled wake writes to the transcript: a
// schedule that fires more often than idleMinutes means the tier can never
// accumulate enough quiet and will sit switched on doing nothing.
//
// Deliberately NOT a computed comparison of cron period vs idleMinutes. A cron
// parser in the settings pane is a lot of fragile surface for a hint, and it
// would be silent exactly when it got a schedule shape wrong. Listing the
// schedules and letting the operator judge is both cheaper and harder to make
// quietly incorrect.
async function showIdleFlushScheduleWarning(agent) {
  const box = document.getElementById('ifScheduleWarning')
  if (!box) return
  // Clear as well as hide: the pane is reused for every agent, and a stale
  // warning left in the node is one accidental unhide away from naming the
  // wrong agent's schedules.
  box.hidden = true
  box.textContent = ''
  const id = (agent && (agent.autoRestartId || agent.name)) || null
  if (!id) return
  try {
    const res = await fetch('/api/schedules')
    if (!res.ok) return
    const all = await res.json()
    const mine = (Array.isArray(all) ? all : []).filter(t => t && t.agent === id && t.schedule)
    if (!mine.length) return
    const list = mine.map(t => `${t.name} (${t.schedule})`).join(', ')
    box.textContent = t('agents.settings.idle_flush_sched_warning').replace('{list}', list)
    box.hidden = false
  } catch { /* the hint is best-effort; never break the pane over it */ }
}

export async function openMarveenDetail() {
  const m = window._marveen
  if (!m) return

  // Reuse the agent detail modal for Marveen
  currentAgent = { ...m, name: mainAgentId(), claudeMd: '', soulMd: '', mcpJson: '', skills: [] }
  setupAutoRestartUI(currentAgent)
  setupIdleFlushUI(currentAgent)

  const displayName = m.name || 'Marveen'
  document.getElementById('agentDetailTitle').textContent = displayName
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar gradient-1'
  avatar.innerHTML = `<img src="/api/marveen/avatar${avatarBust()}" alt="${escapeHtml(displayName)}">`
  document.getElementById('agentDetailName').textContent = displayName
  document.getElementById('agentDetailDesc').textContent = m.description || ''
  document.getElementById('agentDetailModel').textContent = m.model || '-'
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot connected"></span>${t('agents.channel.connected')}</span>`
  // Populate the Skills tab for the main agent too: the endpoint returns the
  // global ~/.claude/skills under its real id (agentId), which every agent
  // inherits. Previously this was hard-set to '-' and loadSkills was never
  // called, so the main agent's Skills tab always looked empty.
  _loadSkills?.(agentApiName())

  // Process control for Marveen - always running, no start/stop
  document.getElementById('processDot').className = 'process-dot running'
  document.getElementById('processLabel').textContent = t('agents.status.running')
  document.getElementById('processUptime').textContent = `tmux: ${m.tmuxSession || '-'}`
  document.getElementById('agentStartBtn').hidden = true
  document.getElementById('agentStopBtn').hidden = true
  // Sync the settings tab model select with Marveen's actual model so it
  // doesn't carry over the previously opened sub-agent's selection.
  const marveenModelSelect = document.getElementById('editAgentModel')
  if (marveenModelSelect) {
    // The main agent's real model (e.g. 'claude-opus-4-8') may not match any
    // static option verbatim (the option is 'claude-opus-4-8[1m]'), so a plain
    // .value assignment finds no match and the select silently displays the
    // first option (Fable 5), misrepresenting what the agent actually runs.
    // Inject the real id as an option so the (read-only) select shows the truth
    // -- same trick as the sub-agent panel's dynamic-model-opt.
    const mv = m.activeModel || m.model || ''
    Array.from(marveenModelSelect.querySelectorAll('option.dynamic-model-opt')).forEach(o => o.remove())
    if (mv && !Array.from(marveenModelSelect.options).some(o => o.value === mv)) {
      const opt = document.createElement('option')
      opt.value = mv
      opt.className = 'dynamic-model-opt'
      opt.textContent = mv
      marveenModelSelect.appendChild(opt)
    }
    marveenModelSelect.value = mv
  }
  // Populate the model dropdown groups (auto/manual) AND surface the OpenRouter
  // curation button -- this is the main agent, the only place curation lives.
  loadAvailableModels()
  // Surface the "channels restart" button -- destructive, but mobile-safe
  // when the Telegram plugin wedges and you're away from a terminal.
  document.getElementById('marveenRestartBtn').hidden = false

  // Settings tab - load real CLAUDE.md / SOUL.md / .mcp.json (read-only).
  // Editing the main agent's identity files via the dashboard is intentionally
  // not allowed: a leaked dashboard token would otherwise let a remote user
  // rewrite the live agent's instructions. Edit via filesystem or by asking
  // Marveen on Telegram instead.
  let mFull = m
  try {
    const claudeRes = await fetch('/api/marveen')
    if (claudeRes.ok) {
      mFull = await claudeRes.json()
      document.getElementById('editClaudeMd').value = mFull.claudeMd || ''
      document.getElementById('editSoulMd').value = mFull.soulMd || ''
      document.getElementById('editMcpJson').value = mFull.mcpJson || ''
    }
  } catch {}
  applyMarveenReadonlyMode(true)

  // Telegram tab -- without this the tab stays in the default "not connected"
  // view even though the bot is running and receiving messages.
  updateChannelTab({
    name: mainAgentId(),
    hasTelegram: mFull.hasTelegram !== undefined ? mFull.hasTelegram : true,
    hasDiscord: mFull.hasDiscord,
    hasSlack: mFull.hasSlack,
    telegramBotUsername: mFull.telegramBotUsername,
    running: true,
  })

  // Delete button - hide for Marveen
  document.getElementById('deleteAgentBtn').style.display = 'none'

  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  _openModal?.(agentDetailOverlay)
}

export function applyMarveenReadonlyMode(readOnly) {
  // `readOnly` is really "this modal is showing the MAIN agent" -- it is called
  // with true from openMarveenDetail and false from openAgentDetail, which makes
  // it the one hook both open-paths share. Anything that must differ for the main
  // agent belongs here; putting it in openAgentDetail alone silently no-ops for
  // the main agent, whose panel never runs that function.
  // The Team tab describes a SUB-agent's place in the hierarchy: role
  // (leader | member), who it reports to, who it delegates to. None of it
  // applies to the main agent, which has no team record and cannot have one.
  // Its role is 'main', a tier ABOVE leader, and it is an implicit trusted peer
  // of every agent (see isTrustedPeer), so there is nothing to configure. Shown
  // anyway, the tab printed the literal fallback "member" and invited the
  // operator to promote the main agent to 'leader' -- a demotion, and one that
  // cannot be saved either way: the PUT targets /api/agents/<main>/team, which
  // 404s because no agents/<main>/ directory exists. Hide the whole tab, same
  // reasoning as claudePlanGroup.
  const teamTabBtn = document.querySelector('#agentTabNav .tab-btn[data-tab="team"]')
  if (teamTabBtn) teamTabBtn.hidden = readOnly
  const textareaIds = ['editClaudeMd', 'editSoulMd', 'editMcpJson']
  // saveModelBtn stays VISIBLE but disabled for Marveen, so the settings tab
  // doesn't look like the row is missing -- the other save buttons (tied to
  // readonly textareas) are hidden because the textareas are also hidden by
  // the readonly note flow.
  const hideButtonIds = ['saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'saveAuthModeBtn', 'saveMcpScopeBtn']
  const disableButtonIds = ['saveModelBtn']
  for (const id of textareaIds) {
    const el = document.getElementById(id)
    if (!el) continue
    if (readOnly) el.setAttribute('readonly', 'readonly')
    else el.removeAttribute('readonly')
  }
  const modelSelect = document.getElementById('editAgentModel')
  if (modelSelect) modelSelect.disabled = readOnly
  for (const id of hideButtonIds) {
    const btn = document.getElementById(id)
    if (btn) btn.hidden = readOnly
  }
  for (const id of disableButtonIds) {
    const btn = document.getElementById(id)
    if (btn) { btn.hidden = false; btn.disabled = readOnly }
  }
  const authModeGroup = document.getElementById('authModeGroup')
  if (authModeGroup) authModeGroup.hidden = readOnly
  const memoryIsolationGroup = document.getElementById('memoryIsolationGroup')
  if (memoryIsolationGroup) memoryIsolationGroup.hidden = readOnly
  const note = document.getElementById('marveenReadonlyNote')
  if (note) note.hidden = !readOnly
}


export function getAvatarGradient(name) {
  const hash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return 'gradient-' + ((hash % 3) + 1)
}

// Tooltip text for the "Fut" / "Leállva" footer indicator (process state).
function processTip(isRunning) {
  return isRunning
    ? t('agents.running_tip')
    : t('agents.stopped_tip')
}

// Tooltip text for the "Online" / "Offline" footer indicator (channel state).
function channelTip(isConnected) {
  return isConnected
    ? t('agents.online_tip')
    : t('agents.offline_tip')
}

// Build the copy-paste tmux attach command for an agent live session. A local
// agent session runs on the orchestrator host (a direct `tmux attach`); a remote
// agent session runs on its configured remoteHost, reached over ssh. Only
// meaningful for running agents.
function tmuxAttachCommand(agent) {
  const session = agent.session || ('agent-' + agent.name)
  const direct = 'tmux attach -t ' + session
  const remoteHost = agent.remoteHost || null
  return remoteHost ? 'ssh ' + remoteHost + " -t '" + direct + "'" : direct
}

// Append a single "copy tmux attach command" button to a running agent card.
// Clicks copy to clipboard and never bubble to the card open-detail handler.
function attachTmuxCopyButtons(card, agent) {
  const cmd = tmuxAttachCommand(agent)
  const row = document.createElement('div')
  row.className = 'agent-tmux-cmds'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tmux-copy-btn'
  btn.setAttribute('aria-label', t('agents.tmux_copy_aria'))
  btn.title = cmd
  btn.innerHTML = '<span class="tmux-copy-ico">⧉</span>tmux'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(cmd).then(() => {
      const orig = btn.innerHTML
      btn.classList.add('copied')
      btn.innerHTML = '<span class="tmux-copy-ico">✓</span>' + t('agents.tmux_copied')
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied') }, 1400)
    }).catch(() => showToast(t('agents.tmux_copy_failed')))
  })
  row.appendChild(btn)
  card.appendChild(row)
}

function renderAgents() {
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((el) => el.remove())

  // Marveen card (always first)
  if (window._marveen) {
    const m = window._marveen
    const displayName = m.name || 'Marveen'
    // The model is no longer hardcoded: /api/marveen reports the configured
    // model (readActiveModelFromProjectDir). Mirror the sub-agent card, which
    // uses the model value as both the badge label and class. Fall back to
    // 'opus' only before /api/marveen has resolved (or on a legacy backend).
    const mainModelLabel = m.model || 'opus'
    const mainModelClass = m.model || 'opus'
    const mCard = document.createElement('div')
    mCard.className = 'agent-card marveen-card'
    mCard.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar gradient-1"><img src="/api/marveen/avatar${avatarBust()}" alt="${escapeHtml(displayName)}"></div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(displayName)} <span class="marveen-badge">${t('agents.main_badge')}</span></div>
          <div class="agent-desc">${escapeHtml(m.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(mainModelClass)}">${escapeHtml(mainModelLabel)}</span>
        <span class="process-indicator" title="${t('agents.marveen_process_tip')}"><span class="process-dot running"></span>${t('agents.status.running')}</span>
        <span class="tg-status" title="${t('agents.marveen_channel_tip')}"><span class="tg-dot connected"></span>${t('agents.status.online')}</span>
      </div>
      <div class="agent-card-actions">
        <button class="btn agent-conversation-btn" data-variant="secondary" data-size="compact" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn agent-terminal-btn" data-variant="secondary" data-size="compact" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    mCard.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openTerminalModal?.(mainAgentId())
    })
    mCard.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openConversationModal?.(mainAgentId(), t('agents.marveen_boss'))
    })
    mCard.addEventListener('click', () => openMarveenDetail())
    agentsGrid.insertBefore(mCard, addBtn)
  }

  for (const agent of agents) {
    // agent.name is the sanitized id (API/filesystem); displayName keeps the
    // original accented/cased input the user typed.
    const label = agent.displayName || agent.name
    const card = document.createElement('div')
    card.className = 'agent-card'
    card.dataset.name = agent.name
    const initial = label.charAt(0).toUpperCase()
    const gradientClass = getAvatarGradient(agent.name)
    const avatarHtml = (agent.hasImage || agent.hasAvatar)
      ? `<img src="/api/agents/${encodeURIComponent(agent.name)}/avatar${avatarBust()}" alt="${escapeHtml(label)}">`
      : initial

    const modelClass = agent.model && agent.model !== 'inherit' ? agent.model : ''
    const modelLabel = agent.model || 'inherit'
    const chConnected = agentIsConnected(agent)
    const chDotClass = chConnected ? 'connected' : 'disconnected'
    const chLabel = chConnected ? t('agents.status.online') : t('agents.status.offline')
    const isRunning = agent.running || false
    const runDotClass = isRunning ? 'running' : 'stopped'
    const runLabel = isRunning ? t('agents.status.running') : t('agents.status.stopped')

    // Tenant-main-agent badge: visible in every view (a tenant-user benefits
    // from knowing who their own coordinator is), unlike the chip below.
    let tenantMainBadgeHtml = ''
    if (agent.primaryTenantId) {
      const tenantName = (agent.tenantNames && agent.tenantNames[agent.primaryTenantId]) || agent.primaryTenantId
      card.classList.add('is-tenant-main')
      card.dataset.tenant = agent.primaryTenantId
      tenantMainBadgeHtml = ` <span class="tenant-main-badge" data-tenant="${escapeHtml(agent.primaryTenantId)}" title="${escapeHtml(t('agents.tenant_main_title', { tenant: tenantName }))}">${escapeHtml(t('agents.tenant_main_badge', { tenant: tenantName }))}</span>`
    }
    // Tenant visibility chips: admin-only (redundant in a tenant-user's own,
    // already-scoped view).
    let tenantChipsHtml = ''
    if (_isAdminView && Array.isArray(agent.tenantIds) && agent.tenantIds.length > 0) {
      const chips = agent.tenantIds.map((id) => {
        const name = (agent.tenantNames && agent.tenantNames[id]) || id
        return `<span class="tenant-chip" data-tenant="${escapeHtml(id)}">${escapeHtml(t('agents.tenant_chip', { tenant: name }))}</span>`
      }).join('')
      tenantChipsHtml = `<span class="chip-group">${chips}</span>`
    }

    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${avatarHtml}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(label)}${tenantMainBadgeHtml}</div>
          <div class="agent-desc">${escapeHtml(agent.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(modelClass)}">${escapeHtml(modelLabel)}</span>
        <span class="process-indicator" title="${escapeHtml(processTip(isRunning))}"><span class="process-dot ${runDotClass}"></span>${runLabel}</span>
        <span class="tg-status" title="${escapeHtml(channelTip(chConnected))}"><span class="tg-dot ${chDotClass}"></span>${chLabel}</span>
        ${tenantChipsHtml}
      </div>
      ${agent.needsReauth ? `
        <div class="agent-reauth-banner">
          <span class="agent-reauth-reason">${escapeHtml(agent.reauthReason || t('agents.reauth.reason'))}</span>
          <button class="btn agent-login-btn" data-variant="danger" data-size="compact" data-phase="start">${t('agents.btn.login')}</button>
        </div>` : ''}
      <div class="agent-card-actions">
        <button class="btn agent-conversation-btn" data-variant="secondary" data-size="compact" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn agent-terminal-btn" data-variant="secondary" data-size="compact" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    // Login button handler (start → confirm flow)
    card.querySelectorAll('.agent-login-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); handleAgentLogin(agent.name, btn) })
    })
    // Terminal button
    card.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openTerminalModal?.(agent.name)
    })
    // Conversation (readable transcript) button
    card.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openConversationModal?.(agent.name, label)
    })
    card.addEventListener('click', () => openAgentDetail(agent.name))
    // Only running agents have a live session to look at, so only they get the
    // copy-the-tmux-command buttons.
    if (isRunning) attachTmuxCopyButtons(card, agent)
    agentsGrid.insertBefore(card, addBtn)
  }
  renderFederatedAgentCards(agentsGrid, addBtn)
  // Re-apply the live busy tint right after a re-render (renderAgents rebuilds
  // the cards from scratch, dropping the class), so it never blinks off while
  // the page is open.
  if (agentsBusyTimer) refreshAgentTerminalBusy()
}

// === Agents: live "working" tint on Terminal buttons ===
// Reuse the Activity page's data source (/api/agents/activity, same 3s poll,
// same working/idle state derived from the tmux pane) to turn an agent card's
// Terminal button green while that agent is actively working, and clear it when
// it goes idle or stops. No new backend -- just a second consumer of the same
// endpoint. The main (Marveen) card matches on mainAgentId(); sub-agent cards
// match on their data-name.
let agentsBusyTimer = null
export function startAgentsBusyPoll() {
  refreshAgentTerminalBusy()
  if (agentsBusyTimer) clearInterval(agentsBusyTimer)
  agentsBusyTimer = setInterval(refreshAgentTerminalBusy, 3000)
}
export function stopAgentsBusyPoll() {
  if (agentsBusyTimer) { clearInterval(agentsBusyTimer); agentsBusyTimer = null }
}
async function refreshAgentTerminalBusy() {
  if (!agentsGrid) return
  let entries
  try {
    const res = await fetch('/api/agents/activity')
    if (!res.ok) return
    entries = await res.json()
  } catch { return }
  if (!Array.isArray(entries)) return
  const stateByName = new Map(entries.map((e) => [e.name, e.state]))
  const mainId = mainAgentId()
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((card) => {
    const btn = card.querySelector('.agent-terminal-btn')
    if (!btn) return
    const id = card.classList.contains('marveen-card') ? mainId : card.dataset.name
    const working = !!id && stateByName.get(id) === 'working'
    btn.classList.toggle('agent-terminal-btn--busy', working)
  })
}

// Federated (remote-system) agents from the manifest-poller cache. Kept in a
// SEPARATE array from `agents`: that global feeds the team editor and the
// create-wizard, where qualified ids would be selectable-and-invalid.
// "remote" already means SSH agents in this codebase -- these are FEDERATED.

// System/plumbing agent names never shown as message targets.
const FEDERATED_HIDDEN_AGENTS = new Set(['heartbeat', 'telegram-coordinator', 'channel-coordinator'])

export function federatedAgentEntries() {
  const out = []
  for (const peer of federatedPeerStatus) {
    const manifest = peer && peer.manifest
    if (!manifest || !Array.isArray(manifest.agents)) continue
    for (const a of manifest.agents) {
      if (!a || typeof a.id !== 'string' || FEDERATED_HIDDEN_AGENTS.has(a.id.split('/').pop())) continue
      out.push({ peer: peer.id, peerState: peer.state, qualified: `${peer.id}/${a.id}`, displayName: a.displayName || a.id, model: a.model || '' })
    }
  }
  return out
}

function renderFederatedAgentCards(agentsGrid, addBtn) {
  for (const fa of federatedAgentEntries()) {
    const card = document.createElement('div')
    card.className = 'agent-card federated-agent-card'
    const reachable = fa.peerState === 'ok'
    // SECURITY: every manifest-derived string is peer-controlled. Text nodes
    // go through escapeHtml; NOTHING peer-controlled may land in an attribute
    // (escapeHtml does not encode quotes). The model badge is a plain text
    // span WITHOUT a model-derived class.
    const gradientClass = 'gradient-' + ((fa.qualified.charCodeAt(0) % 3) + 1)
    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${escapeHtml(fa.displayName.charAt(0).toUpperCase())}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(fa.displayName)} <span class="federated-badge">${t('federation.badge', { peer: fa.peer })}</span></div>
          <div class="agent-desc">${escapeHtml(fa.qualified)}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge">${escapeHtml(fa.model)}</span>
        <span class="tg-status"><span class="tg-dot ${reachable ? 'connected' : 'disconnected'}"></span> ${reachable ? t('federation.peer_state.ok') : t('federation.peer_state.' + (fa.peerState || 'unknown'))}</span>
      </div>
      <div class="agent-card-actions">
        <button class="btn federated-message-btn" data-variant="secondary" data-size="compact" >${t('federation.btn.message')}</button>
      </div>`
    card.querySelector('.federated-message-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      openFederatedThread(fa.qualified)
    })
    agentsGrid.insertBefore(card, addBtn)
  }
}

function openFederatedThread(qualifiedId) {
  _setChatSelectedAgent?.(qualifiedId)
  if (location.hash === '#messages') switchPage('messages')
  else location.hash = 'messages'
}

