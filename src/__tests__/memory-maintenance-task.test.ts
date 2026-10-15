// The move of an installed `memory-maintenance` row from the stock inline curl chain to scripts/memory-maintenance.sh:
// only a command that is still one of the stock forms is rewritten, an operator's own command never is.
import { beforeEach, describe, expect, it } from 'vitest'
import { initDatabase, getScheduleFromDb, upsertSchedule } from '../db.js'
import {
  ensureMemoryMaintenanceCommand, isStockInlineMemoryMaintenanceCommand, memoryMaintenanceCommand,
} from '../web/memory-maintenance-task.js'

const ROOT = '/opt/marveen'

// What the seed file rendered before the script (variable form) and what older installs have (direct form).
const variableForm = (agent = 'main-agent', port = 3420, root = ROOT): string =>
  `API='${root}/scripts/agent-api.sh'; export DASHBOARD_BASE_URL='http://localhost:${port}'; `
  + `bash "$API" --agent ${agent} --max-time 120 POST /api/memories/resort '{}' | grep -q '"ok":true' && `
  + `bash "$API" --agent ${agent} --max-time 300 POST /api/memories/links/maintain '{}' | grep -q '"ok":true'`
const directForm = (root = ROOT): string =>
  `bash ${root}/scripts/agent-api.sh --max-time 120 POST /api/memories/resort '{}' | grep -q '"ok":true' && `
  + `bash ${root}/scripts/agent-api.sh --max-time 300 POST /api/memories/links/maintain '{}' | grep -q '"ok":true'`

function seedRow(command: string, over: Partial<Parameters<typeof upsertSchedule>[1]> = {}): void {
  upsertSchedule('memory-maintenance', {
    prompt: '', description: 'Nightly memory maintenance', schedule: '15 3 * * *', agent: 'main-agent', type: 'command',
    enabled: true, skip_if_busy: false, force_send: false, command, timeout_ms: 480000, fail_threshold: 1,
    status: 'live', tenant_id: 'default', ...over,
  })
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('isStockInlineMemoryMaintenanceCommand', () => {
  it('with an agent given, an inline --agent has to be that agent; without --agent any agent fits', () => {
    expect(isStockInlineMemoryMaintenanceCommand(variableForm('a'), ROOT, 'a')).toBe(true)
    expect(isStockInlineMemoryMaintenanceCommand(variableForm('a'), ROOT, 'b')).toBe(false)
    expect(isStockInlineMemoryMaintenanceCommand(directForm(), ROOT, 'b')).toBe(true)
    expect(isStockInlineMemoryMaintenanceCommand(variableForm('a'), ROOT)).toBe(true)
  })

  it('recognises both stock inline forms', () => {
    expect(isStockInlineMemoryMaintenanceCommand(variableForm(), ROOT)).toBe(true)
    expect(isStockInlineMemoryMaintenanceCommand(variableForm('other-agent', 4567), ROOT)).toBe(true)
    expect(isStockInlineMemoryMaintenanceCommand(directForm(), ROOT)).toBe(true)
  })

  it.each([
    ['a different install root', variableForm('main-agent', 3420, '/srv/other')],
    ['an extra command appended', `${variableForm()} && echo done`],
    ['a changed timeout argument', variableForm().replace('--max-time 300', '--max-time 900')],
    ['a dropped second call', variableForm().split(' && ')[0]],
    ['an operator command', 'bash /srv/my-maintenance.sh'],
    ['the new script command', memoryMaintenanceCommand(ROOT, 3420, 'main-agent')],
    ['an empty command', ''],
  ])('does not recognise %s', (_what, command) => {
    expect(isStockInlineMemoryMaintenanceCommand(command, ROOT)).toBe(false)
  })
})

describe('ensureMemoryMaintenanceCommand', () => {
  it.each([['variable form', variableForm()], ['direct form', directForm()]])('moves a %s row to the script, keeping the rest of the row', (_n, command) => {
    seedRow(command)
    expect(ensureMemoryMaintenanceCommand(ROOT, 4567)).toBe(true)
    expect(getScheduleFromDb('memory-maintenance')).toMatchObject({
      command: "export DASHBOARD_BASE_URL='http://localhost:4567'; bash '/opt/marveen/scripts/memory-maintenance.sh' main-agent",
      schedule: '15 3 * * *', agent: 'main-agent', enabled: 1, timeout_ms: 480000, fail_threshold: 1, status: 'live',
    })
  })

  it('uses the agent of the row, not the main agent', () => {
    seedRow(directForm(), { agent: 'second-agent' })
    ensureMemoryMaintenanceCommand(ROOT, 3420)
    expect(getScheduleFromDb('memory-maintenance')?.command).toContain('memory-maintenance.sh\' second-agent')
  })

  it('moves a row whose inline --agent is the row\'s own agent', () => {
    seedRow(variableForm('second-agent'), { agent: 'second-agent' })
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(true)
    expect(getScheduleFromDb('memory-maintenance')?.command).toContain('memory-maintenance.sh\' second-agent')
  })

  it('leaves a row alone whose inline --agent differs from the row\'s agent (the operator chose it)', () => {
    const custom = variableForm('operator-chosen')
    seedRow(custom, { agent: 'main-agent' })
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(false)
    expect(getScheduleFromDb('memory-maintenance')?.command).toBe(custom)
  })

  it('is idempotent: the migrated row is left alone on the next start', () => {
    seedRow(variableForm())
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(true)
    const after = getScheduleFromDb('memory-maintenance')
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(false)
    expect(getScheduleFromDb('memory-maintenance')).toEqual(after)
  })

  it('never touches an operator command, even one that looks similar', () => {
    const custom = `${variableForm()} && curl -s https://example.invalid/ping`
    seedRow(custom)
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(false)
    expect(getScheduleFromDb('memory-maintenance')?.command).toBe(custom)
  })

  it('leaves a disabled stock row disabled', () => {
    seedRow(variableForm(), { enabled: false })
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(true)
    expect(getScheduleFromDb('memory-maintenance')?.enabled).toBe(0)
  })

  it('does nothing without a row, for a non-command row, or for an agent id it cannot quote safely', () => {
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(false)
    seedRow(variableForm(), { type: 'task', command: null, prompt: 'x' })
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(false)
  })

  it('refuses an agent id with shell metacharacters', () => {
    seedRow(directForm(), { agent: 'a; rm -rf /' })
    expect(ensureMemoryMaintenanceCommand(ROOT, 3420)).toBe(false)
    expect(getScheduleFromDb('memory-maintenance')?.command).toBe(directForm())
  })
})
