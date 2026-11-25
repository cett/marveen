// Full-boot sandbox: an opt-in switch that runs the whole main() boot (message router, schedule runner, watchers,
// runners, timers, startWebServer with its background services) inside an isolated instance. It exists for the
// supervised first full boot on PostgreSQL: the isolated mode returns right after startWebServer with WEB_ONLY=true,
// so none of the runners ever ran on the database under test.
//
// The switch is an env var, so it is never on in production, and it refuses to start unless the instance is
// isolated, not on the live dashboard port, and its PROJECT_ROOT is a temporary checkout (a git worktree or a temp
// dir), so the boot can only write into that checkout. Refusals are listed, not silently ignored: the caller throws.
// Isolated mode still skips the port lock and takeover; the sandbox does not turn those back on.

import { isAbsolute, resolve } from 'node:path'

export const FULL_BOOT_SANDBOX_ENV = 'MARVEEN_SANDBOX_FULL_BOOT'
// The live dashboard port (the production default of WEB_PORT). The sandbox must never bind it: a second process on it
// would be the live dashboard's port, and the port lock that protects it is off in isolated mode.
export const LIVE_DASHBOARD_PORT = 3420

export function fullBootSandboxRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FULL_BOOT_SANDBOX_ENV] === 'true'
}

export interface FullBootSandboxFacts {
  // IS_ISOLATED_MODE: MARVEEN_STORE_DIR is set.
  isolated: boolean
  // WEB_PORT.
  webPort: number
  // isWorktreeRoot(PROJECT_ROOT) || isTemporaryRoot(PROJECT_ROOT): the checkout is transient, so the boot writes only there.
  projectRootIsTemporary: boolean
  // RESPAWN_ENABLED set to 0 or false in the env file (not the default). The respawn runners (channel monitor, reauth
  // healer) restart pollers on the bot tokens; with the default on, a sandbox would fight the live fleet for them (409).
  respawnExplicitlyOff: boolean
  // process.env.TMUX_TMPDIR (undefined when unset) and whether process.env.TMUX is set (the process runs inside a tmux
  // client). tmux names its sessions per socket: a sandbox tmux on the default socket (the parent dir /tmp or /private/tmp)
  // would share the agent-<name> sessions with the live fleet.
  tmuxTmpDir: string | undefined
  tmuxEnvSet: boolean
}

// The reasons the sandbox must refuse to start. An empty list means the sandbox may start.
export function fullBootSandboxRefusals(facts: FullBootSandboxFacts): string[] {
  const reasons: string[] = []
  if (!facts.isolated) {
    reasons.push('MARVEEN_STORE_DIR is not set: the sandbox runs only on an isolated store')
  }
  if (facts.webPort === LIVE_DASHBOARD_PORT) {
    reasons.push(`WEB_PORT is ${LIVE_DASHBOARD_PORT}, the live dashboard port`)
  }
  if (!facts.projectRootIsTemporary) {
    reasons.push('PROJECT_ROOT is neither a git worktree checkout nor a temp dir: the boot would write its agent files in place')
  }
  if (!facts.respawnExplicitlyOff) {
    reasons.push('RESPAWN_ENABLED is not explicitly off (0 or false in the env file): the respawn runners would restart the live bot pollers')
  }
  if (!tmuxDirIsPrivate(facts.tmuxTmpDir, facts.tmuxEnvSet)) {
    reasons.push('TMUX_TMPDIR is unset, relative or the default socket parent (/tmp, /private/tmp), or TMUX is set: the sandbox tmux would share the live fleet sessions')
  }
  return reasons
}

// The default tmux socket parents: a TMUX_TMPDIR equal to one of them is the live fleet's socket directory.
const DEFAULT_TMUX_SOCKET_PARENTS = ['/tmp', '/private/tmp', '/']

// True when TMUX_TMPDIR is an absolute path that is not a default socket parent, and the process is not inside a tmux
// client (TMUX unset). The short-path requirement of the unix socket is the caller's concern (the probe picks the dir).
export function tmuxDirIsPrivate(tmuxTmpDir: string | undefined, tmuxEnvSet: boolean): boolean {
  if (tmuxEnvSet) return false
  if (!tmuxTmpDir || !isAbsolute(tmuxTmpDir)) return false
  return !DEFAULT_TMUX_SOCKET_PARENTS.includes(resolve(tmuxTmpDir))
}
