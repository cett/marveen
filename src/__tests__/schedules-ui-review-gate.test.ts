// UI-side review-gate wiring (issue #917 item 3, per the UI spec).
// Source-assertion smoke test, same pattern as
// schedule-runner-autostart.test.ts's "dashboard button" checks -- this
// vanilla-JS module has no component framework, so a DOM-mount test would
// need to reimplement most of the module's DI wiring for little extra
// signal over grepping the exact strings the feature depends on.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = readFileSync(join(__dirname, '../../web/modules/schedules.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')

describe('schedules.js: draft-status review-gate UI', () => {
  it('a non-live task gets the draft badge (data-variant="warning")', () => {
    expect(APP).toMatch(/!isLive \? `<span class="badge" data-variant="warning">\$\{t\('tasks\.status\.draft'\)\}<\/span>` : ''/)
  })

  it('the activate button is wired to POST /api/schedules/{name}/activate', () => {
    expect(APP).toMatch(/data-action="activate"/)
    expect(APP).toMatch(/\/api\/schedules\/\$\{encodeURIComponent\(task\.name\)\}\/activate/)
    expect(APP).toMatch(/method: 'POST' \}\)\s*\n\s*const data = await r\.json\(\)\.catch\(\(\) => \(\{\}\)\)\s*\n\s*if \(r\.ok\) showToast\(t\('tasks\.toast\.activated'\)\)/)
  })

  it('the activate button only renders (and only wires its handler) for a non-live task', () => {
    const activateBtnIdx = APP.indexOf('data-action="activate"')
    const beforeBtn = APP.slice(Math.max(0, activateBtnIdx - 90), activateBtnIdx)
    expect(beforeBtn).toMatch(/!isLive \? `/)
    const handlerGuardIdx = APP.indexOf("row.querySelector('[data-action=\"activate\"]')")
    const before = APP.slice(Math.max(0, handlerGuardIdx - 30), handlerGuardIdx)
    expect(before).toMatch(/if \(!isLive\) \{/)
  })

  it('run and toggle buttons are disabled on a non-live task', () => {
    const runIdx = APP.indexOf('data-action="run"')
    const runTag = APP.slice(runIdx, runIdx + 200)
    expect(runTag).toMatch(/\$\{!isLive \? 'disabled' : ''\}/)
    const toggleIdx = APP.indexOf('data-action="toggle"')
    const toggleTag = APP.slice(toggleIdx, toggleIdx + 200)
    expect(toggleTag).toMatch(/\$\{!isLive \? 'disabled' : ''\}/)
  })

  it('the RBAC-disable loop also covers the activate action, guarded against a missing element', () => {
    const idx = APP.indexOf("for (const action of ['activate', 'run', 'toggle', 'delete'])")
    expect(idx).toBeGreaterThan(0)
    const block = APP.slice(idx, idx + 250)
    expect(block).toMatch(/if \(!btn\) continue/)
  })

  it('the timeline marker treats a non-live task as disabled (distinct from an active one)', () => {
    expect(APP).toMatch(/'timeline-marker' \+ \(task\.enabled && taskIsLive\(task\) \? '' : ' disabled'\)/)
  })

  it('the week view drops non-live tasks from the day filter', () => {
    expect(APP).toMatch(/t\.enabled && taskIsLive\(t\) && cronMatchesDay\(t\.schedule, dayDow\)/)
  })

  it('taskIsLive mirrors the backend isTaskLive semantics (undefined/live = live)', () => {
    const idx = APP.indexOf('function taskIsLive(task)')
    expect(idx).toBeGreaterThan(0)
    const body = APP.slice(idx, idx + 150)
    expect(body).toMatch(/task\.status === undefined \|\| task\.status === 'live'/)
  })
})

describe('schedules.js: draft-status i18n keys exist in both locales', () => {
  const keys = ['tasks.status.draft', 'tasks.btn.activate', 'tasks.toast.activated', 'tasks.toast.activate_error']
  for (const key of keys) {
    it(`en.js and hu.js both define '${key}'`, () => {
      expect(EN).toMatch(new RegExp(`'${key.replace(/\./g, '\\.')}':`))
      expect(HU).toMatch(new RegExp(`'${key.replace(/\./g, '\\.')}':`))
    })
  }
})
