// Structural proof that a read-then-write function of the db layer runs as ONE transaction.
//
// A select followed by a write is a race window when the two statements are separate facade calls: a
// concurrent writer can slip in between. Counting `dbx.tx` alone is not enough -- a function can open
// one transaction and still run its statements on `dbx` (outside the handle), so this also counts the
// plain facade calls made while the function runs. A correct function shows exactly one `tx` and zero
// plain calls; two separate guarded calls show as no `tx`, or as plain calls.

import { vi } from 'vitest'
import type { Dbx } from '../../db.js'

export interface FacadeCallCounts {
  /** Transactions opened through `dbx.tx`. */
  tx: number
  /** Statements run on `dbx` directly (get / all / run / exec), i.e. outside any transaction handle. */
  outsideTx: number
}

export async function countFacadeCalls(dbx: Dbx, run: () => Promise<unknown>): Promise<FacadeCallCounts> {
  const txSpy = vi.spyOn(dbx, 'tx')
  const plain = (['get', 'all', 'run', 'exec'] as const).map((m) => vi.spyOn(dbx, m))
  try {
    await run()
    return { tx: txSpy.mock.calls.length, outsideTx: plain.reduce((n, s) => n + s.mock.calls.length, 0) }
  } finally {
    txSpy.mockRestore()
    for (const s of plain) s.mockRestore()
  }
}
