// Forensics for a parked input box: when the stuck-input recovery reaches 'hold' (nothing it may do to the box), say
// what the pane looked like ONCE per park episode, so the next incident can be diagnosed from the log. Until now nothing
// was kept: not the row count, not the pane state, not which deliveries had just been pasted, so why an Enter was
// swallowed could only be guessed.
//
// Log only, no behaviour change: a 'hold' stays a 'hold'.
//
// REDACTION. The parked box of a MAIN session can hold a human's own draft, so the box is never logged as text. A row
// is written out only when it is verbatim a piece of the wrapper boilerplate the delivery code itself builds (the three
// preambles of src/prompt-safety.ts, imported, not retyped: a changed preamble changes what counts as boilerplate with
// it). Every other row is logged as '[non-wrapper N chars]', length only. A row that mixes boilerplate and anything
// else is not a piece of the boilerplate and is masked too.
import { logger } from '../logger.js'
import { detectPaneState, parkedInputRows } from '../pane-state.js'
import { UNTRUSTED_PREAMBLE, TRUSTED_PEER_PREAMBLE, CHANNEL_INBOUND_PREAMBLE } from '../prompt-safety.js'
import { recentDeliveryRefs } from './delivery-intent.js'

/** How many trailing rows of the box the log shows (redacted). */
export const FORENSICS_TAIL_ROWS = 6
/** How many recent deliveries into the session the log names. */
export const FORENSICS_DELIVERY_REFS = 3
/** Row lengths are logged for at most this many rows, so a huge box cannot make a huge log line. */
const MAX_ROW_LENGTHS = 40
/**
 * A row shorter than this is never shown even if it is a piece of the boilerplate: a short row ("the", "data") is a
 * substring of almost any English text, so a match proves nothing about where it came from.
 */
const MIN_BOILERPLATE_ROW_CHARS = 20
/** Sessions with an open episode are kept at most this many (the oldest is forgotten first), so the map stays small. */
const MAX_OPEN_EPISODES = 200

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

// The boilerplate as one whitespace-collapsed text: the TUI wraps a long line at the pane width, so a visible row is a
// contiguous piece of this text, not a whole preamble line.
const WRAPPER_BOILERPLATE = collapse([UNTRUSTED_PREAMBLE, TRUSTED_PEER_PREAMBLE, CHANNEL_INBOUND_PREAMBLE].join(' '))

/** One box row as the log may show it: the row itself when it is wrapper boilerplate, else only its length. */
export function redactBoxRow(row: string): string {
  const flat = collapse(row)
  if (flat.length >= MIN_BOILERPLATE_ROW_CHARS && WRAPPER_BOILERPLATE.includes(flat)) return flat
  return `[non-wrapper ${flat.length} chars]`
}

/**
 * What a log line may carry of the text parked in an input box: how long it is (whitespace-collapsed) and, only when it is
 * verbatim a piece of the wrapper boilerplate, that piece (see redactBoxRow). The box of a main session can hold a human's
 * own draft and the box of a sub-agent an inter-agent frame (another agent's or tenant's text), so the text itself never
 * goes to a log. A whole parked frame is boilerplate PLUS a message, so it is masked: the privacy is the point. Spread the
 * result into the log fields.
 */
export function redactParkedForLog(text: string): { parkedChars: number; parkedShown: string } {
  const flat = collapse(text)
  return { parkedChars: flat.length, parkedShown: redactBoxRow(flat) }
}

// session -> an episode is open (its forensics line was written). Insertion-ordered, so the oldest goes first.
const openEpisodes = new Set<string>()

/** The park is over (nothing is parked in the box any more): the next hold in this session is a new episode. */
export function endParkEpisode(session: string): void {
  openEpisodes.delete(session)
}

/** For tests: is an episode open for the session. */
export function _parkEpisodeOpen(session: string): boolean {
  return openEpisodes.has(session)
}

/**
 * Write the forensics line for the first 'hold' of a park episode of `session`; a later hold in the same episode
 * writes nothing. `pane` is the capture the decision was made on.
 */
export function logParkForensicsOnce(session: string, attempt: number, pane: string): void {
  if (openEpisodes.has(session)) return
  openEpisodes.add(session)
  while (openEpisodes.size > MAX_OPEN_EPISODES) {
    const oldest = openEpisodes.values().next().value
    if (oldest === undefined) break
    openEpisodes.delete(oldest)
  }
  const rows = parkedInputRows(pane)
  logger.warn(
    {
      session,
      attempt,
      paneState: detectPaneState(pane),
      rowCount: rows.length,
      rowLengths: rows.slice(0, MAX_ROW_LENGTHS).map((r) => r.length),
      tail: rows.slice(-FORENSICS_TAIL_ROWS).map(redactBoxRow),
      deliveryRefs: recentDeliveryRefs(session, FORENSICS_DELIVERY_REFS),
    },
    'Stuck input -- first hold of a park episode (forensics)',
  )
}
