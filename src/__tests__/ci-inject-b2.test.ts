import { describe, it, expect } from 'vitest'
import { ciInjectB2 } from '../ci-inject.js'

describe('injected failure B2', () => {
  it('fails on purpose: the vitest job must go red and the aggregate test with it', () => {
    expect(ciInjectB2).toBe(3)
  })
})
