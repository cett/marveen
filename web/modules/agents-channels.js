// Agent detail modal: MCP scope tab + Channel tab + Channel Requests
// (split out of agents.js for #773/#776). Strongly coupled trio kept
// together per Rick's review (shared state, all channel-config API calls).

import { t } from './i18n.js'
import { showToast } from './toast.js'
import { getErrorMessage } from './error-message.js'
import { _showSudoModal, agents, currentAgent, loadAgents } from './agents.js'
import {
  channelApiBase, currentChannelProvider, openAgentDetail, setCurrentChannelProvider,
} from './agents-detail.js'

// === MCP scope tab ===

// Read-only tool id prefixes -- used to auto-populate the "readonly" preset.
const MCP_READONLY_PREFIXES = ['list_', 'get_', 'search_', 'check_', 'find_', 'fetch_', 'read_', 'directory_tree']

function isMcpToolReadonly(toolId) {
  return MCP_READONLY_PREFIXES.some((p) => toolId.startsWith(p))
}

// Build the mcpScope object from the current UI state.
// Returns null when mode is "full" (unmanaged, no mcpScope field).
function buildMcpScopeValue() {
  const mode = document.querySelector('input[name="mcpScopeMode"]:checked')?.value || 'full'
  if (mode === 'full') return null

  const scope = {}
  const serverSections = document.querySelectorAll('#mcpScopeServerList .mcp-server-section')
  for (const section of serverSections) {
    const serverKey = section.dataset.server
    if (!serverKey) continue
    const allToggle = section.querySelector('.mcp-server-all-toggle')
    if (allToggle?.checked) {
      scope[serverKey] = '*'
      continue
    }
    const checked = [...section.querySelectorAll('.mcp-tool-cb:checked')].map((cb) => cb.value)
    // Custom tools entered via free-text input
    const customItems = [...section.querySelectorAll('.mcp-custom-tool-tag')].map((el) => el.dataset.tool)
    const allTools = [...new Set([...checked, ...customItems])].filter(Boolean)
    // null means server is explicitly blocked (empty whitelist under managed mode)
    scope[serverKey] = allTools.length > 0 ? allTools : null
  }
  return scope
}

// Render a single server section (accordion-style) inside #mcpScopeServerList.
function renderMcpServerSection(serverKey, catalogEntry, currentServerScope) {
  const tools = catalogEntry?.tools || []
  const isAllStar = currentServerScope === '*'
  const allowedSet = Array.isArray(currentServerScope) ? new Set(currentServerScope) : new Set()
  const isBlocked = !isAllStar && currentServerScope !== undefined && allowedSet.size === 0

  const section = document.createElement('div')
  section.className = 'mcp-server-section'
  section.dataset.server = serverKey

  const serverLabel = catalogEntry?.name || serverKey
  const icon = catalogEntry?.icon || ''

  section.innerHTML = `
    <div class="mcp-server-header">
      <span class="mcp-server-icon">${icon}</span>
      <strong class="mcp-server-name">${escapeHtml(serverLabel)}</strong>
      <label class="mcp-server-all-label">
        <input type="checkbox" class="mcp-server-all-toggle" ${isAllStar ? 'checked' : ''}>
        <span data-i18n="agents.mcp_scope.server_all_toggle">${t('agents.mcp_scope.server_all_toggle')}</span>
      </label>
      ${isBlocked ? `<span class="mcp-scope-blocked-badge">${t('agents.mcp_scope.server_blocked')}</span>` : ''}
    </div>
    <div class="mcp-tool-list" ${isAllStar ? 'style="display:none"' : ''}>
      ${tools.length === 0 ? renderCustomToolSection(serverKey, allowedSet) : ''}
    </div>
  `

  if (tools.length > 0) {
    const toolList = section.querySelector('.mcp-tool-list')
    for (const tool of tools) {
      const isChecked = isAllStar || allowedSet.has(tool.id)
      const row = document.createElement('label')
      row.className = 'mcp-tool-row'
      row.innerHTML = `
        <input type="checkbox" class="mcp-tool-cb" value="${escapeHtml(tool.id)}" ${isChecked ? 'checked' : ''}>
        <span class="mcp-tool-label">${escapeHtml(tool.label)}</span>
        <code class="mcp-tool-id">${escapeHtml(tool.id)}</code>
        ${tool.dangerous ? `<span class="mcp-tool-danger-badge">${t('agents.mcp_scope.dangerous_badge')}</span>` : ''}
      `
      toolList.appendChild(row)
    }
    // Custom tool input for tools not in catalog
    const customSection = document.createElement('div')
    customSection.innerHTML = renderCustomToolSection(serverKey, allowedSet, tools.map((t) => t.id))
    toolList.appendChild(customSection)
  }

  // "All tools" toggle hides/shows the checkbox list
  const allToggle = section.querySelector('.mcp-server-all-toggle')
  const toolListEl = section.querySelector('.mcp-tool-list')
  allToggle.addEventListener('change', () => {
    toolListEl.style.display = allToggle.checked ? 'none' : ''
    if (!allToggle.checked) {
      section.querySelector('.mcp-scope-blocked-badge')?.remove()
    }
  })

  return section
}

