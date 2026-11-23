// The channel coordinator's launched entry (src/channel-coordinator.ts, the bootstrap) as a real child process (tsx):
// launchd runs the compiled entry with KeepAlive, so a boot failure is a crash loop. Two cells on the process, plus a weak
// source pin (the bootstrap names the body in a dynamic import, never a static one).
//  (a) a PostgreSQL URL that refuses the connection: the bootstrap fails at the snapshot step, before the body is imported:
//      the message names the snapshot step, not ConfigSnapshotMissingError, and the body never reaches its token check;
//  (b) no PostgreSQL URL: the snapshot step is skipped and the body runs (it reaches its token check, which fails in the
//      scratch state directory on purpose), so the entry starts as before.
// Privacy: the password is a placeholder; the cells check that it does not reach the output.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PASSWORD = 'placeholder-password-c3'
// port 1 on the loopback: nothing listens there, so the connection is refused at once
const UNREACHABLE = `postgres://user:${PASSWORD}@127.0.0.1:1/marveen`

function runEntry(pgUrl: string): { status: number | null; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'carl-coord-entry-'))
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MARVEEN_STORE_DIR: join(scratch, 'store'),
      COORDINATOR_STATE_DIR: join(scratch, 'state'),
      CLAUDECLAW_ENV_DIR: join(scratch, 'envdir'),
      TELEGRAM_BOT_TOKEN: '',
    }
    if (pgUrl === '') delete env['MARVEEN_PG_URL']
    else env['MARVEEN_PG_URL'] = pgUrl
    const r = spawnSync(TSX, [join(ROOT, 'src/channel-coordinator.ts')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      env: env as NodeJS.ProcessEnv,
    })
    return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe('the channel coordinator entry, as a child process', () => {
  it('(a) a PostgreSQL URL with no server: fails at the snapshot step, before the body (no ConfigSnapshotMissingError, no password)', () => {
    const { status, output } = runEntry(UNREACHABLE)
    expect(status).not.toBe(0)
    expect(output).toContain('system_config snapshot')
    expect(output).not.toContain('ConfigSnapshotMissingError')
    expect(output).not.toContain('TELEGRAM_BOT_TOKEN not found')
    expect(output).not.toContain(PASSWORD)
  }, 120_000)

  it('(b) no PostgreSQL URL: the snapshot step is skipped and the body runs (it reaches its token check)', () => {
    const { status, output } = runEntry('')
    expect(status).not.toBe(0)
    expect(output).toContain('channel-coordinator: crashed')
    expect(output).toContain('TELEGRAM_BOT_TOKEN not found')
    expect(output).not.toContain('system_config snapshot')
  }, 120_000)

  it('source pin (weak by design): the bootstrap loads the body with a dynamic import and never a static one', () => {
    const src = readFileSync(join(ROOT, 'src/channel-coordinator.ts'), 'utf8')
    expect(src).toContain("await import('./channel-coordinator-main.js')")
    expect(src).not.toContain("from './channel-coordinator-main.js'")
    expect(src).not.toContain("from './config.js'")
  })
})
