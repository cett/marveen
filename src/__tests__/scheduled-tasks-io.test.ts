import { describe, it, expect, vi } from 'vitest'

const { FAKE_HOME, TASK_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  const home = mkdtempSync(path.join(os.tmpdir(), 'sched-io-test-'))
  const tasksDir = path.join(home, '.claude', 'scheduled-tasks')
  const taskDir = path.join(tasksDir, 'test-task')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(path.join(taskDir, 'SKILL.md'), '---\nname: test-task\ndescription: A test task\n---\n\nDo something useful\n')
  writeFileSync(path.join(taskDir, 'task-config.json'), JSON.stringify({
    schedule: '0 9 * * *',
    agent: 'marveen',
    enabled: true,
    createdAt: 1700000000,
    type: 'task',
  }))
  return { FAKE_HOME: home, TASK_DIR: taskDir }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn().mockImplementation((path: string, content: string) => {
    require('node:fs').writeFileSync(path, content)
  }),
}))
// DB layer mock: countSchedules=0 forces file-based path (tests test the file IO)
vi.mock('../db.js', () => ({
  countSchedules:    vi.fn().mockReturnValue(0),
  getScheduleFromDb: vi.fn().mockReturnValue(undefined),
  upsertSchedule:    vi.fn(),
  listSchedulesFromDb: vi.fn().mockReturnValue([]),
  deleteSchedule:    vi.fn(),
  setScheduleEnabled: vi.fn(),
  patchSchedule:     vi.fn(),
}))

import {
  parseSkillMdFrontmatter,
  parseRequires,
  readScheduledTask,
  listScheduledTasks,
  writeScheduledTask,
  isTaskLive,
  rowToTask,
} from '../web/scheduled-tasks-io.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScheduleRow } from '../db.js'

