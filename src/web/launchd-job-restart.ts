// Restart of the main channels launchd job, as one launchctl call that cannot leave the job unloaded.
//
// The old shape was `launchctl unload`, a 2 s sleep, `launchctl load`, each with a 5 s timeout. The unload makes
// launchd send SIGTERM and wait for the job's TERM trap (channels.sh), which can take longer than 5 s; the
// unload then threw ETIMEDOUT, the `load` never ran, and the job stayed unregistered (an orphan) until somebody
// loaded it by hand. That repeated for days (2026-10-20 20:28).
//
// `launchctl kickstart -k gui/<uid>/<label>` kills the running instance and starts it again inside launchd, so
// the job stays registered whatever the TERM trap does. A job that is NOT registered (an orphan from earlier) is
// bootstrapped from its plist instead. Either way the registration is checked afterwards: a job that is still
// not registered is reported to the caller, who raises a loud alert.
//
// The launchctl call is injected so the timeout and orphan branches are tested without a launchd.

export const LAUNCHD_RESTART_TIMEOUT_MS = 10_000
export const LAUNCHD_PROBE_TIMEOUT_MS = 2_000

export type LaunchdExec = (args: string[], timeoutMs: number) => void

export type LaunchdRestartResult =
  | { ok: true; via: 'kickstart' | 'bootstrap' }
  | {
      ok: false
      via: 'kickstart' | 'bootstrap'
      /** The job is registered with launchd after the attempt. False = orphaned: nothing will start it. */
      registered: boolean
      /** The launchctl call timed out. With the job still registered launchd is finishing the restart itself. */
      timedOut: boolean
      error: string
    }

function isTimeout(err: unknown): boolean {
  // execFileSync reports its own timeout as code ETIMEDOUT (and kills the child with SIGTERM).
  return (err as { code?: unknown } | null)?.code === 'ETIMEDOUT'
}

function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0].slice(0, 200)
}

export function isLaunchdJobRegistered(label: string, exec: LaunchdExec): boolean {
  try {
    exec(['list', label], LAUNCHD_PROBE_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

export function restartLaunchdJob(opts: { label: string; plist: string; uid: number; exec: LaunchdExec }): LaunchdRestartResult {
  const { label, plist, uid, exec } = opts
  const domain = `gui/${uid}`
  const wasRegistered = isLaunchdJobRegistered(label, exec)
  const via = wasRegistered ? 'kickstart' : 'bootstrap'
  let failure: unknown = null
  try {
    if (wasRegistered) exec(['kickstart', '-k', `${domain}/${label}`], LAUNCHD_RESTART_TIMEOUT_MS)
    else exec(['bootstrap', domain, plist], LAUNCHD_RESTART_TIMEOUT_MS)
  } catch (err) {
    failure = err
  }
  const registered = isLaunchdJobRegistered(label, exec)
  if (failure === null && registered) return { ok: true, via }
  return {
    ok: false,
    via,
    registered,
    timedOut: failure !== null && isTimeout(failure),
    error: failure !== null ? reason(failure) : `launchctl ${via} returned but the job is not registered`,
  }
}
