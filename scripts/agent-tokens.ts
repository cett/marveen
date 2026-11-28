#!/usr/bin/env tsx
// Per-agent API token administration (operator, on the machine that hosts the install).
//
//   npm run agent-tokens -- issue [--rotate] [--dry-run] [<agent>...]   # default: the main agent and every agent
//   npm run agent-tokens -- issue-operator [--rotate]
//   npm run agent-tokens -- rotate-shared                               # new shared dashboard token; refuses when DASHBOARD_TOKEN is set
//   npm run agent-tokens -- check [<agent>...]                          # read-only; exit 1 if any file is not ok
//   npm run agent-tokens -- list
//   npm run agent-tokens -- revoke <agent>
//
// It talks to the database of this install directly (SQLite, or PostgreSQL when MARVEEN_PG_URL is set), so it works with the
// dashboard stopped. The token files are written 0600 next to each agent's files; this command prints the agent, what
// happened and the FILE, never a token.
//
// This file is a thin entry: the body (the commands, the boot, the system job, the exit code) is src/agent-tokens/cli.ts.
// The config snapshot is loaded first, before the body is imported, because config.ts reads it at import on PostgreSQL. When
// the script runs through scripts/with-config.ts the runner has loaded it already and this call is a no-op (the load runs
// once per process).
import './lib/log-to-stderr.js'
import { ensureConfigSnapshot } from '../src/config-bootstrap.js'

try {
  await ensureConfigSnapshot()
} catch (err) {
  // a failed snapshot load is a failed run: one line on stderr, exit 1, no stack for the operator
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
const { runAgentTokensCli } = await import('../src/agent-tokens/cli.js')
process.exit(await runAgentTokensCli(process.argv.slice(2)))