// Render the free-text custom tool input row for servers without a tool catalog.
function renderCustomToolSection(serverKey, existingCustomSet, catalogToolIds = []) {
  const customTools = [...existingCustomSet].filter((id) => !catalogToolIds.includes(id))
  const tags = customTools.map((id) =>
    `<span class="mcp-custom-tool-tag" data-tool="${escapeHtml(id)}">${escapeHtml(id)}<button class="mcp-custom-tool-remove" data-tool="${escapeHtml(id)}">&times;</button></span>`
  ).join('')
  return `
    <div class="mcp-custom-tool-row">
      <div class="mcp-custom-tool-tags" id="customTags_${escapeHtml(serverKey)}">${tags}</div>
      <div class="mcp-custom-tool-input-row">
        <input type="text" class="mcp-custom-tool-input" placeholder="${t('agents.mcp_scope.unknown_server_hint')}">
        <button type="button" class="btn mcp-custom-tool-add" data-variant="secondary" data-size="compact" >${t('agents.mcp_scope.add_custom_tool')}</button>
      </div>
    </div>
  `
}

function wireCustomToolInputs(container) {
  container.querySelectorAll('.mcp-custom-tool-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.mcp-custom-tool-row')
      const input = row.querySelector('.mcp-custom-tool-input')
      const toolId = input.value.trim()
      if (!toolId) return
      const serverKey = btn.closest('.mcp-server-section')?.dataset.server || ''
      const tagsEl = row.querySelector('.mcp-custom-tool-tags') || document.getElementById(`customTags_${serverKey}`)
      if (!tagsEl) return
      const tag = document.createElement('span')
      tag.className = 'mcp-custom-tool-tag'
      tag.dataset.tool = toolId
      tag.innerHTML = `${escapeHtml(toolId)}<button class="mcp-custom-tool-remove" data-tool="${escapeHtml(toolId)}">&times;</button>`
      tag.querySelector('.mcp-custom-tool-remove').addEventListener('click', () => tag.remove())
      tagsEl.appendChild(tag)
      input.value = ''
    })
  })
  container.querySelectorAll('.mcp-custom-tool-remove').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('.mcp-custom-tool-tag')?.remove())
  })
}

let _mcpCatalogCache = null
async function fetchMcpCatalog() {
  if (_mcpCatalogCache) return _mcpCatalogCache
  try {
    const res = await fetch('/api/mcp-catalog')
    if (res.ok) _mcpCatalogCache = await res.json()
  } catch { /* offline -- proceed without catalog */ }
  return _mcpCatalogCache || []
}

