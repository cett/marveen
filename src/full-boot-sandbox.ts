// Full-boot sandbox: an opt-in switch that runs the whole main() boot (message router, schedule runner, watchers,
// runners, timers, startWebServer with its background services) inside an isolated instance. It exists for the
// supervised first full boot on PostgreSQL: the isolated mode returns right after startWebServer with WEB_ONLY=true,
// so none of the runners ever ran on the database under test.
//
// The switch is an env var, so it is never on in production, and it refuses to start unless the instance is
// isolated, not on the live dashboard port, and its PROJECT_ROOT is a temporary checkout (a git worktree or a temp
// dir), so the boot can only write into that checkout. Refusals are listed, not silently ignored: the caller throws.
// Isolated mode still skips the port lock and takeover; the sandbox does not turn those back on.

export const FULL_BOOT_SANDBOX_ENV = 'MARVEEN_SANDBOX_FULL_BOOT'
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
  return reasons
}
