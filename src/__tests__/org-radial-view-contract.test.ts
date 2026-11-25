// The radial org-chart view as a whole: the markup, the strings of both languages, the theme tokens, the wiring.
// web/app.js and the modules have no browser harness in this repo, so the structure is guarded statically (as in
// kanban-archive-pagination.test.ts); the behaviour of the geometry, the markup and the events has its own test files.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')
const HTML = read('web/index.html')
const CHART = read('web/modules/agents-org-chart.js')
const MESSAGES = read('web/modules/messages.js')
const CSS = read('web/css/features/org-radial.css')
const HU = read('web/lang/hu.js')
const EN = read('web/lang/en.js')
const RADIAL = CHART.slice(CHART.indexOf('// === Radial org chart'), CHART.indexOf('// === Agents page: grid / tree / radial'))

describe('the toggle and the containers', () => {
  it('has the Grid / Tree / Radial buttons, and a hidden container with the graph holder for the radial view', () => {
    for (const id of ['agentsViewGrid', 'agentsViewTree', 'agentsViewRadial']) expect(HTML).toContain(`id="${id}"`)
    expect(HTML).toMatch(/<div id="agentsRadialView" hidden>\s*<div id="radialGraph" class="org-radial"><\/div>/)
    expect(HTML).toContain('data-i18n="team.view.radial"')
  })

  it('setAgentsView knows the three views, shows exactly one, and loads a graph only when its view is shown', () => {
    expect(CHART).toMatch(/grid: 'agentsGridView', tree: 'agentsTreeView', radial: 'agentsRadialView'/)
    expect(CHART).toMatch(/el\.hidden = key !== active/)
    expect(CHART).toMatch(/if \(active === 'tree'\) loadTeamGraph\(\)/)
    expect(CHART).toMatch(/if \(active === 'radial'\) loadRadialGraph\(\)/)
    expect(CHART).toContain("['agentsViewRadial', 'radial']")
  })

  it('the radial view fetches the per-tenant graph, and does not draw a picture the layout calls unclean', () => {
    expect(RADIAL).toContain("fetch('/api/team/graph?view=tenants')")
    expect(RADIAL).toMatch(/if \(!layout\.clean\)/)
    expect(RADIAL).toContain("t('team.radial.layout_error')")
  })

  it('has no drag-and-drop in the radial view (display only)', () => {
    expect(RADIAL.length).toBeGreaterThan(500)
    expect(RADIAL).not.toMatch(/draggable|dragstart|dragover|dragend|'drop'|saveTeamReportsTo/)
  })

  it('the tenant header is set through textContent, the picture only by the escaping renderer, the error through escapeHtml', () => {
    expect(RADIAL).toContain('h.textContent = name')
    expect(RADIAL).toContain('count.textContent')
    expect(RADIAL).toContain('holder.innerHTML = renderRadialSvg(')
    // every other innerHTML in the radial part writes a string that went through escapeHtml or a fixed element
    const writes = [...RADIAL.matchAll(/innerHTML\s*=\s*([^\n]+)/g)].map((m) => m[1]!)
    for (const w of writes) expect(w.includes('escapeHtml') || w.includes('renderRadialSvg') || /^''/.test(w) || w.includes('team-empty">\' + t(')).toBe(true)
  })
})

describe('the strings', () => {
  const keys = [
    'team.view.radial', 'team.radial.empty', 'team.radial.count', 'team.radial.picture', 'team.radial.state_running',
    'team.radial.state_stopped', 'team.radial.hidden', 'team.radial.layout_error', 'team.title_invalid',
    'agents.team.title_label', 'agents.team.title_hint',
  ]
  const valueOf = (src: string, key: string) => src.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'([^']*)'`))?.[1]

  it('exist in Hungarian and English, and every {placeholder} of one is in the other', () => {
    for (const key of keys) {
      const hu = valueOf(HU, key)
      const en = valueOf(EN, key)
      expect(hu, `hu ${key}`).toBeTruthy()
      expect(en, `en ${key}`).toBeTruthy()
      expect((hu!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((en!.match(/\{\w+\}/g) ?? []).sort())
    }
  })

  it('have no em dash', () => {
    for (const key of keys) {
      expect(valueOf(HU, key)).not.toContain('—')
      expect(valueOf(EN, key)).not.toContain('—')
    }
  })
})

describe('the theme tokens', () => {
  const tokens = [
    'org-bg', 'org-ring-running', 'org-ring-stopped', 'org-spoke', 'org-guide', 'org-text-name', 'org-text-role',
    'org-center-accent', 'org-focus',
  ]
  const block = (sel: string) => CSS.slice(CSS.indexOf(sel), CSS.indexOf('}', CSS.indexOf(sel)))
  const value = (sel: string, tok: string) => block(sel).match(new RegExp(`--${tok}:\\s*([^;]+);`))?.[1]?.trim()

  it('defines every token for light and for dark, and the label halo follows the background', () => {
    for (const tok of tokens) {
      expect(value(':root {', tok), `light ${tok}`).toBeTruthy()
      expect(value('[data-theme="dark"] {', tok), `dark ${tok}`).toBeTruthy()
    }
    expect(value(':root {', 'org-label-halo')).toBe('var(--org-bg)')
  })

  it('differs between light and dark for each colour token (a dark theme that copied the light value is no theme)', () => {
    for (const tok of tokens) expect(value('[data-theme="dark"] {', tok), tok).not.toBe(value(':root {', tok))
  })

  it('is imported in the features layer', () => {
    expect(read('web/css/index.css')).toMatch(/features\/org-radial\.css"\)\s+layer\(features\)/)
  })

  it('draws the running state solid 4 px and the stopped state 3 px (the dash itself is in the markup)', () => {
    expect(CSS).toMatch(/\.org-running \.org-state-ring \{[^}]*stroke-width: 4/)
    expect(CSS).toMatch(/\.org-stopped \.org-state-ring \{[^}]*stroke-width: 3/)
  })

  it('shows a keyboard focus ring in the focus token wherever the browser outline is removed', () => {
    expect(CSS).toMatch(/\.org-node \{ outline: none;/)
    expect(CSS).toMatch(/\.org-node:focus-visible \.org-focus-ring \{ stroke: var\(--org-focus\)/)
  })
})

describe('the title field of the agent card', () => {
  it('is in the Team tab with a 24 character limit, filled from the agent and ALWAYS sent (the server keeps the old title when the key is missing)', () => {
    expect(HTML).toMatch(/<input type="text" id="editTeamTitle" maxlength="24"/)
    expect(MESSAGES).toContain("document.getElementById('editTeamTitle').value = team.title || ''")
    expect(MESSAGES).toMatch(/title: document\.getElementById\('editTeamTitle'\)\.value\.trim\(\) \|\| null,/)
  })

  it('answers invalid_value for the title with the rule, not with the generic save error', () => {
    expect(MESSAGES).toMatch(/err\.error === 'invalid_value' && err\.field === 'title'/)
    expect(MESSAGES).toContain("t('team.title_invalid', { max: 24 })")
  })
})