export async function loadMcpScope(agent) {
  const serverListEl = document.getElementById('mcpScopeServerList')
  const noServersEl = document.getElementById('mcpScopeNoServers')
  const unmanagedHint = document.getElementById('mcpScopeUnmanagedHint')
  if (!serverListEl) return

  serverListEl.innerHTML = ''

  // Parse .mcp.json to get configured server keys
  let mcpJson = {}
  try { mcpJson = JSON.parse(agent.mcpJson || '{}') } catch { /* ignore */ }
  const serverKeys = Object.keys(mcpJson.mcpServers || {})

  if (serverKeys.length === 0) {
    if (noServersEl) noServersEl.style.display = ''
    serverListEl.style.display = 'none'
    return
  }
  if (noServersEl) noServersEl.style.display = 'none'

  // Current mcpScope from agent config
  const currentScope = agent.mcpScope || null

  // Preset mode
  let mode = 'full'
  if (currentScope !== null && currentScope !== undefined) {
    // Check if all servers are set to readonly-only tools
    const allReadonly = serverKeys.every((key) => {
      const s = currentScope[key]
      return Array.isArray(s) && s.every(isMcpToolReadonly)
    })
    mode = allReadonly ? 'readonly' : 'custom'
  }
  const modeInput = document.querySelector(`input[name="mcpScopeMode"][value="${mode}"]`)
  if (modeInput) modeInput.checked = true
  if (unmanagedHint) unmanagedHint.style.display = mode === 'full' ? '' : 'none'
  serverListEl.style.display = mode === 'custom' ? '' : 'none'

  // Wire preset radio buttons
  document.querySelectorAll('input[name="mcpScopeMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const m = document.querySelector('input[name="mcpScopeMode"]:checked')?.value
      serverListEl.style.display = m === 'custom' ? '' : 'none'
      if (unmanagedHint) unmanagedHint.style.display = m === 'full' ? '' : 'none'
    })
  })

  const catalog = await fetchMcpCatalog()
  const catalogMap = {}
  for (const entry of catalog) catalogMap[entry.id] = entry

  for (const serverKey of serverKeys) {
    // Match server key to catalog: try exact id match or prefix match
    try {
      const catalogEntry = catalogMap[serverKey] ||
        Object.values(catalogMap).find((e) => serverKey.startsWith(e.id))
      const serverScope = currentScope ? currentScope[serverKey] : undefined
      const section = renderMcpServerSection(serverKey, catalogEntry, serverScope)
      serverListEl.appendChild(section)
    } catch (err) {
      console.error(`MCP scope: failed to render server "${serverKey}":`, err)
    }
  }

  try {
    wireCustomToolInputs(serverListEl)
  } catch (err) {
    console.error('MCP scope: wireCustomToolInputs failed:', err)
  }
}

document.getElementById('saveMcpScopeBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const mode = document.querySelector('input[name="mcpScopeMode"]:checked')?.value || 'full'

  let scopeValue = null
  if (mode === 'readonly') {
    // Auto-build readonly scope: only list/get/search tools from catalog per server
    let mcpJson = {}
    try { mcpJson = JSON.parse(currentAgent.mcpJson || '{}') } catch { /* ignore */ }
    const serverKeys = Object.keys(mcpJson.mcpServers || {})
    const catalog = await fetchMcpCatalog()
    const catalogMap = {}
    for (const entry of catalog) catalogMap[entry.id] = entry
    scopeValue = {}
    for (const serverKey of serverKeys) {
      const catalogEntry = catalogMap[serverKey] ||
        Object.values(catalogMap).find((e) => serverKey.startsWith(e.id))
      if (catalogEntry?.tools) {
        const readonlyTools = catalogEntry.tools.filter((t) => isMcpToolReadonly(t.id)).map((t) => t.id)
        scopeValue[serverKey] = readonlyTools.length > 0 ? readonlyTools : null
      } else {
        // Unknown server: no tools to whitelist -> block
        scopeValue[serverKey] = null
      }
    }
  } else if (mode === 'custom') {
    scopeValue = buildMcpScopeValue()
    // Warn if any dangerous tools are newly included
    const hasDangerous = Object.values(scopeValue || {}).some((v) =>
      Array.isArray(v) && v.some((id) => !isMcpToolReadonly(id))
    )
    if (hasDangerous && !confirm(t('agents.mcp_scope.confirm_dangerous'))) return
  }
  // mode === 'full' -> scopeValue stays null (removes mcpScope field)

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpScope: scopeValue }),
    })
    if (!res.ok) throw new Error()
    currentAgent.mcpScope = scopeValue
    showToast(t('agents.mcp_scope.save_ok'))
  } catch { showToast(t('agents.mcp_scope.save_error')) }
})

