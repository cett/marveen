// Fire-time snapshot + reference delivery for large scheduled-task
// bodies. Tests the pure filename round-trip, the pure retention decision,
// and the real fs write/sweep behavior against a scratch directory (never
// STORE_DIR itself).
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSnapshotFilename,
  parseSnapshotFilename,
  selectSnapshotsToDelete,
  writeScheduledRunSnapshot,
  sweepScheduledRunSnapshots,
  SNAPSHOT_RETENTION_MS,
  SNAPSHOT_RETENTION_KEEP_PER_TASK,
} from '../web/scheduled-run-snapshot.js'

describe('buildSnapshotFilename / parseSnapshotFilename round-trip', () => {
  it('recovers the task name from a filename it built', () => {
    const d = new Date('2026-09-21T14:30:05.000Z')
    const filename = buildSnapshotFilename('morning-briefing', d, 'ab12')
    const parsed = parseSnapshotFilename(filename)
    expect(parsed?.taskName).toBe('morning-briefing')
  })

  it('sanitizes an unsafe task name to filesystem-safe characters', () => {
    const filename = buildSnapshotFilename('weird/../name with spaces', new Date(), 'ab12')
    expect(filename).not.toMatch(/[/\\ ]/)
  })

  it('returns null for a filename that does not match the produced shape', () => {
    expect(parseSnapshotFilename('not-a-snapshot.txt')).toBeNull()
    expect(parseSnapshotFilename('.hidden')).toBeNull()
  })
})

describe('selectSnapshotsToDelete (pure retention decision)', () => {
  const now = 1_700_000_000_000
  const DAY = 24 * 60 * 60 * 1000

  it('keeps everything within the retention window', () => {
    const entries = [
      { filePath: 'a', taskName: 't', mtimeMs: now - DAY },
      { filePath: 'b', taskName: 't', mtimeMs: now - 6 * DAY },
    ]
    expect(selectSnapshotsToDelete(entries, now)).toEqual([])
  })

  it('deletes an old file beyond the per-task keep-count even if just past retention', () => {
    // 25 snapshots for one task, all 8 days old (past the 7-day cutoff) --
    // only the oldest 5 (25 - 20 kept) should be marked for deletion.
    const entries = Array.from({ length: 25 }, (_, i) => ({
      filePath: `f${i}`,
      taskName: 'noisy-task',
      mtimeMs: now - 8 * DAY - i * 1000, // strictly decreasing -> f0 newest
    }))
    const toDelete = selectSnapshotsToDelete(entries, now)
    expect(toDelete).toHaveLength(25 - SNAPSHOT_RETENTION_KEEP_PER_TASK)
    // The kept ones must be the 20 newest (lowest index).
    for (const kept of entries.slice(0, SNAPSHOT_RETENTION_KEEP_PER_TASK)) {
      expect(toDelete).not.toContain(kept.filePath)
    }
  })

  it('never deletes a recent file even past the per-task keep-count', () => {
    // 25 snapshots for one task, all FRESH (within retention) -- none deleted,
    // a quiet task's only recent evidence must survive regardless of count.
    const entries = Array.from({ length: 25 }, (_, i) => ({
      filePath: `f${i}`,
      taskName: 'quiet-task',
      mtimeMs: now - i * 1000,
    }))
    expect(selectSnapshotsToDelete(entries, now)).toEqual([])
  })

  it('respects an explicit retentionMs/keepPerTask override', () => {
    const entries = [{ filePath: 'a', taskName: 't', mtimeMs: now - 1000 }]
    expect(selectSnapshotsToDelete(entries, now, { retentionMs: 500, keepPerTask: 0 })).toEqual(['a'])
  })

  it('defaults match the documented policy (7 days / 20 per task)', () => {
    expect(SNAPSHOT_RETENTION_MS).toBe(7 * DAY)
    expect(SNAPSHOT_RETENTION_KEEP_PER_TASK).toBe(20)
  })
})

describe('writeScheduledRunSnapshot / sweepScheduledRunSnapshots (real fs, scratch dir)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scheduled-run-snapshot-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a snapshot file containing the (scrubbed) body and returns its path/sha256/chars', () => {
    const snap = writeScheduledRunSnapshot('my-task', 'hello world body', { dir })
    expect(snap).not.toBeNull()
    expect(existsSync(snap!.filePath)).toBe(true)
    const content = readFileSync(snap!.filePath, 'utf-8')
    expect(content).toContain('hello world body')
    expect(content).toContain('scheduled-run task=my-task')
    // Regression guard: declared sha256/chars must describe the FULL written
    // file (header + body), not just the body -- a header-only delta here
    // means a consumer verifying file integrity against the declared values
    // will always see a mismatch.
    expect(snap!.chars).toBe(content.length)
    expect(snap!.chars).not.toBe('hello world body'.length)
    expect(snap!.sha256).toBe(createHash('sha256').update(content).digest('hex'))
  })

  it('writes the file with 0600 permissions', () => {
    const snap = writeScheduledRunSnapshot('perm-task', 'body', { dir })
    const mode = statSync(snap!.filePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('sweep deletes the oldest file past retention while keeping the most recent 20 per task', () => {
    // One fresh snapshot + 20 old ones (backdated past the 7-day cutoff) for
    // the same task = 21 total. Keeping the 20 newest by mtime means exactly
    // the single oldest one crosses the keep-count AND is past retention.
    const fresh = writeScheduledRunSnapshot('sweep-task', 'fresh body', { dir })!
    const old: string[] = []
    for (let i = 0; i < 20; i++) {
      const snap = writeScheduledRunSnapshot('sweep-task', `old body ${i}`, { dir })!
      const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000 - i * 1000) / 1000
      utimesSync(snap.filePath, eightDaysAgo, eightDaysAgo)
      old.push(snap.filePath)
    }
    const deleted = sweepScheduledRunSnapshots(dir)
    expect(deleted).toEqual([old[old.length - 1]]) // the single oldest (i=19) is the only one past the keep-20 boundary
    expect(existsSync(fresh.filePath)).toBe(true) // the fresh one always survives (newest mtime)
  })

  it('is a no-op (empty array, no throw) when the directory does not exist', () => {
    expect(sweepScheduledRunSnapshots(join(dir, 'does-not-exist'))).toEqual([])
  })

  it('leaves foreign (non-matching) files in the directory alone', () => {
    const foreignPath = join(dir, 'README.md')
    writeFileSync(foreignPath, 'not a snapshot')
    sweepScheduledRunSnapshots(dir)
    expect(existsSync(foreignPath)).toBe(true)
  })
})