describe('scheduled-tasks-io', () => {
  describe('parseSkillMdFrontmatter', () => {
    it('parses frontmatter and body correctly', () => {
      const content = '---\nname: my-task\ndescription: A task\n---\n\nDo something\n'
      const result = parseSkillMdFrontmatter(content)
      expect(result.name).toBe('my-task')
      expect(result.description).toBe('A task')
      expect(result.body).toContain('Do something')
    })

    it('returns body only when no frontmatter', () => {
      const content = 'No frontmatter here'
      const result = parseSkillMdFrontmatter(content)
      expect(result.name).toBeUndefined()
      expect(result.description).toBeUndefined()
      expect(result.body).toBe('No frontmatter here')
    })
  })

  describe('parseRequires', () => {
    it('returns undefined for undefined input', () => {
      expect(parseRequires(undefined)).toBeUndefined()
    })

    it('returns undefined when mcp_servers is not array', () => {
      expect(parseRequires({ mcp_servers: 'not-array' as any })).toBeUndefined()
    })

    it('returns parsed servers array', () => {
      const result = parseRequires({ mcp_servers: ['server-a', 'server-b'] })
      expect(result?.mcp_servers).toEqual(['server-a', 'server-b'])
    })

    it('returns undefined for empty servers array', () => {
      expect(parseRequires({ mcp_servers: [] })).toBeUndefined()
    })

    it('filters out non-string entries', () => {
      const result = parseRequires({ mcp_servers: ['ok', 42 as any, ''] })
      expect(result?.mcp_servers).toEqual(['ok'])
    })
  })

  describe('readScheduledTask', () => {
    it('reads existing task correctly', () => {
      const task = readScheduledTask('test-task')
      expect(task).not.toBeNull()
      expect(task!.name).toBe('test-task')
      expect(task!.description).toBe('A test task')
      expect(task!.schedule).toBe('0 9 * * *')
      expect(task!.agent).toBe('marveen')
      expect(task!.enabled).toBe(true)
      expect(task!.type).toBe('task')
    })

    it('returns null for nonexistent task', () => {
      expect(readScheduledTask('nonexistent-xyz')).toBeNull()
    })
  })

  describe('listScheduledTasks', () => {
    it('lists tasks from the scheduled-tasks directory', () => {
      const tasks = listScheduledTasks()
      expect(Array.isArray(tasks)).toBe(true)
      expect(tasks.some(t => t.name === 'test-task')).toBe(true)
    })
  })

  describe('writeScheduledTask', () => {
    it('creates a new task with provided data', () => {
      writeScheduledTask('new-test-task', {
        description: 'New task',
        prompt: 'Do new things',
        schedule: '0 8 * * 1',
        agent: 'marveen',
        enabled: true,
        type: 'heartbeat',
      })
      const task = readScheduledTask('new-test-task')
      expect(task).not.toBeNull()
      expect(task!.description).toBe('New task')
      expect(task!.schedule).toBe('0 8 * * 1')
      expect(task!.type).toBe('heartbeat')
    })
  })

  // DB-mode tenant_id preservation: writeScheduledTask is called with no
  // tenantId at all by the toggle route's file-mirror step and by the PUT
  // edit route. Before the fix, the merge always fell back to a hardcoded
  // null there, silently moving a tenant-owned schedule to fleet scope
  // (tenant_id NULL) on every edit or toggle.
  describe('writeScheduledTask -- DB-mode tenant_id preservation', () => {
    it('preserves the existing DB row tenant_id when the caller omits tenantId', async () => {
      const db = await import('../db.js')
      vi.mocked(db.countSchedules).mockReturnValue(1)
      vi.mocked(db.getScheduleFromDb).mockReturnValue({
        id: 'tenant-task', prompt: 'p', description: 'd', schedule: '0 9 * * *',
        agent: 'marveen', type: 'task', enabled: 1, tenant_id: 'tenant-a',
        skip_if_busy: 0, force_send: 0, target_session: null, command: null,
        timeout_ms: null, fail_threshold: null, pre_check: null,
        catch_up_max_age_minutes: null, stuck_after_minutes: null, requires: null,
        created_at: 1700000000, updated_at: 1700000000,
      } as any)

      writeScheduledTask('tenant-task', { enabled: false })

      expect(vi.mocked(db.upsertSchedule)).toHaveBeenCalledWith(
        'tenant-task',
        expect.objectContaining({ tenant_id: 'tenant-a' }),
      )

      vi.mocked(db.countSchedules).mockReturnValue(0)
      vi.mocked(db.getScheduleFromDb).mockReturnValue(undefined)
    })

    it('still honors an explicit tenantId (including explicit null) from the caller', async () => {
      const db = await import('../db.js')
      vi.mocked(db.countSchedules).mockReturnValue(1)
      vi.mocked(db.getScheduleFromDb).mockReturnValue({
        id: 'tenant-task-2', prompt: 'p', description: 'd', schedule: '0 9 * * *',
        agent: 'marveen', type: 'task', enabled: 1, tenant_id: 'tenant-a',
        skip_if_busy: 0, force_send: 0, target_session: null, command: null,
        timeout_ms: null, fail_threshold: null, pre_check: null,
        catch_up_max_age_minutes: null, stuck_after_minutes: null, requires: null,
        created_at: 1700000000, updated_at: 1700000000,
      } as any)

      writeScheduledTask('tenant-task-2', { tenantId: null })

      expect(vi.mocked(db.upsertSchedule)).toHaveBeenCalledWith(
        'tenant-task-2',
        expect.objectContaining({ tenant_id: null }),
      )

      vi.mocked(db.countSchedules).mockReturnValue(0)
      vi.mocked(db.getScheduleFromDb).mockReturnValue(undefined)
    })
  })

  // Review-gate: isTaskLive() and the status field
  // round-trip through the file-based read/write path.
  describe('isTaskLive', () => {
    it('treats an undefined status as live (legacy pre-migration tasks)', () => {
      expect(isTaskLive({ status: undefined })).toBe(true)
    })

    it('treats status "live" as live', () => {
      expect(isTaskLive({ status: 'live' })).toBe(true)
    })

    it('treats status "draft" as not live', () => {
      expect(isTaskLive({ status: 'draft' })).toBe(false)
    })

    it('treats status "pending_review" as not live', () => {
      expect(isTaskLive({ status: 'pending_review' })).toBe(false)
    })
  })

  describe('readScheduledTask -- status field', () => {
    it('a task-config.json with no status key at all reads back status: undefined, live', () => {
      // The 'test-task' fixture (set up in vi.hoisted above) predates the
      // review-gate migration and has no `status` key.
      const task = readScheduledTask('test-task')
      expect(task!.status).toBeUndefined()
      expect(isTaskLive(task!)).toBe(true)
    })

    it('reads each of the three known status values back verbatim', () => {
      for (const status of ['draft', 'pending_review', 'live'] as const) {
        const name = `status-fixture-${status}`
        const dir = join(FAKE_HOME, '.claude', 'scheduled-tasks', name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nBody\n`)
        writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
          schedule: '0 9 * * *', agent: 'marveen', enabled: true, createdAt: 1700000000, type: 'task', status,
        }))
        const task = readScheduledTask(name)
        expect(task!.status).toBe(status)
        expect(isTaskLive(task!)).toBe(status === 'live')
      }
    })

    it('an unrecognized status value in task-config.json is treated as absent (live), not fail-closed', () => {
      const name = 'status-fixture-garbage'
      const dir = join(FAKE_HOME, '.claude', 'scheduled-tasks', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nBody\n`)
      writeFileSync(join(dir, 'task-config.json'), JSON.stringify({
        schedule: '0 9 * * *', agent: 'marveen', enabled: true, createdAt: 1700000000, type: 'task', status: 'hand-edited-garbage',
      }))
      const task = readScheduledTask(name)
      expect(task!.status).toBeUndefined()
      expect(isTaskLive(task!)).toBe(true)
    })
  })

  describe('writeScheduledTask -- status round-trip (file-mode)', () => {
    it('writes and reads back a draft status', () => {
      writeScheduledTask('roundtrip-draft', {
        description: 'x', prompt: 'y', schedule: '0 9 * * *', agent: 'marveen',
        enabled: true, type: 'task', status: 'draft',
      })
      const task = readScheduledTask('roundtrip-draft')
      expect(task!.status).toBe('draft')
      expect(isTaskLive(task!)).toBe(false)
    })

    it('writes and reads back a pending_review status', () => {
      writeScheduledTask('roundtrip-pending', {
        description: 'x', prompt: 'y', schedule: '0 9 * * *', agent: 'marveen',
        enabled: true, type: 'task', status: 'pending_review',
      })
      const task = readScheduledTask('roundtrip-pending')
      expect(task!.status).toBe('pending_review')
      expect(isTaskLive(task!)).toBe(false)
    })

    it('omitting status on create defaults to live', () => {
      writeScheduledTask('roundtrip-default', {
        description: 'x', prompt: 'y', schedule: '0 9 * * *', agent: 'marveen', enabled: true, type: 'task',
      })
      const task = readScheduledTask('roundtrip-default')
      expect(task!.status).toBe('live')
      expect(isTaskLive(task!)).toBe(true)
    })

    it('an edit that omits status preserves the existing draft status (does not silently activate)', () => {
      writeScheduledTask('roundtrip-preserve', {
        description: 'x', prompt: 'y', schedule: '0 9 * * *', agent: 'marveen',
        enabled: true, type: 'task', status: 'draft',
      })
      // Simulate an unrelated edit (e.g. the toggle route) that never mentions status.
      writeScheduledTask('roundtrip-preserve', { enabled: false })
      const task = readScheduledTask('roundtrip-preserve')
      expect(task!.status).toBe('draft')
      expect(isTaskLive(task!)).toBe(false)
    })
  })

  describe('rowToTask -- status pass-through', () => {
    it('maps a DB row status straight onto the ScheduledTask shape', () => {
      const row = {
        id: 'db-task', prompt: 'p', description: 'd', schedule: '0 9 * * *',
        agent: 'marveen', type: 'task', enabled: 1, tenant_id: null,
        skip_if_busy: 0, force_send: 0, target_session: null, command: null,
        timeout_ms: null, fail_threshold: null, pre_check: null,
        catch_up_max_age_minutes: null, stuck_after_minutes: null, requires: null,
        status: 'draft', created_at: 1700000000, updated_at: 1700000000,
      } satisfies ScheduleRow
      const task = rowToTask(row)
      expect(task.status).toBe('draft')
      expect(isTaskLive(task)).toBe(false)
    })
  })
})
