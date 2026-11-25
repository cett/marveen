// The Agents page view toggle (web/modules/agents-org-chart.js): TWO views, the card grid and the radial org chart. The radial
// chart replaced the old tree view, so a "tree" (the #team alias, an old in-memory choice) must land on the radial view.
// Runs the real module against a stub DOM, like team-tab-save-handler.test.ts.
//
// Privacy: neutral fixtures only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

type Handler = (e?: unknown) => unknown
interface StubEl {
  id: string; hidden: boolean; innerHTML: string; textContent: string
  active: boolean
  handlers: Map<string, Handler>
  classList: { toggle(c: string, on: boolean): void; add(): void; remove(): void; contains(): boolean }
  [key: string]: unknown
}
const elements = new Map<string, StubEl>()
const makeEl = (id: string): StubEl => {
  const el: StubEl = {
    id, hidden: false, innerHTML: '', textContent: '', active: false, handlers: new Map(), style: {}, dataset: {},
    classList: { toggle: (c: string, on: boolean) => { if (c === 'active') el.active = on }, add() {}, remove() {}, contains: () => false },
    addEventListener: (type: string, fn: Handler) => { el.handlers.set(type, fn) },
    appendChild() {}, append() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, setAttribute() {}, options: [],
  }
  return el
}
const el = (id: string) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id)! }

const installDom = () => {
  vi.stubGlobal('document', {
    getElementById: (id: string) => el(id), querySelector: () => null, querySelectorAll: () => [], createElement: () => makeEl('created'),
    addEventListener() {}, body: makeEl('body'), documentElement: makeEl('html'), readyState: 'complete',
  })
  vi.stubGlobal('window', { _marveen: { agentId: 'agent-main', name: 'Main' }, addEventListener() {}, location: { hash: '', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {} }) })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('navigator', { language: 'en', clipboard: {} })
}

describe('the Agents page view toggle', () => {
  const urls: string[] = []
  const CHART = '../../web/modules/agents-org-chart.js'
  const AGENTS = '../../web/modules/agents.js'
  let chart: any
  let agents: any

  beforeAll(async () => {
    installDom()
    // the buttons must exist when the module registers its click handlers
    for (const id of ['agentsGridView', 'agentsRadialView', 'agentsViewGrid', 'agentsViewRadial', 'radialGraph']) el(id)
    chart = await import(/* @vite-ignore */ CHART)
    agents = await import(/* @vite-ignore */ AGENTS)
  })
  beforeEach(() => {
    urls.length = 0
    installDom()
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      urls.push(url)
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tenants: [], mainAgentId: null }) })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('grid shows the grid and hides the radial view, with no graph request', async () => {
    chart.setAgentsView('grid')
    await settle()
    expect(el('agentsGridView').hidden).toBe(false)
    expect(el('agentsRadialView').hidden).toBe(true)
    expect(el('agentsViewGrid').active).toBe(true)
    expect(el('agentsViewRadial').active).toBe(false)
    expect(agents.getAgentsActiveView()).toBe('grid')
    expect(urls).toEqual([])
  })

  it('radial shows the radial view, hides the grid and fetches the per-tenant graph', async () => {
    chart.setAgentsView('radial')
    await settle()
    expect(el('agentsGridView').hidden).toBe(true)
    expect(el('agentsRadialView').hidden).toBe(false)
    expect(el('agentsViewRadial').active).toBe(true)
    expect(el('agentsViewGrid').active).toBe(false)
    expect(agents.getAgentsActiveView()).toBe('radial')
    expect(urls).toEqual(['/api/team/graph?view=tenants'])
  })

  it('the removed "tree" view (the #team alias, an old choice) lands on radial, and an unknown name too', async () => {
    for (const old of ['tree', 'something-else', undefined]) {
      urls.length = 0
      chart.setAgentsView(old)
      await settle()
      expect(agents.getAgentsActiveView(), String(old)).toBe('radial')
      expect(el('agentsRadialView').hidden).toBe(false)
      expect(el('agentsGridView').hidden).toBe(true)
      expect(urls).toEqual(['/api/team/graph?view=tenants'])
    }
  })

  it('the two buttons switch the view', async () => {
    el('agentsViewGrid').handlers.get('click')!()
    await settle()
    expect(el('agentsGridView').hidden).toBe(false)
    el('agentsViewRadial').handlers.get('click')!()
    await settle()
    expect(el('agentsRadialView').hidden).toBe(false)
  })

  it('there is no tree button, container or loader any more', () => {
    expect(chart.setAgentsView).toBeTypeOf('function')
    expect(el('agentsViewTree').handlers.size).toBe(0) // nothing registers on the removed button
  })
})
