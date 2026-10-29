// Startup and on-demand report of the files an interrupted fleet import left behind.
//
// The import stages every file as `<path>.import-new` and copies a file it will replace to `<path>.import-bak`
// (see fleet-transfer.ts). A crash between staging and the rename leaves `.import-new` files (partial work);
// a crash after the commit but before a restore finished leaves a `.import-bak` (possibly the only copy of the
// previous content), and the next import refuses to run while one exists (409).
//
// This module only REPORTS. It never deletes, renames or writes anything: a backup can be the only copy, and
// removing a staged file is the operator's decision. The scan walks importTargetRoots() (the same list the
// import's writers are built from), is bounded in depth, result count and time, and never throws into the boot.

import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger.js'
import {
  BACKUP_SUFFIX,
  STAGE_SUFFIX,
  importTargetRoots,
  isImportApplyInProgress,
  type ImportTargetRoot,
} from './fleet-transfer.js'

export type LeftoverKind = 'orphan_new' | 'stale_bak'

export interface Leftover {
  path: string
  kind: LeftoverKind
  /** Last modification time, ISO 8601. */
  mtime: string
  ageSeconds: number
  /** What the operator can do about it. */
  action: string
}

export interface LeftoverScan {
  items: Leftover[]
  /** True when the scan stopped at a limit; the list is then incomplete. */
  truncated: boolean
  truncatedReason: 'max_results' | 'timeout' | null
  /** An apply was running: its own staged files are not leftovers, so nothing is reported. */
  importInProgress: boolean
  scannedAt: string
}

export interface LeftoverScanOptions {
  roots?: readonly ImportTargetRoot[]
  maxResults?: number
  timeoutMs?: number
  now?: () => number
}

export const DEFAULT_MAX_RESULTS = 500
export const DEFAULT_TIMEOUT_MS = 2000

// Trees that can be big and never hold staged import files.
const SKIPPED_DIRS = new Set(['node_modules', '.git'])

export function leftoverAction(kind: LeftoverKind, path: string): string {
  if (kind === 'stale_bak') {
    return (
      'A previous import was interrupted after its commit; this file is a copy of the ORIGINAL content. ' +
      `If the original should come back: cp "${path}" "${path.slice(0, -BACKUP_SUFFIX.length)}", then remove the backup by hand. ` +
      'Otherwise remove it by hand. While a .import-bak exists the next import is refused (409).'
    )
  }
  return (
    'A previous import was interrupted before its files were put in place; this is a partial staged copy and is not ' +
    'used by anything. Remove it by hand when no import is running.'
  )
}

function classify(name: string): LeftoverKind | null {
  if (name.endsWith(BACKUP_SUFFIX)) return 'stale_bak'
  if (name.endsWith(STAGE_SUFFIX)) return 'orphan_new'
  return null
}

class ScanStop extends Error {
  constructor(readonly reason: 'max_results' | 'timeout') {
    super(reason)
  }
}

/** Find the leftovers. Read-only; resolves with a (possibly truncated) list and does not throw for unreadable directories. */
export async function scanImportLeftovers(opts: LeftoverScanOptions = {}): Promise<LeftoverScan> {
  const now = opts.now ?? Date.now
  const startedAt = now()
  const scannedAt = new Date(startedAt).toISOString()
  if (isImportApplyInProgress()) {
    return { items: [], truncated: false, truncatedReason: null, importInProgress: true, scannedAt }
  }
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS
  const deadline = startedAt + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const roots = opts.roots ?? importTargetRoots()
  const items: Leftover[] = []
  const seen = new Set<string>()
  let stopped: 'max_results' | 'timeout' | null = null

  const expired = (): boolean => now() > deadline

  async function walk(dir: string, depth: number, maxDepth: number): Promise<void> {
    if (expired()) throw new ScanStop('timeout')
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // missing or unreadable: nothing staged there
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIPPED_DIRS.has(entry.name)) await walk(full, depth + 1, maxDepth)
        continue
      }
      const kind = classify(entry.name)
      if (!kind || seen.has(full)) continue
      seen.add(full)
      let mtimeMs: number
      try {
        mtimeMs = (await lstat(full)).mtimeMs
      } catch {
        continue // vanished between the listing and the stat
      }
      items.push({
        path: full,
        kind,
        mtime: new Date(mtimeMs).toISOString(),
        ageSeconds: Math.max(0, Math.round((now() - mtimeMs) / 1000)),
        action: leftoverAction(kind, full),
      })
      if (items.length >= maxResults) throw new ScanStop('max_results')
    }
  }

  try {
    for (const root of roots) await walk(root.dir, 1, root.maxDepth)
  } catch (err) {
    if (err instanceof ScanStop) stopped = err.reason
    else throw err
  }

  // An apply that started during the walk owns files that look like leftovers: report nothing rather than guess.
  if (isImportApplyInProgress()) {
    return { items: [], truncated: false, truncatedReason: null, importInProgress: true, scannedAt }
  }
  items.sort((a, b) => a.path.localeCompare(b.path))
  return { items, truncated: stopped !== null, truncatedReason: stopped, importInProgress: false, scannedAt }
}

/** One warn line per leftover and a summary line; nothing when the scan is clean. */
export function logImportLeftovers(scan: LeftoverScan): void {
  if (scan.truncated) {
    logger.warn({ reason: scan.truncatedReason, found: scan.items.length }, 'Fleet import leftover scan stopped at a limit; the list is incomplete')
  }
  if (scan.items.length === 0) return
  let orphans = 0
  let backups = 0
  for (const item of scan.items) {
    if (item.kind === 'orphan_new') orphans++
    else backups++
    logger.warn({ path: item.path, kind: item.kind, mtime: item.mtime, ageSeconds: item.ageSeconds }, item.action)
  }
  logger.warn({ orphans, staleBackups: backups }, `Fleet import leftovers: ${orphans} orphan, ${backups} stale backup (GET /api/fleet/import-leftovers lists them; nothing was deleted)`)
}

/** Boot hook: scan, log, never throw and never block the caller beyond the call itself (the scan is asynchronous). */
export async function runBootImportLeftoverScan(opts: LeftoverScanOptions = {}): Promise<void> {
  try {
    logImportLeftovers(await scanImportLeftovers(opts))
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Fleet import leftover scan failed (ignored)')
  }
}
