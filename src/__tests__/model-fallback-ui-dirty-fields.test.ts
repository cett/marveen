// Settings > Model fallback panel: the save handler must send only the
// fields that actually changed from what GET loaded, not the full object --
// mirroring the server's own partial-write fix (PUT /api/model-fallback,
// model-fallback-store.ts's writeModelFallbackConfig()). A fresh install's
// chain is a code-computed default until the operator actually edits it; if
// the UI always sent the full object, the server would have no way to tell
// "unchanged" from "operator re-confirmed this exact chain", and would keep
// baking today's default in on every save. Source-assertion smoke test, same
// pattern as schedules-tick-status-ui.test.ts -- this vanilla-JS module has
// no component framework, so a DOM-mount test would need to reimplement most
// of the module's DI wiring for little extra signal over grepping the exact
// logic the feature depends on.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = readFileSync(join(__dirname, '../../web/modules/settings.js'), 'utf-8')

function panelBody(): string {
  const idx = APP.indexOf('async function renderModelFallbackPanel')
  expect(idx, 'renderModelFallbackPanel not found in settings.js').toBeGreaterThan(-1)
  const end = APP.indexOf('\nfunction ', idx + 1)
  return APP.slice(idx, end > idx ? end : idx + 6000)
}

describe('Settings > Model fallback: dirty-field tracking on save', () => {
  it('snapshots the loaded config right after the GET, before any edits', () => {
    const body = panelBody()
    const cfgIdx = body.indexOf('cfg = await res.json()')
    const loadedIdx = body.indexOf('const loaded = {')
    expect(cfgIdx).toBeGreaterThan(-1)
    expect(loadedIdx).toBeGreaterThan(cfgIdx)
    const loadedLine = body.slice(loadedIdx, body.indexOf('}', loadedIdx) + 1)
    expect(loadedLine).toContain('enabled: cfg.enabled')
    expect(loadedLine).toContain('chain: [...cfg.chain]')
    expect(loadedLine).toContain('revertAfterMinutes: cfg.revertAfterMinutes')
  })

  it('the save handler builds a dirty object comparing each field against the loaded snapshot', () => {
    const body = panelBody()
    // The template string uses id="modelFallbackSaveBtn" (no '#'); the
    // querySelector registration below uses '#modelFallbackSaveBtn' -- so
    // this selector string is unique to the addEventListener call site.
    const saveIdx = body.indexOf("querySelector('#modelFallbackSaveBtn')")
    expect(saveIdx).toBeGreaterThan(-1)
    const handlerIdx = body.indexOf('addEventListener', saveIdx)
    const handlerBody = body.slice(handlerIdx, body.indexOf('fetch(', handlerIdx))
    expect(handlerBody).toContain("if (enabled !== loaded.enabled) dirty.enabled = enabled")
    expect(handlerBody).toContain('if (JSON.stringify(cleanedChain) !== JSON.stringify(loaded.chain)) dirty.chain = cleanedChain')
    expect(handlerBody).toContain('if (revertAfterMinutes !== loaded.revertAfterMinutes) dirty.revertAfterMinutes = revertAfterMinutes')
  })

  it('the PUT body is the dirty object, not the raw {enabled, chain, revertAfterMinutes}', () => {
    const body = panelBody()
    const fetchIdx = body.indexOf("fetch('/api/model-fallback'")
    const fetchCall = body.slice(fetchIdx, body.indexOf(')', body.indexOf('body:', fetchIdx)) + 1)
    expect(fetchCall).toContain('body: JSON.stringify(dirty)')
    expect(fetchCall).not.toContain('body: JSON.stringify({ enabled, chain: cleanedChain, revertAfterMinutes })')
  })

  it('the chain-too-short guard still runs on the current input regardless of dirty state', () => {
    // Client-side validation must not be skipped just because the chain
    // happens to be unchanged from what was loaded.
    const body = panelBody()
    const guardIdx = body.indexOf('cleanedChain.length < 2')
    const dirtyIdx = body.indexOf('const dirty = {}')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(dirtyIdx).toBeGreaterThan(guardIdx)
  })
})
