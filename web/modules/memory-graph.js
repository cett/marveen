import { escapeHtml, mainAgentId } from './util.js'
import { getMemTenant } from './memories.js'

// === Memory Graph (Force-directed, Obsidian-style) ===

let graphNodes = []
let graphEdges = []
let graphSim = null
export let graphCanvas = null
export let graphCtx = null
let graphDragging = null
let graphHover = null
let graphSelectedNode = null
let graphSearchQuery = ''

// Zoom & pan state
let graphZoom = 1
let graphPanX = 0
let graphPanY = 0
let graphPanning = false
let graphPanStartX = 0
let graphPanStartY = 0
let graphZoomIndicatorTimer = null
let graphPanelHoverNeighborId = null  // mem.id of neighbor row being hovered in card
let graphCameraNudge = null           // {fromX, fromY, toX, toY, startMs, dur}
let graphNodePulseActive = null       // {node, startMs} for 600ms halo pulse on neighbor click

// Edge animation
let graphAnimFrame = 0

export const GRAPH_TIER_COLORS = {
  hot: '#dc3c3c',
  warm: '#d97757',
  cold: '#6a9bcc',
  shared: '#b0a040',
  import: '#39FF14',
}

// design spec: luminous dark-variants for ambient glow
export const GRAPH_TIER_GLOW = {
  hot:    '#ff6b5e',
  warm:   '#ff9a70',
  cold:   '#8fc1ff',
  shared: '#e3cf5e',
  import: '#39FF14',  // neon green per Jónás spec
}

const GRAPH_TIER_BG = {
  hot: 'rgba(220, 60, 60, 0.06)',
  warm: 'rgba(217, 119, 87, 0.06)',
  cold: 'rgba(106, 155, 204, 0.06)',
  shared: 'rgba(176, 160, 64, 0.06)',
  import: 'rgba(57, 255, 20, 0.06)',
}

// Offscreen glow sprites (pre-rendered at buildGraph time, reused every frame)
export let graphGlowSprites = {}  // { [tier]: HTMLCanvasElement }
export let graphParticleSprite = null
export const GRAPH_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// Idle animation state
let graphIdleRaf = null      // rAF handle for post-settle idle loop
let graphLastInteraction = Date.now()
let graphIdleSlowFrame = 0   // counts frames for 30fps throttle
let graphLastRenderTs = 0    // for delta-time based lerp

// Particle pool: up to 60 particles on active edges
let graphParticles = []  // [{ edgeIdx, t, speed }]

// design spec section 2: back-out easing for node pop-in (cubic-bezier(0.34,1.56,0.64,1))
export function graphEaseOutBack(t) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function makeGlowSprite(hexColor, size) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0.0, hexColor + '55')  // a=0.33
  grad.addColorStop(0.4, hexColor + '22')  // a=0.13
  grad.addColorStop(1.0, hexColor + '00')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return c
}

export function initGlowSprites() {
  const size = (window.devicePixelRatio || 1) >= 2 ? 256 : 128
  for (const tier of Object.keys(GRAPH_TIER_GLOW)) {
    graphGlowSprites[tier] = makeGlowSprite(GRAPH_TIER_GLOW[tier], size)
  }
  graphGlowSprites['white'] = makeGlowSprite('#ffffff', size)
  graphParticleSprite = makeGlowSprite('#ffffff', 32)
}

function screenToWorld(sx, sy) {
  return { x: (sx - graphPanX) / graphZoom, y: (sy - graphPanY) / graphZoom }
}

function worldToScreen(wx, wy) {
  return { x: wx * graphZoom + graphPanX, y: wy * graphZoom + graphPanY }
}

export async function loadMemoryGraph() {
  const agent = document.getElementById('memAgentFilter').value
  const limitEl = document.getElementById('graphNodeLimit')
  const limit = limitEl ? parseInt(limitEl.value, 10) || 200 : 200
  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  params.set('limit', String(Math.min(500, Math.max(1, limit))))
  params.set('weight_min', '0.75')
  const tenant = getMemTenant()
  if (tenant) params.set('tenant', tenant)

  try {
    const res = await fetch(`/api/memories/graph?${params}`)
    const graphData = await res.json()

    const emptyEl = document.getElementById('graphEmpty')
    if (!graphData.nodes || graphData.nodes.length === 0) {
      emptyEl.hidden = false
      document.getElementById('memGraphCanvas').hidden = true
      return
    }
    emptyEl.hidden = true
    document.getElementById('memGraphCanvas').hidden = false

    graphZoom = 1
    graphPanX = 0
    graphPanY = 0
    graphSelectedNode = null
    hideGraphPanel()

    buildGraph(graphData)
    startGraphSimulation()
  } catch (err) {
    console.error('Gráf betöltés hiba:', err)
  }
}

function buildGraph(graphData) {
  graphNodes = []
  graphEdges = []

  const canvas = document.getElementById('memGraphCanvas')
  const rect = canvas.parentElement.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = rect.width + 'px'
  canvas.style.height = rect.height + 'px'
  graphCanvas = canvas
  graphCtx = canvas.getContext('2d')
  graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const w = rect.width
  const h = rect.height

  // Build nodes from /api/memories/graph response
  for (const node of graphData.nodes) {
    graphNodes.push({
      id: node.id,
      x: w / 2 + (Math.random() - 0.5) * w * 0.6,
      y: h / 2 + (Math.random() - 0.5) * h * 0.6,
      vx: 0,
      vy: 0,
      radius: 6,
      connectionCount: 0,
      label: node.label.replace(/\n/g, ' '),
      tier: node.tier || 'warm',
      agent: node.agent || mainAgentId(),
      keywords: [],        // not in graph response; keyword fallback uses this
      degree: node.degree, // pre-computed by backend
      created_at: node.created_at,
      accessed_at: node.accessed_at,
      mem: node,
      searchMatch: true,
    })
  }

  // Build id -> node index map for fast lookup
  const idToIdx = new Map()
  graphNodes.forEach((node, idx) => idToIdx.set(node.id, idx))

  // Semantic edges from the graph endpoint (AND-filtered, both endpoints present)
  const semanticEdgeIds = new Set()
  for (const edge of (graphData.edges || [])) {
    const si = idToIdx.get(edge.src_id)
    const di = idToIdx.get(edge.dst_id)
    if (si === undefined || di === undefined) continue
    const a = graphNodes[si]
    const b = graphNodes[di]
    const strength = edge.weight || 0.5
    graphEdges.push({ source: si, target: di, strength, semantic: true })
    a.connectionCount += strength
    b.connectionCount += strength
    semanticEdgeIds.add(`${Math.min(si, di)}-${Math.max(si, di)}`)
  }

  // Keyword-based fallback for orphan nodes (no semantic links)
  for (let i = 0; i < graphNodes.length; i++) {
    for (let j = i + 1; j < graphNodes.length; j++) {
      if (semanticEdgeIds.has(`${i}-${j}`)) continue
      const a = graphNodes[i]
      const b = graphNodes[j]
      const shared = a.keywords.filter(k => b.keywords.includes(k))
      if (shared.length > 0) {
        graphEdges.push({ source: i, target: j, strength: shared.length * 0.3, semantic: false })
        a.connectionCount += shared.length * 0.3
        b.connectionCount += shared.length * 0.3
      }
    }
  }

  // Node radius uses backend degree; orphan/hub badges use same
  const HUB_THRESHOLD = 5
  for (const node of graphNodes) {
    node.radius = 5 + Math.min(Math.sqrt(node.connectionCount) * 2.5, 14)
    node.isOrphan = node.degree === 0
    node.isHub = node.degree >= HUB_THRESHOLD
    node.importance = node.connectionCount + (node.isHub ? 10 : 0) + (node.tier === 'hot' ? 2 : 0)
    node.labelAlpha = 0
  }

  // Pop-in animation: stagger entry by node index (design spec section 2)
  const popStagger = GRAPH_REDUCED_MOTION ? 0 : Math.min(10, 1200 / Math.max(graphNodes.length, 1))
  const nowInit = Date.now()
  for (let ni = 0; ni < graphNodes.length; ni++) {
    graphNodes[ni].birthMs = nowInit + ni * popStagger
    graphNodes[ni].renderedAlpha = 0  // lerp start value for hover-crossfade
  }
  graphLastRenderTs = 0  // reset delta tracker on new graph

  // Ensure controls hint and zoom indicator exist
  const graphView = document.getElementById('memGraphView')
  if (!graphView.querySelector('.graph-controls-hint')) {
    const hint = document.createElement('div')
    hint.className = 'graph-controls-hint'
    hint.innerHTML = 'Scroll: zoom | Drag: move nodes<br>Click: details | Dbl-click: edit'
    graphView.appendChild(hint)
  }
  if (!graphView.querySelector('.graph-zoom-indicator')) {
    const zi = document.createElement('div')
    zi.className = 'graph-zoom-indicator'
    zi.id = 'graphZoomIndicator'
    graphView.appendChild(zi)
  }
}

