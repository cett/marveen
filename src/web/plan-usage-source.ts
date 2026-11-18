import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import type { PlanSnapshot, SnapshotWindow } from '../claude-plan-health.js'
import { canonicalConfigDir, configDirHash } from './plan-config-hash.js'
import { readWindow } from './quota.js'

// Read side of the PER-PLAN rate-limit snapshot. The writer is
// scripts/statusline-ratelimit.sh: on every statusLine render it records the
// rate_limits block the CLI hands it, next to the legacy global file, in
// store/.claude-rate-limits.d/<configDirHash>.json (see plan-config-hash.ts).
// No token, no keychain, no network: the numbers come from the CLI's own
// response headers via the statusLine.
//
// This module turns one such file into the PlanSnapshot the pure classifier
// (claude-plan-health.ts) consumes, plus a `detail` saying WHY there is
// nothing when there is nothing. It never throws: a missing or odd file is an
// answer ('missing'), because the monitor must keep ticking.
//
// Attribution rules (the whole point of the per-plan file):
//   * The file is looked up by the hash of the plan's VALIDATED, symlink-
//     resolved configDir, never by text comparison.
//   * The record carries the config dir it was written for; it must equal the
//     plan's canonical dir, or the record is rejected (guards a misplaced file
//     or a hash collision from attributing another login's numbers to a plan).
//   * For any plan except the default (~/.claude) one, the record must say
//     config_dir_source = "env". A statusLine process that did NOT receive
//     CLAUDE_CONFIG_DIR falls back to the default dir and says so ("default");
//     such a record could belong to any session, so it never counts for a
//     non-default plan.

/** Directory holding one snapshot file per plan. */
export const PLAN_RATE_LIMITS_DIR = join(STORE_DIR, '.claude-rate-limits.d')

/** Above this many files in the snapshot directory the monitor logs ONE line
 *  (no dashboard warning). Every session writes a file for its own config
 *  dir, including each sub-agent's, so the directory grows with the fleet. */
export const PLAN_SNAPSHOT_FILE_NOTICE_THRESHOLD = 50

const SNAPSHOT_FILE_RE = /^[0-9a-f]{8}\.json$/

/** How many snapshot files the directory holds (0 when it does not exist).
 *  Only counts: the reader never lists or opens files that are not a
 *  registered plan's own, and nothing here deletes anything. */
export function countPlanSnapshotFiles(dir: string = PLAN_RATE_LIMITS_DIR): number {
  try {
    return readdirSync(dir).filter((f) => SNAPSHOT_FILE_RE.test(f)).length
  } catch {
    return 0
  }
}

/** A snapshot file is a few hundred bytes. Anything bigger is not ours. */
const MAX_SNAPSHOT_BYTES = 64 * 1024

export type PlanSnapshotDetail =
  | 'ok'
  | 'no-config-dir' // the plan's configDir has no canonical form (empty, relative, ~user)
  | 'no-file'
  | 'unreadable'
  | 'no-rate-limits'
  | 'no-written-at'
  | 'config-dir-mismatch'
  | 'not-env-sourced'

export interface PlanSnapshotRead {
  snapshot: PlanSnapshot
  detail: PlanSnapshotDetail
  /** Unix seconds the statusLine wrote the record, null when unknown. */
  writtenAt: number | null
}

const missing = (detail: PlanSnapshotDetail, writtenAt: number | null = null): PlanSnapshotRead => ({
  snapshot: { kind: 'missing' },
  detail,
  writtenAt,
})

/** One window of the record -> SnapshotWindow. Absent (null/undefined) stays
 *  null; PRESENT but unparsable becomes a NaN window so the classifier marks
 *  the whole snapshot unknown instead of silently skipping it into "ok". */
function toSnapshotWindow(raw: unknown, nowSec: number): SnapshotWindow | null {
  if (raw === null || raw === undefined) return null
  const w = readWindow(raw, nowSec)
  if (!w) return { usedPercent: Number.NaN, resetsAt: null }
  return { usedPercent: w.usedPercentage, resetsAt: w.resetsAt }
}

export function readPlanSnapshot(
  plan: { configDir: string },
  nowSec: number = Math.floor(Date.now() / 1000),
  opts: { dir?: string; home?: string } = {},
): PlanSnapshotRead {
  const dir = opts.dir ?? PLAN_RATE_LIMITS_DIR
  const home = opts.home ?? homedir()

  const canonical = canonicalConfigDir(plan.configDir, home)
  const hash = configDirHash(plan.configDir, home)
  if (canonical === null || hash === null) return missing('no-config-dir')

  const file = join(dir, `${hash}.json`)
  let parsed: unknown
  try {
    if (statSync(file).size > MAX_SNAPSHOT_BYTES) return missing('unreadable')
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return missing(code === 'ENOENT' ? 'no-file' : 'unreadable')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return missing('unreadable')

  const rec = parsed as {
    written_at?: unknown
    config_dir?: unknown
    config_dir_source?: unknown
    rate_limits?: unknown
  }

  if (rec.config_dir !== canonical) return missing('config-dir-mismatch')

  const defaultDir = canonicalConfigDir(join(home, '.claude'), home)
  const isDefaultPlan = defaultDir !== null && canonical === defaultDir
  if (!isDefaultPlan && rec.config_dir_source !== 'env') return missing('not-env-sourced')

  const rl = rec.rate_limits
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return missing('no-rate-limits')
  const rlObj = rl as Record<string, unknown>
  const five = toSnapshotWindow(rlObj.five_hour, nowSec)
  const seven = toSnapshotWindow(rlObj.seven_day, nowSec)
  if (!five && !seven) return missing('no-rate-limits')

  // Unlike the dashboard strip, a record without a usable timestamp is not
  // read as "age 0": a number of unknown age must never look fresh.
  const writtenAt =
    typeof rec.written_at === 'number' && Number.isFinite(rec.written_at) && rec.written_at > 0
      ? rec.written_at
      : null
  if (writtenAt === null) return missing('no-written-at')

  return {
    snapshot: {
      kind: 'snapshot',
      // Not clamped to 0: a record from the future must reach the classifier,
      // which refuses it beyond a small skew.
      ageSec: nowSec - writtenAt,
      windows: { five_hour: five, seven_day: seven },
    },
    detail: 'ok',
    writtenAt,
  }
}
