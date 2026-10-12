// Server-only markers of inter-agent messages.
//
// The server tells the main agent and the requesting agent about the human-only approval flow with
// system-authored inter-agent messages whose first token is a marker (see web/approval-owner-notice.ts,
// which builds them and re-exports the list). A receiving agent acts on those lines, so a message an
// agent wrote must never be able to pass for one: this module is the single list of the markers and the
// filter every writer of an inter-agent message goes through (createAgentMessage, the HTTP routes).
//
// Refuse, not rewrite. A legitimate agent never needs to send a marker as the start of a line, so the
// message is rejected loudly (the sender sees the error and can resend) instead of being delivered with
// its text silently altered. Text that merely mentions a marker in the middle of a line is ordinary text
// and is not touched.
//
// Dependency-free on purpose (no database, no config): the database layer enforces the filter too, and
// the approval module that owns the builders reaches the database, which would be an import cycle.

import { stripInvisible } from './invisible-text.js'
import { sanitizeAgentIdent } from './prompt-safety.js'

/** The one sender that may put these markers on a message: the server itself, in-process. */
export const SERVER_SENDER = 'system'

export const MARKER_APPROVAL_REQUEST = '[APPROVAL_REQUEST]'
export const MARKER_APPROVAL_REQUEST_HUMAN_ONLY = '[APPROVAL_REQUEST][HUMAN_ONLY]'
export const MARKER_OWNER_UNREACHED = '[OWNER_UNREACHED]'
export const MARKER_APPROVAL_RESOLVED = '[APPROVAL_RESOLVED]'

/**
 * Every marker a server-authored message may start with. A new marker is added HERE and nowhere else;
 * the test that builds each notice line checks that its first token is in this list, so a builder
 * cannot start using a marker that the filter does not know.
 */
export const SERVER_ONLY_MARKERS: readonly string[] = [
  MARKER_APPROVAL_REQUEST_HUMAN_ONLY,
  MARKER_APPROVAL_REQUEST,
  MARKER_OWNER_UNREACHED,
  MARKER_APPROVAL_RESOLVED,
]

// Look-alike letters (lower case, after case folding) that render like a Latin letter in the markers,
// as [code point, Latin letter]. Best effort, not a full confusables table: NFKD already folds the
// full-width and mathematical forms, this adds the Cyrillic, Greek and Armenian letters that survive it.
// The receiver's own check (read the approval back with a GET) stays the real boundary; this closes the
// cheap forgeries. Code points as numbers, so the source carries no look-alike character itself.
const CONFUSABLE_PAIRS: ReadonlyArray<readonly [number, string]> = [
  [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0445, 'x'],
  [0x0456, 'i'], [0x0455, 's'], [0x0458, 'j'], [0x0501, 'd'], [0x051b, 'q'], [0x051d, 'w'],
  [0x04bb, 'h'], [0x0475, 'v'], [0x043a, 'k'], [0x0442, 't'], [0x043d, 'h'], [0x043c, 'm'],
  [0x04cf, 'l'], [0x0131, 'i'],
  [0x03b1, 'a'], [0x03b5, 'e'], [0x03bf, 'o'], [0x03c1, 'p'], [0x03b9, 'i'], [0x03c4, 't'],
  [0x03bd, 'v'], [0x03c5, 'u'], [0x03ba, 'k'], [0x03b7, 'n'],
  [0x0578, 'n'], [0x057d, 'u'],
]
const CONFUSABLES = new Map<string, string>(CONFUSABLE_PAIRS.map(([cp, latin]) => [String.fromCodePoint(cp), latin]))

/** A character class matching exactly the given code points (written as escapes, never as raw characters). */
function codePointClass(points: readonly number[], flags: string): RegExp {
  return new RegExp(`[${points.map((cp) => `\\u{${cp.toString(16)}}`).join('')}]`, flags)
}

// Bracket look-alikes that NFKD leaves alone (the full-width forms it already folds to [ and ]).
const OPEN_BRACKETS = codePointClass([0x2045, 0x27e6, 0x27ec, 0x2772, 0x3010, 0x3014, 0x3016, 0x3018, 0x301a], 'gu')
const CLOSE_BRACKETS = codePointClass([0x2046, 0x27e7, 0x27ed, 0x2773, 0x3011, 0x3015, 0x3017, 0x3019, 0x301b], 'gu')

