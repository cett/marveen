// Manifest poller: keeps a per-peer freshness/capability cache for the
// dashboard (Federation page + federated agent cards). update-checker shape
// (in-memory cache, thin interval starter, manual refresh endpoint) with the
// mcp-list refinements: stale RETENTION (a transient failure never blanks
// the last known manifest) and a single-flight guard shared by the interval
// tick and the manual refresh.
//
// Classification is by STATUS CODE only, never by peer-controlled body text.
// A disabled peer presents on the wire as a plain 401 (its gate refuses
// before its handler could 403), so 'auth-or-disabled' is ONE honest state:
// "the peer answered but did not accept our token -- it either disabled
// federation or rotated the token". The UI explains both possibilities.
//
// The poller never feeds the bridge's backoff (different semantics) and
// deliberately does NOT skip backing-off peers: 1 GET / 10 min is nothing
// next to the bridge's retry traffic, while skipping would leave a stale
// 'ok' visible for hours exactly when visibility matters most.
import { logger } from '../../logger.js'
import { scrubSecurityTags, tagOpenings } from '../../prompt-safety.js'
import { getFederationConfig, FEDERATION_MIN_TOKEN_LENGTH, type FederationPeer } from './config.js'
import { isValidIdSegment } from './address.js'
import { readBoundedBody, PeerResponseTooLargeError } from './http.js'
import { FEDERATION_REQUEST_TIMEOUT_MS } from './bridge.js'

import { systemJob } from '../../db/background-jobs.js'
// 512KB: the structural worst case (100 agents with 600-char summaries --
// which truncate() counts in UTF-16 units, so up to ~1.8KB of UTF-8 each --
// plus 300 capped skills) must fit; an over-limit body is rejected WHOLE,
// which would freeze the peer's view on its stale manifest.
export const MANIFEST_MAX_BODY_BYTES = 512 * 1024
export const MANIFEST_MAX_AGENTS = 100
export const MANIFEST_MAX_SKILLS = 300
export const MANIFEST_MAX_SUMMARY = 600
const MAX_SHORT_FIELD = 120
const MAX_DESCRIPTION = 300
export const FEDERATION_POLL_INTERVAL_MS = 10 * 60_000
// First poll offset: 5/10/20/30/35/40/45/50/90s are taken by other runners.
export const FEDERATION_POLL_INITIAL_DELAY_MS = 25_000

export type PeerPollState = 'ok' | 'auth-or-disabled' | 'error' | 'unreachable' | 'unpaired' | 'unknown'

export interface PeerManifest {
  system: string
  marveenVersion: string
  federationVersion: number
  agents: Array<{ id: string; displayName: string; model: string; capabilitySummary?: string }>
  skills: Array<{ agent: string; name: string; description: string }>
}

export interface PeerStatus {
  id: string
  baseUrl: string
  state: PeerPollState
  lastChecked: number // ms epoch; 0 = never
  lastOkAt: number // ms epoch; 0 = never
  error?: string
  manifest?: PeerManifest // last KNOWN manifest (stale-retained on failure)
}

const statusCache = new Map<string, PeerStatus>()
let inflightRefresh: Promise<PeerStatus[]> | null = null

function truncate(s: unknown, max: number): string {
  const str = typeof s === 'string' ? s : ''
  return str.length > max ? str.slice(0, max) + '…' : str
}

// Peer free text is no longer UI-text-node-only: the routing directory feeds
// it into the MAIN AGENT'S DECISION CONTEXT (capability routing), so it is a
// standing prompt-injection surface. Neutralize security-framing tags (same
// scrubber as the message wrappers), drop control characters, and collapse
// newlines -- a summary must never be able to fake a </untrusted> close or
// smuggle heading-shaped instruction lines into the catalog.
// The three security-wrap tags share the STRIPPED_SENTINEL via
// scrubSecurityTags; <channel> is NOT in that set (wrapChannelInbound must
// preserve the envelope), but a peer summary must never smuggle a forged
// live-user <channel> delivery frame into the routing context, so neutralize
// it here too. Local, federation-specific -- does not touch the wrappers.
//
// Only the OPENER is a pattern (`<channel`, `</channel`, spaces and any case, then a non-word character):
// the old `<\s*\/?\s*channel\b[^>]*>` searched the rest of the text again from every opener that had no
// '>' after it, quadratic on a manifest field of openers (a peer body may be MANIFEST_MAX_BODY_BYTES, so one
// field can be ~512 kB: ~15 s of event loop). The '>' is looked up once by tagOpenings and reused. A tag whose
// '>' is missing or more than TAG_SPAN_MAX characters away is replaced by its opener alone, so no forged
// `<channel` frame can survive in a manifest string (the old rule left an unterminated opener untouched).
const CHANNEL_OPENER_RX = /<(?:\s*\/)?\s*channel\b/gi

