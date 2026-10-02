import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveApprovalTimeoutSeconds,
  DEFAULT_APPROVAL_TIMEOUT_MINUTES,
  MAX_CATEGORY_TIMEOUT_MINUTES,
} from '../web/approval-timeout.js'
import {
  initDatabase,
  getDb,
  createApproval,
  getApproval,
  resolveApproval,
  expireTimedOutApprovals,
} from '../db.js'

const HOUR = 3600
const DAY = DEFAULT_APPROVAL_TIMEOUT_MINUTES * 60

describe('resolveApprovalTimeoutSeconds', () => {
  const cases: Array<[string, number | null | undefined, unknown, number]> = [
    ['category value, nothing requested', 60, undefined, HOUR],
    ['category value, request shorter', 60, 600, 600],
    ['category value, request equal', 60, 3600, 3600],
    ['category value, request longer is capped', 60, 7200, HOUR],
    ['NULL category value falls back to the 24 h ceiling', null, undefined, DAY],
    ['unknown category (undefined) falls back to the 24 h ceiling', undefined, undefined, DAY],
    ['fallback ceiling also caps a longer request', null, 10 * DAY, DAY],
    ['fallback ceiling accepts a shorter request', null, 1800, 1800],
    ['zero category value is not a usable value', 0, undefined, DAY],
    ['negative category value is not a usable value', -5, undefined, DAY],
    ['NaN category value is not a usable value', Number.NaN, undefined, DAY],
    ['negative request is ignored', 60, -10, HOUR],
    ['zero request is ignored', 60, 0, HOUR],
    ['sub-second request is ignored', 60, 0.5, HOUR],
    ['NaN request is ignored', 60, Number.NaN, HOUR],
    ['Infinity request is ignored (capped, never unbounded)', 60, Infinity, HOUR],
    ['string request is ignored', 60, '600', HOUR],
    ['null request is ignored', 60, null, HOUR],
    ['object request is ignored', 60, {}, HOUR],
    ['fractional request is floored', 60, 90.9, 90],
  ]
  it.each(cases)('%s', (_name, category, requested, expected) => {
    expect(resolveApprovalTimeoutSeconds(category, requested)).toBe(expected)
  })

  it('the category ceiling is never exceeded and the result is always finite', () => {
    for (const requested of [undefined, null, 'x', -1, 0, 1, 59, 3600, 3601, 1e12, Infinity, Number.NaN]) {
      const out = resolveApprovalTimeoutSeconds(60, requested)
      expect(Number.isFinite(out)).toBe(true)
      expect(out).toBeGreaterThan(0)
      expect(out).toBeLessThanOrEqual(HOUR)
    }
  })

  it('exposes the documented limits', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MINUTES).toBe(1440)
    expect(MAX_CATEGORY_TIMEOUT_MINUTES).toBe(10080)
  })
})

describe('approval deadline in the DB', () => {
  const now = () => Math.floor(Date.now() / 1000)
  beforeEach(() => { initDatabase(':memory:') })

  it('a request past its deadline cannot be approved or rejected, even before the sweeper ran', () => {
    createApproval({ id: 'late', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: now() - 1 })
    expect(resolveApproval('late', 'approved', 'human')).toBe(false)
    expect(resolveApproval('late', 'rejected', 'human')).toBe(false)
    expect(getApproval('late')?.status).toBe('pending')
  })

  it('a request exactly at its deadline is already expired', () => {
    createApproval({ id: 'edge', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: now() })
    expect(resolveApproval('edge', 'approved', 'human')).toBe(false)
  })

  it('a request before its deadline and one without a deadline can still be approved', () => {
    createApproval({ id: 'open', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: now() + 600 })
    createApproval({ id: 'none', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: null })
    expect(resolveApproval('open', 'approved', 'human')).toBe(true)
    expect(resolveApproval('none', 'approved', 'human')).toBe(true)
  })

  it('the timeout status itself can still be recorded on an expired request', () => {
    createApproval({ id: 'exp', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: now() - 1 })
    expect(resolveApproval('exp', 'timeout', 'agent-a')).toBe(true)
    expect(getApproval('exp')?.status).toBe('timeout')
  })

  it('the sweeper marks an expired request as timeout and says it was the system', () => {
    createApproval({ id: 's1', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: now() - 5 })
    createApproval({ id: 's2', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: now() + 600 })
    expect(expireTimedOutApprovals()).toBe(1)
    expect(getApproval('s1')).toMatchObject({ status: 'timeout', resolved_by: 'system:timeout' })
    expect(getApproval('s2')).toMatchObject({ status: 'pending', resolved_by: null })
  })

  it('the sweeper leaves a decided request alone even when its deadline is in the past', () => {
    createApproval({ id: 'done', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: now() + 600 })
    resolveApproval('done', 'approved', 'human')
    getDb().prepare("UPDATE approvals SET timeout_at = ? WHERE id = 'done'").run(now() - 100)
    expect(expireTimedOutApprovals()).toBe(0)
    expect(getApproval('done')).toMatchObject({ status: 'approved', resolved_by: 'human' })
  })
})

describe('migration 0067', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0067_approval_timeout_defaults.sql'), 'utf-8')
  const timeouts = () =>
    Object.fromEntries((getDb().prepare('SELECT key, timeout_minutes FROM autonomy_categories').all() as { key: string; timeout_minutes: number | null }[])
      .map((r) => [r.key, r.timeout_minutes]))
  beforeEach(() => { initDatabase(':memory:') })

  it('a fresh install already has 60 minutes on every category that can raise an approval, NULL on the locked ones', () => {
    const rows = getDb().prepare('SELECT key, max_level, timeout_minutes FROM autonomy_categories').all() as { key: string; max_level: number; timeout_minutes: number | null }[]
    expect(rows.length).toBeGreaterThan(10)
    for (const r of rows) expect(r.timeout_minutes, r.key).toBe(r.max_level >= 2 ? 60 : null)
  })

  it('fills the NULL level-capable rows, keeps a value an operator set and the locked rows, and is idempotent', () => {
    const d = getDb()
    d.prepare('UPDATE autonomy_categories SET timeout_minutes = NULL').run()
    d.prepare("UPDATE autonomy_categories SET timeout_minutes = 240 WHERE key = 'email_send'").run()
    d.exec(sql)
    const once = timeouts()
    expect(once.email_send).toBe(240)
    expect(once.deploy_retry).toBe(60)
    expect(once.payment).toBeNull()
    d.exec(sql)
    expect(timeouts()).toEqual(once)
  })

  it('gives a pending request without a deadline one derived from when it was asked, and leaves the rest', () => {
    const d = getDb()
    createApproval({ id: 'old-pending', agent_id: 'a', category: 'email_send', action_description: 'x' })
    createApproval({ id: 'has-deadline', agent_id: 'a', category: 'email_send', action_description: 'x', timeout_at: 99 })
    createApproval({ id: 'was-approved', agent_id: 'a', category: 'email_send', action_description: 'x' })
    resolveApproval('was-approved', 'approved', 'human')
    d.prepare("UPDATE approvals SET requested_at = 1000 WHERE id IN ('old-pending', 'has-deadline', 'was-approved')").run()
    d.exec(sql)
    expect(getApproval('old-pending')?.timeout_at).toBe(1000 + HOUR)
    expect(getApproval('has-deadline')?.timeout_at).toBe(99)
    expect(getApproval('was-approved')?.timeout_at).toBeNull()
    // and the next sweep tick expires the old one
    expect(expireTimedOutApprovals()).toBe(2)
  })
})