// Line boundaries as a reader or a model sees them: LF, VT, FF, CR, the file/group/record separators,
// NEL and the Unicode line/paragraph separators. Split BEFORE stripping invisibles, or a marker on a new
// line separated by U+2028 would be glued to the previous line.
const LINE_BREAKS = codePointClass([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029], 'u')

// A leading run of these wraps a marker in Markdown emphasis or a heading (`**[X]**`, `__[X]__`,
// `~~[X]~~`, `#[X]`) without quoting or listing it -- a receiver's own Markdown renderer (or a model
// reading the text) can strip exactly these and be left with the marker sitting at the start of a
// rendered line. Dropped before the bracket check, unlike a quote or list prefix (`>`, `-`, a quote
// mark, a backtick), which stays meaningful: a marker shown that way is being discussed, not claimed.
const LEADING_MARKDOWN_DECORATION = /^[*_#~]+/

// A leading inline HTML tag that only wraps or styles the text (`<b>`, `<strong>`, `<em>`, `<span style=...>`,
// `<p>`, `<div>`, a heading, a link, ... also closing, also nested) renders the marker at the start of the line
// just like Markdown emphasis does, so it is dropped with the other leading decoration. NOT listed on purpose:
// `<code>`, `<pre>`, `<kbd>`, `<samp>`, `<tt>` (quotation, like a backtick: a marker shown that way is being
// discussed, not claimed) and `<blockquote>` / `<li>` (a quote or list prefix, like `>` and `-`). The text is
// lower case here already, and `&lt;b&gt;` is not decoded, so an escaped tag stays visible text, not a tag.
const LEADING_HTML_TAG = /^<\/?(?:a|b|strong|em|i|u|ins|del|s|strike|mark|span|p|div|small|big|sub|sup|center|font|h[1-6])(?=[\s/>])[^<>]*>/

/** Drop, repeatedly, what a renderer would not show in front of the first visible character of a line. */
function stripLeadingWrappers(text: string): string {
  let current = text
  for (let pass = 0; pass < 32; pass++) {
    const next = current.replace(/^[\s\p{Z}]+/u, '').replace(LEADING_MARKDOWN_DECORATION, '').replace(LEADING_HTML_TAG, '')
    if (next === current) return next
    current = next
  }
  return current
}

// A Markdown backslash escape (`\[`, `\_`, `\*`) renders as the bare punctuation mark: a receiver's renderer
// (or a model reading the text) drops the backslash and is left with the marker. Only a backslash in front
// of ASCII punctuation is an escape; `\\` is an escaped backslash (a literal one, which hides the marker).
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g

// HTML character references that spell a character of a marker: numeric (decimal or hex, the closing `;`
// optional as in a browser) and the few named ones for its brackets, underscore, hyphen and blank. A
// renderer that decodes them shows the marker. Decoded to a fixed point (bounded), so a double-encoded
// `&amp;#91;` does not survive one pass.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lbrack: '[', lsqb: '[', rbrack: ']', rsqb: ']', lowbar: '_', underbar: '_', hyphen: '-', nbsp: ' ', amp: '&',
}
const HTML_ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));?/g
const MAX_ENTITY_PASSES = 3

// A percent-encoded bracket (`%5B`, `%5D`) stands for the bracket where a receiver URL-decodes a line. Only the
// two brackets are decoded, not percent escapes in general: ordinary text keeps its `%` sequences.
const PERCENT_BRACKET = /%5([bBdD])/g

function decodeEntityPass(text: string): string {
  return text.replace(PERCENT_BRACKET, (_whole, hex: string) => (hex.toLowerCase() === 'b' ? '[' : ']')).replace(HTML_ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole
    const point = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16)
    if (!Number.isInteger(point) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return whole
    return String.fromCodePoint(point)
  })
}

function decodeEntities(text: string): string {
  let current = text
  for (let pass = 0; pass < MAX_ENTITY_PASSES; pass++) {
    const next = decodeEntityPass(current)
    if (next === current) break
    current = next
  }
  return current
}