function neutralizeChannelFrames(s: string): string {
  let out = ''
  let copied = 0 // s[0, copied) is already in `out`
  for (const o of tagOpenings(s, CHANNEL_OPENER_RX)) {
    if (o.start < copied) continue // inside a tag that was already replaced
    out += s.slice(copied, o.start) + '[channel]'
    copied = o.tagEnd !== -1 ? o.tagEnd : o.openerEnd
  }
  return out + s.slice(copied)
}

/** Same result as s.replace(/[ \t]*\n[ \t]*\/g, ' '), in one pass. The pattern searched a whole run of spaces and
 *  tabs again from every position of the run when no newline ended it: a manifest field of 550 kB of spaces took
 *  minutes. Each space or tab is looked at once here. */
function collapseNewlines(s: string): string {
  let out = ''
  let i = 0 // s[0, i) is already in `out`
  for (;;) {
    const nl = s.indexOf('\n', i)
    if (nl === -1) break
    let from = nl // the spaces and tabs before the newline belong to the match, but not those a previous match used
    while (from > i && (s[from - 1] === ' ' || s[from - 1] === '\t')) from--
    let to = nl + 1
    while (to < s.length && (s[to] === ' ' || s[to] === '\t')) to++
    out += s.slice(i, from) + ' '
    i = to
  }
  return out + s.slice(i)
}

export function cleanPeerText(s: unknown, max: number): string {
  const raw = typeof s === 'string' ? s : ''
  // Scrub BEFORE truncating: the sentinel is longer than the tags it
  // replaces, so the cap must be applied last to stay a real bound (and a
  // truncation-split half-tag no longer parses as a tag anyway). Collapse
  // ALL vertical whitespace (not just \n) -- U+0085/U+2028/U+2029 would
  // otherwise reintroduce heading-shaped instruction lines the routing agent
  // could read as structure.
  const scrubbed = neutralizeChannelFrames(scrubSecurityTags(raw))
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u0085\u2028\u2029]/g, ' ')
  return truncate(collapseNewlines(scrubbed), max)
}

/** Structural validation + hard caps on a peer-supplied manifest. Never
 *  trust counts or string sizes from the wire. */
export function sanitizeManifest(raw: unknown, expectedSystem: string): PeerManifest | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'manifest is not an object'
  const m = raw as Record<string, unknown>
  const system = truncate(m.system, MAX_SHORT_FIELD)
  if (!system) return 'manifest has no system id'
  // Case-insensitive: system ids are stored lowercase on OUR side, but the
  // peer reports its own (possibly pre-normalization) systemId verbatim.
  if (system.toLowerCase() !== expectedSystem.toLowerCase()) return `system mismatch: peer reports '${system}'`
  const agentsRaw = Array.isArray(m.agents) ? m.agents : []
  const skillsRaw = Array.isArray(m.skills) ? m.skills : []
  const agents = agentsRaw.slice(0, MANIFEST_MAX_AGENTS).flatMap((a) => {
    if (a === null || typeof a !== 'object') return []
    const o = a as Record<string, unknown>
    // SECURITY: the agent id becomes part of a "<peer>/<id>" qualified name
    // that the dashboard renders into a data-agent ATTRIBUTE. A peer-supplied
    // id with a quote would break out (escapeHtml does not encode quotes).
    // Charset-validate it exactly like an inbound `from` id -- drop, never
    // truncate-and-trust. Free-text fields go through cleanPeerText: they are
    // rendered as UI text nodes AND fed to the routing agent's context.
    if (typeof o.id !== 'string' || !isValidIdSegment(o.id)) return []
    const summary = cleanPeerText(o.capabilitySummary, MANIFEST_MAX_SUMMARY)
    return [{
      id: o.id,
      displayName: cleanPeerText(o.displayName, MAX_SHORT_FIELD) || o.id,
      model: cleanPeerText(o.model, MAX_SHORT_FIELD),
      ...(summary ? { capabilitySummary: summary } : {}),
    }]
  })
  const skills = skillsRaw.slice(0, MANIFEST_MAX_SKILLS).flatMap((s) => {
    if (s === null || typeof s !== 'object') return []
    const o = s as Record<string, unknown>
    const name = cleanPeerText(o.name, MAX_SHORT_FIELD)
    if (!name) return []
    return [{ agent: truncate(o.agent, MAX_SHORT_FIELD), name, description: cleanPeerText(o.description, MAX_DESCRIPTION) }]
  })
  return {
    system,
    marveenVersion: truncate(m.marveenVersion, MAX_SHORT_FIELD) || 'unknown',
    federationVersion: typeof m.federationVersion === 'number' ? m.federationVersion : 0,
    agents,
    skills,
  }
}

