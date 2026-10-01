export interface ScheduleFormFields {
  name: string
  description: string
  prompt: string
  schedule: string
  agent: string
  type: string
  skipIfBusy: boolean
  forceSend: boolean
  targetSession: string
  command: string
  timeoutMs: string
  failThreshold: string
}

export type SchedulePayloadResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; focus: string }

export function buildSchedulePayload(f: ScheduleFormFields, opts: { editing: boolean }): SchedulePayloadResult
