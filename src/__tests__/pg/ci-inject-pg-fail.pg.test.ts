import { describe, it, expect } from 'vitest'

// Throwaway CI cell, never merged: a failing PostgreSQL test must turn the required test context red.
describe('ci inject: pg-parity failure', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2)
  })
})
