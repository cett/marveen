import { describe, it, expect } from 'vitest'
import { initDatabase, getDb, closeDatabase } from '../db.js'

describe('closeDatabase', () => {
  it('flushes and closes the handle without throwing', () => {
    initDatabase(':memory:')
    expect(getDb().open).toBe(true)
    expect(() => closeDatabase()).not.toThrow()
    expect(getDb().open).toBe(false)
  })

  it('is a no-op (does not throw) when called again on an already-closed handle', () => {
    expect(() => closeDatabase()).not.toThrow()
  })
})