// === Channel tab ===
// Provider-aware "connected" check: a sub-agent record carries hasTelegram /
// hasDiscord / hasSlack flags from the backend, Marveen carries the same
// shape from /api/marveen. Falls back to hasTelegram for legacy callers.
export function agentIsConnected(agent) {
  if (!agent) return false
  if (currentChannelProvider === 'discord') return !!agent.hasDiscord
  if (currentChannelProvider === 'slack') return !!agent.hasSlack
  if (currentChannelProvider === 'teams') return !!agent.hasTeams
  return !!agent.hasTelegram
}

function getProviderLabel() {
  if (currentChannelProvider === 'discord') return 'Discord'
  if (currentChannelProvider === 'slack') return 'Slack'
  if (currentChannelProvider === 'teams') return 'Microsoft Teams'
  return 'Telegram'
}

// Connected-view help text per provider. Returns innerHTML for the
// #chHowtoContent <div> -- swapped on every updateProviderUI() call so the
// "Hogyan adj hozzá több embert vagy csoportot?" panel matches the active
// channel provider.
function buildHowtoHtml() {
  if (currentChannelProvider === 'discord') return t('channel.howto.discord')
  if (currentChannelProvider === 'slack') return t('channel.howto.slack')
  if (currentChannelProvider === 'teams') return t('channel.howto.teams')
  return t('channel.howto.telegram')
}

export function updateProviderUI() {
  const isTg = currentChannelProvider === 'telegram'
  const title = document.getElementById('chSetupTitle')
  const steps = document.getElementById('chSetupSteps')
  const label = document.getElementById('chTokenLabel')
  const input = document.getElementById('chTokenInput')
  const slackGroup = document.getElementById('chSlackAppTokenGroup')
  const manifestBtnGroup = document.getElementById('chSlackManifestBtnGroup')
  const smokeTestBtn = document.getElementById('chSmokeTestBtn')
  const reconnectBtn = document.getElementById('chReconnectBtn')
  const howto = document.getElementById('chHowtoContent')
  const pairingInfo = document.getElementById('chPairingInfo')
  const discordChannelGroup = document.getElementById('chDiscordChannelIdGroup')
  const tokenGroup = document.getElementById('chTokenGroup')
  // Teams config is terminal-driven (creds land in the .env via setup-azure-bot.sh),
  // not a dashboard token paste -- default the token field visible, hide it for teams.
  if (tokenGroup) tokenGroup.hidden = false

  if (isTg) {
    if (title) title.textContent = t('channel.setup.tg_title')
    if (steps) steps.innerHTML = t('channel.setup.tg_steps')
    if (label) label.textContent = 'Bot API Token'
    if (input) input.placeholder = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.tg_pairing')
  } else if (currentChannelProvider === 'discord') {
    if (title) title.textContent = t('channel.setup.discord_title')
    if (steps) steps.innerHTML = t('channel.setup.discord_steps')
    if (label) label.textContent = 'Bot Token'
    if (input) input.placeholder = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ...'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = false
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.discord_pairing')
  } else if (currentChannelProvider === 'teams') {
    if (title) title.textContent = t('channel.setup.teams_title')
    if (steps) steps.innerHTML = t('channel.setup.teams_steps')
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    // No dashboard token entry for Teams -- creds come from the terminal setup.
    if (tokenGroup) tokenGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.teams_pairing')
  } else {
    if (title) title.textContent = t('channel.setup.slack_title')
    if (steps) steps.innerHTML = t('channel.setup.slack_steps')
    if (label) label.textContent = 'Bot Token (xoxb-...)'
    if (input) input.placeholder = 'xoxb-...'
    if (slackGroup) slackGroup.hidden = false
    if (manifestBtnGroup) manifestBtnGroup.hidden = false
    if (smokeTestBtn) smokeTestBtn.hidden = false
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.slack_pairing')
  }
  if (howto) howto.innerHTML = buildHowtoHtml()
  if (reconnectBtn) {
    reconnectBtn.hidden = !(currentAgent && currentAgent.running && agentIsConnected(currentAgent))
  }
}

