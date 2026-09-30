import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncTaskConfigEnabledFromDb } from '../web/scheduled-tasks-io.js'

// task-config.json is a mirror of the schedules row. 17 files had drifted to
// enabled=false while the DB said 1; the sync pulls the file back to the DB.

let dir: string

function put(name: string, config: unknown, raw?: string): string {
  const d = join(dir, name)
  mkdirSync(d, { recursive: true })
  const path = join(d, 'task-config.json')
  writeFileSync(path, raw ?? JSON.stringify(config, null, 2))
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\n---\n\nbody of ${name}\n`)
  return path
}
const read = (name: string) => JSON.parse(readFileSync(join(dir, name, 'task-config.json'), 'utf-8'))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'taskcfg-sync-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('syncTaskConfigEnabledFromDb (file <- DB)', () => {
  it('rewrites a file that says disabled while the DB row is enabled', () => {
    put('a', { schedule: '0 3 * * *', enabled: false })
    expect(syncTaskConfigEnabledFromDb([{ id: 'a', enabled: 1 }], dir)).toEqual(['a'])
    expect(read('a').enabled).toBe(true)
  })

  it('rewrites the other direction too: a file that says enabled while the DB row is disabled', () => {
    put('b', { schedule: '0 3 * * *', enabled: true })
    expect(syncTaskConfigEnabledFromDb([{ id: 'b', enabled: 0 }], dir)).toEqual(['b'])
    expect(read('b').enabled).toBe(false)
  })

  it('adds the key when the file has none', () => {
    put('c', { schedule: '0 3 * * *' })
    expect(syncTaskConfigEnabledFromDb([{ id: 'c', enabled: 1 }], dir)).toEqual(['c'])
    expect(read('c').enabled).toBe(true)
  })

  it('touches only `enabled`: every other key and SKILL.md stay as they were', () => {
    const cfg = { schedule: '*/5 * * * *', agent: 'main', enabled: false, type: 'command', command: 'echo hi', timeoutMs: 1000, nested: { a: [1, 2] } }
    put('d', cfg)
    const skillBefore = readFileSync(join(dir, 'd', 'SKILL.md'), 'utf-8')
    syncTaskConfigEnabledFromDb([{ id: 'd', enabled: 1 }], dir)
    expect(read('d')).toEqual({ ...cfg, enabled: true })
    expect(readFileSync(join(dir, 'd', 'SKILL.md'), 'utf-8')).toBe(skillBefore)
  })

  it('leaves an already matching file byte-for-byte alone', () => {
    const path = put('e', { enabled: true }, '{"enabled":true,"x":1}')
    expect(syncTaskConfigEnabledFromDb([{ id: 'e', enabled: 1 }], dir)).toEqual([])
    expect(readFileSync(path, 'utf-8')).toBe('{"enabled":true,"x":1}')
  })

  it('never creates a missing mirror and skips unreadable or non-object files', () => {
    const corrupt = put('f', null, '{not json')
    const array = put('g', null, '[1,2]')
    const rows = [{ id: 'missing', enabled: 1 }, { id: 'f', enabled: 1 }, { id: 'g', enabled: 1 }]
    expect(syncTaskConfigEnabledFromDb(rows, dir)).toEqual([])
    expect(existsSync(join(dir, 'missing'))).toBe(false)
    expect(readFileSync(corrupt, 'utf-8')).toBe('{not json')
    expect(readFileSync(array, 'utf-8')).toBe('[1,2]')
  })

  it('is idempotent and reports only the tasks it changed', () => {
    put('h', { enabled: false })
    put('i', { enabled: true })
    const rows = [{ id: 'h', enabled: 1 }, { id: 'i', enabled: 1 }]
    expect(syncTaskConfigEnabledFromDb(rows, dir)).toEqual(['h'])
    expect(syncTaskConfigEnabledFromDb(rows, dir)).toEqual([])
  })

  it('reconciles a whole drifted fleet in one pass (17 false files, DB enabled)', () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, enabled: 1 as const }))
    rows.forEach((r, i) => put(r.id, { schedule: '0 * * * *', enabled: i >= 17 }))
    const fixed = syncTaskConfigEnabledFromDb(rows, dir)
    expect(fixed).toHaveLength(17)
    for (const r of rows) expect(read(r.id).enabled).toBe(true)
  })
})

describe('the runner runs the reconcile from the tick, on an interval', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  it('gates it on CONFIG_ENABLED_SYNC_INTERVAL_MS and starts at 0 so the first tick runs it', () => {
    expect(SRC).toMatch(/let lastConfigSyncMs = 0/)
    expect(SRC).toMatch(/now - lastConfigSyncMs >= CONFIG_ENABLED_SYNC_INTERVAL_MS/)
  })
})
