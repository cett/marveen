import { describe, it, expect } from 'vitest'

describe('injected PG-parity failure B5', () => {
  it('fails on purpose: pg-parity must run and go red (throwaway, never merged)', () => {
    expect(1).toBe(2)
  })
})
