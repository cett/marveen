import type { HookAuditLogEntry } from './db.js'

// Validation-counter gate for context watchdog phase 4 (retiring
// context-compact-monitor.sh): Jonas asked for 10 successful watchdog
// cycles observed before that decision is even on the table. A cycle
// starts when scripts/hooks/context-watchdog.py fires a HANDOFF (logged as
// a hook_audit_log row: hook_type='PostToolUse', verdict='handoff', reason
// carrying 'ctx=NN%;interlock=yes|no') and is judged against
// context-compact-monitor.sh's own audit rows (hook_type='PreCompact',
// verdict='allow', written only when it actually sends a real /compact --
// see record_compact_audit() there).
//
// A cycle is:
//   - 'interlock_failed' if the watchdog's own state-file stamp didn't
//     land (interlock=no in its reason) -- the compact-monitor was never
//     actually gated, so this cycle proves nothing either way.
//   - 'pending' if less than cooldownSecs has elapsed since the handoff --
//     too early to know whether the monitor respected the interlock.
//   - 'double_compact' if a PreCompact/allow row for the same agent lands
//     strictly after the handoff and within cooldownSecs of it -- the
//     interlock did NOT prevent the heartbeat from also compacting.
//   - 'success' otherwise: interlock landed, and no compact fired inside
//     the window it was supposed to suppress.

export const DEFAULT_COOLDOWN_SECS = 45 * 60 // matches context-compact-monitor.sh's COOLDOWN_S
export const DEFAULT_VALIDATION_TARGET = 10

export type WatchdogCycleStatus = 'success' | 'double_compact' | 'interlock_failed' | 'pending'

export interface WatchdogCycle {
  ts: number
  agent_id: string | null
  tool_name: string | null
  pct: number | null
  interlock: boolean | null
  status: WatchdogCycleStatus
}

export interface WatchdogValidationResult {
  successful: number
  target: number
  ready: boolean
  totalHandoffs: number
  cycles: WatchdogCycle[]
}

const REASON_RE = /ctx=(\d+)%;interlock=(yes|no)/

function parseHandoffReason(reason: string | null): { pct: number | null; interlock: boolean | null } {
  if (!reason) return { pct: null, interlock: null }
  const m = REASON_RE.exec(reason)
  if (!m) return { pct: null, interlock: null }
  return { pct: Number(m[1]) / 100, interlock: m[2] === 'yes' }
}

/**
 * Pure function over already-fetched hook_audit_log rows (no DB access) --
 * fetch with `listHookAuditLog({ agent_id, sinceSecs, limit })` (unfiltered
 * by verdict, so both 'handoff' and PreCompact/'allow' rows come back) and
 * pass the result here.
 */
export function computeWatchdogCycles(
  rows: HookAuditLogEntry[],
  opts: { agentId: string; nowSecs: number; cooldownSecs?: number; target?: number },
): WatchdogValidationResult {
  const cooldownSecs = opts.cooldownSecs ?? DEFAULT_COOLDOWN_SECS
  const target = opts.target ?? DEFAULT_VALIDATION_TARGET

  const handoffs = rows
    .filter(r => r.agent_id === opts.agentId && r.hook_type === 'PostToolUse' && r.verdict === 'handoff')
    .sort((a, b) => a.ts - b.ts)
  const compacts = rows
    .filter(r => r.agent_id === opts.agentId && r.hook_type === 'PreCompact' && r.verdict === 'allow')
    .map(r => r.ts)
    .sort((a, b) => a - b)

  const cycles: WatchdogCycle[] = handoffs.map(h => {
    const { pct, interlock } = parseHandoffReason(h.reason)
    let status: WatchdogCycleStatus
    if (interlock !== true) {
      status = 'interlock_failed'
    } else {
      const windowEnd = h.ts + cooldownSecs
      if (opts.nowSecs < windowEnd) {
        status = 'pending'
      } else {
        // >= h.ts, not strictly >: at 1-second timestamp resolution a
        // same-second compact and handoff can't be reliably ordered, and
        // treating that as "not a double" would be an optimistic guess --
        // fail conservative instead.
        const doubleCompact = compacts.some(ts => ts >= h.ts && ts <= windowEnd)
        status = doubleCompact ? 'double_compact' : 'success'
      }
    }
    return { ts: h.ts, agent_id: h.agent_id, tool_name: h.tool_name, pct, interlock, status }
  })

  const successful = cycles.filter(c => c.status === 'success').length

  return {
    successful,
    target,
    ready: successful >= target,
    totalHandoffs: handoffs.length,
    cycles,
  }
}
