#!/usr/bin/env tsx
// Install-time seed: points the 'default' tenant's main_agent_id at the
// just-installed MAIN_AGENT_ID (and, optionally, overrides its display_name).
//
// Without this, tenants.main_agent_id stays NULL after a fresh install (see
// migration 0043) until an operator sets it by hand, so the Agents screen has
// no tenant-main-agent badge to show from first boot.
//
// Invoked from install.sh/install-macos.sh/install-linux.sh, after `npm run
// build` and before the launchd/systemd units start: this call itself runs
// the DB migrations (initDatabase()), so the schema is guaranteed to exist
// first. Safe to run again on every install/update -- both fields are always
// overwritten to the current values, never merged.
//
//   tsx scripts/install-seed-tenant.ts --main-agent-id <id> [--display-name <name>]

import { initDatabase, getTenant, updateTenant } from '../src/db.js'

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1 || idx === process.argv.length - 1) return undefined
  return process.argv[idx + 1]
}

function usage(): never {
  process.stderr.write('Usage: install-seed-tenant --main-agent-id <id> [--display-name <name>]\n')
  process.exit(2)
}

function main(): void {
  const mainAgentId = arg('main-agent-id')
  if (!mainAgentId) usage()
  const displayName = arg('display-name')?.trim()

  initDatabase()

  const existing = getTenant('default')
  if (!existing) {
    process.stderr.write("install-seed-tenant: 'default' tenant not found -- did migrations run?\n")
    process.exit(1)
  }

  const patch: { main_agent_id: string; display_name?: string } = { main_agent_id: mainAgentId }
  if (displayName) patch.display_name = displayName

  updateTenant('default', patch)
  process.stdout.write(
    `install-seed-tenant: default tenant main_agent_id=${mainAgentId}` +
      (patch.display_name ? ` display_name="${patch.display_name}"` : '') +
      '\n',
  )
}

main()
