// Application log capture for the OTLP log export (OTel H6b). Every warn, error and fatal line the dashboard's
// pino logger writes is noted here in a small in-memory buffer; the push exporter sends the buffer when
// OTEL_EXPORT_APP_LOGS is on. Imports nothing but the scrub rules, so src/logger.ts can use it without a cycle.
//
// What is kept of a line, and why it is little:
//   - the MESSAGE TEMPLATE only, scrubbed (credentials, home directory, mailboxes, paths, long ids) and cut to
//     MAX_MESSAGE_CHARS. pino's format arguments (`%s` values) and the bindings object are never read, because
//     that is where the data of a call lives (an agent name, a path, a card title, an error text). A message
//     with a value built into the string itself is the one thing the scrub cannot recognise; that is why this
//     export is its own opt-in and not part of the audit log export.
//   - from an Error under `err` / `error`: its class name and a string `code` (ECONNREFUSED ...), as bounded
//     identifiers. Never its message or stack.
// Identical lines (same level and scrubbed message) are folded into one record with a count, the buffer holds
// MAX_BUFFER distinct ones and drops the oldest beyond that, and the number dropped is counted by reason.
// The buffer is lost when the process stops. The exporter's own lines are not captured: an unreachable
// collector would otherwise log about itself, and every failure would send more of the same.

import { scrubLogText } from './otel-scrub.js'

export const MAX_BUFFER = 500
export const MAX_MESSAGE_CHARS = 160
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const MIN_LEVEL = 40 // warn
const SELF_PREFIXES = ['otel-push-exporter:', 'otel-app-logs:']

export interface AppLogRecord {
  level: number
  message: string
  exceptionType: string | null
  errorCode: string | null
  firstMs: number
  count: number
}

const buffer = new Map<string, AppLogRecord>()
const dropped = { overflow: 0 }

function token(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  return TOKEN_RE.test(value) ? value : '_other'
}

// pino's logMethod hook arguments: (obj, msg, ...formatArgs) or (msg, ...formatArgs).
function templateAndError(args: unknown[]): { template: string; err: unknown } {
  const first = args[0]
  if (typeof first === 'string') return { template: first, err: undefined }
  if (first instanceof Error) return { template: typeof args[1] === 'string' ? args[1] : 'error', err: first }
  const bindings = first && typeof first === 'object' ? first as Record<string, unknown> : {}
  return { template: typeof args[1] === 'string' ? args[1] : '', err: bindings['err'] ?? bindings['error'] }
}

// Notes one log call. Never throws and never reads anything but the template and the error's class and code.
export function captureLogCall(level: number, args: unknown[], nowMs: number = Date.now()): void {
  try {
    if (level < MIN_LEVEL) return
    const { template, err } = templateAndError(args)
    if (SELF_PREFIXES.some((p) => template.startsWith(p))) return
    const message = scrubLogText(template, MAX_MESSAGE_CHARS)
    const isError = err instanceof Error
    const exceptionType = isError ? token(err.name) ?? token(err.constructor?.name) : null
    const code = isError ? token((err as Error & { code?: unknown }).code) : null
    if (!message && !exceptionType) return
    const key = `${level}\u0000${message}\u0000${exceptionType ?? ''}\u0000${code ?? ''}`
    const existing = buffer.get(key)
    if (existing) {
      existing.count += 1
      return
    }
    if (buffer.size >= MAX_BUFFER) {
      const oldest = buffer.keys().next().value as string
      buffer.delete(oldest)
      dropped.overflow += 1
    }
    buffer.set(key, { level, message, exceptionType, errorCode: code, firstMs: nowMs, count: 1 })
  } catch {
    /* logging must never fail because of its own telemetry */
  }
}

// Hands over up to `max` records, oldest first, and removes them from the buffer.
export function takeAppLogs(max: number): AppLogRecord[] {
  const out: AppLogRecord[] = []
  for (const [key, rec] of buffer) {
    if (out.length >= max) break
    out.push(rec)
    buffer.delete(key)
  }
  return out
}

// Puts records back after a failed send (merged with what was logged meanwhile; the oldest give way if full).
export function restoreAppLogs(records: AppLogRecord[]): void {
  for (const rec of records) {
    const key = `${rec.level}\u0000${rec.message}\u0000${rec.exceptionType ?? ''}\u0000${rec.errorCode ?? ''}`
    const existing = buffer.get(key)
    if (existing) {
      existing.count += rec.count
      existing.firstMs = Math.min(existing.firstMs, rec.firstMs)
    } else if (buffer.size < MAX_BUFFER) {
      buffer.set(key, rec)
    } else {
      dropped.overflow += rec.count
    }
  }
}

export function getAppLogDropped(): { overflow: number } {
  return { ...dropped }
}

export function resetAppLogs(): void {
  buffer.clear()
  dropped.overflow = 0
}

export function pendingAppLogCount(): number {
  return buffer.size
}
