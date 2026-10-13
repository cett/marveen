// What the Approvals detail view shows for an email request and for the journal of any request. Pure
// builders: data in, HTML string out, with every value from the server run through escapeHtml. The mail
// payload (subject, body, names) is written by an agent and is never HTML: it is shown as text and
// nothing here ever assigns a raw value to markup. approvals.js owns the DOM and the fetches.
import { escapeHtml } from './util.js'
import { t, getLang } from './i18n.js'

const HASH_RE = /^[0-9a-f]{64}$/

/** The journal kinds the server writes (approval_events.event); each has an approvals.event.<kind> label. */
export const EVENT_KINDS = ['consumed', 'consume_refused', 'bearer_denied', 'owner_unreached', 'created_deduplicated', 'notify_suppressed']

/** The reasons the server writes with those kinds; each has an approvals.event.reason.<reason> label. */
export const EVENT_REASONS = [
  'not_found', 'agent_mismatch', 'wrong_category', 'already_consumed', 'not_approved', 'hash_mismatch', 'expired', 'not_human_decided',
  'human_only_category', 'human_only_category_advisory', 'rate_limited',
]

/** The list cell text: the server-built description cut to `max` characters (by code point, never mid-pair). */
export function truncateDescription(text, max = 80) {
  const chars = Array.from(String(text ?? ''))
  return chars.length > max ? chars.slice(0, max).join('') + '...' : chars.join('')
}

/** First 12 hex of a content hash for display; '' when the value is not a sha256 hex string. */
export function shortHash(hash) {
  return typeof hash === 'string' && HASH_RE.test(hash) ? hash.slice(0, 12) : ''
}

/** A timestamp in seconds as local date and time in the dashboard language; '' for a missing one. */
export function formatTime(sec, withSeconds = false) {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const opts = withSeconds ? { dateStyle: 'short', timeStyle: 'medium' } : { dateStyle: 'short', timeStyle: 'short' }
  return new Date(sec * 1000).toLocaleString(getLang() === 'en' ? 'en-GB' : 'hu-HU', opts)
}

const asText = (v) => (typeof v === 'string' ? v : '')
const asAddresses = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

/**
 * The email envelope of an approval row (its action_payload JSON), reduced to the fields the view shows
 * with a safe type each; null when the payload is missing, not JSON or not an object.
 */
export function parseEmailPayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let p
  try { p = JSON.parse(raw) } catch { return null }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const attachments = Array.isArray(p.attachments)
    ? p.attachments
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({ name: asText(a.name), size: Number.isFinite(a.size) ? a.size : null, sha256: asText(a.sha256) }))
    : []
  return {
    to: asAddresses(p.to), cc: asAddresses(p.cc), bcc: asAddresses(p.bcc),
    subject: asText(p.subject), body: asText(p.body), html_sha256: asText(p.html_sha256),
    attachments, from: asText(p.from), reply_to: asText(p.reply_to), in_reply_to: asText(p.in_reply_to),
  }
}

/**
 * The state markers of a row: plain labels, no markup. `consumed` and `unused` only exist for a
 * hash-bound request; `expired` is a request nobody decided in time; the decision markers say whether a
 * logged-in person or a bearer token made the call. The list shows `compact` ones only (consumed, unused,
 * lapsed). An approved, unused request decided longer ago than `windowS` seconds is `lapsed`: the server
 * no longer lets it be used up (same cut as the server: strictly more than the window since the decision).
 * Without a `windowS` (an older server) the request stays `unused`. `nowS` is for tests.
 */
