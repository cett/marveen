// Events of the radial org chart, delegated on the container of the tenant graphs (it survives every reload, only its
// children are replaced). No import and no global: the container and the callbacks are passed in, so a test can drive it
// with a fake container.
//
//   - a click, or Enter / Space on a focused node, opens the agent (Space must not scroll the page);
//   - the centre node (role="img", the main agent) opens nothing, as the main agent had no detail page in the tree view;
//   - hovering or focusing an agent lights up every copy of it (the same agent can be in several tenants).

const OPEN_KEYS = new Set(['Enter', ' '])

/**
 * @param container  an element: addEventListener, querySelectorAll
 * @param api        { open(id): void, isMain(id): boolean }
 */
export function wireRadialEvents(container, api) {
  const nodeOf = (target) => (target && typeof target.closest === 'function' ? target.closest('.org-node') : null)
  const activate = (node) => {
    const id = node && node.dataset ? node.dataset.agent : null
    if (!id || node.getAttribute('role') !== 'button' || api.isMain(id)) return false
    api.open(id)
    return true
  }
  const mark = (id, on) => {
    for (const n of container.querySelectorAll('.org-node')) {
      if (n.dataset.agent === id) n.classList.toggle('org-linked', on)
    }
  }

  container.addEventListener('click', (e) => { activate(nodeOf(e.target)) })
  container.addEventListener('keydown', (e) => {
    if (!OPEN_KEYS.has(e.key)) return
    const node = nodeOf(e.target)
    if (!node || node.getAttribute('role') !== 'button') return
    e.preventDefault()
    activate(node)
  })
  for (const [on, off] of [['mouseover', 'mouseout'], ['focusin', 'focusout']]) {
    container.addEventListener(on, (e) => { const n = nodeOf(e.target); if (n && n.dataset) mark(n.dataset.agent, true) })
    container.addEventListener(off, (e) => { const n = nodeOf(e.target); if (n && n.dataset) mark(n.dataset.agent, false) })
  }
}
