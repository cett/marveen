// The events of the radial org chart (web/modules/org-radial-events.js), driven with a fake container: no browser needed.
// Privacy: neutral fixtures only.
import { describe, it, expect } from 'vitest'
import { wireRadialEvents } from '../../web/modules/org-radial-events.js'

type Handler = (e: any) => void
class FakeNode {
  classes = new Set<string>()
  dataset: { agent: string }
  constructor(id: string, public role: string) { this.dataset = { agent: id } }
  getAttribute(name: string) { return name === 'role' ? this.role : null }
  closest(sel: string) { return sel === '.org-node' ? this : null }
  classList = { toggle: (c: string, on: boolean) => { if (on) this.classes.add(c); else this.classes.delete(c) } }
}
// a child element inside a node (the image, the text): closest() climbs to the node, as in the browser
const childOf = (n: FakeNode) => ({ closest: (sel: string) => n.closest(sel) })

const setup = () => {
  const nodes = [new FakeNode('agent-main', 'img'), new FakeNode('agent-a', 'button'), new FakeNode('agent-a', 'button'), new FakeNode('agent-b', 'button')]
  const handlers = new Map<string, Handler>()
  const container = {
    addEventListener: (type: string, fn: Handler) => { handlers.set(type, fn) },
    querySelectorAll: () => nodes,
  }
  const opened: string[] = []
  wireRadialEvents(container, { open: (id: string) => opened.push(id), isMain: (id: string) => id === 'agent-main' })
  const fire = (type: string, target: unknown, extra: object = {}) => {
    const e = { target, key: '', defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }
    handlers.get(type)!(e)
    return e
  }
  return { nodes, opened, fire }
}

describe('opening an agent', () => {
  it('a click on a node, or on something inside it, opens that agent', () => {
    const { nodes, opened, fire } = setup()
    fire('click', nodes[1])
    fire('click', childOf(nodes[3]!))
    expect(opened).toEqual(['agent-a', 'agent-b'])
  })

  it('Enter and Space on a focused node open it, and the key is kept from scrolling the page', () => {
    const { nodes, opened, fire } = setup()
    expect(fire('keydown', nodes[1], { key: 'Enter' }).defaultPrevented).toBe(true)
    expect(fire('keydown', nodes[3], { key: ' ' }).defaultPrevented).toBe(true)
    expect(opened).toEqual(['agent-a', 'agent-b'])
  })

  it('any other key does nothing, and does not swallow the key either', () => {
    const { nodes, opened, fire } = setup()
    for (const key of ['Tab', 'a', 'Escape', 'ArrowRight']) expect(fire('keydown', nodes[1], { key }).defaultPrevented).toBe(false)
    expect(opened).toEqual([])
  })

  it('the centre (the main agent, role img) opens nothing by click or key', () => {
    const { nodes, opened, fire } = setup()
    fire('click', nodes[0])
    fire('keydown', nodes[0], { key: 'Enter' })
    expect(opened).toEqual([])
  })

  it('a main agent drawn as a button still opens nothing (the id decides, not only the role)', () => {
    const { opened, fire } = setup()
    fire('click', new FakeNode('agent-main', 'button'))
    expect(opened).toEqual([])
  })

  it('a click outside every node, or on a target without closest(), is ignored without a throw', () => {
    const { opened, fire } = setup()
    fire('click', { closest: () => null })
    fire('click', {})
    fire('click', null)
    expect(opened).toEqual([])
  })
})

describe('the same agent in several tenants', () => {
  it('hover or focus lights up every copy of the agent and nothing else; leaving puts it out', () => {
    const { nodes, fire } = setup()
    fire('mouseover', childOf(nodes[1]!))
    expect(nodes.map((n) => n.classes.has('org-linked'))).toEqual([false, true, true, false])
    fire('mouseout', childOf(nodes[1]!))
    expect(nodes.some((n) => n.classes.has('org-linked'))).toBe(false)
    fire('focusin', nodes[3])
    expect(nodes.map((n) => n.classes.has('org-linked'))).toEqual([false, false, false, true])
    fire('focusout', nodes[3])
    expect(nodes.some((n) => n.classes.has('org-linked'))).toBe(false)
  })
})