export function approvalStateBadges(a, { compact = false, windowS = null, nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (!a) return []
  const out = []
  const bound = typeof a.content_hash === 'string' && a.content_hash !== ''
  if (bound && a.consumed_at) {
    out.push({
      kind: 'consumed',
      label: t('approvals.state.consumed', { time: formatTime(a.consumed_at), by: a.consumed_by || '-' }),
    })
  } else if (bound && a.status === 'approved') {
    const lapsed = typeof windowS === 'number' && Number.isFinite(windowS) && windowS > 0
      && typeof a.resolved_at === 'number' && nowS - a.resolved_at > windowS
    out.push(lapsed
      ? { kind: 'lapsed', label: t('approvals.state.lapsed'), title: t('approvals.state.lapsed_title', { n: Math.round(windowS / 60) }) }
      : { kind: 'unused', label: t('approvals.state.unused') })
  }
  if (compact) return out
  if (a.status === 'timeout') out.push({ kind: 'expired', label: t('approvals.state.expired') })
  if (a.resolved_via === 'dashboard_session') out.push({ kind: 'human', label: t('approvals.state.human') })
  else if (a.resolved_via === 'bearer') out.push({ kind: 'token', label: t('approvals.state.token'), title: t('approvals.state.token_title') })
  return out
}

/** The markers as pill markup; '' when there are none. */
export function renderBadges(badges) {
  return badges
    .map((b) => `<span class="approvals-state-badge approvals-state-${escapeHtml(b.kind)}"${b.title ? ` title="${escapeHtml(b.title)}"` : ''}>${escapeHtml(b.label)}</span>`)
    .join(' ')
}

const field = (label, valueHtml) => `
    <div class="approvals-detail-row">
      <span class="approvals-detail-label">${escapeHtml(label)}</span>
      <span class="approvals-detail-value">${valueHtml}</span>
    </div>`

const lines = (items) => items.map((x) => `<div class="approvals-email-line">${escapeHtml(x)}</div>`).join('')

/**
 * The mail of an email_send request, field by field: recipients one per line, the subject, the whole body
 * in a scrollable box, the attachment names with their sha256. Empty cc and bcc are said out loud, so a
 * reader sees that nobody is copied rather than wondering whether the field was hidden.
 */
export function renderEmailPayload(payload) {
  if (!payload) {
    return `<div class="approvals-detail-row"><span class="approvals-detail-value approvals-email-missing">${escapeHtml(t('approvals.email.payload_missing'))}</span></div>`
  }
  const none = `<span class="approvals-email-none">${escapeHtml(t('approvals.email.none'))}</span>`
  const parts = [
    `<div class="approvals-detail-section">${escapeHtml(t('approvals.email.section'))}</div>`,
    field(t('approvals.email.to'), payload.to.length ? lines(payload.to) : none),
    field(t('approvals.email.cc'), payload.cc.length ? lines(payload.cc) : none),
    field(t('approvals.email.bcc'), payload.bcc.length ? lines(payload.bcc) : none),
  ]
  if (payload.from) parts.push(field(t('approvals.email.from'), escapeHtml(payload.from)))
  if (payload.reply_to) parts.push(field(t('approvals.email.reply_to'), escapeHtml(payload.reply_to)))
  if (payload.in_reply_to) parts.push(field(t('approvals.email.in_reply_to'), escapeHtml(payload.in_reply_to)))
  parts.push(field(t('approvals.email.subject'), escapeHtml(payload.subject)))
  parts.push(field(t('approvals.email.body'), `<div class="approvals-email-body">${escapeHtml(payload.body)}</div>`))
  if (payload.html_sha256) parts.push(field(t('approvals.email.html'), `<code class="approvals-hash">${escapeHtml(payload.html_sha256)}</code>`))
  if (payload.attachments.length) {
    const items = payload.attachments.map((a) => {
      const label = t('approvals.email.attachment', { name: a.name, size: a.size ?? '?' })
      return `<div class="approvals-email-line">${escapeHtml(label)}<br><code class="approvals-hash">${escapeHtml(a.sha256)}</code></div>`
    })
    parts.push(field(t('approvals.email.attachments'), items.join('')))
  }
  return parts.join('')
}

/** The journal oldest first; a stable sort on (created_at, id) so a same-second pair keeps insertion order. */
export function sortEvents(items) {
  if (!Array.isArray(items)) return []
  return items
    .filter((e) => e && typeof e === 'object')
    .slice()
    .sort((x, y) => (Number(x.created_at) || 0) - (Number(y.created_at) || 0) || (Number(x.id) || 0) - (Number(y.id) || 0))
}

/** Plain-text label of one journal row: kind, then the reason when there is one. Unknown values show as sent. */
export function eventLabel(ev) {
  const kind = EVENT_KINDS.includes(ev.event) ? t('approvals.event.' + ev.event) : String(ev.event ?? '')
  if (!ev.reason) return { kind, reason: '' }
  const reason = EVENT_REASONS.includes(ev.reason) ? t('approvals.event.reason.' + ev.reason) : String(ev.reason)
  return { kind, reason }
}

/** The event timeline of one approval; the empty-state line when there is nothing to list. */
export function renderTimeline(items) {
  const events = sortEvents(items)
  if (!events.length) return `<div class="approvals-email-none">${escapeHtml(t('approvals.event.empty'))}</div>`
  return `<ol class="approvals-events">${events.map((ev) => {
    const { kind, reason } = eventLabel(ev)
    const meta = [
      ev.actor ? t('approvals.event.actor', { actor: String(ev.actor) }) : '',
      ev.ref ? t('approvals.event.ref', { ref: String(ev.ref) }) : '',
    ].filter(Boolean)
    const tone = ev.event === 'consumed' ? 'ok' : (ev.event === 'consume_refused' || ev.event === 'bearer_denied') ? 'warn' : 'info'
    return `<li class="approvals-event approvals-event-${tone}" data-event="${escapeHtml(String(ev.event ?? ''))}">
      <span class="approvals-event-time">${escapeHtml(formatTime(Number(ev.created_at), true))}</span>
      <span class="approvals-event-kind">${escapeHtml(kind)}</span>${reason ? ` <span class="approvals-event-reason">${escapeHtml(reason)}</span>` : ''}${meta.length ? ` <span class="approvals-event-meta">${escapeHtml(meta.join(' / '))}</span>` : ''}
    </li>`
  }).join('')}</ol>`
}
