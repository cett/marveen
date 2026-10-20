// 2026-10-20 20:28: the main channels restart was `launchctl unload`, a sleep, `launchctl load`, each with a 5 s
// timeout. The unload waits for the job's slow TERM trap, threw ETIMEDOUT, the load never ran and the job stayed
// unregistered for days. The restart is now one `kickstart -k` (a `bootstrap` for an orphan) with the registration
// checked afterwards. launchctl is injected here, so every branch runs without a launchd.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { restartLaunchdJob, isLaunchdJobRegistered, LAUNCHD_RESTART_TIMEOUT_MS, type LaunchdExec } from '../web/launchd-job-restart.js'

const LABEL = 'com.test.channels'
const PLIST = '/tmp/launch-agents/com.test.channels.plist'
const UID = 501

function timeoutError(): Error {
  return Object.assign(new Error('spawnSync /bin/launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' })
}

/** A fake launchctl: `list` reports `registered`, anything else is run by `onCall` (which may throw). */
function fake(state: { registered: boolean }, onCall: (args: string[], state: { registered: boolean }) => void) {
  const calls: Array<{ args: string[]; timeoutMs: number }> = []
  const exec: LaunchdExec = (args, timeoutMs) => {
    calls.push({ args, timeoutMs })
    if (args[0] === 'list') {
      if (!state.registered) throw new Error('Could not find service')
      return
    }
    onCall(args, state)
  }
  return { exec, calls, verbs: () => calls.map((c) => c.args[0]) }
}

describe('restartLaunchdJob', () => {
  it('a registered job is restarted with ONE kickstart -k on its gui domain, never unload or load', () => {
    const f = fake({ registered: true }, () => { /* kickstart succeeds */ })
    const r = restartLaunchdJob({ label: LABEL, plist: PLIST, uid: UID, exec: f.exec })
    expect(r).toEqual({ ok: true, via: 'kickstart' })
    const kick = f.calls.find((c) => c.args[0] === 'kickstart')!
    expect(kick.args).toEqual(['kickstart', '-k', `gui/${UID}/${LABEL}`])
    expect(kick.timeoutMs).toBe(LAUNCHD_RESTART_TIMEOUT_MS)
    expect(f.verbs()).not.toContain('unload')
    expect(f.verbs()).not.toContain('load')
  })

  it('an orphaned job (plist on disk, not registered) is bootstrapped from the plist', () => {
    const f = fake({ registered: false }, (args, st) => { if (args[0] === 'bootstrap') st.registered = true })
    const r = restartLaunchdJob({ label: LABEL, plist: PLIST, uid: UID, exec: f.exec })
    expect(r).toEqual({ ok: true, via: 'bootstrap' })
    expect(f.calls.find((c) => c.args[0] === 'bootstrap')!.args).toEqual(['bootstrap', `gui/${UID}`, PLIST])
    expect(f.verbs()).not.toContain('kickstart')
  })

  it('the TIMEOUT branch: kickstart ETIMEDOUT with the job still registered is not an orphan and is not retried with unload/load', () => {
    const f = fake({ registered: true }, (args) => { if (args[0] === 'kickstart') throw timeoutError() })
    const r = restartLaunchdJob({ label: LABEL, plist: PLIST, uid: UID, exec: f.exec })
    expect(r).toMatchObject({ ok: false, via: 'kickstart', registered: true, timedOut: true })
    expect(f.verbs()).not.toContain('unload')
    expect(f.verbs()).not.toContain('load')
    expect(f.verbs().filter((v) => v === 'kickstart')).toHaveLength(1)
  })

  it('the failure the incident left behind: a timeout that ends with the job unregistered is reported as unregistered', () => {
    const f = fake({ registered: true }, (args, st) => { if (args[0] === 'kickstart') { st.registered = false; throw timeoutError() } })
    const r = restartLaunchdJob({ label: LABEL, plist: PLIST, uid: UID, exec: f.exec })
    expect(r).toMatchObject({ ok: false, registered: false, timedOut: true })
  })

  it('a bootstrap that returns but leaves the job unregistered is a failure, not a success', () => {
    const f = fake({ registered: false }, () => { /* bootstrap "succeeds" and registers nothing */ })
    const r = restartLaunchdJob({ label: LABEL, plist: PLIST, uid: UID, exec: f.exec })
    expect(r).toMatchObject({ ok: false, via: 'bootstrap', registered: false, timedOut: false })
    expect((r as { error: string }).error).toContain('not registered')
  })

  it('a kickstart that fails for another reason with the job registered is neither a timeout nor an orphan', () => {
    const f = fake({ registered: true }, (args) => { if (args[0] === 'kickstart') throw new Error('Command failed: launchctl kickstart\nOperation not permitted') })
    const r = restartLaunchdJob({ label: LABEL, plist: PLIST, uid: UID, exec: f.exec })
    expect(r).toMatchObject({ ok: false, registered: true, timedOut: false, error: 'Command failed: launchctl kickstart' })
  })

  it('a kickstart that returns while the registration check then fails is not reported as success', () => {
    const f = fake({ registered: true }, (args, st) => { if (args[0] === 'kickstart') st.registered = false })
    const r = restartLaunchdJob({ label: LABEL, plist: PLIST, uid: UID, exec: f.exec })
    expect(r).toMatchObject({ ok: false, registered: false })
  })
})

