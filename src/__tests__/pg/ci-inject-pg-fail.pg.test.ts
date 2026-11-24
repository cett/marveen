import { describe, it, expect } from 'vitest'

// Throwaway CI cell, never merged: a failing PostgreSQL test must turn the required test context red.
describe.skipIf(!process.env.MARVEEN_PG_TEST_URL)('ci inject: pg-parity failure', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2)
  })
})