async function pollOnePeer(peer: FederationPeer, now: number, fetchImpl: typeof fetch): Promise<void> {
  const prev = statusCache.get(peer.id)
  const base: PeerStatus = {
    id: peer.id,
    baseUrl: peer.baseUrl,
    state: 'unknown',
    lastChecked: now,
    lastOkAt: prev?.lastOkAt ?? 0,
    manifest: prev?.manifest,
  }

  if (!peer.outboundToken || peer.outboundToken.length < FEDERATION_MIN_TOKEN_LENGTH) {
    statusCache.set(peer.id, { ...base, state: 'unpaired', error: 'pairing incomplete: no outbound token' })
    return
  }

  let res: Response
  try {
    res = await fetchImpl(`${peer.baseUrl}/api/federation/manifest`, {
      headers: { Authorization: `Bearer ${peer.outboundToken}` },
      signal: AbortSignal.timeout(FEDERATION_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    statusCache.set(peer.id, { ...base, state: 'unreachable', error: truncate(String(err), MAX_DESCRIPTION) })
    return
  }

  if (res.status === 401 || res.status === 403) {
    // 401: the peer's gate refused our token -- federation disabled there OR
    // the token was rotated; the wire cannot distinguish the two. (A 403
    // could only come from a handler variant; treat it the same.)
    try { await res.body?.cancel() } catch { /* ignore */ }
    statusCache.set(peer.id, { ...base, state: 'auth-or-disabled', error: `peer answered ${res.status}` })
    return
  }
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* ignore */ }
    statusCache.set(peer.id, { ...base, state: 'error', error: `peer answered ${res.status}` })
    return
  }

  let body: string
  try {
    body = await readBoundedBody(res, MANIFEST_MAX_BODY_BYTES)
  } catch (err) {
    const msg = err instanceof PeerResponseTooLargeError ? 'manifest too large' : truncate(String(err), MAX_DESCRIPTION)
    statusCache.set(peer.id, { ...base, state: 'error', error: msg })
    return
  }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { statusCache.set(peer.id, { ...base, state: 'error', error: 'manifest is not JSON' }); return }
  const manifest = sanitizeManifest(parsed, peer.id)
  if (typeof manifest === 'string') {
    statusCache.set(peer.id, { ...base, state: 'error', error: manifest })
    return
  }
  statusCache.set(peer.id, { ...base, state: 'ok', lastOkAt: now, manifest })
}

/** One poll round over the configured peers. Pure-ish tick: takes `now` and
 *  an injectable fetch, mutates only the module cache. A disabled config
 *  clears the cache and does no network (this is what makes enable/disable
 *  take effect without a restart). */
export async function pollPeerManifests(now: number, fetchImpl: typeof fetch = fetch): Promise<PeerStatus[]> {
  const cfg = getFederationConfig()
  if (!cfg.enabled) {
    statusCache.clear()
    return []
  }
  // Drop cache entries for peers no longer configured (removed/renamed).
  const ids = new Set(cfg.peers.map((p) => p.id))
  for (const key of [...statusCache.keys()]) {
    if (!ids.has(key)) statusCache.delete(key)
  }
  for (const peer of cfg.peers) {
    try {
      await pollOnePeer(peer, now, fetchImpl)
    } catch (err) {
      // Belt: one broken peer must never abort the round.
      logger.warn({ err, peer: peer.id }, 'federation poller: unexpected error')
      const prev = statusCache.get(peer.id)
      statusCache.set(peer.id, {
        id: peer.id, baseUrl: peer.baseUrl, state: 'error', lastChecked: now,
        lastOkAt: prev?.lastOkAt ?? 0, manifest: prev?.manifest, error: 'internal poll error',
      })
    }
  }
  return getFederationStatus()
}

/** Single-flight refresh shared by the interval tick and the manual refresh
 *  endpoint -- the two must never run concurrently. */
export function refreshFederationStatus(fetchImpl: typeof fetch = fetch): Promise<PeerStatus[]> {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = (async () => {
    try {
      return await pollPeerManifests(Date.now(), fetchImpl)
    } finally {
      inflightRefresh = null
    }
  })()
  return inflightRefresh
}

/** Cache view for GET /api/federation/status: config order, 'unknown' rows
 *  for not-yet-polled peers so the UI always sees every configured peer. */
export function getFederationStatus(): PeerStatus[] {
  const cfg = getFederationConfig()
  return cfg.peers.map((peer) => statusCache.get(peer.id) ?? {
    id: peer.id,
    baseUrl: peer.baseUrl,
    state: (!peer.outboundToken ? 'unpaired' : 'unknown') as PeerPollState,
    lastChecked: 0,
    lastOkAt: 0,
  })
}

/** Production reset (peer removal / full removal). */
export function resetFederationPollerCache(peerId?: string): void {
  if (peerId === undefined) statusCache.clear()
  else statusCache.delete(peerId)
}

export function startFederationPoller(): NodeJS.Timeout {
  const run = systemJob('federation-poller', () => { refreshFederationStatus().catch(() => {}) })
  setTimeout(run, FEDERATION_POLL_INITIAL_DELAY_MS).unref()
  return setInterval(run, FEDERATION_POLL_INTERVAL_MS)
}
