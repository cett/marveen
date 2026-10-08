import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logLedgerTurn } from './db.js'
import { logger } from './logger.js'
import { parseLedgerEntry } from './web/routes/conversation-ledger.js'

// The ledger hooks (scripts/hooks/ledger_lib.py) append a turn to
// store/.ledger-spool/<agent>.jsonl when the dashboard cannot be reached, and
// flush that file on their next successful call. A turn spooled right before
// the dashboard stopped is only picked up by a hook after the restart, so the
// dashboard also drains the directory itself at boot.

export function ledgerSpoolDir(): string {
  return join(STORE_DIR, '.ledger-spool')
}

/** Insert every spooled turn (idempotent) and delete the files. Returns the
 *  number of rows inserted. A file is claimed by renaming it first, so a hook
 *  appending at the same moment starts a fresh file instead of losing lines. */
export function flushLedgerSpool(dir = ledgerSpoolDir()): number {
  if (!existsSync(dir)) return 0
  let inserted = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const claimed = join(dir, `${name}.flushing`)
    try {
      renameSync(join(dir, name), claimed)
    } catch {
      continue
    }
    try {
      for (const line of readFileSync(claimed, 'utf-8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        let raw: unknown
        try { raw = JSON.parse(t) } catch { continue }
        const turn = parseLedgerEntry(raw)
        if (typeof turn === 'string') continue
        if (logLedgerTurn(turn)) inserted++
      }
      unlinkSync(claimed)
    } catch (err) {
      logger.warn({ err, file: name }, 'ledger spool flush failed, file kept for the next boot')
    }
  }
  if (inserted > 0) logger.info({ inserted }, 'Ledger spool beolvasva')
  return inserted
}
