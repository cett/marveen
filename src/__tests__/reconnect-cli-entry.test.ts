// The reconnect child (src/web/reconnect-cli.ts, the bootstrap) as a real child process (tsx). The health monitor spawns it
// detached with its stdio ignored, so a boot failure must leave its trace in the store log, not on the console.
//  (a) a PostgreSQL URL with no server: the child exits non-zero, and store/channels.log gets one line that names the step
//      and the reason, without the URL or the password;
//  (b) no PostgreSQL URL: the snapshot step is skipped and the body runs (its own log line appears); the agent name is one
//      that has no tmux session, so no pane is touched;
//  (c) a missing agent name keeps its exit code 2.
// Privacy: the password is a placeholder; the cells check that it does not reach the output or the log.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PASSWORD = 'placeholder-password-c4'
const UNREACHABLE = `postgres://user:${PASSWORD}@127.0.0.1:1/marveen`
const AGENT = 'carl-reconnect-probe-agent'

function runChild(pgUrl: string, args: string[]): { status: number | null; output: string; channelsLog: string; logMode: number | undefined } {
  const scratch = mkdtempSync(join(tmpdir(), 'carl-reconnect-entry-'))
  const store = join(scratch, 'store')
  mkdirSync(store)
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MARVEEN_STORE_DIR: store,
      CLAUDECLAW_ENV_DIR: join(scratch, 'envdir'),
    }
    if (pgUrl === '') delete env['MARVEEN_PG_URL']
    else env['MARVEEN_PG_URL'] = pgUrl
    const r = spawnSync(TSX, [join(ROOT, 'src/web/reconnect-cli.ts'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      env: env as NodeJS.ProcessEnv,
    })
    const logPath = join(store, 'channels.log')
    return {
      status: r.status,
      output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
      channelsLog: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
      logMode: existsSync(logPath) ? statSync(logPath).mode & 0o777 : undefined,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe('the reconnect child, as a child process', () => {
  it('(a) a PostgreSQL URL with no server: exits non-zero and leaves one line in channels.log (step and reason, no URL)', () => {
    const { status, output, channelsLog } = runChild(UNREACHABLE, [AGENT])
    expect(status).not.toBe(0)
    expect(channelsLog).toContain(`reconnect-cli ${AGENT}: snapshot step failed, no reconnect run`)
    expect(channelsLog).toContain('system_config snapshot could not be read')
    expect(channelsLog).not.toContain(PASSWORD)
    expect(output).not.toContain('ConfigSnapshotMissingError')
    expect(output).not.toContain(PASSWORD)
  }, 120_000)

  it('(b) no PostgreSQL URL: the snapshot step is skipped and the body runs (its own log line appears)', () => {
    const { output, channelsLog } = runChild('', [AGENT])
    expect(output).toContain('reconnect-cli: reconnect attempt')
    expect(channelsLog).not.toContain('snapshot step failed')
  }, 120_000)

  it('(a2) the log line is private (mode 0600) and one line, even when the agent name carries a line break', () => {
    const { channelsLog, logMode } = runChild(UNREACHABLE, [`${AGENT}\nforged-line`])
    expect(logMode).toBe(0o600)
    const lines = channelsLog.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('forged-line')
  }, 120_000)

  it('(c) a missing agent name keeps its exit code 2', () => {
    const { status } = runChild('', [])
    expect(status).toBe(2)
  }, 120_000)

  it('source pin (weak by design): the bootstrap loads the body with a dynamic import and never a static one', () => {
    const src = readFileSync(join(ROOT, 'src/web/reconnect-cli.ts'), 'utf8')
    expect(src).toContain("await import('./reconnect-cli-main.js')")
    expect(src).not.toContain("from '../config.js'")
    expect(src).not.toContain("from './channel-mcp-reconnect.js'")
  })

  it('the monitor still spawns the same path (the bootstrap is the launched file)', () => {
    const monitor = readFileSync(join(ROOT, 'src/web/channel-health-monitor.ts'), 'utf8')
    expect(monitor).toContain("new URL('./reconnect-cli.js', import.meta.url)")
    expect(readdirSync(join(ROOT, 'src/web')).includes('reconnect-cli-main.ts')).toBe(true)
  })
})
