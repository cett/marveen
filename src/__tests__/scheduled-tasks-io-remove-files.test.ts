// removeScheduledTaskFiles: the file mirror of deleted schedules (tenant delete) goes away,
// anything outside the tasks directory never does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let home: string

vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => home,
}))

let io: typeof import('../web/scheduled-tasks-io.js')

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tasks-io-home-'))
  vi.resetModules()
  io = await import('../web/scheduled-tasks-io.js')
  mkdirSync(io.SCHEDULED_TASKS_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function mirror(name: string): string {
  const dir = join(io.SCHEDULED_TASKS_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'task-config.json'), '{}')
  return dir
}

describe('removeScheduledTaskFiles', () => {
  it('removes the directories of the named tasks only and counts them', () => {
    const a = mirror('job-a'); const b = mirror('job-b'); const keep = mirror('keep-me')
    expect(io.removeScheduledTaskFiles(['job-a', 'job-b'])).toBe(2)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
    expect(existsSync(keep)).toBe(true)
  })

  it('a name with no directory is a no-op', () => {
    expect(io.removeScheduledTaskFiles(['never-existed'])).toBe(0)
  })

  it('never reaches outside the tasks directory (traversal and empty names are ignored)', () => {
    const outside = join(home, 'precious'); mkdirSync(outside)
    const keep = mirror('keep-me')
    expect(io.removeScheduledTaskFiles(['../precious', '..', '', '/'])).toBe(0)
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(io.SCHEDULED_TASKS_DIR)).toBe(true)
    expect(existsSync(keep)).toBe(true)
  })
})
