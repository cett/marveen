import { describe, expect, it } from 'vitest'
import { buildSchedulePayload, type ScheduleFormFields } from '../../web/modules/schedule-payload.js'

const base: ScheduleFormFields = {
  name: 'job', description: 'desc', prompt: '', schedule: '0 3 * * *', agent: 'main-agent',
  type: 'task', skipIfBusy: false, forceSend: false, targetSession: '',
  command: '', timeoutMs: '', failThreshold: '',
}

describe('buildSchedulePayload: command tasks', () => {
  const cmd = { ...base, type: 'command', command: ' bash /opt/app/backup.sh ', timeoutMs: '120000', failThreshold: '1' }

  it('does not need a prompt and never sends one', () => {
    const r = buildSchedulePayload({ ...cmd, prompt: 'stale text kept on the server' }, { editing: true })
    expect(r).toEqual({ ok: true, body: expect.not.objectContaining({ prompt: expect.anything() }) })
    if (r.ok) expect('prompt' in r.body).toBe(false)
  })

  it('sends type, trimmed command and numeric timeoutMs / failThreshold', () => {
    const r = buildSchedulePayload(cmd, { editing: true })
    expect(r).toEqual({
      ok: true,
      body: {
        description: 'desc', schedule: '0 3 * * *', agent: 'main-agent', type: 'command',
        command: 'bash /opt/app/backup.sh', timeoutMs: 120000, failThreshold: 1,
        skipIfBusy: false, forceSend: false,
      },
    })
  })

  it('requires a command (blank counts as missing)', () => {
    expect(buildSchedulePayload({ ...cmd, command: '   ' }, { editing: false })).toEqual({ ok: false, focus: 'command' })
  })

  it('omits timeoutMs / failThreshold when left empty so the stored values stay', () => {
    const r = buildSchedulePayload({ ...cmd, timeoutMs: '', failThreshold: ' ' }, { editing: true })
    expect(r.ok && 'timeoutMs' in r.body).toBe(false)
    expect(r.ok && 'failThreshold' in r.body).toBe(false)
  })

  it.each(['0', '-5', '1.5', 'abc', '1e3x'])('rejects timeoutMs %s', raw => {
    expect(buildSchedulePayload({ ...cmd, timeoutMs: raw }, { editing: false })).toEqual({ ok: false, focus: 'timeoutMs' })
  })

  it('rejects a non-positive failThreshold', () => {
    expect(buildSchedulePayload({ ...cmd, failThreshold: '0' }, { editing: false })).toEqual({ ok: false, focus: 'failThreshold' })
  })

  it('create carries the name, edit does not', () => {
    const created = buildSchedulePayload(cmd, { editing: false })
    const edited = buildSchedulePayload(cmd, { editing: true })
    expect(created.ok && created.body.name).toBe('job')
    expect(edited.ok && 'name' in edited.body).toBe(false)
  })
})

describe('buildSchedulePayload: prompt tasks keep their old behavior', () => {
  it('still requires a prompt', () => {
    expect(buildSchedulePayload({ ...base, prompt: '  ' }, { editing: false })).toEqual({ ok: false, focus: 'prompt' })
  })

  it('never sends the command fields, even if they are filled in', () => {
    const r = buildSchedulePayload({ ...base, prompt: 'do it', command: 'echo x', timeoutMs: '5', failThreshold: '2' }, { editing: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body).toEqual({
        name: 'job', description: 'desc', prompt: 'do it', schedule: '0 3 * * *', agent: 'main-agent',
        type: 'task', skipIfBusy: false, forceSend: false,
      })
    }
  })

  it('sends targetSession only when set', () => {
    const r = buildSchedulePayload({ ...base, prompt: 'p', targetSession: 'sess' }, { editing: true })
    expect(r.ok && r.body.targetSession).toBe('sess')
  })

  it('requires a name and a schedule', () => {
    expect(buildSchedulePayload({ ...base, prompt: 'p', name: '' }, { editing: false })).toEqual({ ok: false, focus: 'name' })
    expect(buildSchedulePayload({ ...base, prompt: 'p', schedule: '' }, { editing: false })).toEqual({ ok: false, focus: 'schedule' })
  })
})

describe('buildSchedulePayload: tenant', () => {
  const task = { ...base, prompt: 'check the thing' }

  it('sends tenant_id when the form carries one (global admin)', () => {
    const r = buildSchedulePayload({ ...task, tenantId: 'tenant-b' }, { editing: false })
    expect(r.ok && r.body.tenant_id).toBe('tenant-b')
  })

  it('sends no tenant_id when the field is empty or absent (non-admin, or an edit that keeps the tenant)', () => {
    for (const f of [task, { ...task, tenantId: '' }]) {
      const r = buildSchedulePayload(f, { editing: true })
      expect(r.ok && 'tenant_id' in r.body).toBe(false)
    }
  })

  it('sends tenant_id for a command task too', () => {
    const r = buildSchedulePayload({ ...base, type: 'command', command: 'echo hi', tenantId: 'tenant-b' }, { editing: true })
    expect(r.ok && r.body.tenant_id).toBe('tenant-b')
  })
})
