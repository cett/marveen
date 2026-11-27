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

/** The spool file of an agent: the same name the hook writes (scripts/hooks/ledger_lib.py `_spool_path`: every character that is not a letter, a digit, `-` or `_` becomes `_`). */
export function spoolFileNameFor(agentId: string): string {
  return `${agentId.replace(/[^\p{L}\p{N}_-]/gu, '_')}.jsonl`
}

/** Insert every spooled turn (idempotent) and delete the files. Returns the
 *  number of rows inserted. A file is claimed by renaming it first, so a hook
 *  appending at the same moment starts a fresh file instead of losing lines. */
export async function flushLedgerSpool(dir = ledgerSpoolDir()): Promise<number> {
  if (!existsSync(dir)) return 0
  let inserted = 0
  let foreign = 0
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
        // The flush has no token to tell whose turn a line is, so the file is the identity: the hook writes the turns of ONE agent to
        // <that agent>.jsonl. A line naming another agent is not written. The route refuses the same thing (a fleet token may only
        // act as its own agent); without this, anything that can write into the spool directory could store a turn for any agent.
        if (spoolFileNameFor(turn.agent_id) !== name) {
          foreign++
          continue
        }
        if (await logLedgerTurn(turn)) inserted++
      }
      unlinkSync(claimed)
    } catch (err) {
      logger.warn({ err, file: name }, 'ledger spool flush failed, file kept for the next boot')
    }
  }
  if (foreign > 0) logger.warn({ foreign }, 'Ledger spool: lines that name another agent than their file were not stored')
  if (inserted > 0) logger.info({ inserted }, 'Ledger spool beolvasva')
  return inserted
}
