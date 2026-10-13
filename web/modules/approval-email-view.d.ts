export interface EmailPayloadView {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  html_sha256: string
  attachments: Array<{ name: string; size: number | null; sha256: string }>
  from: string
  reply_to: string
  in_reply_to: string
}
export interface StateBadge {
  kind: string
  label: string
  title?: string
}
export interface ApprovalEventRow {
  id?: number
  event?: string
  reason?: string | null
  actor?: string | null
  ref?: string | null
  created_at?: number
  [key: string]: unknown
}
export const EVENT_KINDS: string[]
export const EVENT_REASONS: string[]
export function truncateDescription(text: unknown, max?: number): string
export function shortHash(hash: unknown): string
export function formatTime(sec: number, withSeconds?: boolean): string
export function parseEmailPayload(raw: unknown): EmailPayloadView | null
export function approvalStateBadges(a: Record<string, unknown> | null | undefined, opts?: { compact?: boolean }): StateBadge[]
export function renderBadges(badges: StateBadge[]): string
export function renderEmailPayload(payload: EmailPayloadView | null): string
export function sortEvents(items: unknown): ApprovalEventRow[]
export function eventLabel(ev: ApprovalEventRow): { kind: string; reason: string }
export function renderTimeline(items: unknown): string
