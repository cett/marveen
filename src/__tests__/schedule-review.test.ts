import { describe, expect, it } from 'vitest'
import {
  REVIEWED_FIELDS, REVIEW_EXEMPT_FIELDS, normalizeReviewValue, reviewTriggerFields,
  reviewValueSha256, scheduleContentHash,
} from '../web/schedule-review.js'

// What rowToTask() hands the route for a stored command task / prompt task.
const stored = {
  description: 'Nightly',
  prompt: 'Summarise the day',
  schedule: '0 8 * * *',
  agent: 'tenant-agent',
  enabled: true,
  type: 'task',
  skipIfBusy: false,
  forceSend: false,
  targetSession: undefined,
  command: undefined,
  timeoutMs: undefined,
  failThreshold: undefined,
}

describe('reviewTriggerFields: what sends an approved task back to review', () => {
  it.each([
    ['prompt', 'Summarise the week'],
    ['schedule', '*/5 * * * *'],
    ['agent', 'other-agent'],
    ['type', 'heartbeat'],
    ['skipIfBusy', true],
    ['forceSend', true],
    ['targetSession', 'agent-main'],
    ['command', 'rm -rf /srv/data'],
    ['timeoutMs', 60000],
    ['failThreshold', 5],
  ])('a changed %s triggers', (field, value) => {
    expect(reviewTriggerFields(stored, { [field]: value })).toEqual([field])
  })

  it('every reviewed field is covered by the matrix above (none is exempt)', () => {
    for (const f of REVIEWED_FIELDS) expect(REVIEW_EXEMPT_FIELDS.has(f)).toBe(false)
  })

  it('description and enabled never trigger, alone or together', () => {
    expect(reviewTriggerFields(stored, { description: 'A new label' })).toEqual([])
    expect(reviewTriggerFields(stored, { enabled: false })).toEqual([])
    expect(reviewTriggerFields(stored, { description: 'x', enabled: false })).toEqual([])
  })

  it('a field it has never heard of triggers (fail-closed for a future PUT field)', () => {
    expect(reviewTriggerFields(stored, { someFutureField: 'x' })).toEqual(['someFutureField'])
  })

  it('reports every changed field, in patch order, and ignores the exempt one beside them', () => {
    expect(reviewTriggerFields(stored, { enabled: false, command: 'ls', prompt: 'new', description: 'd' }))
      .toEqual(['command', 'prompt'])
  })
})

describe('reviewTriggerFields: a save that changes nothing is not a change', () => {
  it('resending every stored value is a no-op', () => {
    expect(reviewTriggerFields(stored, { ...stored })).toEqual([])
  })

  it('compares trimmed: the dashboard trims, the PUT stores as sent', () => {
    expect(reviewTriggerFields({ ...stored, prompt: 'Summarise the day \n' }, { prompt: 'Summarise the day' })).toEqual([])
    expect(reviewTriggerFields(stored, { prompt: '  Summarise the day  ' })).toEqual([])
  })

  it("treats '', null and a missing value as the same unset", () => {
    expect(reviewTriggerFields(stored, { targetSession: '' })).toEqual([])
    expect(reviewTriggerFields(stored, { command: null })).toEqual([])
    expect(reviewTriggerFields({ ...stored, targetSession: '   ' }, { targetSession: undefined })).toEqual([])
  })

  it('treats false and unset as the same for the boolean flags', () => {
    expect(reviewTriggerFields(stored, { skipIfBusy: false, forceSend: false })).toEqual([])
    expect(reviewTriggerFields({ ...stored, skipIfBusy: undefined }, { skipIfBusy: false })).toEqual([])
  })

  it('clearing a set value is still a change', () => {
    expect(reviewTriggerFields({ ...stored, targetSession: 'agent-main' }, { targetSession: '' })).toEqual(['targetSession'])
    expect(reviewTriggerFields({ ...stored, skipIfBusy: true }, { skipIfBusy: false })).toEqual(['skipIfBusy'])
  })

  it('compares numbers by value and by type', () => {
    expect(reviewTriggerFields({ ...stored, timeoutMs: 30000 }, { timeoutMs: 30000 })).toEqual([])
    expect(reviewTriggerFields({ ...stored, timeoutMs: 30000 }, { timeoutMs: 30001 })).toEqual(['timeoutMs'])
    expect(reviewTriggerFields({ ...stored, timeoutMs: 30000 }, { timeoutMs: '30000' })).toEqual(['timeoutMs'])
  })

  it('an empty patch, or one of undefined keys only, changes nothing', () => {
    expect(reviewTriggerFields(stored, {})).toEqual([])
    expect(reviewTriggerFields(stored, { prompt: undefined, command: undefined })).toEqual([])
  })

  it('a changed value is not hidden by case or inner whitespace', () => {
    expect(reviewTriggerFields(stored, { prompt: 'summarise the day' })).toEqual(['prompt'])
    expect(reviewTriggerFields(stored, { prompt: 'Summarise  the day' })).toEqual(['prompt'])
  })
})

describe('normalizeReviewValue', () => {
  it('maps the unset forms to null and keeps real values', () => {
    expect(normalizeReviewValue(undefined)).toBeNull()
    expect(normalizeReviewValue(null)).toBeNull()
    expect(normalizeReviewValue('  ')).toBeNull()
    expect(normalizeReviewValue(false)).toBeNull()
    expect(normalizeReviewValue(true)).toBe(true)
    expect(normalizeReviewValue(0)).toBe(0)
    expect(normalizeReviewValue(' a ')).toBe('a')
  })

  it('never lets an object compare equal to a scalar', () => {
    expect(normalizeReviewValue({ a: 1 })).toBe('{"a":1}')
    expect(reviewTriggerFields({ ...stored, command: '{"a":1}' }, { command: { a: 1 } })).toEqual([])
    expect(reviewTriggerFields(stored, { command: { a: 1 } })).toEqual(['command'])
  })
})

describe('fingerprints', () => {
  it('reviewValueSha256 is stable, hex, and differs per value; unset forms collide', () => {
    expect(reviewValueSha256('ls')).toMatch(/^[0-9a-f]{64}$/)
    expect(reviewValueSha256('ls')).toBe(reviewValueSha256(' ls '))
    expect(reviewValueSha256('ls')).not.toBe(reviewValueSha256('ls -la'))
    expect(reviewValueSha256('')).toBe(reviewValueSha256(undefined))
  })

  it('scheduleContentHash moves with every reviewed field and not with the exempt ones', () => {
    const base = scheduleContentHash(stored, REVIEWED_FIELDS)
    expect(scheduleContentHash({ ...stored }, REVIEWED_FIELDS)).toBe(base)
    expect(scheduleContentHash({ ...stored, description: 'other', enabled: false }, REVIEWED_FIELDS)).toBe(base)
    const changes: Record<string, unknown> = {
      prompt: 'p2', schedule: '1 1 * * *', agent: 'a2', type: 'command', skipIfBusy: true, forceSend: true,
      targetSession: 's', command: 'c', timeoutMs: 5, failThreshold: 9,
    }
    for (const f of REVIEWED_FIELDS) {
      expect(scheduleContentHash({ ...stored, [f]: changes[f] }, REVIEWED_FIELDS), f).not.toBe(base)
    }
  })

  it('scheduleContentHash cannot be fooled by moving text between adjacent fields', () => {
    const a = scheduleContentHash({ prompt: 'ab', command: 'c' }, ['prompt', 'command'])
    const b = scheduleContentHash({ prompt: 'a', command: 'bc' }, ['prompt', 'command'])
    expect(a).not.toBe(b)
  })
})
