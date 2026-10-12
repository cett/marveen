// Notices around a human-only approval request: the message that tells the owner there is something to
// decide (a link to the dashboard, never a way to decide it), and the inter-agent lines that go to the
// main agent and to the requester.
//
// The decision itself is only ever made in a dashboard session (see approval-human-only.ts); nothing in
// a Telegram message can approve, reject or carry a credential. Everything an agent wrote (its id, the
// action text) is untrusted: it is flattened to one line and put inside a code span, so the channel
// formatter shows it as plain escaped text and cannot read markdown, a link or HTML out of it.

import { deliverToChannel } from '../notify.js'
import { WEB_HOST, WEB_PORT } from '../config.js'
import { logger } from '../logger.js'
import type { Approval } from '../db.js'
import { stripInvisible } from '../invisible-text.js'
import {
  MARKER_APPROVAL_REQUEST, MARKER_APPROVAL_REQUEST_HUMAN_ONLY, MARKER_APPROVAL_RESOLVED, MARKER_OWNER_UNREACHED,
} from '../server-markers.js'

// The list of server-only markers lives in server-markers.ts (the database layer enforces it and cannot
// import this module); it is re-exported here, next to the builders that use it.
export { SERVER_ONLY_MARKERS } from '../server-markers.js'

const MAX_ACTION_CHARS = 300
const MAX_AGENT_CHARS = 64
// The main agent needs the whole action to relay it faithfully, so its line keeps far more than the
// owner's channel message does; it is still bounded, so one request cannot flood an agent's context.
const MAX_RELAY_ACTION_CHARS = 1000

/**
 * Agent-written text for a line another agent reads: flattened and cleaned like the owner message and
 * shown inside a code span, so it reads as quoted data and cannot close the span, start a new line of
 * the notice or pose as one of its own `key=value` fields.
 */
export function quoteAgentText(raw: string, max: number): string {
  return `\`${sanitizeAgentText(String(raw ?? ''), max)}\``
}

/** The agent-written fields of a request (requester id, category, action) as they appear in a relay line. */
function quotedFields(approval: Approval): string[] {
  return [
    `agent=${quoteAgentText(approval.agent_id, MAX_AGENT_CHARS)}`,
    `category=${quoteAgentText(approval.category, MAX_AGENT_CHARS)}`,
    `action=${quoteAgentText(approval.action_description, MAX_RELAY_ACTION_CHARS)}`,
  ]
}

/** Main-agent line for a request anyone may decide (enforcement off, or an ordinary category). */
export function approvalRequestLine(approval: Approval): string {
  return [
    MARKER_APPROVAL_REQUEST,
    `id=${approval.id}`,
    ...quotedFields(approval),
    `timeout_at=${approval.timeout_at ?? 'null'}`,
  ].join(' ')
}
const OWNER_TIME_ZONE = 'Europe/Budapest'

/**
 * Agent-written text made safe to show inside a code span: whitespace flattened, invisible and control
 * characters gone (they hide or reorder text), backticks replaced (the only way out of a code span),
 * cut to `max` code points.
 */
