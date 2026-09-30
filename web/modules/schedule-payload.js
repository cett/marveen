// Pure payload builder for the schedule modal's save button (no DOM access, so
// it can be unit-tested). The modal reads its fields into `f`, this decides
// whether the form is complete and what the API body is.
//
// A `command` task runs a shell command with no LLM: it needs a command, its
// prompt is optional and is NOT sent (an edit keeps whatever prompt is stored),
// and it carries its own timeoutMs / failThreshold. Every other type needs a
// prompt and never sends the command fields.

function positiveInt(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return { empty: true }
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? { value: n } : { invalid: true }
}

/**
 * @param {{
 *   name: string, description: string, prompt: string, schedule: string, agent: string,
 *   type: string, skipIfBusy: boolean, forceSend: boolean, targetSession: string,
 *   command: string, timeoutMs: string, failThreshold: string,
 * }} f
 * @param {{ editing: boolean }} opts
 * @returns {{ ok: true, body: Record<string, unknown> } | { ok: false, focus: string }}
 */
export function buildSchedulePayload(f, { editing }) {
  if (!f.name) return { ok: false, focus: 'name' }
  const isCommand = f.type === 'command'
  if (isCommand) {
    if (!f.command.trim()) return { ok: false, focus: 'command' }
  } else if (!f.prompt.trim()) {
    return { ok: false, focus: 'prompt' }
  }
  if (!f.schedule) return { ok: false, focus: 'schedule' }

  const body = {}
  if (!editing) body.name = f.name
  body.description = f.description
  if (!isCommand) body.prompt = f.prompt
  body.schedule = f.schedule
  body.agent = f.agent
  body.type = f.type
  if (isCommand) {
    body.command = f.command.trim()
    const timeout = positiveInt(f.timeoutMs)
    if (timeout.invalid) return { ok: false, focus: 'timeoutMs' }
    if (timeout.value !== undefined) body.timeoutMs = timeout.value
    const threshold = positiveInt(f.failThreshold)
    if (threshold.invalid) return { ok: false, focus: 'failThreshold' }
    if (threshold.value !== undefined) body.failThreshold = threshold.value
  }
  body.skipIfBusy = f.skipIfBusy
  body.forceSend = f.forceSend
  if (f.targetSession) body.targetSession = f.targetSession
  return { ok: true, body }
}
