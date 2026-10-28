// Tokens per card: what the assignee agent spent while the card was in_progress.
//
// The windows come from kanban_card_events (a move into 'in_progress' opens one, the next move out of it
// closes it; an open window runs until `now`), not from updated_at, which any comment or subcard write bumps.
//
// The honest limit: an agent that has two cards in_progress at once spends ONE stream of tokens, and nothing
// in the transcript says which card a call was for. The total is therefore an upper bound, and
// `overlappingCards` says how many other cards of the same agent were in_progress during the windows. No
// split is invented.

import {
  getKanbanCard, getKanbanCardEvents, listOtherCardIdsWithProgressEvents,
  sumTokenUsageByModel, getLastTokenUsageTimestamp,
} from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'

export interface CardWindow { from: number; to: number }

export interface CardStatusEvent { from_status: string | null; to_status: string; created_at: number }

/** in_progress windows from a card's status events (oldest first). Pure. */
export function inProgressWindows(events: CardStatusEvent[], now: number): CardWindow[] {
  const windows: CardWindow[] = []
  let openedAt: number | null = null
  for (const ev of events) {
    if (ev.to_status === 'in_progress') {
      if (openedAt === null) openedAt = ev.created_at
    } else if (openedAt !== null) {
      windows.push({ from: openedAt, to: ev.created_at })
      openedAt = null
    }
  }
  if (openedAt !== null) windows.push({ from: openedAt, to: now })
  return windows
}

export interface CardTokenModelRow {
  model: string | null
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface CardTokenUsage {
  /** The token_usage agent the assignee resolved to, or null (human, unassigned). */
  agent: string | null
  windows: CardWindow[]
  totalCalls: number
  /** input + output + cache read + cache creation. */
  totalTokens: number
  outputTokens: number
  /** input + cache creation: what was newly read in, as opposed to re-read from cache. */
  freshInputTokens: number
  cacheReadTokens: number
  perModel: CardTokenModelRow[]
  /** Other cards of the same agent that were in_progress at some point of the windows. */
  overlappingCards: number
  /** Latest collected token row of this agent: rows after it are not in the sum yet. */
  dataUntil: number | null
  /**
   * True when a window starts before the raw token log is kept (TOKEN_USAGE_RETENTION_DAYS): the rows of
   * that part were rolled up and deleted, so the sums are incomplete there and a zero is not a measurement.
   */
  dataExpired: boolean
  /** The retention in days the check used, or null when the setting is not a usable number. */
  retentionDays: number | null
}

/** Map a card assignee onto the token_usage agent name (lowercase id). */
export function tokenAgentForAssignee(
  assignee: string | null | undefined,
  opts: { botName: string; mainAgentId: string },
): string | null {
  const a = (assignee ?? '').trim().toLowerCase()
  if (!a) return null
  if (a === opts.botName.toLowerCase()) return opts.mainAgentId.toLowerCase()
  return a
}

/** The raw token log retention in days, or null when the setting is not a positive number. */
function rawRetentionDays(): number | null {
  const n = Number(getEffectiveSettingValue('TOKEN_USAGE_RETENTION_DAYS'))
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function getCardTokenUsage(
  cardId: string,
  opts: { botName: string; mainAgentId: string; now?: number; retentionDays?: number | null },
): Promise<CardTokenUsage | null> {
  const card = await getKanbanCard(cardId)
  if (!card) return null
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const agent = tokenAgentForAssignee(card.assignee, opts)
  const windows = inProgressWindows(await getKanbanCardEvents(cardId), now)
  // The prune keeps rows with timestamp >= now - retention; a window that starts before that has lost rows.
  const retentionDays = opts.retentionDays !== undefined ? opts.retentionDays : rawRetentionDays()
  const dataExpired = retentionDays !== null && windows.some((w) => w.from < now - retentionDays * 86400)
  const empty: CardTokenUsage = {
    agent, windows, totalCalls: 0, totalTokens: 0, outputTokens: 0, freshInputTokens: 0, cacheReadTokens: 0, perModel: [], overlappingCards: 0, dataUntil: null,
    dataExpired, retentionDays,
  }
  if (!agent) return empty
  empty.dataUntil = getLastTokenUsageTimestamp(agent)
  if (windows.length === 0) return empty

  const byModel = new Map<string, CardTokenModelRow>()
  for (const w of windows) {
    for (const r of sumTokenUsageByModel(agent, w.from, w.to)) {
      const key = r.model ?? ''
      const acc = byModel.get(key)
      if (!acc) { byModel.set(key, { ...r }); continue }
      acc.calls += r.calls
      acc.inputTokens += r.inputTokens
      acc.outputTokens += r.outputTokens
      acc.cacheReadTokens += r.cacheReadTokens
      acc.cacheCreationTokens += r.cacheCreationTokens
    }
  }
  // A model row with no tokens at all (the transcript's '<synthetic>' entries) is noise here.
  const perModel = [...byModel.values()]
    .filter((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens > 0)
    .sort((a, b) => b.outputTokens - a.outputTokens)
  const totalCalls = perModel.reduce((s, r) => s + r.calls, 0)
  const outputTokens = perModel.reduce((s, r) => s + r.outputTokens, 0)
  const freshInputTokens = perModel.reduce((s, r) => s + r.inputTokens + r.cacheCreationTokens, 0)
  const cacheReadTokens = perModel.reduce((s, r) => s + r.cacheReadTokens, 0)
  const totalTokens = perModel.reduce(
    (s, r) => s + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens, 0)

  // Overlap: the agent's other cards and their own in_progress windows.
  const names = [agent]
  if (agent === opts.mainAgentId.toLowerCase()) names.push(opts.botName.toLowerCase())
  let overlappingCards = 0
  for (const otherId of await listOtherCardIdsWithProgressEvents(cardId, names)) {
    const ow = inProgressWindows(await getKanbanCardEvents(otherId), now)
    if (ow.some((x) => windows.some((w) => x.from < w.to && w.from < x.to))) overlappingCards++
  }

  return {
    agent, windows, totalCalls, totalTokens, outputTokens, freshInputTokens, cacheReadTokens, perModel,
    overlappingCards, dataUntil: empty.dataUntil, dataExpired, retentionDays,
  }
}
