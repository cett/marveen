import { describe, it, expect } from 'vitest'
import { wasPromptRefused } from '../web/send-result.js'

// The classifier matches the two refusal values, nothing else.
describe('wasPromptRefused', () => {
  it('the two refusals are refused', () => {
    expect(wasPromptRefused('aborted-busy')).toBe(true)
    expect(wasPromptRefused('skipped-locked')).toBe(true)
  })

  it('a sent prompt is not refused', () => {
    expect(wasPromptRefused('sent')).toBe(false)
  })

  it.each([undefined, null, '', 'Sent', 'aborted', 'aborted-busy ', 0, false, {}, ['aborted-busy']])(
    'anything else (%j) is NOT refused: a mocked or older sender stays on the delivered path',
    (value) => {
      expect(wasPromptRefused(value)).toBe(false)
    },
  )
})