export function updateChannelTab(agent) {
  const connected = agentIsConnected(agent)
  const running = agent.running || false
  document.getElementById('chNotConnected').hidden = connected
  document.getElementById('chConnected').hidden = !connected
  if (connected) {
    document.getElementById('chBotUsername').textContent = agent.telegramBotUsername || '@bot'
    document.getElementById('chRunNotice').hidden = running
    document.getElementById('chRunningNotice').hidden = !running
  }
  document.getElementById('chTokenInput').value = ''
  const slackInput = document.getElementById('chSlackAppToken')
  if (slackInput) slackInput.value = ''
  const discordChanInput = document.getElementById('chDiscordChannelId')
  if (discordChanInput) discordChanInput.value = ''
  updateProviderUI()
  if (connected && running) {
    refreshChannelHealth()
  } else {
    document.getElementById('chDisconnectedNotice').hidden = true
    document.getElementById('chReconnectBtn').hidden = true
  }
  if (connected) {
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }
}

async function refreshChannelHealth() {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/health`)
    if (!res.ok) return
    const data = await res.json()
    const notice = document.getElementById('chDisconnectedNotice')
    const btn = document.getElementById('chReconnectBtn')
    if (!data.healthy) {
      if (notice) notice.hidden = false
      if (btn) btn.hidden = false
    } else {
      if (notice) notice.hidden = true
      if (btn) btn.hidden = false
    }
  } catch { /* ignore */ }
}

document.getElementById('chProviderSelect').addEventListener('change', (e) => {
  setCurrentChannelProvider(e.target.value)
  updateProviderUI()
  if (currentAgent) {
    updateChannelTab(currentAgent)
  }
})

document.getElementById('chConnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const token = document.getElementById('chTokenInput').value.trim()
  if (!token) {
    document.getElementById('chTokenInput').focus()
    return
  }

  const payload = { botToken: token }
  if (currentChannelProvider === 'slack') {
    const appToken = document.getElementById('chSlackAppToken').value.trim()
    if (appToken) payload.appToken = appToken
  } else if (currentChannelProvider === 'discord') {
    const channelId = document.getElementById('chDiscordChannelId').value.trim()
    if (channelId) payload.channelId = channelId
  }

  const btn = document.getElementById('chConnectBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`${channelApiBase()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 409) {
      const err = await res.json()
      if (err.error === 'managed_settings_missing') {
        _showSudoModal?.(err.sudoCommand)
        return
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    const result = await res.json()
    showToast(`${getProviderLabel()} sikeresen csatlakoztatva!`)
    // Refresh detail
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Kapcsolodasi hiba'))
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('chTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`${channelApiBase()}/test`, { method: 'POST' })
    if (!res.ok) throw new Error()
    showToast('Kapcsolat rendben!')
  } catch {
    showToast(t('channel.toast.smoke_failed'))
  }
})

document.getElementById('chReconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chReconnectBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.reconnect')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/reconnect`, { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      showToast('Channel-MCP reconnect sikeres')
      document.getElementById('chDisconnectedNotice').hidden = true
    } else {
      showToast(data.message || 'Reconnect sikertelen', true)
    }
  } catch {
    showToast('Reconnect hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

document.getElementById('chSmokeTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chSmokeTestBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.running')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent)}/channels/slack/smoke-test`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      showToast(getErrorMessage(data, 'Smoke-test sikertelen'), true)
      return
    }
    showSmokeTestResult(data.output || 'OK')
  } catch {
    showToast('Smoke-test hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

function showSmokeTestResult(output) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:600px">
      <h3>${t('channel.smoke_test.title')}</h3>
      <pre style="background:#1a1a2e;color:#e0e0e0;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;max-height:400px;white-space:pre-wrap">${output.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      <div style="text-align:right;margin-top:12px">
        <button class="btn" data-variant="secondary" id="smokeTestCloseBtn">${t('common.btn.close')}</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.getElementById('smokeTestCloseBtn').addEventListener('click', () => overlay.remove())
}

// Pairing: refresh pending list
export async function refreshPendingPairings() {
  if (!currentAgent) return
  const listEl = document.getElementById('chPendingList')
  try {
    const res = await fetch(`${channelApiBase()}/pending`)
    if (!res.ok) return
    const pending = await res.json()
    listEl.innerHTML = ''
    if (pending.length === 0) {
      listEl.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">${t('channel.pending.empty')}</div>`
      return
    }
    for (const p of pending) {
      const item = document.createElement('div')
      item.className = 'tg-pending-item'
      const created = new Date(p.createdAt).toLocaleString('hu-HU')
      item.innerHTML = `
        <div>
          <span class="tg-pending-code">${escapeHtml(p.code)}</span>
          <span class="tg-pending-sender">Sender: ${escapeHtml(p.senderId)}</span>
        </div>
        <button class="btn" data-variant="primary" data-size="compact" style="padding:5px 12px; font-size:12px; margin:0" data-code="${escapeHtml(p.code)}">${t('common.btn.approve')}</button>
      `
      item.querySelector('button').addEventListener('click', async () => {
        await approvePairing(p.code)
      })
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function approvePairing(code) {
  if (!currentAgent) return
  try {
    const res = await fetch(`${channelApiBase()}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const err = await res.json()
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    showToast(t('channel.toast.pairing_approved'))
    refreshPendingPairings()
    refreshAllowedList()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, t('channel.toast.approve_error')))
  }
}

document.getElementById('chRefreshPendingBtn').addEventListener('click', refreshPendingPairings)

export async function refreshAllowedList() {
  if (!currentAgent) return
  const listEl = document.getElementById('chAllowedList')
  try {
    const res = await fetch(`${channelApiBase()}/allowed`)
    if (!res.ok) return
    const data = await res.json()
    const users = data.users || []
    const groups = data.groups || []
    if (users.length === 0 && groups.length === 0) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.allowed.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const id of users) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind">DM</span>
          <span class="tg-allowed-id">${escapeHtml(id)}</span>
        </div>
        <button class="btn" data-variant="icon" data-danger="" title="${t('common.btn.remove')}" data-kind="user" data-id="${escapeHtml(id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('user', id))
      listEl.appendChild(item)
    }
    for (const g of groups) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.badge.group')}</span>
          <span class="tg-allowed-id">${escapeHtml(g.id)}</span>
        </div>
        <button class="btn" data-variant="icon" data-danger="" title="${t('common.btn.remove')}" data-kind="group" data-id="${escapeHtml(g.id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('group', g.id))
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function removeAllowed(kind, id) {
  if (!currentAgent) return
  const label = kind === 'user' ? t('channel.kind.user') : t('channel.kind.group')
  if (!confirm(t('channel.confirm.remove', { label, id }))) return
  try {
    const res = await fetch(`${channelApiBase()}/allowed/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    showToast(t('common.toast.removed'))
    refreshAllowedList()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, t('channel.toast.remove_error')))
  }
}

document.getElementById('chRefreshAllowedBtn').addEventListener('click', refreshAllowedList)

export async function refreshInvites() {
  if (!currentAgent) return
  const listEl = document.getElementById('chInviteList')
  try {
    const res = await fetch(`${channelApiBase()}/invites`)
    if (!res.ok) return
    const items = await res.json()
    if (!items.length) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.invite.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const inv of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const expiresIn = Math.max(0, Math.floor((inv.expiresAt - Date.now()) / 60000))
      const status = inv.used
        ? `<span class="tg-allowed-kind" style="background:rgba(180,180,180,0.15); color:var(--text-muted);">${t('channel.invite.used_badge')}</span>`
        : `<span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.invite.active_badge', { min: expiresIn })}</span>`
      const linkHtml = inv.deepLink
        ? `<a href="${escapeHtml(inv.deepLink)}" target="_blank" class="tg-allowed-id" style="text-decoration:underline;">${escapeHtml(inv.deepLink)}</a>`
        : `<span class="tg-allowed-id">${t('channel.invite.no_username')}</span>`
      item.innerHTML = `
        <div class="tg-allowed-meta" style="flex-wrap:wrap; gap:6px;">
          ${status}
          ${linkHtml}
        </div>
        <div style="display:flex; gap:6px;">
          ${inv.deepLink && !inv.used ? `<button class="btn" data-variant="secondary" data-size="compact" data-link="${escapeHtml(inv.deepLink)}" style="padding:4px 10px; font-size:11px; margin:0;">${t('common.btn.copy_btn')}</button>` : ''}
          <button class="btn" data-variant="icon" data-danger="" title="${t('channel.btn.revoke')}" data-token="${escapeHtml(inv.token)}">&times;</button>
        </div>
      `
      const copyBtn = item.querySelector('button[data-link]')
      if (copyBtn) {
        copyBtn.addEventListener('click', async (e) => {
          const link = e.currentTarget.getAttribute('data-link')
          try { await navigator.clipboard.writeText(link); showToast(t('common.toast.copied')) }
          catch { showToast(t('common.toast.copy_failed')) }
        })
      }
      const revokeBtn = item.querySelector('button[data-token]')
      if (revokeBtn) {
        revokeBtn.addEventListener('click', () => revokeInviteToken(inv.token))
      }
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function generateInvite() {
  if (!currentAgent) return
  const btn = document.getElementById('chGenerateInviteBtn')
  btn.disabled = true
  btn.textContent = t('channel.btn.invite_gen')
  try {
    const res = await fetch(`${channelApiBase()}/invites`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    const data = await res.json()
    if (data.deepLink) {
      try { await navigator.clipboard.writeText(data.deepLink); showToast(t('channel.toast.invite_copied')) }
      catch { showToast(t('channel.toast.invite_created')) }
    } else {
      showToast(t('channel.toast.invite_pending'))
    }
    refreshInvites()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Sikertelen'))
  } finally {
    btn.disabled = false
    btn.textContent = t('channel.btn.invite_new')
  }
}

async function revokeInviteToken(token) {
  if (!currentAgent) return
  if (!confirm(t('channel.confirm.revoke'))) return
  try {
    const res = await fetch(`${channelApiBase()}/invites/${encodeURIComponent(token)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
    }
    showToast(t('channel.toast.invite_revoked'))
    refreshInvites()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Sikertelen'))
  }
}

document.getElementById('chGenerateInviteBtn').addEventListener('click', generateInvite)
document.getElementById('chRefreshInvitesBtn').addEventListener('click', refreshInvites)

// --- Channel Requests (Slack channel opt-in) ---
export async function refreshChannelRequests() {
  if (!currentAgent) return
  const section = document.getElementById('chRequestSection')
  const listEl = document.getElementById('chRequestList')
  const badge = document.getElementById('chRequestBadge')
  if (currentChannelProvider !== 'slack') {
    section.hidden = true
    return
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests`)
    if (!res.ok) { section.hidden = true; return }
    const items = await res.json()
    if (!items.length) {
      section.hidden = true
      badge.hidden = true
      return
    }
    section.hidden = false
    badge.hidden = false
    badge.textContent = items.length
    listEl.innerHTML = ''
    for (const req of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const name = req.channel_name ? escapeHtml(req.channel_name) : req.channel_id
      const ts = new Date(req.requested_at * 1000).toLocaleString('hu-HU')
      const userId = req.user_id ? `<span class="tg-allowed-id">user: ${escapeHtml(req.user_id)}</span>` : ''
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">#${name}</span>
          ${userId}
          <span class="tg-allowed-id" style="font-size:11px;color:var(--text-muted)">${ts}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" data-variant="primary" data-size="compact" data-approve="${req.id}" style="padding:4px 10px;font-size:11px;margin:0">${t('common.btn.approve')}</button>
          <button class="btn" data-variant="icon" data-danger="" data-deny="${req.id}" title="${t('channel.btn.deny')}">&times;</button>
        </div>
      `
      item.dataset.reqId = req.id
      item.querySelector('[data-approve]').addEventListener('click', () => openApproveModal(req.id, req.channel_name || req.channel_id, req.user_id))
      item.querySelector('[data-deny]').addEventListener('click', () => denyChannelRequest(req.id, item))
      listEl.appendChild(item)
    }
  } catch { section.hidden = true }
}

let _approveReqId = null

function openApproveModal(id, channelName, userId) {
  _approveReqId = id
  const desc = document.getElementById('chApproveModalDesc')
  const userNote = userId ? t('channel.approve.requester', { user: escapeHtml(userId) }) : ''
  desc.textContent = t('channel.approve.desc', { channel: escapeHtml(channelName), requester: userNote })
  document.getElementById('chApproveRequireMention').checked = true
  document.getElementById('chApproveAllowFromAll').checked = false
  document.getElementById('chApproveModalOverlay').hidden = false
}

async function submitApproveModal() {
  const id = _approveReqId
  if (!id) return
  const requireMention = document.getElementById('chApproveRequireMention').checked
  const allowFromAll = document.getElementById('chApproveAllowFromAll').checked
  const confirmBtn = document.getElementById('chApproveModalConfirm')
  confirmBtn.querySelector('.btn-text').hidden = true
  confirmBtn.querySelector('.btn-loading').hidden = false
  confirmBtn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireMention, allowFromAll }),
    })
    // apiData carries the full response object for getErrorMessage(); do NOT use err.message
    if (!res.ok) { const apiErr = await res.json().catch(() => ({})); throw Object.assign(new Error('api call failed'), { apiData: apiErr }) }
    document.getElementById('chApproveModalOverlay').hidden = true
    const item = document.querySelector(`[data-req-id="${id}"]`)
    if (item) item.remove()
    showToast(t('channel.toast.approved'))
    refreshChannelRequests()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Hiba'))
  } finally {
    confirmBtn.querySelector('.btn-text').hidden = false
    confirmBtn.querySelector('.btn-loading').hidden = true
    confirmBtn.disabled = false
  }
}

async function denyChannelRequest(id, itemEl) {
  if (itemEl?.dataset.denying) return
  if (itemEl) itemEl.dataset.denying = '1'
  if (itemEl) itemEl.remove()
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/deny`, { method: 'POST' })
    if (!res.ok) throw new Error('Hiba')
    showToast(t('channel.toast.denied'))
    refreshChannelRequests()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
    refreshChannelRequests()
  }
}

;(function initApproveModal() {
  function closeApproveModal() { document.getElementById('chApproveModalOverlay').hidden = true }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chApproveModalConfirm').addEventListener('click', submitApproveModal)
    document.getElementById('chApproveModalClose').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalCancel').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeApproveModal() })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('chApproveModalOverlay').hidden) closeApproveModal()
    })
  })
})()

document.getElementById('chApproveBtn').addEventListener('click', async () => {
  const code = document.getElementById('chPairCode').value.trim()
  if (!code) { document.getElementById('chPairCode').focus(); return }
  await approvePairing(code)
  document.getElementById('chPairCode').value = ''
  refreshAllowedList()
})

document.getElementById('chDisconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const provLabel = getProviderLabel()
  if (!confirm(`Biztosan levalasztod a ${provLabel} csatornat?`)) return
  try {
    await fetch(`${channelApiBase()}`, { method: 'DELETE' })
    showToast(`${provLabel} levalasztva`)
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch {
    showToast(t('channel.toast.disconnect_error'))
  }
})


