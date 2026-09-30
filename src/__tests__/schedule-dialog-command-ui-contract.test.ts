// Source-contract checks for the schedule dialog's command-type support. The
// behavior itself is covered by schedule-payload.test.ts (payload), the route
// test (server) and tests/smoke/schedules-command-dialog.spec.ts (real DOM).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '../../web', p), 'utf-8')
const HTML = read('index.html')
const MOD = read('modules/schedules.js')

const KEYS = [
  'tasks.modal.type_command', 'tasks.modal.command_label', 'tasks.modal.command_ph',
  'tasks.modal.timeout_label', 'tasks.modal.fail_threshold_label',
]

describe('schedule dialog: command type wiring', () => {
  it('the type selector offers command and the dialog has the command block and a prompt group to swap with', () => {
    expect(HTML).toMatch(/<option value="command" data-i18n="tasks\.modal\.type_command"/)
    for (const id of ['scheduleCommandGroup', 'scheduleCommand', 'scheduleTimeoutMs', 'scheduleFailThreshold', 'schedulePromptGroup']) {
      expect(HTML, id).toContain(`id="${id}"`)
    }
  })

  it('every new label has a hu and an en string', () => {
    for (const lang of ['hu', 'en']) {
      const src = read(`lang/${lang}.js`)
      for (const k of KEYS) expect(src, `${lang}:${k}`).toContain(`'${k}':`)
    }
    for (const k of KEYS) expect(HTML.includes(k) || MOD.includes(k), k).toBe(true)
  })

  it('editing loads a command task as a command and locks its type', () => {
    expect(MOD).toMatch(/task\.type === 'heartbeat' \|\| task\.type === 'command'\) \? task\.type : 'task'/)
    expect(MOD).toMatch(/typeEl\.disabled = task\.type === 'command'/)
    expect(MOD).toMatch(/scheduleTimeoutMs'\)\.value = task\.timeoutMs/)
  })

  it('the save button builds its body with the shared pure builder, not an inline object', () => {
    expect(MOD).toMatch(/import \{ buildSchedulePayload \} from '\.\/schedule-payload\.js'/)
    expect(MOD).toMatch(/body: JSON\.stringify\(built\.body\)/)
    expect(MOD).not.toMatch(/JSON\.stringify\(\{ (name, )?description, prompt, schedule, agent, type, \.\.\.advanced \}\)/)
  })

  it("an edited task whose agent is not in the selector keeps it instead of being reassigned to the first agent", () => {
    expect(MOD).toMatch(/Not in the selector[\s\S]{0,400}agentSel\.appendChild\(keep\)/)
  })
})
