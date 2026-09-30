import { describe, expect, it } from 'vitest'
import { fallbackModelOf, isNoopModelSave, selectorModelFor } from '../../web/modules/agent-model-selection.js'

const X = 'claude-opus-5-5'
const Y = 'claude-sonnet-5'
const OTHER = 'claude-haiku-4-5-20251001'

// What GET /api/agents/:name reports while the runner has downgraded X -> Y:
// `model` is the operator's X, the session jsonl says Y, the overlay carries Y.
const onFallback = { model: X, activeModel: Y, fallback: { primary: X, current: Y, downgradedAt: 1 } }
const normal = { model: X, activeModel: X, fallback: null }

describe('selectorModelFor', () => {
  it('shows the configured X under a fallback, never the running Y', () => {
    expect(selectorModelFor(onFallback)).toBe(X)
  })

  it('shows X even when the session has not reported a model yet', () => {
    expect(selectorModelFor({ model: X, activeModel: null, fallback: onFallback.fallback })).toBe(X)
  })

  it('keeps the previous behaviour without a fallback: activeModel, then model, then the default', () => {
    expect(selectorModelFor({ model: X, activeModel: OTHER, fallback: null })).toBe(OTHER)
    expect(selectorModelFor({ model: X, activeModel: null })).toBe(X)
    expect(selectorModelFor({})).toBe('claude-opus-4-8[1m]')
  })
})

describe('fallbackModelOf', () => {
  it('returns Y while pinned, null otherwise', () => {
    expect(fallbackModelOf(onFallback)).toBe(Y)
    expect(fallbackModelOf(normal)).toBeNull()
    expect(fallbackModelOf({})).toBeNull()
  })
})

describe('isNoopModelSave', () => {
  it('saving the unchanged selector value (X) under a fallback is a no-op', () => {
    expect(isNoopModelSave(onFallback, selectorModelFor(onFallback))).toBe(true)
  })

  it('saving Y or another model under a fallback is a real change', () => {
    expect(isNoopModelSave(onFallback, Y)).toBe(false)
    expect(isNoopModelSave(onFallback, OTHER)).toBe(false)
  })

  it('without a fallback every save goes through, as before', () => {
    expect(isNoopModelSave(normal, X)).toBe(false)
    expect(isNoopModelSave(normal, OTHER)).toBe(false)
  })
})
