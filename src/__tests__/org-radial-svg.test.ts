// The SVG markup of one tenant's radial org chart (web/modules/org-radial-svg.js): a pure string builder, so the rules of
// the plan (3.3 rendering, 3.4 colours and accessibility) are cells here, without a browser.
//
// Privacy: neutral fixtures only (agent-a, agent-b ...).
import { describe, it, expect } from 'vitest'
import { layoutRadial } from '../../web/modules/org-radial-layout.js'
import { renderRadialSvg, shortLabel, monogram, AVATAR_SIZE, LABEL_MAX, type TenantViewInput } from '../../web/modules/org-radial-svg.js'

type Tenant = TenantViewInput & { rootId: string | null; edges: { from: string; to: string }[] }

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: 'tenant-a',
  name: 'Tenant A',
  rootId: 'agent-main',
  nodes: [
    { id: 'agent-main', label: 'Main', title: null, running: true },
    { id: 'agent-a', label: 'Alpha', title: 'Backend', running: true },
    { id: 'agent-b', label: 'Beta', title: 'Design', running: false },
    { id: 'agent-c', label: 'Gamma', title: null, running: true },
  ],
  edges: [
    { from: 'agent-main', to: 'agent-a' }, { from: 'agent-main', to: 'agent-b' }, { from: 'agent-a', to: 'agent-c' },
  ],
  ...over,
})
const opts = {
  index: 0,
  avatarUrl: (id: string) => `/api/agents/${id}/avatar`,
  a11yLabel: (n: { label: string; title: string | null; running: boolean }) => [n.label, n.title, n.running ? 'running' : 'not running'].filter(Boolean).join(', '),
  hiddenLabel: (n: number) => `${n} hidden`,
}
const draw = (t: Tenant = tenant(), o = opts) => renderRadialSvg(t, layoutRadial(t), o)
// the <g class="org-node ..."> block of one agent
const nodeOf = (svg: string, id: string) => {
  const start = svg.indexOf(`data-agent="${id}"`)
  expect(start, `node ${id}`).toBeGreaterThan(-1)
  const open = svg.lastIndexOf('<g ', start)
  const end = svg.indexOf('</g>', svg.indexOf('</text>', start)) // the node ends after its last text; the badge group is checked on its own
  return svg.slice(open, end + 4)
}

