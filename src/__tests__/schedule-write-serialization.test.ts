import { describe, it, expect, vi, beforeEach } from 'vitest'

// The db is async, so a schedule write (read the row, merge the change, write the row, mirror the files) can be
// interleaved with a second one. These tests run the REAL writeScheduledTask and lock against a fake db whose every
// call yields to the event loop (what a pooled async driver does), so an unserialized implementation loses updates.

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  return { FAKE_HOME: mkdtempSync(path.join(os.tmpdir(), 'sched-serial-test-')) as string }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, MAIN_AGENT_ID: 'marveen' }
})

const rows = new Map<string, Record<string, unknown>>()
let failNextUpsert = false
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

vi.mock('../db.js', () => ({
  countSchedules: vi.fn(async () => { await tick(); return 1 }),
  getScheduleFromDb: vi.fn(async (id: string) => { await tick(); const r = rows.get(id); return r ? { ...r } : undefined }),
  upsertSchedule: vi.fn(async (id: string, opts: Record<string, unknown>) => {
    await tick()
    if (failNextUpsert) { failNextUpsert = false; throw new Error('db down') }
    rows.set(id, { id, ...opts, enabled: opts.enabled ? 1 : 0, skip_if_busy: opts.skip_if_busy ? 1 : 0, force_send: opts.force_send ? 1 : 0, created_at: 1, updated_at: 1 })
    return { ...rows.get(id) }
  }),
  listSchedulesFromDb: vi.fn(() => Promise.resolve([])),
  deleteSchedule: vi.fn(),
  setScheduleEnabled: vi.fn(),
  patchSchedule: vi.fn(),
  seedScheduleIfAbsent: vi.fn(),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeScheduledTask } from '../web/scheduled-tasks-io.js'
import { withScheduleLock } from '../web/schedule-lock.js'
import { createKeyedSerializer } from '../web/keyed-serializer.js'

const configOf = (name: string) => JSON.parse(readFileSync(join(FAKE_HOME, '.claude', 'scheduled-tasks', name, 'task-config.json'), 'utf-8')) as Record<string, unknown>
const skillOf = (name: string) => readFileSync(join(FAKE_HOME, '.claude', 'scheduled-tasks', name, 'SKILL.md'), 'utf-8')

describe('createKeyedSerializer', () => {
  it('runs the callers of one key one after the other, in call order', async () => {
    const s = createKeyedSerializer()
    const log: string[] = []
    const job = (id: string, ms: number) => s.run('k', async () => {
      log.push(`start ${id}`)
      await new Promise(r => setTimeout(r, ms))
      log.push(`end ${id}`)
      return id
    })
    const out = await Promise.all([job('a', 20), job('b', 1), job('c', 1)])
    expect(out).toEqual(['a', 'b', 'c'])
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('does not make different keys wait for each other', async () => {
    const s = createKeyedSerializer()
    const log: string[] = []
    let release: () => void = () => {}
    const slow = s.run('one', () => new Promise<void>(resolve => { release = resolve }).then(() => { log.push('one done') }))
    await s.run('two', () => { log.push('two done'); return Promise.resolve() })
    expect(log).toEqual(['two done'])
    release()
    await slow
    expect(log).toEqual(['two done', 'one done'])
  })

  it('a failing caller rejects for itself only: the next caller of the key still runs', async () => {
    const s = createKeyedSerializer()
    const first = s.run('k', () => Promise.reject(new Error('boom')))
    const second = s.run('k', () => Promise.resolve('ok'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
  })

  it('is re-entrant: code running under a key can take the same key again without deadlocking', async () => {
    const s = createKeyedSerializer()
    const out = await s.run('k', () => s.run('k', () => Promise.resolve('inner')))
    expect(out).toBe('inner')
  })

  it('a nested caller of ANOTHER key still waits for that key', async () => {
    const s = createKeyedSerializer()
    const log: string[] = []
    let release: () => void = () => {}
    const holder = s.run('b', () => new Promise<void>(resolve => { release = resolve }))
    const outer = s.run('a', async () => { await s.run('b', () => { log.push('b entered'); return Promise.resolve() }) })
    await tick()
    expect(log).toEqual([])
    release()
    await holder
    await outer
    expect(log).toEqual(['b entered'])
  })
})

describe('writeScheduledTask: concurrent writers of one schedule', () => {
  beforeEach(() => {
    rows.clear()
    failNextUpsert = false
    rows.set('job', {
      id: 'job', prompt: 'p0', description: 'd0', schedule: '0 9 * * *', agent: 'marveen', type: 'task', enabled: 1,
      tenant_id: 'default', skip_if_busy: 0, force_send: 0, target_session: null, command: null, timeout_ms: null,
      fail_threshold: null, pre_check: null, catch_up_max_age_minutes: null, stuck_after_minutes: null, requires: null,
      status: 'live', created_at: 1, updated_at: 1,
    })
  })

  it('two edits of different fields both survive (no lost update)', async () => {
    await Promise.all([
      writeScheduledTask('job', { prompt: 'p-new' }),
      writeScheduledTask('job', { description: 'd-new' }),
    ])
    expect(rows.get('job')).toMatchObject({ prompt: 'p-new', description: 'd-new' })
  })

  it('the mirror files hold the final row, not an older merge (no stale file)', async () => {
    await Promise.all([
      writeScheduledTask('job', { prompt: 'p-new' }),
      writeScheduledTask('job', { enabled: false }),
      writeScheduledTask('job', { description: 'd-new' }),
    ])
    const row = rows.get('job')!
    expect(row).toMatchObject({ prompt: 'p-new', description: 'd-new', enabled: 0 })
    expect(skillOf('job')).toContain('description: d-new')
    expect(skillOf('job')).toContain('p-new')
    expect(configOf('job')).toMatchObject({ enabled: false, description: 'd-new' })
  })

  it('two writes of the same content end in one row and one consistent mirror', async () => {
    await Promise.all([
      writeScheduledTask('job', { prompt: 'same', description: 'same-d' }),
      writeScheduledTask('job', { prompt: 'same', description: 'same-d' }),
    ])
    expect(rows.get('job')).toMatchObject({ prompt: 'same', description: 'same-d' })
    expect(skillOf('job')).toContain('same')
    expect(configOf('job')).toMatchObject({ description: 'same-d' })
  })

  it('a failed write leaves the next one running, and the next one starts from the row as it is', async () => {
    failNextUpsert = true
    const failing = writeScheduledTask('job', { prompt: 'lost' })
    const next = writeScheduledTask('job', { description: 'kept' })
    await expect(failing).rejects.toThrow('db down')
    await next
    expect(rows.get('job')).toMatchObject({ prompt: 'p0', description: 'kept' })
    expect(skillOf('job')).toContain('description: kept')
    expect(skillOf('job')).not.toContain('lost')
  })

  it('writes of two different schedules do not wait for each other', async () => {
    let release: () => void = () => {}
    const holder = withScheduleLock('job', () => new Promise<void>(resolve => { release = resolve }))
    await writeScheduledTask('other', { prompt: 'x', description: 'y' })
    expect(rows.get('other')).toMatchObject({ prompt: 'x' })
    release()
    await holder
  })

  it('a write started while the schedule lock is held by a longer decision waits for it, and runs inside it without a deadlock', async () => {
    const log: string[] = []
    const decision = withScheduleLock('job', async () => {
      log.push('decision start')
      await writeScheduledTask('job', { prompt: 'inner' }) // re-entrant
      log.push('decision end')
    })
    const outsider = writeScheduledTask('job', { description: 'outsider' }).then(() => { log.push('outsider done') })
    await Promise.all([decision, outsider])
    expect(log).toEqual(['decision start', 'decision end', 'outsider done'])
    expect(rows.get('job')).toMatchObject({ prompt: 'inner', description: 'outsider' })
  })
})
