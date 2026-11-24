// The startup backfill of the quarantine-reader agent file. ensureQuarantineReader reads the egress allowlist through
// the db facade, so it is asynchronous, and startWebServer (which hands back the server) cannot await it. This runs
// behind the synchronous hook registration loop instead. It writes only <agent>/.claude/agents/quarantine-reader.md,
// never a settings.json, so it does not depend on what that loop registered. A failure is logged per agent and
// never reaches the caller: the server comes up either way.

import { logger } from '../logger.js'
import { runAs } from '../db/context.js'

// A boot step with no request around it: it opens its own system job. The allowlist read inside `ensure` is a tenant
// table; an empty context sees no row, so the file would be rendered from an EMPTY allowlist and written over the good one.
export async function backfillQuarantineReaders(
  agentNames: readonly string[],
  ensure: (agentName: string) => Promise<boolean>,
): Promise<void> {
  await runAs.system('boot-sequence', async () => {
    for (const agentName of agentNames) {
      try {
        await ensure(agentName)
      } catch (err) {
        logger.warn({ err, agent: agentName }, 'Quarantine reader backfill skipped')
      }
    }
  })
}
