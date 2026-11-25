// Agents page: grid / radial org-chart view toggle (split out of agents.js).
// Page-level view-toggle, not a modal tab. The radial chart REPLACED the old tree view (drag-and-drop included): who reports
// to whom is edited on the Team tab of the agent card.

import { t } from './i18n.js'
import { escapeHtml } from './util.js'
import { avatarBust, setAgentsActiveView } from './agents.js'
import { openAgentDetail } from './agents-detail.js'
import { layoutRadial } from './org-radial-layout.js'
import { renderRadialSvg } from './org-radial-svg.js'
import { wireRadialEvents } from './org-radial-events.js'

// === Radial org chart: one SVG per tenant ===
// Display only (no drag-and-drop): the reporting lines are edited on the Team tab of the agent card. The geometry is
// org-radial-layout.js, the markup org-radial-svg.js; this part fetches, builds the headers and wires the events.
let radialMainAgentId = null
let radialWired = false

async function loadRadialGraph() {
  const container = document.getElementById('radialGraph')
  if (!container) return
  container.innerHTML = '<div class="team-empty">' + t('team.loading') + '</div>'
  try {
    const res = await fetch('/api/team/graph?view=tenants')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    renderRadialGraph(container, await res.json())
  } catch (err) {
    container.innerHTML = `<div class="team-empty">${escapeHtml(t('team.error', { msg: (err && err.message) || err }))}</div>`
  }
}

function radialAvatarUrl(id) {
  return id === radialMainAgentId
    ? `/api/marveen/avatar${avatarBust()}`
    : `/api/agents/${encodeURIComponent(id)}/avatar${avatarBust()}`
}

function renderRadialGraph(container, data) {
  radialMainAgentId = data.mainAgentId || null
  container.innerHTML = ''
  const tenants = (data.tenants || []).filter((tn) => Array.isArray(tn.nodes) && tn.nodes.length > 0)
  if (!tenants.length) {
    container.innerHTML = `<div class="team-empty">${escapeHtml(t('team.radial.empty'))}</div>`
    return
  }
  tenants.forEach((tn, index) => {
    const name = tn.name || tn.id
    const section = document.createElement('section')
    section.className = 'org-radial-tenant'
    const head = document.createElement('div')
    head.className = 'org-radial-head'
    const h = document.createElement('h3')
    h.className = 'org-radial-name'
    h.textContent = name
    const count = document.createElement('span')
    count.className = 'org-radial-count'
    count.textContent = t('team.radial.count', { n: tn.nodes.length })
    head.append(h, count)
    section.appendChild(head)
    const layout = layoutRadial({ rootId: tn.rootId, nodes: tn.nodes, edges: tn.edges || [] })
    if (!layout.clean) {
      // never draw a picture with overlapping boxes: say so instead
      const warn = document.createElement('div')
      warn.className = 'team-empty'
      warn.textContent = t('team.radial.layout_error')
      section.appendChild(warn)
    } else {
      const holder = document.createElement('div')
      // renderRadialSvg escapes every value it writes
      holder.innerHTML = renderRadialSvg(tn, layout, {
        index,
        avatarUrl: radialAvatarUrl,
        a11yLabel: ({ label, title, running }) =>
          [label, title, running ? t('team.radial.state_running') : t('team.radial.state_stopped')].filter(Boolean).join(', '),
        hiddenLabel: (n) => t('team.radial.hidden', { n }),
        ariaLabel: t('team.radial.picture', { tenant: name, n: tn.nodes.length }),
      })
      section.appendChild(holder)
    }
    container.appendChild(section)
  })
  if (!radialWired) {
    radialWired = true // the container survives every reload, so the delegated handlers are added once
    wireRadialEvents(container, { open: openAgentDetail, isMain: (id) => id === radialMainAgentId })
  }
}

// === Agents page: grid / radial view toggle ===
// 'tree' (the removed view, still the name the #team alias and an old in-memory choice may carry) falls back to radial.
export function setAgentsView(view) {
  const active = view === 'grid' ? 'grid' : 'radial'
  setAgentsActiveView(active)
  const views = { grid: 'agentsGridView', radial: 'agentsRadialView' }
  const buttons = { grid: 'agentsViewGrid', radial: 'agentsViewRadial' }
  if (!document.getElementById(views.grid) || !document.getElementById(views.radial)) return
  for (const key of Object.keys(views)) {
    document.getElementById(views[key]).hidden = key !== active
    const btn = document.getElementById(buttons[key])
    if (btn) btn.classList.toggle('active', key === active)
  }
  if (active === 'radial') loadRadialGraph()
}

for (const [id, view] of [['agentsViewGrid', 'grid'], ['agentsViewRadial', 'radial']]) {
  const btn = document.getElementById(id)
  if (btn) btn.addEventListener('click', () => setAgentsView(view))
}
