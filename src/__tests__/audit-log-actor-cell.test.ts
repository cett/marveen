// The audit table reads a row without an actor as "ismeretlen", not as an empty cell (a blank looks
// like a rendering fault). web/modules/audit-log.js is a browser module (DOM, fetch), so the cell
// function is cut out of the source and run on its own.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '../../web/modules/audit-log.js'), 'utf8')

function actorCell(): (entry: Record<string, unknown>) => string {
  const start = SOURCE.indexOf('function _actorCell(entry)')
  expect(start).toBeGreaterThan(-1)
  const end = SOURCE.indexOf('\n}\n', start)
  const body = SOURCE.slice(start, end + 2)
  const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // The text is this repository's own source, run in a bare vm context that only knows escapeHtml.
  return runInNewContext(`${body}\n_actorCell`, { escapeHtml })
}

describe('audit table actor cell', () => {
  it('names a missing actor "ismeretlen"', () => {
    const cell = actorCell()
    expect(cell({ source: 'store' })).toBe('ismeretlen')
    expect(cell({ source: 'store', agent: null })).toBe('ismeretlen')
    expect(cell({ source: 'hook', agent_id: null })).toBe('ismeretlen')
    expect(cell({ source: 'hook', agent_id: '' })).toBe('ismeretlen')
  })

  it('shows the actor, escaped, from agent_id or (store rows) agent', () => {
    const cell = actorCell()
    expect(cell({ source: 'agent', agent_id: 'zack' })).toBe('zack')
    expect(cell({ source: 'store', agent: 'dashboard' })).toBe('dashboard')
    expect(cell({ source: 'agent', agent_id: '<b>x</b>' })).toBe('&lt;b&gt;x&lt;/b&gt;')
  })

  it('the table row renders the actor through that function', () => {
    expect(SOURCE).toMatch(/<td>\$\{_actorCell\(entry\)\}<\/td>/)
  })
})