/**
 * A line reduced to the shape it is compared in: compatibility-decomposed (NFKD: full-width and
 * mathematical forms fold to plain letters, an accented letter splits from its accent), invisible and
 * format characters and combining marks gone, lower case, look-alike letters and brackets mapped to
 * ASCII, whitespace dropped, HTML character references decoded and Markdown backslash escapes resolved
 * (`\[`, `&#91;`, `&lbrack;` all read as `[`), a leading run of Markdown emphasis/heading markers gone. A line that does
 * not open with a bracket after that is no candidate (empty shape). Underscores and hyphens are dropped
 * only then, so `[APPROVAL-RESOLVED]` and `[ approval resolved ]` read as the marker they imitate while
 * `- [APPROVAL_RESOLVED]` stays a list item.
 */
function skeleton(line: string): string {
  const folded = stripInvisible(decodeEntities(line).normalize('NFKD')).replace(/[\p{Cf}\p{M}]/gu, '').toLowerCase()
  const shape = Array.from(folded, (ch) => CONFUSABLES.get(ch) ?? ch).join('')
    .replace(OPEN_BRACKETS, '[')
    .replace(CLOSE_BRACKETS, ']')
  // Escapes first (one pass, so an escaped backslash stays a literal one), then the wrappers while the
  // whitespace inside a tag still separates its attributes, then the blanks.
  const visible = stripLeadingWrappers(shape.replace(MARKDOWN_ESCAPE, '$1')).replace(/[\s\p{Z}]/gu, '')
  return visible.startsWith('[') ? visible.replace(/[_-]/g, '') : ''
}

const MARKER_SKELETONS: ReadonlyArray<readonly [string, string]> = SERVER_ONLY_MARKERS.map(
  (marker) => [marker, skeleton(marker)] as const,
)

/**
 * The server-only marker that `content` starts with, on its first line or at the start of any later
 * line, or null. Leading whitespace, invisible characters, case, full-width and look-alike letters do
 * not hide a marker. A marker in the middle of a line, or behind a quote or list prefix, is just text.
 * Anything that is not a string has no marker (the callers reject it as invalid content themselves).
 */
export function findReservedMarker(content: unknown): string | null {
  if (typeof content !== 'string') return null
  for (const line of content.split(LINE_BREAKS)) {
    const shape = skeleton(line)
    if (!shape) continue
    for (const [marker, markerShape] of MARKER_SKELETONS) {
      if (shape.startsWith(markerShape)) return marker
    }
  }
  return null
}

/** True for the exact sender string the server's own code uses. */
export function isServerSender(from: string): boolean {
  return from === SERVER_SENDER
}

/**
 * Whether a sender claimed over HTTP is (or reads as) the server's sender: the id the delivery code
 * would sanitize it to is `system`, in any case. The claim is refused even when a directory called
 * `system` exists or `system` was opted in as a neighbouring-system sender, because the stored sender
 * of every marker message is that very word.
 */
export function claimsServerSender(from: unknown): boolean {
  return typeof from === 'string' && sanitizeAgentIdent(from).toLowerCase() === SERVER_SENDER
}

export class ReservedMarkerError extends Error {
  readonly code = 'reserved_marker'
  constructor(readonly marker: string) {
    super(`content starts a line with the server-only marker ${marker}`)
    this.name = 'ReservedMarkerError'
  }
}

/**
 * The gate every inter-agent message goes through before it is stored: anyone but the server's own
 * sender is refused when the text starts a line with a server-only marker.
 */
export function assertNoReservedMarker(from: string, content: unknown): void {
  if (isServerSender(from)) return
  const marker = findReservedMarker(content)
  if (marker) throw new ReservedMarkerError(marker)
}

/** Body of the 400 an HTTP route answers with when the content starts a line with a reserved marker. */
export function reservedMarkerRefusal(marker: string): {
  error: 'invalid_value'; code: 'reserved_marker'; field: 'content'; hint: string
} {
  return {
    error: 'invalid_value',
    code: 'reserved_marker',
    field: 'content',
    hint: `a line of the text starts with ${marker}, which only the server may send: reword it, or quote it mid-line`,
  }
}