function simulateGraphStep(damping) {
  const w = graphCanvas.width / (window.devicePixelRatio || 1)
  const h = graphCanvas.height / (window.devicePixelRatio || 1)
  const nodes = graphNodes

  const tierCenters = {}
  for (const node of nodes) {
    if (!tierCenters[node.tier]) tierCenters[node.tier] = { x: 0, y: 0, count: 0 }
    tierCenters[node.tier].x += node.x
    tierCenters[node.tier].y += node.y
    tierCenters[node.tier].count++
  }
  for (const tier of Object.keys(tierCenters)) {
    tierCenters[tier].x /= tierCenters[tier].count
    tierCenters[tier].y /= tierCenters[tier].count
  }
  for (const node of nodes) {
    const tc = tierCenters[node.tier]
    if (tc) {
      node.vx += (tc.x - node.x) * 0.0035
      node.vy += (tc.y - node.y) * 0.0035
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let dx = nodes[j].x - nodes[i].x
      let dy = nodes[j].y - nodes[i].y
      let dist = Math.sqrt(dx * dx + dy * dy) || 1
      let force = 2400 / (dist * dist)
      let fx = (dx / dist) * force
      let fy = (dy / dist) * force
      nodes[i].vx -= fx
      nodes[i].vy -= fy
      nodes[j].vx += fx
      nodes[j].vy += fy
    }
  }

  for (const edge of graphEdges) {
    const a = nodes[edge.source]
    const b = nodes[edge.target]
    let dx = b.x - a.x
    let dy = b.y - a.y
    let dist = Math.sqrt(dx * dx + dy * dy) || 1
    // Degree-weighted rest length: higher-degree nodes pull neighbors closer.
    // Clamp prevents hub collapse (min 40px) while preserving island separation.
    const degSum = (a.degree || 0) + (b.degree || 0)
    const restLength = Math.max(40, 140 - 10.0 * Math.min(degSum, 44))
    let force = (dist - restLength) * 0.005 * edge.strength
    // Cap force to prevent oscillation on very short edges
    force = Math.max(-4, Math.min(4, force))
    let fx = (dx / dist) * force
    let fy = (dy / dist) * force
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }

  for (const node of nodes) {
    node.vx += (w / 2 - node.x) * 0.001
    node.vy += (h / 2 - node.y) * 0.001
  }

  const maxV = 6
  for (const node of nodes) {
    if (node === graphDragging) continue
    node.vx *= damping
    node.vy *= damping
    if (node.vx > maxV) node.vx = maxV; else if (node.vx < -maxV) node.vx = -maxV
    if (node.vy > maxV) node.vy = maxV; else if (node.vy < -maxV) node.vy = -maxV
    node.x += node.vx
    node.y += node.vy
    node.x = Math.max(-200, Math.min(w + 200, node.x))
    node.y = Math.max(-200, Math.min(h + 200, node.y))
  }
}

function startGraphSimulation() {
  if (graphSim) cancelAnimationFrame(graphSim)
  if (graphIdleRaf) cancelAnimationFrame(graphIdleRaf)
  graphParticles = []
  initGlowSprites()

  for (const node of graphNodes) {
    node.vx = 0
    node.vy = 0
    // Randomize idle drift parameters per node (stable per session)
    node.driftF = 0.3 + (node.id % 13) * 0.015   // 0.3-0.495 rad/s
    node.driftP1 = (node.id * 2.39) % (Math.PI * 2)
    node.driftP2 = (node.id * 1.61) % (Math.PI * 2)
  }

  const preSettleIterations = Math.min(250, 40 + graphNodes.length * 2)
  for (let i = 0; i < preSettleIterations; i++) {
    simulateGraphStep(0.88)
  }

  let frame = 0
  const maxFrames = 60

  function tick() {
    if (document.hidden) { graphSim = requestAnimationFrame(tick); return }
    if (frame > maxFrames) {
      autoFitGraph()
      startIdleLoop()
      return
    }
    frame++
    graphAnimFrame = frame
    simulateGraphStep(0.94 + (frame / maxFrames) * 0.05)
    renderGraph()
    graphSim = requestAnimationFrame(tick)
  }

  tick()
}

function autoFitGraph() {
  if (!graphNodes.length || !graphCanvas) return
  const dpr = window.devicePixelRatio || 1
  const w = graphCanvas.width / dpr
  const h = graphCanvas.height / dpr
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const n of graphNodes) {
    if (n.x < minX) minX = n.x
    if (n.x > maxX) maxX = n.x
    if (n.y < minY) minY = n.y
    if (n.y > maxY) maxY = n.y
  }
  const pad = 60
  const contentW = maxX - minX + pad * 2
  const contentH = maxY - minY + pad * 2
  graphZoom = Math.max(0.4, Math.min(1.0, Math.min(w / contentW, h / contentH)))
  graphPanX = w / 2 - ((minX + maxX) / 2) * graphZoom
  graphPanY = h / 2 - ((minY + maxY) / 2) * graphZoom
}

function startIdleLoop() {
  if (graphIdleRaf) cancelAnimationFrame(graphIdleRaf)
  graphIdleSlowFrame = 0

  function idleTick() {
    if (document.hidden) { graphIdleRaf = requestAnimationFrame(idleTick); return }

    // Throttle to ~30fps after 5s of no interaction
    const idle5s = Date.now() - graphLastInteraction > 5000
    if (idle5s) {
      graphIdleSlowFrame++
      if (graphIdleSlowFrame % 2 !== 0) { graphIdleRaf = requestAnimationFrame(idleTick); return }
    }

    if (!GRAPH_REDUCED_MOTION) tickParticles()
    renderGraph()
    graphIdleRaf = requestAnimationFrame(idleTick)
  }

  graphIdleRaf = requestAnimationFrame(idleTick)
}

function tickParticles() {
  // Identify active edges (connected to hover/selected node), cap at 20
  const activeNode = graphHover || graphSelectedNode
  let activeEdges = []
  if (activeNode) {
    const activeIdx = graphNodes.indexOf(activeNode)
    activeEdges = graphEdges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.source === activeIdx || e.target === activeIdx)
      .sort((a, b) => b.e.strength - a.e.strength)
      .slice(0, 20)
  } else {
    // Ambient: top 20 edges by strength
    activeEdges = graphEdges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.semantic)
      .sort((a, b) => b.e.strength - a.e.strength)
      .slice(0, 20)
  }

  const activeEdgeSet = new Set(activeEdges.map(({ i }) => i))

  // Remove particles on edges that are no longer active
  graphParticles = graphParticles.filter(p => activeEdgeSet.has(p.edgeIdx))

  // Spawn up to 3 particles per active edge (cap total 60)
  for (const { i } of activeEdges) {
    const existing = graphParticles.filter(p => p.edgeIdx === i).length
    const toSpawn = Math.max(0, 3 - existing)
    for (let s = 0; s < toSpawn && graphParticles.length < 60; s++) {
      graphParticles.push({ edgeIdx: i, t: s / 3, speed: 0.35 })  // stagger start
    }
  }

  // Advance particles
  const dt = 1 / 60
  for (const p of graphParticles) {
    p.t += p.speed * dt
    if (p.t > 1) p.t -= 1
  }
}

