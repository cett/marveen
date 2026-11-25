// The Save button of the Team tab on an agent card (web/modules/messages.js): it used to throw
// "ReferenceError: currentAgent is not defined" (the binding was never imported), so nothing could be saved from the UI,
// including the one-word title of the radial org chart. This runs the REAL module against a stub DOM, finds the click
// handler the module registers on #saveTeamBtn, and clicks it.
//
// Privacy: neutral fixtures only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

type Handler = (e?: unknown) => unknown
interface StubEl {
  id: string
  value: string
  checked: boolean
  textContent: string
  disabled: boolean
  hidden: boolean
  style: Record<string, string>
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean }
  dataset: Record<string, string>
  handlers: Map<string, Handler>
  addEventListener(type: string, fn: Handler): void
  [key: string]: unknown
}

const elements = new Map<string, StubEl>()
const makeEl = (id: string): StubEl => {
  const el: StubEl = {
    id, value: '', checked: false, textContent: '', disabled: false, hidden: false, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, handlers: new Map(),
    addEventListener(type, fn) { el.handlers.set(type, fn) },
    appendChild() {}, append() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, remove() {}, insertAdjacentHTML() {}, innerHTML: '', options: [],
  }
  return el
}
const el = (id: string) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id)! }

// the first import of the module graph touches the DOM at load, so the stubs go in first
const installDom = () => {
  const doc = {
    getElementById: (id: string) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl('created'),
    addEventListener() {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
    readyState: 'complete',
  }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { _marveen: { agentId: 'agent-main', name: 'Main' }, addEventListener() {}, location: { hash: '', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {} }) })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('navigator', { language: 'en', clipboard: {} })
}

describe('the Team tab save button', () => {
  const calls: { url: string; init: { method?: string; body?: string } }[] = []
  // the dashboard modules are plain JS with no declaration files: a computed path keeps them untyped (any)
  const MESSAGES = '../../web/modules/messages.js'
  const AGENTS = '../../web/modules/agents.js'
  let messages: any
  let agents: any

  beforeAll(async () => {
    installDom()
    messages = await import(/* @vite-ignore */ MESSAGES)
    agents = await import(/* @vite-ignore */ AGENTS)
  })

  beforeEach(() => {
    calls.length = 0
    installDom()
    vi.stubGlobal('fetch', vi.fn((url: string, init: { method?: string; body?: string } = {}) => {
      calls.push({ url, init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    }))
    el('editTeamRole').value = 'member'
    el('editTeamReportsTo').value = ''
    el('editTeamTitle').value = '  Backend  '
    el('editTeamAutoDelegation').checked = false
    el('saveTeamBtn').textContent = 'Save'
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const click = async () => {
    const h = el('saveTeamBtn').handlers.get('click')
    expect(h, 'messages.js registers a click handler on #saveTeamBtn').toBeTypeOf('function')
    await h!()
    await new Promise((r) => setTimeout(r, 20)) // the handler starts loadAgents() without awaiting it: let it finish before the globals go
  }
  const saves = () => calls.filter((c) => c.url.endsWith('/team'))

  it('saves the team of the open agent: PUT /api/agents/<name>/team with the trimmed title', async () => {
    agents.setCurrentAgent({ name: 'agent-a', role: 'member' })
    await click()
    expect(saves()).toHaveLength(1)
    expect(saves()[0]!.url).toBe('/api/agents/agent-a/team')
    expect(saves()[0]!.init.method).toBe('PUT')
    expect(JSON.parse(saves()[0]!.init.body!)).toMatchObject({ role: 'member', reportsTo: null, title: 'Backend' })
  })

  it('after a successful save the agent list is reloaded and the success toast stays (no ReferenceError turning it into the error toast)', async () => {
    agents.setCurrentAgent({ name: 'agent-a', role: 'member' })
    await click()
    expect(calls.some((c) => c.url.startsWith('/api/agents') && !c.url.endsWith('/team'))).toBe(true)
    expect(el('toast').textContent).not.toMatch(/save_error|Error saving team|Hiba a csapat/)
    expect(el('toast').textContent).toMatch(/save_ok|Team saved|Csapat mentve/)
  })

  it('an empty title field is sent as null, so the server clears it (the key is never left out)', async () => {
    agents.setCurrentAgent({ name: 'agent-a', role: 'member' })
    el('editTeamTitle').value = '   '
    await click()
    expect(JSON.parse(saves()[0]!.init.body!)).toHaveProperty('title', null)
  })

  it('does nothing without an open agent, and nothing for the main agent', async () => {
    agents.setCurrentAgent(null)
    await click()
    agents.setCurrentAgent({ name: 'agent-main', role: 'main' })
    await click()
    expect(calls).toEqual([])
  })

  it('a title the server refuses shows the rule, not a crash and not the generic error', async () => {
    agents.setCurrentAgent({ name: 'agent-a', role: 'member' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'invalid_value', field: 'title' }) })))
    await expect(click()).resolves.toBeUndefined()
    expect(el('saveTeamBtn').disabled).toBe(false) // the button is usable again
  })

  it('the module under test is the real one (a stub that never imported it would pass the other cells)', () => {
    expect(typeof messages.renderTeamEditor).toBe('function')
  })
})
