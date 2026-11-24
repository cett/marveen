// The one way to run the scripts that load config.ts (phase F1). Usage: tsx scripts/with-config.ts <name> [args...]
//
// config.ts evaluates its system_config overrides at import time, so on a PostgreSQL install the snapshot must be set before
// a script is imported. This runner does that: it loads the snapshot (ensureConfigSnapshot, a no-op on SQLite), then imports
// the named script, which sees its own name and its arguments as if it had been run directly.
//
// The name must be one of the scripts below: the runner is not a general loader. The database access of each script is
// unchanged by this runner (SQLite until the cutover).
//
// dashboard-user is NOT here, on purpose: it is an admin command, and the auth-admin gate of the hooks matches the command
// line that names the script directly. Routing it through this runner would let the gate pass a command it refuses. It keeps
// its direct npm script and refuses on a PostgreSQL install until the cutover.
import { ensureConfigSnapshot } from '../src/config-bootstrap.js'

const SCRIPTS = [
  'setup',
  'status',
  'remote-access-enroll',
  'dashboard-url',
  'agent-tokens',
  'install-seed-tenant',
  'budget-alert-check',
  'claude-plan-rotate-check',
  'materialize-skills',
  'migrate-legacy-store-docs',
  'migrate-schedules-to-db',
  'migrate-sqlite-to-pg',
  'regen-skills',
  'eval/recall-eval',
  'eval/recall-eval-run',
  'eval/recall-eval-pg',
] as const

const name = process.argv[2]
if (name === undefined || !(SCRIPTS as readonly string[]).includes(name)) {
  console.error(`usage: tsx scripts/with-config.ts <${SCRIPTS.join('|')}> [args]`)
  process.exit(2)
}

// the script sees its own path as argv[1] and its own arguments from argv[2], as when it is run directly
process.argv.splice(2, 1)
process.argv[1] = new URL(`./${name}.ts`, import.meta.url).pathname
// A command whose stdout is a JSON report sends its log lines to stderr. The logger reads this at import, so it is set here,
// before the script is imported (nothing on the static import path of this file loads the logger).
if (name === 'migrate-sqlite-to-pg') process.env['LOG_TO_STDERR'] ??= '1'

await ensureConfigSnapshot()
await import(`./${name}.ts`)
