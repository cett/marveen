// Agents page: grid / org-chart view toggle (split out of agents.js for
// #773/#776). Page-level view-toggle, not a modal tab.

import { t } from './i18n.js'
import { showToast } from './toast.js'
import { escapeHtml } from './util.js'
import { agents, avatarBust, setAgentsActiveView, isAdminView } from './agents.js'
import { openAgentDetail } from './agents-detail.js'

// === Team org-chart (now embedded in Agents page, tree view) ===
async function loadTeamGraph() {
  const container = document.getElementById('teamGraph')
  if (!container) return
  container.innerHTML = '<div class="team-empty">' + t('team.loading') + '</div>'
  try {
    const res = await fetch('/api/team/graph')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    renderTeamGraph(container, data, { editable: true })
  } catch (err) {
    container.innerHTML = `<div class="team-empty">${t('team.error', { msg: err.message || err })}</div>`
  }
}

// Persist a drag-and-drop reporting change: `childId` now reports to `parentId`.
// Guards (also enforced server-side) keep the caller from creating a cycle or
// writing a no-op. On success the graph is reloaded so the tree re-lays-out.
async function saveTeamReportsTo(childId, parentId, ctx) {
  const { byId, parentOf, descendantsOf, mainAgentId } = ctx
  if (!childId || childId === parentId || childId === mainAgentId) return
  if (parentOf.get(childId) === parentId) return  // already the parent
  if (descendantsOf(childId).has(parentId)) { showToast(t('team.drop.cycle')); return }
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(childId)}/team`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportsTo: parentId }),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const result = await r.json().catch(() => ({}))
    if (result.cycleRejected) { showToast(t('team.drop.cycle')); return }
    const childLabel = (byId.get(childId) || {}).label || childId
    const parentLabel = (byId.get(parentId) || {}).label || parentId
    showToast(t('team.drop.saved', { child: childLabel, parent: parentLabel }))
    loadTeamGraph()
  } catch {
    showToast(t('team.drop.error'))
  }
}

function renderTeamGraph(container, data, opts = {}) {
  const editable = !!opts.editable
  const { nodes, edges, mainAgentId } = data
  container.innerHTML = ''
  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = new Map()
  const parentOf = new Map()
  for (const n of nodes) childrenOf.set(n.id, [])
  for (const e of edges) {
    if (childrenOf.has(e.from)) childrenOf.get(e.from).push(e.to)
    parentOf.set(e.to, e.from)
  }
  // Transitive reports of `id` (its whole subtree). Used to reject dropping a
  // manager onto one of its own reports, which would orphan the subtree.
  const descendantsOf = (id) => {
    const out = new Set()
    const walk = (x) => {
      for (const c of (childrenOf.get(x) || [])) {
        if (!out.has(c)) { out.add(c); walk(c) }
      }
    }
    walk(id)
    return out
  }
  const dropCtx = { byId, parentOf, descendantsOf, mainAgentId }
  // A single dragged id shared across all nodes' dragover handlers so they can
  // validate the target (dataTransfer payload is unreadable during dragover).
  let draggingId = null
  const renderNode = (node) => {
    const div = document.createElement('div')
    div.className = 'team-node'
    if (node.role === 'main') div.classList.add('main')
    else if (node.primaryTenantId) div.classList.add('tenant-main')
    else if (node.role === 'leader') div.classList.add('leader')
    const roleLabel = node.role === 'main'
      ? t('team.role.main')
      : node.primaryTenantId
        ? t('agents.tenant_main_badge', { tenant: node.primaryTenantName || node.primaryTenantId })
        : (node.role === 'leader' ? t('team.role.leader') : t('team.role.member'))
    const running = node.running ? t('team.running') : t('team.stopped')
    const avatarUrl = node.id === mainAgentId
      ? `/api/marveen/avatar${avatarBust()}`
      : `/api/agents/${encodeURIComponent(node.id)}/avatar${avatarBust()}`
    // Tenant-membership chips: admin-only, mirroring the Agents grid card's
    // tenantChipsHtml (#857 -- the org-chart never got this on #919's
    // card-only rollout).
    let tenantChipsHtml = ''
    if (isAdminView() && Array.isArray(node.tenantIds) && node.tenantIds.length > 0) {
      const chips = node.tenantIds.map((id) => {
        const name = (node.tenantNames && node.tenantNames[id]) || id
        return `<span class="tenant-chip" data-tenant="${escapeHtml(id)}">${escapeHtml(t('agents.tenant_chip', { tenant: name }))}</span>`
      }).join('')
      tenantChipsHtml = `<div class="team-node-chips chip-group">${chips}</div>`
    }
    div.innerHTML = `
      <div class="team-node-avatar"><img src="${avatarUrl}" alt="${escapeHtml(node.label || node.id)}" onerror="this.style.display='none'"></div>
      <div class="team-node-name">${escapeHtml(node.label || node.id)}</div>
      <div class="team-node-meta">${escapeHtml(roleLabel)}</div>
      <div class="team-node-meta">${running}</div>
      ${tenantChipsHtml}
    `
    if (node.id !== mainAgentId) {
      div.addEventListener('click', () => openAgentDetail(node.id))
    }
    // Drag-and-drop reporting edit (Team page only). Any agent except the main
    // one can be dragged; any node can be a drop target (dropping onto the main
    // agent makes the report a direct report of it).
    if (editable) {
      if (node.id !== mainAgentId) {
        div.draggable = true
        div.classList.add('team-draggable')
        div.addEventListener('dragstart', (e) => {
          draggingId = node.id
          e.dataTransfer.setData('text/plain', node.id)
          e.dataTransfer.effectAllowed = 'move'
          div.classList.add('team-dragging')
        })
        div.addEventListener('dragend', () => {
          draggingId = null
          div.classList.remove('team-dragging')
        })
      }
      const isValidTarget = () =>
        draggingId && draggingId !== node.id &&
        parentOf.get(draggingId) !== node.id &&
        !descendantsOf(draggingId).has(node.id)
      div.addEventListener('dragover', (e) => {
        if (!isValidTarget()) return  // no preventDefault -> shows "no drop"
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        div.classList.add('team-drop-target')
      })
      div.addEventListener('dragleave', () => div.classList.remove('team-drop-target'))
      div.addEventListener('drop', (e) => {
        e.preventDefault()
        div.classList.remove('team-drop-target')
        const childId = e.dataTransfer.getData('text/plain') || draggingId
        saveTeamReportsTo(childId, node.id, dropCtx)
      })
    }
    return div
  }
  // Render as a nested tree so each report sits directly under its own
  // manager. A flat BFS-by-row layout made a leader's reports look like they
  // belonged to whichever node happened to be above them in the row.
  const seen = new Set([mainAgentId])
  const renderSubtree = (id) => {
    const node = byId.get(id)
    if (!node) return null
    const col = document.createElement('div')
    col.className = 'team-subtree'
    col.appendChild(renderNode(node))
    const kids = (childrenOf.get(id) || []).filter(c => !seen.has(c) && byId.has(c))
    for (const c of kids) seen.add(c)
    if (kids.length) {
      const conn = document.createElement('div')
      conn.className = 'team-connector'
      col.appendChild(conn)
      const row = document.createElement('div')
      row.className = 'team-children'
      for (const c of kids) {
        const sub = renderSubtree(c)
        if (sub) row.appendChild(sub)
      }
      col.appendChild(row)
    }
    return col
  }
  // Main on top, then a row of its direct reports (each carrying its own
  // subtree beneath it).
  const mainNode = byId.get(mainAgentId)
  if (mainNode) {
    const mainRow = document.createElement('div')
    mainRow.className = 'team-level'
    mainRow.appendChild(renderNode(mainNode))
    container.appendChild(mainRow)
  }
  const directs = (childrenOf.get(mainAgentId) || []).filter(c => !seen.has(c) && byId.has(c))
  for (const c of directs) seen.add(c)
  if (directs.length) {
    const conn = document.createElement('div')
    conn.className = 'team-connector'
    container.appendChild(conn)
    const row = document.createElement('div')
    row.className = 'team-children team-roots'
    for (const c of directs) {
      const sub = renderSubtree(c)
      if (sub) row.appendChild(sub)
    }
    container.appendChild(row)
  }
  // Orphans (nodes not reachable from main, shouldn't happen with the auto
  // fallback on the backend but guard just in case) go to a trailing row.
  const orphans = nodes.filter(n => !seen.has(n.id))
  if (orphans.length) {
    const row = document.createElement('div')
    row.className = 'team-level'
    for (const n of orphans) row.appendChild(renderNode(n))
    container.appendChild(row)
  }
  if (nodes.length === 1) {
    const empty = document.createElement('div')
    empty.className = 'team-empty'
    empty.textContent = t('team.empty')
    container.appendChild(empty)
  }
}

// === Agents page: grid / org-chart view toggle ===
export function setAgentsView(view) {
  setAgentsActiveView(view)
  const gridView = document.getElementById('agentsGridView')
  const treeView = document.getElementById('agentsTreeView')
  const gridBtn  = document.getElementById('agentsViewGrid')
  const treeBtn  = document.getElementById('agentsViewTree')
  if (!gridView || !treeView) return
  const showGrid = view === 'grid'
  gridView.hidden = !showGrid
  treeView.hidden = showGrid
  if (gridBtn) gridBtn.classList.toggle('active', showGrid)
  if (treeBtn) treeBtn.classList.toggle('active', !showGrid)
  if (!showGrid) loadTeamGraph()
}

const _agentsViewGridBtn = document.getElementById('agentsViewGrid')
const _agentsViewTreeBtn = document.getElementById('agentsViewTree')
if (_agentsViewGridBtn) _agentsViewGridBtn.addEventListener('click', () => setAgentsView('grid'))
if (_agentsViewTreeBtn) _agentsViewTreeBtn.addEventListener('click', () => setAgentsView('tree'))