describe('isLaunchdJobRegistered', () => {
  it('is launchctl list exiting 0, with the short probe timeout', () => {
    const f = fake({ registered: true }, () => undefined)
    expect(isLaunchdJobRegistered(LABEL, f.exec)).toBe(true)
    expect(f.calls[0]).toEqual({ args: ['list', LABEL], timeoutMs: 2000 })
    expect(isLaunchdJobRegistered(LABEL, fake({ registered: false }, () => undefined).exec)).toBe(false)
  })
})

// hardRestartMarveenChannels is I/O heavy (tmux, launchd, the filesystem), so its wiring is pinned at source level,
// the idiom of main-restart-platform.test.ts: one launchd helper, no unload/load, a loud alert for an unregistered
// job, and no respawn-pane race on a timeout with the job still registered.
describe('hardRestartMarveenChannels wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
  const start = src.indexOf('export function hardRestartMarveenChannels')
  const body = src.slice(start, src.indexOf('\n}\n', start))

  it('restarts through restartLaunchdJob and no longer unloads or loads the plist', () => {
    expect(body).toContain('restartLaunchdJob(')
    expect(body).not.toMatch(/'unload'|'load'/)
    expect(body).not.toContain("'/bin/sleep'")
  })

  it('raises the loud alert for an unregistered job and rate-limits it', () => {
    expect(body).toMatch(/if \(!r\.registered\) \{[\s\S]*alertLaunchdJobUnregistered\(/)
    expect(src).toMatch(/function alertLaunchdJobUnregistered[\s\S]*sendAlert\(/)
    expect(src).toMatch(/if \(now - lastUnregisteredAlertAt < UNREGISTERED_ALERT_COOLDOWN_MS\) return\n\s*lastUnregisteredAlertAt = now\n\s*sendAlert\(/)
  })

  it('a timeout with the job still registered returns without a respawn-pane race', () => {
    const timeoutBranch = body.slice(body.indexOf('} else if (r.timedOut) {'), body.indexOf('} else {', body.indexOf('} else if (r.timedOut) {')))
    expect(timeoutBranch).toContain('return { ok: false')
    expect(timeoutBranch).not.toContain('respawnMarveenSessionFresh')
  })

  it('uses the same kickstart target form as the auto-restart runner (gui/<uid>/<label>)', () => {
    const runner = readFileSync(join(__dirname, '..', 'web', 'auto-restart-runner.ts'), 'utf-8')
    expect(runner).toContain("'kickstart', '-k', `gui/${uid}/com.${SERVICE_ID}.channels`")
    expect(readFileSync(join(__dirname, '..', 'web', 'launchd-job-restart.ts'), 'utf-8')).toContain("'kickstart', '-k', `${domain}/${label}`")
  })
})