describe('the picture', () => {
  it('is one svg with a viewBox from the bounds of the layout and an accessible name for the whole picture', () => {
    const t = tenant()
    const l = layoutRadial(t)
    const svg = renderRadialSvg(t, l, { ...opts, ariaLabel: 'Tenant A, 3 agents' })
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg).toContain(`viewBox="${l.bounds.minX} ${l.bounds.minY} ${l.bounds.width} ${l.bounds.height}"`)
    expect(svg).toContain('aria-label="Tenant A, 3 agents"')
    expect(svg.endsWith('</svg>')).toBe(true)
  })

  it('is drawn at most 1.25 times its own size, so a small tenant is not blown up to the page width', () => {
    const t = tenant()
    const l = layoutRadial(t)
    expect(renderRadialSvg(t, l, opts)).toContain(`style="max-width:${Math.round(l.bounds.width * 1.25)}px"`)
  })

  it('has one spoke per edge, one guide circle per ring, and one node per placed agent', () => {
    const t = tenant()
    const l = layoutRadial(t)
    const svg = draw(t)
    expect((svg.match(/class="org-spoke"/g) ?? []).length).toBe(l.spokes.length)
    expect((svg.match(/class="org-guide"/g) ?? []).length).toBe(l.radii.length)
    expect((svg.match(/data-agent="/g) ?? []).length).toBe(l.nodes.length)
  })

  it('is deterministic: the same input gives the same string', () => {
    expect(draw()).toBe(draw())
  })

  it('takes every colour from a --org-* token in the stylesheet: no colour literal in the markup', () => {
    const svg = draw()
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(svg).not.toMatch(/\b(?:fill|stroke)="(?!none)/)
    expect(svg).not.toMatch(/rgb\(|hsl\(/)
  })
})

describe('a node', () => {
  it('is a keyboard button with ONE accessible name "Name, title, state", the visible texts hidden from a reader', () => {
    const n = nodeOf(draw(), 'agent-a')
    expect(n).toContain('role="button"')
    expect(n).toContain('tabindex="0"')
    expect(n).toContain('aria-label="Alpha, Backend, running"')
    expect(n).toContain('<title>Alpha, Backend, running</title>')
    expect(n).toContain('<text class="org-name" y="')
    expect((n.match(/aria-hidden="true"/g) ?? []).length).toBe(2) // the name and the title text
  })

  it('tells running from not running by TWO cues: a solid ring (class org-running) vs a dashed one (class org-stopped)', () => {
    const svg = draw()
    const up = nodeOf(svg, 'agent-a')
    const down = nodeOf(svg, 'agent-b')
    expect(up).toContain('org-running')
    expect(up).not.toContain('stroke-dasharray')
    expect(down).toContain('org-stopped')
    expect(down).toContain('stroke-dasharray="7 6"')
    expect(down).toContain('aria-label="Beta, Design, not running"')
  })

  it('writes no "running" or "member" text on the picture, only inside the accessible names', () => {
    const svg = draw()
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
    expect(texts.join(' ')).not.toMatch(/running|member|stopped/i)
  })

  it('clips the avatar to a circle, 80 px normal and 112 px for the centre, the state ring 6 px outside the edge', () => {
    const svg = draw()
    const a = nodeOf(svg, 'agent-a')
    expect(a).toContain(`width="${AVATAR_SIZE.normal}" height="${AVATAR_SIZE.normal}"`)
    expect(a).toContain(`<circle class="org-state-ring" r="${AVATAR_SIZE.normal / 2 + 6}"`)
    const c = nodeOf(svg, 'agent-main')
    expect(c).toContain(`width="${AVATAR_SIZE.centre}" height="${AVATAR_SIZE.centre}"`)
    expect(c).toContain(`<circle class="org-state-ring" r="${AVATAR_SIZE.centre / 2 + 6}"`)
    expect(svg).toMatch(/clip-path="url\(#org-clip-0-\d+\)"/)
  })

  it('keeps the clip-path ids unique across the tenants of one page (the index of the tenant is in the id)', () => {
    const first = renderRadialSvg(tenant(), layoutRadial(tenant()), { ...opts, index: 0 })
    const second = renderRadialSvg(tenant(), layoutRadial(tenant()), { ...opts, index: 1 })
    const ids = (s: string) => [...s.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1])
    expect(ids(first).filter((x) => ids(second).includes(x))).toEqual([])
    expect(new Set(ids(first)).size).toBe(ids(first).length)
  })

  it('has no title line under the centre, and the centre is no button (the main agent has no detail page here)', () => {
    const c = nodeOf(draw(), 'agent-main')
    expect(c).toContain('role="img"')
    expect(c).not.toContain('tabindex')
    expect(c).not.toContain('org-title')
    expect(c).toContain('org-centre-halo')
  })

  it('has no title text for an agent without a title, and says so neither visibly nor in the name', () => {
    const n = nodeOf(draw(), 'agent-c')
    expect(n).not.toContain('org-title')
    expect(n).toContain('aria-label="Gamma, running"')
  })

  it('cuts a long name or title at 14 characters, the whole text stays in the tooltip', () => {
    const long = 'A'.repeat(30)
    const t = tenant({ nodes: [{ id: 'agent-main', label: 'Main', running: true }, { id: 'agent-a', label: long, title: 'B'.repeat(24), running: true }], edges: [{ from: 'agent-main', to: 'agent-a' }] })
    const n = nodeOf(draw(t), 'agent-a')
    expect(n).toContain('>' + 'A'.repeat(LABEL_MAX - 1) + '…</text>')
    expect(n).toContain('>' + 'B'.repeat(LABEL_MAX - 1) + '…</text>')
    expect(n).toContain(`<title>${long}, ${'B'.repeat(24)}, running</title>`)
  })

  it('shortLabel leaves a short text alone, cuts at the limit, and counts characters, not UTF-16 units', () => {
    expect(shortLabel('Alpha')).toBe('Alpha')
    expect(shortLabel('x'.repeat(14))).toBe('x'.repeat(14))
    expect(shortLabel('x'.repeat(15))).toBe('x'.repeat(13) + '…')
    expect(shortLabel('\u{1F600}'.repeat(15))).toBe('\u{1F600}'.repeat(13) + '…')
    expect(shortLabel(null)).toBe('')
  })

  it('shows the "+N" badge with its tooltip for a node that hides deeper agents, and no badge for the rest', () => {
    const chain: [string, string][] = [['agent-main', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'], ['n4', 'n6']]
    const t = tenant({
      nodes: ['agent-main', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id) => ({ id, label: id, running: true })),
      edges: chain.map(([from, to]) => ({ from, to })),
    })
    const svg = draw(t)
    expect(svg).toContain('<title>2 hidden</title>')
    expect(svg).toContain('>+2</text>')
    expect((svg.match(/org-hidden-badge/g) ?? []).length).toBe(1)
    expect(draw()).not.toContain('org-hidden-badge')
  })

  it('shows only the monogram on a crowded ring, no title line, the accessible name still the whole one', () => {
    const ids = Array.from({ length: 26 }, (_, i) => `agent-${i}`)
    const t = tenant({
      nodes: [{ id: 'agent-main', label: 'Main', running: true }, ...ids.map((id) => ({ id, label: 'Zeta ' + id, title: 'Role', running: true }))],
      edges: ids.map((id) => ({ from: 'agent-main', to: id })),
    })
    const n = nodeOf(draw(t), 'agent-0')
    expect(n).toContain('>ZE</text>')
    expect(n).not.toContain('org-title')
    expect(n).toContain('aria-label="Zeta agent-0, Role, running"')
    expect(monogram('  zeta beta')).toBe('ZE')
    expect(monogram('')).toBe('')
  })
})

describe('escaping: every server-supplied value is data, never markup', () => {
  const evil = '"><script>alert(1)</script><img src=x onerror=alert(2)>'
  it('escapes the name, the title, the id, the avatar URL, the tenant and the picture name', () => {
    const t = tenant({
      id: evil,
      name: evil,
      nodes: [{ id: 'agent-main', label: 'Main', running: true }, { id: evil, label: evil, title: evil, running: true }],
      edges: [{ from: 'agent-main', to: evil }],
    })
    const svg = renderRadialSvg(t, layoutRadial(t), { ...opts, avatarUrl: () => evil, ariaLabel: evil })
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&quot;&gt;')
    // the only elements are the ones the module writes
    const tags = new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]))
    expect([...tags].sort()).toEqual(['circle', 'clipPath', 'g', 'image', 'line', 'svg', 'text', 'title'])
  })

  it('escapes the translated texts of the caller too (a translation with a quote or an angle bracket)', () => {
    const svg = draw(tenant(), { ...opts, a11yLabel: () => 'a "b" <c>' })
    expect(svg).toContain('aria-label="a &quot;b&quot; &lt;c&gt;"')
  })
})

describe('an empty or odd view', () => {
  it('without a centre draws no centre node and no halo (a tenant role has no global main node)', () => {
    const t = tenant({ rootId: null })
    const svg = draw(t)
    expect(svg).not.toContain('org-centre-halo')
    expect(svg).not.toContain('role="img"')
  })

  it('an agent the layout placed but the view has no entry for still draws, with its id as the name', () => {
    const t = tenant()
    const l = layoutRadial({ ...t, nodes: [...t.nodes, { id: 'agent-x' }], edges: [...t.edges, { from: 'agent-main', to: 'agent-x' }] })
    const svg = renderRadialSvg(t, l, opts)
    expect(nodeOf(svg, 'agent-x')).toContain('aria-label="agent-x, not running"')
  })
})
