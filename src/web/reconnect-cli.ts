// Standalone entry so the channel health monitor can run the (deliberately
// synchronous, tmux-driven) MCP reconnect OFF the dashboard's main event loop.
//
// Root cause it fixes: attemptChannelMcpReconnect() walks the interactive /mcp
// tmux menu with execFileSync('/bin/sleep', ...) pacing. Run inline from the
// 60s health-monitor timer, that sequence BLOCKS the libuv event loop for the
// full tmux+sleep duration; with several agents in '✘ failed' state the loop is
// starved continuously and the dashboard accepts TCP connections but never
// services HTTP requests (observed 2026-06-30: deaf for hours, 0% CPU, stuck in
// node::SyncProcessRunner::Spawn under uv__run_timers). Spawning this CLI
// detached keeps the blocking work in a throwaway child process.
//
// Usage: node dist/web/reconnect-cli.js <agentName>
//
// This file is the bootstrap of that child. The monitor spawns it detached with its stdio ignored, so a failure here
// leaves no trace on the console: the bootstrap loads the system_config snapshot on a PostgreSQL install BEFORE the body
// (reconnect-cli-main.ts) is imported, and when that step fails it appends one line to store/channels.log (the step and the
// reason, never the URL) and exits non-zero.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureConfigSnapshot } from '../config-bootstrap.js'
import { STORE_DIR } from '../paths.js'

const agentName = process.argv[2]
if (!agentName) {
  // eslint-disable-next-line no-console
  console.error('reconnect-cli: missing agentName argument')
  process.exit(2)
}

// one line per failure, with control characters replaced: the agent name and the reason come from outside this process
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ')

let body: typeof import('./reconnect-cli-main.js')
try {
  await ensureConfigSnapshot()
  body = await import('./reconnect-cli-main.js')
} catch (err) {
  const reason = oneLine(err instanceof Error ? err.message : 'unknown error')
  try {
    appendFileSync(join(STORE_DIR, 'channels.log'),
      `${new Date().toISOString()} reconnect-cli ${oneLine(agentName)}: snapshot step failed, no reconnect run (${reason})\n`,
      { mode: 0o600 })
  } catch { /* no store to write to: the exit code is the signal */ }
  process.exit(1)
}
body.run(agentName)
