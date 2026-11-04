// The work that must finish BEFORE the database is closed when the process gets SIGTERM.
//
// index.ts's shutdown() closes the database; a SIGTERM listener registered later (as startWebServer once did for
// the desired-state flush) ran after that close and wrote into a closed handle. With the db writes asynchronous
// the flush also needs an await, so the shutdown path runs these hooks itself and closes the database after
// them. A hook that throws or does not finish within the budget is logged and given up on: it is best effort,
// and it must never keep the process from exiting.

import { logger } from '../logger.js'

const hooks: Array<{ name: string; run: () => Promise<void> }> = []

/** Register a flush to run on SIGTERM, before the database closes. Returns a function that removes it. */
export function registerSigtermFlush(name: string, run: () => Promise<void>): () => void {
  const entry = { name, run }
  hooks.push(entry)
  return () => {
    const i = hooks.indexOf(entry)
    if (i !== -1) hooks.splice(i, 1)
  }
}

/** Run every registered flush (one after the other) within `budgetMs` in total. Never rejects. */
export async function runSigtermFlushes(budgetMs: number): Promise<void> {
  if (hooks.length === 0) return
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), budgetMs) })
  const all = (async () => {
    for (const hook of [...hooks]) {
      try {
        await hook.run()
      } catch (err) {
        logger.warn({ err, hook: hook.name }, 'SIGTERM flush failed')
      }
    }
    return 'done' as const
  })()
  const outcome = await Promise.race([all, deadline])
  if (timer) clearTimeout(timer)
  if (outcome === 'timeout') logger.warn({ budgetMs }, 'SIGTERM flush did not finish within its budget; closing the database anyway')
}
