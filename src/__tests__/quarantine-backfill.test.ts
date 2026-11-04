import { describe, it, expect, vi, afterEach } from 'vitest'
import { backfillQuarantineReaders } from '../web/quarantine-backfill.js'
import { logger } from '../logger.js'

afterEach(() => { vi.restoreAllMocks() })

describe('backfillQuarantineReaders', () => {
  it('runs the step for every agent, in order', async () => {
    const seen: string[] = []
    await backfillQuarantineReaders(['agent-a', 'agent-b'], async (n) => { seen.push(n); return true })
    expect(seen).toEqual(['agent-a', 'agent-b'])
  })

  it('a failing agent is a warning, the others still run and the call resolves', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const ensure = vi.fn(async (n: string) => {
      if (n === 'agent-a') throw new Error('allowlist read failed')
      return true
    })
    await expect(backfillQuarantineReaders(['agent-a', 'agent-b'], ensure)).resolves.toBeUndefined()
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'agent-a', err: expect.objectContaining({ message: 'allowlist read failed' }) }),
      'Quarantine reader backfill skipped',
    )
  })

  it('an empty list does nothing', async () => {
    const ensure = vi.fn(async () => true)
    await backfillQuarantineReaders([], ensure)
    expect(ensure).not.toHaveBeenCalled()
  })
})
