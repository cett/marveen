// Size-guard tiers (WARN/ALERT) and the inline-vs-snapshot delivery
// decision, plus the same-day notice dedupe. Pure functions only -- the
// fire-and-forget notice sender (createAgentMessage side effects) is
// exercised indirectly through these building blocks, same convention as
// schedule-catchup.test.ts for this file's other pure decision functions.
import { describe, expect, it } from 'vitest'
import {
  sizeGuardLevel,
  shouldSnapshotTaskBody,
  shouldSendSizeGuardNotice,
} from '../web/schedule-runner.js'
import {
  SCHEDULED_TASK_INLINE_MAX_CHARS,
  SCHEDULED_TASK_BODY_WARN_CHARS,
  MAX_SCHEDULED_TASK_PROMPT_LEN,
} from '../web/scheduled-tasks-io.js'

describe('sizeGuardLevel', () => {
  it('is none below the warn threshold', () => {
    expect(sizeGuardLevel(SCHEDULED_TASK_BODY_WARN_CHARS - 1)).toBe('none')
  })

  it('is warn at and above the warn threshold, below alert', () => {
    expect(sizeGuardLevel(SCHEDULED_TASK_BODY_WARN_CHARS)).toBe('warn')
    expect(sizeGuardLevel(MAX_SCHEDULED_TASK_PROMPT_LEN - 1)).toBe('warn')
  })

  it('is alert at and above the alert threshold', () => {
    expect(sizeGuardLevel(MAX_SCHEDULED_TASK_PROMPT_LEN)).toBe('alert')
    expect(sizeGuardLevel(MAX_SCHEDULED_TASK_PROMPT_LEN + 10_000)).toBe('alert')
  })

  it('respects explicit threshold overrides', () => {
    expect(sizeGuardLevel(50, 100, 200)).toBe('none')
    expect(sizeGuardLevel(150, 100, 200)).toBe('warn')
    expect(sizeGuardLevel(250, 100, 200)).toBe('alert')
  })
})

describe('shouldSnapshotTaskBody', () => {
  it('stays inline at and below the 1500-char threshold', () => {
    expect(shouldSnapshotTaskBody(SCHEDULED_TASK_INLINE_MAX_CHARS)).toBe(false)
    expect(shouldSnapshotTaskBody(0)).toBe(false)
  })

  it('snapshots once strictly above the threshold', () => {
    expect(shouldSnapshotTaskBody(SCHEDULED_TASK_INLINE_MAX_CHARS + 1)).toBe(true)
  })

  it('uses the corrected 1500-char default, not the originally-assumed 8192 bytes', () => {
    expect(SCHEDULED_TASK_INLINE_MAX_CHARS).toBe(1_500)
  })
})

describe('shouldSendSizeGuardNotice (same-day dedupe)', () => {
  it('sends on the first call for a task/day and claims the stamp', () => {
    const stamps = new Map<string, string>()
    expect(shouldSendSizeGuardNotice(stamps, 'task-a', '2026-09-21')).toBe(true)
    expect(stamps.get('task-a')).toBe('2026-09-21')
  })

  it('does not re-send the same task on the same day', () => {
    const stamps = new Map<string, string>([['task-a', '2026-09-21']])
    expect(shouldSendSizeGuardNotice(stamps, 'task-a', '2026-09-21')).toBe(false)
  })

  it('sends again once the day rolls over', () => {
    const stamps = new Map<string, string>([['task-a', '2026-09-21']])
    expect(shouldSendSizeGuardNotice(stamps, 'task-a', '2026-09-22')).toBe(true)
    expect(stamps.get('task-a')).toBe('2026-09-22')
  })

  it('tracks each task independently', () => {
    const stamps = new Map<string, string>([['task-a', '2026-09-21']])
    expect(shouldSendSizeGuardNotice(stamps, 'task-b', '2026-09-21')).toBe(true)
  })
})
