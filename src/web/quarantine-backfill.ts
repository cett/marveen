// The startup backfill of the quarantine-reader agent file. ensureQuarantineReader reads the egress allowlist through
// the db facade, so it is asynchronous, and startWebServer (which hands back the server) cannot await it. This runs
// behind the synchronous hook registration loop instead. It writes only <agent>/.claude/agents/quarantine-reader.md,
// never a settings.json, so it does not depend on what that loop registered. A failure is logged per agent and
// never reaches the caller: the server comes up either way.

import { logger } from '../logger.js'

export async function backfillQuarantineReaders(
  agentNames: readonly string[],
  ensure: (agentName: string) => Promise<boolean>,
): Promise<void> {
  for (const agentName of agentNames) {
    try {
      await ensure(agentName)
    } catch (err) {
      logger.warn({ err, agent: agentName }, 'Quarantine reader backfill skipped')
    }
  }
}
