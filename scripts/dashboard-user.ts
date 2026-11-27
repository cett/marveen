#!/usr/bin/env tsx
// Dashboard browser-login user administration (break-glass + scripting).
//
//   npm run dashboard-user -- add <username> [--password-stdin]
//   npm run dashboard-user -- reset-password <username> [--password-stdin]
//   npm run dashboard-user -- list
//   npm run dashboard-user -- remove <username>
//   npm run dashboard-user -- sessions:clear [<username>]
//   npm run dashboard-user -- security:reset
//
// THIS IS THE BREAK-GLASS PATH: it reaches the database of this install directly (SQLite, or PostgreSQL when MARVEEN_PG_URL
// is set), with no HTTP and no auth gate, so it works even when the web login is misconfigured or unreachable. The operator
// can always run commands on the machine hosting the install, so "I can run this CLI" is the root credential.
//
// security:reset is the panic lever: it revokes EVERY device key and clears EVERY browser session in one step (future
// login-enforcement toggles will be cleared here too). Passwords and users are untouched; the bearer token keeps working.
// See docs/user-guide/en/18-profile.md ("Authentication recovery").
//
// This file is a thin entry: the body (the commands, the boot, the system job, the exit code) is src/dashboard-user/cli.ts.
// The config snapshot is loaded first, before the body is imported, because config.ts reads it at import on PostgreSQL.
// Passwords are read interactively (twice, muted) or from stdin with --password-stdin for automation.
import './lib/log-to-stderr.js'
import { ensureConfigSnapshot } from '../src/config-bootstrap.js'

try {
  await ensureConfigSnapshot()
} catch (err) {
  // a failed snapshot load is a failed run: one line on stderr, exit 1, no stack for the operator
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
const { runDashboardUserCli } = await import('../src/dashboard-user/cli.js')
process.exit(await runDashboardUserCli(process.argv.slice(2)))