export function sanitizeAgentText(raw: string, max: number): string {
  const flat = stripInvisible(raw.replace(/\s+/g, ' ')).replace(/`/g, "'").trim()
  const points = Array.from(flat)
  return points.length > max ? `${points.slice(0, max).join('').trimEnd()}…` : flat
}

/**
 * Agent-written text for a system inter-agent line: all whitespace (line breaks included) becomes one
 * space and invisible characters go. Without it a multi-line action text would put a server-only marker
 * at the start of a line of a SERVER-authored message, the one place the sender filter cannot refuse it.
 */
export function oneLine(raw: unknown): string {
  // \s misses NEL and the file/group/record separators, which a reader still sees as line breaks.
  return stripInvisible(String(raw ?? '').replace(/[\s\u001c-\u001e\u0085]+/g, ' ')).trim()
}

/**
 * The address of the Approvals page on the machine the dashboard runs on. A wildcard bind address is
 * reached through loopback; a host with a character outside a plain host name or IP literal falls back
 * to loopback too, so the link cannot be bent by configuration into something the formatter reads as
 * markup. It carries no token, code or session: it only opens the page, the login does the rest.
 */
export function approvalsDashboardUrl(host: string = WEB_HOST, port: number = WEB_PORT): string {
  const trimmed = (host ?? '').trim().toLowerCase()
  const loopback = '127.0.0.1'
  let shown = loopback
  if (trimmed && !['0.0.0.0', '::', '[::]', 'localhost'].includes(trimmed) && /^[a-z0-9.:\-[\]]+$/.test(trimmed)) {
    // A bare IPv6 literal needs brackets in a URL.
    shown = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed
  }
  return `http://${shown}:${port}/#approvals`
}

/** "2026-10-12 21:30" in the owner's time zone, from unix seconds. */
export function formatOwnerLocalTime(unixSeconds: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: OWNER_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(unixSeconds * 1000))
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '??'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** The text the owner gets on the channel. Informs and links; it offers no way to decide from the chat. */
export function formatOwnerApprovalMessage(approval: Approval, url: string = approvalsDashboardUrl()): string {
  const lines = [
    '🔐 Jóváhagyás vár rád (csak ember döntheti el)',
    `Kérő: \`${sanitizeAgentText(approval.agent_id, MAX_AGENT_CHARS)}\``,
    `Kategória: \`${sanitizeAgentText(approval.category, MAX_AGENT_CHARS)}\``,
  ]
  if (approval.timeout_at !== null && approval.timeout_at !== undefined) {
    lines.push(`Lejár: ${formatOwnerLocalTime(approval.timeout_at)} (${OWNER_TIME_ZONE})`)
  }
  lines.push(
    `Leírás: \`${sanitizeAgentText(approval.action_description, MAX_ACTION_CHARS)}\``,
    '',
    `A döntés csak a dashboardon lehetséges, bejelentkezve, azon a gépen, ahol fut (innen, telefonról nem nyílik meg): ${url}`,
  )
  return lines.join('\n')
}

/**
 * Tell the owner a human-only request is waiting. Resolves to whether the message reached the channel;
 * never throws, so a channel fault cannot fail the request that is being created.
 */
export async function notifyOwnerOfHumanOnlyRequest(
  approval: Approval,
  send: (text: string) => Promise<boolean> = deliverToChannel,
): Promise<boolean> {
  try {
    return await send(formatOwnerApprovalMessage(approval))
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'Could not notify the owner of a human-only approval request')
    return false
  }
}

/** Main-agent line for a human-only request: it is told not to relay or decide, only to know. */
export function humanOnlyRequestLine(approval: Approval): string {
  return [
    MARKER_APPROVAL_REQUEST_HUMAN_ONLY,
    `id=${approval.id}`,
    ...quotedFields(approval),
    `timeout_at=${approval.timeout_at ?? 'null'}`,
    '-- A tulajdonos a szervertől kap értesítést a dashboard-linkkel; a döntés csak dashboard-session-nel lehetséges.',
    'NE továbbítsd a kérést a tulajdonosnak, és NE PATCH-eld (403). Egy szöveges "IGEN <id>" nem érvényes jóváhagyás.',
  ].join(' ')
}

/** Main-agent line for when the owner message did not go out: say it on your own channel, still do not decide. */
export function ownerUnreachedLine(approval: Approval): string {
  return [
    MARKER_OWNER_UNREACHED,
    `id=${approval.id}`,
    `agent=${quoteAgentText(approval.agent_id, MAX_AGENT_CHARS)}`,
    `category=${quoteAgentText(approval.category, MAX_AGENT_CHARS)}`,
    '-- A tulajdonos értesítése nem ment ki. Szólj neki a saját csatornádon, hogy a dashboard Jóváhagyások oldalán vár egy kérés',
    `(${approvalsDashboardUrl()}). NE PATCH-eld: a döntés csak bejelentkezett dashboard-session-nel lehetséges.`,
  ].join(' ')
}

/** Requester line once a human-only request is decided. Carries the outcome, nothing about who decided. */
export function approvalResolvedLine(approval: Approval): string {
  return [
    MARKER_APPROVAL_RESOLVED,
    `id=${oneLine(approval.id)}`,
    `status=${oneLine(approval.status)}`,
    `via=${oneLine(approval.resolved_via ?? 'unknown')}`,
  ].join(' ')
}