function renderGraph() {
  const ctx = graphCtx
  const dpr = window.devicePixelRatio || 1
  const w = graphCanvas.width / dpr
  const h = graphCanvas.height / dpr

  // Dark-cinematic: always dark if no explicit light theme; light = reduced fallback
  const themeAttr = document.documentElement.getAttribute('data-theme')
  const isDark = themeAttr !== 'light'

  const cs = getComputedStyle(document.documentElement)
  const borderColor = cs.getPropertyValue('--border').trim() || (isDark ? '#3d3d3a' : '#d1cfc5')
  const textColor = cs.getPropertyValue('--text').trim() || (isDark ? '#e8e7e0' : '#141413')
  const textMuted = cs.getPropertyValue('--text-muted').trim() || (isDark ? '#73726c' : '#87867f')

  // Camera nudge animation (card open or neighbor click, spec §2 / §4.4)
  if (graphCameraNudge && !GRAPH_REDUCED_MOTION) {
    const { fromX, fromY = graphPanY, toX, toY = graphPanY, startMs, dur } = graphCameraNudge
    const elapsed = performance.now() - startMs
    const t = Math.min(1, elapsed / dur)
    // Ease-in-out cubic
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    graphPanX = fromX + (toX - fromX) * e
    graphPanY = fromY + (toY - fromY) * e
    if (t >= 1) graphCameraNudge = null
  }

  // === Background: dark-cinematic vignette OR light fallback ===
  ctx.clearRect(0, 0, w, h)
  if (isDark) {
    const vign = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75)
    vign.addColorStop(0.0, '#1c1b19')
    vign.addColorStop(0.6, '#151514')
    vign.addColorStop(1.0, '#0e0e0d')
    ctx.fillStyle = vign
  } else {
    const vign = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75)
    vign.addColorStop(0.0, '#ffffff')
    vign.addColorStop(1.0, '#f0eee6')
    ctx.globalAlpha = 0.6
    ctx.fillStyle = vign
  }
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 1

  // === Dot grid (screen space) ===
  const gridSize = 26
  ctx.fillStyle = borderColor
  ctx.globalAlpha = isDark ? 0.16 : 0.25
  const offsetX = ((graphPanX % (gridSize * graphZoom)) + gridSize * graphZoom) % (gridSize * graphZoom)
  const offsetY = ((graphPanY % (gridSize * graphZoom)) + gridSize * graphZoom) % (gridSize * graphZoom)
  const scaledGrid = gridSize * graphZoom
  if (scaledGrid > 4) {
    for (let x = offsetX; x < w; x += scaledGrid) {
      for (let y = offsetY; y < h; y += scaledGrid) {
        ctx.beginPath()
        ctx.arc(x, y, Math.max(0.5, 0.7 * graphZoom), 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1

  // === Apply zoom/pan transform ===
  ctx.save()
  ctx.translate(graphPanX, graphPanY)
  ctx.scale(graphZoom, graphZoom)

  const nowMs = Date.now()
  const time = nowMs * 0.001
  const dt = graphLastRenderTs > 0 ? Math.min(nowMs - graphLastRenderTs, 50) : 16.67
  graphLastRenderTs = nowMs
  // design spec section 2: 180ms crossfade via exponential lerp (tau=60ms -> 95% at ~180ms)
  const lerpFactor = 1 - Math.exp(-dt / 60)
  const hasSearch = graphSearchQuery.length > 0

  // === Tier cluster halos (lighter blend in dark; source-over in light) ===
  const tierGroups = {}
  for (const node of graphNodes) {
    if (!tierGroups[node.tier]) tierGroups[node.tier] = []
    tierGroups[node.tier].push(node)
  }
  const activeNode = graphHover || graphSelectedNode
  for (const [tier, tNodes] of Object.entries(tierGroups)) {
    if (tNodes.length < 2) continue
    let cx = 0, cy = 0
    for (const n of tNodes) { cx += n.x; cy += n.y }
    cx /= tNodes.length; cy /= tNodes.length
    let maxDist = 0
    for (const n of tNodes) {
      const d = Math.sqrt((n.x - cx) ** 2 + (n.y - cy) ** 2)
      if (d > maxDist) maxDist = d
    }
    const radius = maxDist + 110
    const glowCol = GRAPH_TIER_GLOW[tier] || GRAPH_TIER_COLORS[tier]
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
    if (isDark) {
      grad.addColorStop(0.0, glowCol + '14')  // a=0.08
      grad.addColorStop(1.0, glowCol + '00')
      const isActiveTier = activeNode && activeNode.tier === tier
      ctx.globalAlpha = hasSearch ? 0.25 : (isActiveTier ? 0.9 : 0.85)
      ctx.globalCompositeOperation = 'lighter'
    } else {
      const baseCol = GRAPH_TIER_COLORS[tier]
      grad.addColorStop(0.0, baseCol + '1a')
      grad.addColorStop(1.0, baseCol + '00')
      ctx.globalAlpha = hasSearch ? 0.15 : 0.35
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  // Build connected set for hover/selected focus
  const connectedToActive = new Set()
  if (activeNode) {
    const activeIdx = graphNodes.indexOf(activeNode)
    for (const edge of graphEdges) {
      if (edge.source === activeIdx) connectedToActive.add(edge.target)
      if (edge.target === activeIdx) connectedToActive.add(edge.source)
    }
  }

  // === Draw edges ===
  for (let ei = 0; ei < graphEdges.length; ei++) {
    const edge = graphEdges[ei]
    const a = graphNodes[edge.source]
    const b = graphNodes[edge.target]

    const isActiveEdge = activeNode && (a === activeNode || b === activeNode)
    const isDimmed = activeNode && !isActiveEdge
    const searchFaded = hasSearch && (!a.searchMatch || !b.searchMatch)

    const baseWidth = edge.semantic
      ? 1.0 + Math.min(edge.strength * 1.2, 3)
      : 0.5 + Math.min(edge.strength * 0.3, 1.2)
    const pulse = GRAPH_REDUCED_MOTION ? 1 : (0.85 + 0.15 * Math.sin(time * (edge.semantic ? 2 : 1.5) + edge.source * 0.3 + edge.target * 0.7))

    ctx.lineWidth = isActiveEdge ? baseWidth * 1.8 : baseWidth * pulse

    // Edge color: linear gradient source->target tier glow in dark, base color in light
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const curvature = Math.min(dist * 0.15, 30)
    const cpx = mx + (-dy / dist) * curvature
    const cpy = my + (dx / dist) * curvature

    if (edge.semantic && isDark) {
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      const ca = GRAPH_TIER_GLOW[a.tier] || GRAPH_TIER_COLORS[a.tier]
      const cb = GRAPH_TIER_GLOW[b.tier] || GRAPH_TIER_COLORS[b.tier]
      grad.addColorStop(0, ca)
      grad.addColorStop(0.5, GRAPH_TIER_COLORS[a.tier] || ca)
      grad.addColorStop(1, cb)
      ctx.strokeStyle = grad
    } else {
      ctx.strokeStyle = edge.semantic ? (GRAPH_TIER_COLORS[a.tier] || borderColor) : borderColor
    }

    const baseAlpha = edge.semantic
      ? (0.25 + Math.min(edge.strength * 0.3, 0.55))
      : (0.08 + Math.min(edge.strength * 0.05, 0.12))
    const isNeighborHighlightEdge = graphPanelHoverNeighborId !== null && graphSelectedNode !== null
      && ((a === graphSelectedNode && b.mem && b.mem.id === graphPanelHoverNeighborId)
      ||  (b === graphSelectedNode && a.mem && a.mem.id === graphPanelHoverNeighborId))
    const edgeAlpha = searchFaded ? 0.04
      : isNeighborHighlightEdge ? Math.min(0.9, baseAlpha * 2.5)
      : (isActiveEdge ? 0.85 : (isDimmed ? 0.05 : baseAlpha * pulse))
    // Light theme: bump alpha for contrast
    ctx.globalAlpha = isDark ? edgeAlpha : Math.min(1, edgeAlpha + 0.10)

    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(cpx, cpy, b.x, b.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // === Draw particles (active edges, no shadowBlur) ===
  if (!GRAPH_REDUCED_MOTION && graphParticleSprite) {
    const pSize = 7
    for (const p of graphParticles) {
      const edge = graphEdges[p.edgeIdx]
      if (!edge) continue
      const a = graphNodes[edge.source]
      const b = graphNodes[edge.target]
      if (!a || !b) continue
      // Quadratic bezier point at t
      const t = p.t
      const qx = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * ((a.x + b.x) / 2 + (-(b.y - a.y) / (Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2)||1)) * Math.min(Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2) * 0.15, 30)) + t * t * b.x
      const qy = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * ((a.y + b.y) / 2 + ((b.x - a.x) / (Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2)||1)) * Math.min(Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2) * 0.15, 30)) + t * t * b.y
      const tier = graphNodes[edge.source].tier
      const sprite = graphGlowSprites[tier] || graphParticleSprite
      ctx.globalAlpha = 0.9
      ctx.drawImage(sprite, qx - pSize, qy - pSize, pSize * 2, pSize * 2)
    }
    ctx.globalAlpha = 1
  }

  // === Label LOD: precompute eligibility + greedy collision (design spec section 6) ===
  {
    const z = graphZoom
    const dpr = window.devicePixelRatio || 1
    const screenW = graphCanvas.width / dpr
    const screenH = graphCanvas.height / dpr
    const focusNode = graphHover || graphSelectedNode
    const hasFocus = !!focusNode
    const VP_MARGIN = 40
    const truncLimit = z >= 2 ? 40 : 25

    // zoom ramps for P3 ambient labels
    const hubRamp = Math.min(1, Math.max(0, (z - 0.35) / 0.3))
    const ambientRamp = Math.min(1, Math.max(0, (z - 0.7) / 0.5))

    // P3 ambient cap based on zoom
    let p3Cap = 0
    if (z >= 1.5) p3Cap = 60
    else if (z >= 0.8) p3Cap = 20
    else if (z >= 0.5) p3Cap = 8

    // Neighbors of focusNode (by edge weight desc, cap 12) -> P1
    const neighborIdxSet = new Set()
    if (focusNode) {
      const focusIdx = graphNodes.indexOf(focusNode)
      graphEdges
        .filter(e => e.source === focusIdx || e.target === focusIdx)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 12)
        .forEach(e => neighborIdxSet.add(e.source === focusIdx ? e.target : e.source))
    }

    // Pre-populate placed rects with still-fading-out labels (anti-flicker)
    const lodPlacedRects = []
    for (const node of graphNodes) {
      if ((node._labelTargetAlpha || 0) === 0 && (node.labelAlpha || 0) > 0.15 && node._pillScreenRect) {
        lodPlacedRects.push(node._pillScreenRect)
      }
    }

    // Classify candidates
    const candidates = []
    for (let ni = 0; ni < graphNodes.length; ni++) {
      const node = graphNodes[ni]
      const driftX2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.sin(time * node.driftF + node.driftP1) : 0
      const driftY2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.cos(time * node.driftF * 0.8 + node.driftP2) : 0
      const wx = node.x + driftX2
      const wy = node.y + driftY2
      const sx = wx * z + graphPanX
      const sy = wy * z + graphPanY
      const inVP = sx >= -VP_MARGIN && sx <= screenW + VP_MARGIN && sy >= -VP_MARGIN && sy <= screenH + VP_MARGIN

      let priority = -1
      let alphaTarget = 0
      const isP0 = node === focusNode || node === graphSelectedNode
      if (isP0) {
        priority = 0; alphaTarget = 1
      } else if (hasFocus && neighborIdxSet.has(ni)) {
        priority = 1; alphaTarget = 1
      } else if (hasSearch && node.searchMatch) {
        priority = 2; alphaTarget = 1
      } else if (inVP && p3Cap > 0) {
        priority = 3
        // Focus active: P3 ambient participates in collision but wins only 8% dim;
        // non-winners get target=0 (see placement loop below).
        if (hasFocus) {
          alphaTarget = 0.08
        } else if (node.isHub) {
          alphaTarget = hubRamp
        } else {
          alphaTarget = ambientRamp
        }
      }

      node._labelTargetAlpha = 0  // default: hidden; set to real value if placed
      node._labelDisplayText = node.label.length > truncLimit ? node.label.slice(0, truncLimit) + '…' : node.label

      if (priority >= 0) {
        candidates.push({ node, ni, priority, alphaTarget, importance: node.importance || 0 })
      }
    }

    // Sort P0->P1->P2->P3, within class by importance desc
    candidates.sort((a, b) => a.priority - b.priority || b.importance - a.importance)

    let p1Count = 0, p2Count = 0, p3Count = 0
    const labelFontBase = Math.max(7, Math.min(11, 9 / Math.max(z * 0.7, 0.5)))
    ctx.font = `500 ${labelFontBase}px -apple-system, sans-serif`

    for (const c of candidates) {
      const { node, priority, alphaTarget } = c
      // Caps
      if (priority === 1 && p1Count >= 12) continue
      if (priority === 2 && p2Count >= 20) continue
      if (priority === 3) {
        if (p3Count >= p3Cap) continue
      }

      // Compute pill screen rect
      const driftX2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.sin(time * node.driftF + node.driftP1) : 0
      const driftY2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.cos(time * node.driftF * 0.8 + node.driftP2) : 0
      const wx = node.x + driftX2
      const wy = node.y + driftY2
      const r2 = node.isHub ? node.radius + 3 : node.radius
      const textW = ctx.measureText(node._labelDisplayText).width
      const pillW = textW + 10
      const pillH = labelFontBase + 6

      // Screen-space rect (world -> screen via zoom/pan)
      const psx = (wx - pillW / 2) * z + graphPanX
      const psy = (wy + r2 + 5) * z + graphPanY
      const psw = pillW * z
      const psh = pillH * z
      const padded = { x: psx - 4, y: psy - 4, w: psw + 8, h: psh + 8 }

      // Collision check
      let collides = false
      for (const rect of lodPlacedRects) {
        if (padded.x < rect.x + rect.w && padded.x + padded.w > rect.x &&
            padded.y < rect.y + rect.h && padded.y + padded.h > rect.y) {
          collides = true; break
        }
      }

      if (!collides) {
        node._labelTargetAlpha = alphaTarget
        node._pillScreenRect = padded
        lodPlacedRects.push(padded)
        if (priority === 1) p1Count++
        else if (priority === 2) p2Count++
        else if (priority === 3) p3Count++
      }
    }

    // Exp-lerp labelAlpha per node (fade-in 180ms tau=60, fade-out 240ms tau=80)
    for (const node of graphNodes) {
      const target = node._labelTargetAlpha || 0
      const current = node.labelAlpha || 0
      const tau = target > current ? 60 : 80
      node.labelAlpha = current + (target - current) * (1 - Math.exp(-dt / tau))
    }
  }

  // === Draw nodes: halo sprites + core gradient ===
  for (let ni = 0; ni < graphNodes.length; ni++) {
    const node = graphNodes[ni]
    const color = GRAPH_TIER_COLORS[node.tier] || '#d97757'
    const glowColor = GRAPH_TIER_GLOW[node.tier] || color
    const isHover = node === graphHover
    const isSelected = node === graphSelectedNode
    const isConnected = connectedToActive.has(ni)
    const searchFaded = hasSearch && !node.searchMatch
    const searchGlow = hasSearch && node.searchMatch

    const isPanelHoverNeighbor = graphPanelHoverNeighborId !== null && node.mem && node.mem.id === graphPanelHoverNeighborId
    let targetAlpha = 0.85
    if (searchFaded) targetAlpha = 0.12
    else if (searchGlow || isHover || isSelected || isPanelHoverNeighbor) targetAlpha = 1.0
    else if (activeNode && !isConnected) targetAlpha = 0.13

    // Hover-crossfade: exponential lerp toward targetAlpha (design spec section 2)
    if (node.renderedAlpha === undefined) node.renderedAlpha = targetAlpha
    node.renderedAlpha += (targetAlpha - node.renderedAlpha) * lerpFactor
    const displayAlpha = node.renderedAlpha

    // Pop-in scale: 0->1 back-out 300ms, staggered (design spec section 2)
    let popScale = 1
    if (!GRAPH_REDUCED_MOTION && node.birthMs && nowMs < node.birthMs + 300) {
      const t = Math.max(0, Math.min(1, (nowMs - node.birthMs) / 300))
      popScale = graphEaseOutBack(t)
    }

    // Idle drift offset (render only, NOT fed back into simulation)
    let driftX = 0, driftY = 0
    if (!GRAPH_REDUCED_MOTION && node.driftF) {
      const A = node.isHub ? 1.0 : 1.5
      driftX = A * Math.sin(time * node.driftF + node.driftP1)
      driftY = A * Math.cos(time * node.driftF * 0.8 + node.driftP2)
    }
    const rx = node.x + driftX
    const ry = node.y + driftY

    const r = isHover ? node.radius + 3 : (isSelected ? node.radius + 2 : node.radius)

    // Hub pulse: animated outer ring radius
    const hubPulseR = node.isHub && !GRAPH_REDUCED_MOTION
      ? r + 5 + 1.5 * Math.sin(time * 2.1 + node.id * 0.5)
      : r + 5

    // Pop-in: apply scale transform around node center
    if (popScale !== 1) {
      ctx.save()
      ctx.translate(rx, ry)
      ctx.scale(popScale, popScale)
      ctx.translate(-rx, -ry)
    }

    // Ambient halo via glow sprite (replaces shadowBlur in loop)
    if (!searchFaded) {
      const haloScale = isHover || isSelected ? 4.5 : (isConnected ? 4.0 : 3.6)
      const haloR = r * haloScale
      const haloAlpha = isDark ? (isHover || isSelected ? 1.0 : 0.75) : 0.35
      const sprite = graphGlowSprites[node.tier]
      if (sprite) {
        if (isDark) ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = searchFaded ? 0.04 : haloAlpha * displayAlpha
        ctx.drawImage(sprite, rx - haloR, ry - haloR, haloR * 2, haloR * 2)
        ctx.globalCompositeOperation = 'source-over'
      }
    }
    // Core alpha: dark mode uses displayAlpha; light mode bumps to ~0.9 ambient
    // so the halo's 0.35 multiplier doesn't drag the core down visually (design spec §4)
    ctx.globalAlpha = isDark ? displayAlpha : Math.min(displayAlpha * (0.9 / 0.85), 1.0)

    // Node core: radial gradient with highlight center offset
    const coreGrad = ctx.createRadialGradient(rx - r * 0.25, ry - r * 0.25, 0, rx, ry, r)
    if (isDark) {
      coreGrad.addColorStop(0.00, '#ffffff')
      coreGrad.addColorStop(0.25, glowColor)
      coreGrad.addColorStop(1.00, color)
    } else {
      coreGrad.addColorStop(0.00, '#ffffff')
      coreGrad.addColorStop(1.00, color)
    }
    ctx.fillStyle = coreGrad
    ctx.beginPath()
    ctx.arc(rx, ry, r, 0, Math.PI * 2)
    ctx.fill()

    // Selected node persistent ring (spec §2: radius+5, 1.5px, tierGlow@0.9)
    if (isSelected) {
      ctx.strokeStyle = glowColor
      ctx.lineWidth = 1.5
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.arc(rx, ry, r + 5, 0, Math.PI * 2)
      ctx.stroke()
    }
    // Neighbor click pulse: halo x2.2 decaying over 600ms
    if (graphNodePulseActive && graphNodePulseActive.node === node) {
      const pElapsed = performance.now() - graphNodePulseActive.startMs
      if (pElapsed < 600) {
        const pT = pElapsed / 600
        const pScale = 2.2 - 1.2 * pT  // 2.2 -> 1.0
        const sprite = graphGlowSprites[node.tier]
        if (sprite) {
          const pHaloR = r * 4.5 * pScale
          if (isDark) ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = displayAlpha * (1 - pT) * 0.7
          ctx.drawImage(sprite, rx - pHaloR, ry - pHaloR, pHaloR * 2, pHaloR * 2)
          ctx.globalCompositeOperation = 'source-over'
        }
      } else {
        graphNodePulseActive = null
      }
    }

    // Orphan dashed ring / hub pulsing ring
    if (node.isOrphan && !searchFaded) {
      ctx.globalAlpha = displayAlpha * 0.6
      ctx.strokeStyle = isDark ? '#888' : '#aaa'
      ctx.lineWidth = 1
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.arc(rx, ry, r + 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    } else if (node.isHub && !searchFaded) {
      ctx.globalAlpha = displayAlpha * 0.8
      ctx.strokeStyle = glowColor
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(rx, ry, hubPulseR, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.globalAlpha = displayAlpha

    // Label pill (LOD-gated, design spec section 6)
    const labelA = node.labelAlpha || 0
    if (labelA > 0.015) {
      const labelFontSize = Math.max(7, Math.min(11, 9 / Math.max(graphZoom * 0.7, 0.5)))
      ctx.font = (isHover || isSelected) ? `600 ${labelFontSize + 1}px -apple-system, sans-serif` : `500 ${labelFontSize}px -apple-system, sans-serif`
      const displayLabel = node._labelDisplayText || node.label
      const textWidth = ctx.measureText(displayLabel).width
      const pillW = textWidth + 10
      const pillH = labelFontSize + 6
      const pillX = rx - pillW / 2
      const pillY = ry + r + 5

      ctx.globalAlpha = labelA * ((isHover || isSelected) ? 0.9 : 0.65)
      ctx.fillStyle = 'rgba(20,20,19,0.85)'
      graphRoundRect(ctx, pillX, pillY, pillW, pillH, 3)
      ctx.fill()

      ctx.fillStyle = '#faf9f5'
      ctx.globalAlpha = labelA * ((isHover || isSelected) ? 1 : 0.85)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(displayLabel, rx, pillY + pillH / 2)
    }

    ctx.globalAlpha = 1
    ctx.textBaseline = 'alphabetic'

    // Restore pop-in transform if applied
    if (popScale !== 1) ctx.restore()
  }

  // === Hover tooltip (shadowBlur allowed: one draw per frame max) ===
  if (graphHover && !graphSelectedNode) {
    const node = graphHover
    const driftX = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.sin(time * node.driftF + node.driftP1) : 0
    const driftY = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.cos(time * node.driftF * 0.8 + node.driftP2) : 0
    const rx = node.x + driftX
    const ry = node.y + driftY

    const tLabels = { hot: 'Hot', warm: 'Warm', cold: 'Cold', shared: 'Shared' }
    const text = `${node.label}`
    const sub = `${tLabels[node.tier] || node.tier} | ${node.agent}`
    const conns = `${node.degree} kapcsolat`

    ctx.font = 'bold 11px -apple-system, sans-serif'
    const tw = Math.max(ctx.measureText(text).width, ctx.measureText(sub).width, ctx.measureText(conns).width) + 24
    const th = 64
    const tx = Math.min(rx - tw / 2, (graphCanvas.width / (window.devicePixelRatio || 1)) / graphZoom - tw - 10)
    const ty = ry - node.radius - th - 12

    ctx.fillStyle = 'rgba(31,30,29,0.92)'
    ctx.strokeStyle = '#3d3d3a'
    ctx.lineWidth = 1
    ctx.shadowColor = 'rgba(0,0,0,0.25)'
    ctx.shadowBlur = 12
    graphRoundRect(ctx, tx, ty, tw, th, 8)
    ctx.fill()
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'

    ctx.fillStyle = '#faf9f5'
    ctx.font = '600 11px -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(text, tx + 12, ty + 18)
    ctx.font = '10px -apple-system, sans-serif'
    ctx.fillStyle = '#ff9a70'
    ctx.fillText(sub, tx + 12, ty + 34)
    ctx.fillStyle = '#73726c'
    ctx.fillText(conns, tx + 12, ty + 50)
  }

  ctx.restore()
}

function graphRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// === Graph detail card (design spec §1-§7) ===

function gcRelTime(ts) {
  const diff = Math.max(0, Date.now() / 1000 - ts)
  const min = Math.floor(diff / 60)
  if (min < 2) return 'most'
  if (min < 60) return min + ' perce'
  const hr = Math.floor(min / 60)
  if (hr < 24) return hr + ' órája'
  const day = Math.floor(hr / 24)
  if (day < 7) return day + ' napja'
  const wk = Math.floor(day / 7)
  if (wk < 5) return wk + ' hete'
  const mo = Math.floor(day / 30)
  if (mo < 12) return mo + ' hónapja'
  return Math.floor(mo / 12) + ' éve'
}

function gcAbsTime(ts) {
  return new Date(ts * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
}

function gcHexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function gcFreshnessInfo(accessedAt) {
  const daysSince = (Date.now() / 1000 - accessedAt) / 86400
  if (daysSince <= 30) return { cls: 'aktiv',   label: 'aktív',   color: '#7ddc8a' }
  if (daysSince <= 90) return { cls: 'alvo',    label: 'alvó',    color: 'rgba(255,255,255,0.35)' }
  return                      { cls: 'elavult', label: 'elavult', color: 'rgba(220,60,60,0.7)' }
}

function showGraphPanel(node, swapping) {
  const mem = node.mem
  const tier = node.tier
  const glowHex = GRAPH_TIER_GLOW[tier] || '#ffffff'
  const glowShadow = gcHexToRgba(glowHex, 0.14)
  const tierBg = gcHexToRgba(glowHex, 0.12)
  const tierLabels = { hot: 'HOT', warm: 'WARM', cold: 'COLD', shared: 'SHARED' }
  const fresh = gcFreshnessInfo(node.accessed_at || 0)

  let panel = document.getElementById('graphPanel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'graphPanel'
    panel.className = 'graph-panel'
    document.getElementById('memGraphView').appendChild(panel)
  }
  panel.style.setProperty('--gc-tier-accent', glowHex)
  panel.style.setProperty('--gc-tier-glow-shadow', glowShadow)

  const headerHtml = `
    <div class="graph-panel-drag-handle"></div>
    <div class="graph-panel-header">
      <span class="gc-tier-badge" style="background:${tierBg};color:${glowHex}">
        <span class="gc-tier-dot" style="background:${glowHex}"></span>
        ${escapeHtml(tierLabels[tier] || tier.toUpperCase())}
      </span>
      <span class="gc-agent-chip">@${escapeHtml(node.agent || '')}</span>
      ${node.isHub ? `<span class="gc-hub-badge">⬡ HUB · ${node.degree}</span>` : ''}
      <span class="gc-freshness">
        <span class="gc-freshness-dot ${fresh.cls}" style="background:${fresh.color}"></span>
        ${escapeHtml(fresh.label)}
      </span>
      <button class="graph-panel-close" id="graphPanelCloseBtn">&times;</button>
    </div>
    ${mem.created_label ? `<div class="gc-created-line">${escapeHtml(mem.created_label)}</div>` : ''}
  `

  const skeletonHtml = `
    <div class="gc-body">
      <div class="gc-content">
        <div class="gc-skeleton-bar" style="width:100%"></div>
        <div class="gc-skeleton-bar" style="width:92%"></div>
        <div class="gc-skeleton-bar" style="width:61%"></div>
      </div>
      <div class="gc-skeleton-neighbor"></div>
      <div class="gc-skeleton-neighbor"></div>
      <div class="gc-skeleton-neighbor"></div>
    </div>
    <div class="gc-footer">
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">✏</span>Szerkesztés</button>
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">⬡</span>Költöztetés</button>
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">◎</span>Fókusz</button>
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">⧉</span>Másolás</button>
    </div>
  `

  panel.innerHTML = headerHtml + skeletonHtml
  panel.hidden = false

  document.getElementById('graphPanelCloseBtn').addEventListener('click', () => {
    graphSelectedNode = null
    graphPanelHoverNeighborId = null
    panel.hidden = true
    renderGraph()
  })

  // Camera nudge on open (not on swap): pan left if node falls under card (spec §2)
  if (!swapping && !GRAPH_REDUCED_MOTION && graphCanvas) {
    const dpr = window.devicePixelRatio || 1
    const canvasW = graphCanvas.width / dpr
    const screenX = node.x * graphZoom + graphPanX
    const cardLeft = canvasW - 364
    if (screenX > cardLeft) {
      const nudgePx = (screenX - cardLeft) + 40
      graphCameraNudge = {
        fromX: graphPanX, fromY: graphPanY,
        toX: graphPanX - nudgePx, toY: graphPanY,
        startMs: performance.now(), dur: 350,
      }
    }
  }

  const capturedNode = node
  fetch('/api/memories/' + mem.id + '/detail')
    .then(r => r.ok ? r.json() : null)
    .then(detail => {
      if (!detail || graphSelectedNode !== capturedNode) return
      gcFillBody(panel, capturedNode, detail)
    })
    .catch(() => {})
}

function gcFillBody(panel, node, detail) {
  const mem = node.mem
  const glowHex = GRAPH_TIER_GLOW[node.tier] || '#ffffff'
  const tierLabels = { hot: 'HOT', warm: 'WARM', cold: 'COLD', shared: 'SHARED' }
  function tierPill(t) {
    const tc = GRAPH_TIER_GLOW[t] || '#fff'
    const bg = gcHexToRgba(tc, 0.12)
    return `<span class="gc-tier-pill" style="background:${bg};color:${tc}">${escapeHtml(tierLabels[t] || t)}</span>`
  }

  // 4.1 Full content -- import shadow rows show file/source info, not the raw content
  const isImport = detail.agent_id === 'import'
  let contentHtml
  if (isImport) {
    const im = detail.import_meta || {}
    const fname = im.file_name
      ? `<div class="gc-import-row"><span class="gc-import-lbl">Fájlnév</span><span class="gc-import-val">${escapeHtml(im.file_name)}</span></div>`
      : ''
    const slabel = im.source_label
      ? `<div class="gc-import-row"><span class="gc-import-lbl">Forrás</span><span class="gc-import-val">${escapeHtml(im.source_label)}</span></div>`
      : ''
    const fpath = im.file_path
      ? `<div class="gc-import-row"><span class="gc-import-lbl">Útvonal</span><span class="gc-import-val gc-import-path">${escapeHtml(im.file_path)}</span></div>`
      : ''
    contentHtml = `<div class="gc-import-meta"><span class="gc-import-badge">Importált fájl</span>${fname}${slabel}${fpath}</div>`
  } else {
    contentHtml = `<div class="gc-content">${escapeHtml(detail.content || mem.content || '')}</div>`
  }

  // 4.2 Meta row
  const accessedAt = detail.accessed_at || node.accessed_at || 0
  const createdAt = detail.created_at || node.created_at || 0
  const readCount = detail.read_count || 0
  const readSuffix = readCount > 0 ? ` (${readCount}x)` : ''
  const metaHtml = `<div class="gc-meta" title="${escapeHtml(gcAbsTime(createdAt))}">létrehozva ${escapeHtml(gcRelTime(createdAt))} · olvasva ${escapeHtml(gcRelTime(accessedAt))}${readSuffix}</div>`

  // 4.3 Keywords
  const rawKw = detail.keywords || ''
  const keywords = rawKw ? rawKw.split(',').map(k => k.trim()).filter(Boolean) : []
  const kwHtml = keywords.length
    ? `<div class="gc-keywords" id="gcKwBox">${keywords.map(k => `<span class="gc-kw-chip">${escapeHtml(k)}</span>`).join('')}</div>`
    : ''

  // 4.4 Neighbors -- unified weight-desc list (spec: direction is a glyph, not a section)
  const neighbors = [...(detail.neighbors || [])].sort((a, b) => b.weight - a.weight)
  let neighborHtml = ''
  if (neighbors.length) {
    const rows = neighbors.map(n => {
      const nGlow = GRAPH_TIER_GLOW[n.tier] || '#fff'
      const fillPct = Math.round(((n.weight - 0.75) / 0.25) * 70 + 30)
      const dirGlyph = n.direction === 'outgoing' ? '→' : '←'
      const dirTitle = n.direction === 'outgoing' ? 'kimenő kapcsolat' : 'bejövő kapcsolat'
      return `<div class="gc-neighbor-row" data-nid="${n.id}">
        <span class="gc-neighbor-dot" style="background:${nGlow}"></span>
        <span class="gc-neighbor-dir" title="${dirTitle}">${dirGlyph}</span>
        <span class="gc-neighbor-label">${escapeHtml(n.label)}</span>
        <span class="gc-neighbor-bar-track"><span class="gc-neighbor-bar-fill" style="width:${fillPct}%;background:${nGlow}"></span></span>
        <span class="gc-neighbor-weight">${n.weight.toFixed(2)}</span>
      </div>`
    }).join('')
    const totalDeg = node.degree || neighbors.length
    const overflow = totalDeg > neighbors.length
      ? `<div class="gc-neighbor-overflow">a graf további ${totalDeg - neighbors.length} kapcsolatot mutat</div>`
      : ''
    neighborHtml = `
      <div class="gc-section-title">Kapcsolatok <span>${neighbors.length}</span></div>
      <div class="gc-neighbor-list">${rows}${overflow}</div>
    `
  }

  // 4.5 Tier history (omit section entirely if empty)
  const tierHistory = detail.tier_history || []
  let tierHistHtml = ''
  if (tierHistory.length) {
    const shown = tierHistory.length > 3 ? tierHistory.slice(-3) : tierHistory
    const hasMore = tierHistory.length > 3
    const steps = shown.map(h => {
      const dt = new Date(h.changed_at * 1000)
      const dateStr = String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
      return `<div class="gc-tier-step">
        <div class="gc-tier-pills">${tierPill(h.from_tier)}<span class="gc-tier-arrow">→</span>${tierPill(h.to_tier)}</div>
        <div class="gc-tier-date">${dateStr}</div>
      </div>`
    }).join('')
    tierHistHtml = `
      <div class="gc-section-title">Tier-történet</div>
      <div class="gc-tier-history">
        <div class="gc-tier-chain">${hasMore ? '<span class="gc-tier-more">…</span>' : ''}${steps}</div>
      </div>
    `
  }

  const bodyHtml = `<div class="gc-body gc-fade-in">${contentHtml}${metaHtml}${kwHtml}${neighborHtml}${tierHistHtml}</div>`
  const footerHtml = isImport
    ? `<div class="gc-footer">
        <button class="gc-footer-btn" id="gcBtnFocus"><span class="gc-footer-icon">◎</span>Fókusz</button>
        <button class="gc-footer-btn" id="gcBtnCopy"><span class="gc-footer-icon">⧉</span><span class="gc-copy-label">Útvonal</span></button>
      </div>`
    : `<div class="gc-footer">
        <button class="gc-footer-btn" id="gcBtnEdit"><span class="gc-footer-icon">✏</span>Szerkesztés</button>
        <button class="gc-footer-btn" id="gcBtnMove"><span class="gc-footer-icon">⬡</span>Költöztetés</button>
        <button class="gc-footer-btn" id="gcBtnFocus"><span class="gc-footer-icon">◎</span>Fókusz</button>
        <button class="gc-footer-btn" id="gcBtnCopy"><span class="gc-footer-icon">⧉</span><span class="gc-copy-label">Másolás</span></button>
      </div>`

  const oldBody = panel.querySelector('.gc-body')
  if (oldBody) oldBody.remove()
  const oldFooter = panel.querySelector('.gc-footer')
  if (oldFooter) oldFooter.remove()
  // #817 triage: every dynamic value folded into bodyHtml/footerHtml above (memory
  // content, keywords, neighbor labels, timestamps) already goes through
  // escapeHtml()/escapeAttr() before concatenation -- footerHtml is 100% static
  // markup. Semgrep flags the insertAdjacentHTML sink itself, it can't trace that
  // the string it's called with was pre-escaped upstream.
  panel.insertAdjacentHTML('beforeend', bodyHtml + footerHtml) // nosemgrep: typescript.react.security.audit.react-unsanitized-method.react-unsanitized-method

  // Keyword +N collapse
  const kwBox = panel.querySelector('#gcKwBox')
  if (kwBox) {
    setTimeout(() => {
      if (kwBox.scrollHeight > kwBox.offsetHeight + 4) {
        const chips = Array.from(kwBox.querySelectorAll('.gc-kw-chip'))
        const boxH = kwBox.offsetHeight
        // Use full chip bottom edge vs box height -- catches partial 3rd-row overflow reliably
        const hiddenChips = chips.filter(c => c.offsetTop + c.offsetHeight > boxH)
        if (hiddenChips.length) {
          const btn = document.createElement('span')
          btn.className = 'gc-kw-more'
          btn.textContent = '+' + hiddenChips.length
          btn.addEventListener('click', () => { kwBox.classList.add('expanded'); btn.remove() })
          kwBox.appendChild(btn)
        }
      }
    }, 0)
  }

  // Neighbor row events
  panel.querySelectorAll('.gc-neighbor-row').forEach(row => {
    const nid = parseInt(row.dataset.nid, 10)
    row.addEventListener('mouseenter', () => { graphPanelHoverNeighborId = nid; renderGraph() })
    row.addEventListener('mouseleave', () => { graphPanelHoverNeighborId = null; renderGraph() })
    row.addEventListener('click', () => {
      const targetNode = graphNodes.find(n => n.id === nid)
      if (!targetNode) return
      graphSelectedNode = targetNode
      graphPanelHoverNeighborId = null
      graphNodePulseActive = { node: targetNode, startMs: performance.now() }
      // Pan to neighbor (center-left, spec §4.4: 400ms ease-in-out)
      const dpr = window.devicePixelRatio || 1
      const cw = graphCanvas.width / dpr
      const ch = graphCanvas.height / dpr
      const newPanX = cw * 0.35 - targetNode.x * graphZoom
      const newPanY = ch * 0.5  - targetNode.y * graphZoom
      if (graphZoom < 0.8) graphZoom = Math.min(1.0, graphZoom * 1.25)
      graphCameraNudge = {
        fromX: graphPanX, fromY: graphPanY,
        toX: newPanX, toY: newPanY,
        startMs: performance.now(), dur: 400,
      }
      showGraphPanel(targetNode, true)
    })
  })

  // Footer actions
  const btnEdit = panel.querySelector('#gcBtnEdit')
  const btnMove = panel.querySelector('#gcBtnMove')
  const btnFocus = panel.querySelector('#gcBtnFocus')
  const btnCopy = panel.querySelector('#gcBtnCopy')
  if (btnEdit) btnEdit.addEventListener('click', () => openEditMemory(node.mem))
  if (btnMove) btnMove.addEventListener('click', () => openEditMemory(node.mem))
  if (btnFocus) btnFocus.addEventListener('click', () => {
    const dpr = window.devicePixelRatio || 1
    const cw = graphCanvas.width / dpr
    const ch = graphCanvas.height / dpr
    const z = Math.max(graphZoom, 1.1)
    graphCameraNudge = {
      fromX: graphPanX, fromY: graphPanY,
      toX: cw / 2 - node.x * z, toY: ch / 2 - node.y * z,
      startMs: performance.now(), dur: 400,
    }
    graphZoom = z
    renderGraph()
  })
  if (btnCopy) btnCopy.addEventListener('click', () => {
    const label = btnCopy.querySelector('.gc-copy-label')
    const copyText = isImport
      ? ((detail.import_meta && detail.import_meta.file_path) || '')
      : (detail.content || mem.content || '')
    const resetLabel = isImport ? 'Útvonal' : 'Másolás'
    navigator.clipboard.writeText(copyText).then(() => {
      if (label) label.textContent = 'Másolva'
      setTimeout(() => { if (label) label.textContent = resetLabel }, 1200)
    })
  })
}

function hideGraphPanel() {
  const panel = document.getElementById('graphPanel')
  if (panel) panel.hidden = true
  graphPanelHoverNeighborId = null
}

export function openEditMemory(mem) {
  const tier = mem.tier || mem.category || 'warm'
  openMemEditModal({ ...mem, agent_id: mem.agent_id || mainAgentId() }, tier)
}

// === Graph search integration ===
export function updateGraphSearch(query) {
  const q = query.trim().toLowerCase()
  graphSearchQuery = q
  for (const node of graphNodes) {
    if (!q) {
      node.searchMatch = true
    } else {
      const content = (node.mem.content || '').toLowerCase()
      const kws = node.keywords.join(' ').toLowerCase()
      const agent = (node.agent || '').toLowerCase()
      node.searchMatch = content.includes(q) || kws.includes(q) || agent.includes(q)
    }
  }
  if (graphNodes.length > 0) renderGraph()
}

// === Zoom indicator ===
function showZoomIndicator() {
  const el = document.getElementById('graphZoomIndicator')
  if (!el) return
  el.textContent = `${Math.round(graphZoom * 100)}%`
  el.classList.add('visible')
  clearTimeout(graphZoomIndicatorTimer)
  graphZoomIndicatorTimer = setTimeout(() => el.classList.remove('visible'), 1200)
}

// === Graph mouse interaction (with zoom/pan) ===
;(function initGraphInteraction() {
  const canvas = document.getElementById('memGraphCanvas')
  let wasDragging = false
  let wasPanning = false
  let mouseDownPos = { x: 0, y: 0 }

  // Mouse wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    // Zoom toward cursor
    const worldX = (mx - graphPanX) / graphZoom
    const worldY = (my - graphPanY) / graphZoom

    graphZoom = Math.max(0.3, Math.min(3.0, graphZoom * zoomFactor))

    graphPanX = mx - worldX * graphZoom
    graphPanY = my - worldY * graphZoom

    showZoomIndicator()
    if (graphNodes.length > 0) renderGraph()
  }, { passive: false })

  // Mouse move: hover detection + panning + dragging
  canvas.addEventListener('mousemove', (e) => {
    graphLastInteraction = Date.now()
    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    // Panning
    if (graphPanning) {
      const dx = sx - graphPanStartX
      const dy = sy - graphPanStartY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasPanning = true
      graphPanX += dx
      graphPanY += dy
      graphPanStartX = sx
      graphPanStartY = sy
      if (graphNodes.length > 0) renderGraph()
      return
    }

    // Dragging a node
    const world = screenToWorld(sx, sy)
    if (graphDragging) {
      const dx = sx - mouseDownPos.x
      const dy = sy - mouseDownPos.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasDragging = true
      graphDragging.x = world.x
      graphDragging.y = world.y
      graphDragging.vx = 0
      graphDragging.vy = 0
      if (graphNodes.length > 0) renderGraph()
      return
    }

    // Hover detection in world space
    graphHover = null
    for (const node of graphNodes) {
      const ndx = world.x - node.x
      const ndy = world.y - node.y
      const hitRadius = (node.radius + 6) / Math.max(graphZoom, 0.5)
      if (ndx * ndx + ndy * ndy < hitRadius * hitRadius) {
        graphHover = node
        break
      }
    }
    canvas.style.cursor = graphHover ? 'pointer' : 'grab'
    if (graphNodes.length > 0) renderGraph()
  })

  // Mouse down: start drag on node, or start pan on empty space
  canvas.addEventListener('mousedown', (e) => {
    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    mouseDownPos = { x: sx, y: sy }
    wasDragging = false
    wasPanning = false

    if (graphHover) {
      // Drag node
      graphDragging = graphHover
      canvas.style.cursor = 'grabbing'
    } else {
      // Pan
      graphPanning = true
      graphPanStartX = sx
      graphPanStartY = sy
      canvas.style.cursor = 'grabbing'
    }
  })

  // Click: select node and show panel (only if not dragged/panned)
  canvas.addEventListener('click', (e) => {
    if (wasDragging || wasPanning) return

    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const world = screenToWorld(sx, sy)

    let clicked = null
    for (const node of graphNodes) {
      const dx = world.x - node.x
      const dy = world.y - node.y
      const hitRadius = (node.radius + 6) / Math.max(graphZoom, 0.5)
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        clicked = node
        break
      }
    }

    if (clicked) {
      graphSelectedNode = clicked
      showGraphPanel(clicked)
    } else {
      graphSelectedNode = null
      hideGraphPanel()
    }
    if (graphNodes.length > 0) renderGraph()
  })

  // Double click: open edit modal
  canvas.addEventListener('dblclick', (e) => {
    if (graphHover && graphHover.mem) {
      openEditMemory(graphHover.mem)
    }
  })

  // Mouse up: stop drag/pan
  document.addEventListener('mouseup', () => {
    if (graphDragging) {
      graphDragging = null
      const c = document.getElementById('memGraphCanvas')
      if (c) c.style.cursor = graphHover ? 'pointer' : 'grab'
    }
    if (graphPanning) {
      graphPanning = false
      const c = document.getElementById('memGraphCanvas')
      if (c) c.style.cursor = 'grab'
    }
  })
})()

export function stopGraphSimulation() {
  if (graphSim) { cancelAnimationFrame(graphSim); graphSim = null }
  if (graphIdleRaf) { cancelAnimationFrame(graphIdleRaf); graphIdleRaf = null }
}

export function setGraphCanvas(canvas, ctx) {
  graphCanvas = canvas
  graphCtx = ctx
}
