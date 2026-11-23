// The runner for the scripts that load config.ts (scripts/with-config.ts), as a child process (tsx). Its contract:
//  (a) an unknown name is refused with exit 2 and a usage line (the runner is not a general loader);
//  (b) a PostgreSQL URL with no server: the snapshot step fails before the script is imported, so the failure names the
//      snapshot step and not ConfigSnapshotMissingError (the script's import would have evaluated config.ts first);
//  (c) no PostgreSQL URL: the snapshot step is skipped and the script runs (dashboard-url, a read-only command on the scratch
//      store, prints the dashboard address and exits 0).
// Privacy: the password is a placeholder; the cells check that it does not reach the output.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const RUNNER = join(ROOT, 'scripts', 'with-config.ts')
const PASSWORD = 'placeholder-password-c5'
const UNREACHABLE = `postgres://user:${PASSWORD}@127.0.0.1:1/marveen`

function run(pgUrl: string, args: string[]): { status: number | null; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'carl-with-config-'))
  mkdirSync(join(scratch, 'store'))
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MARVEEN_STORE_DIR: join(scratch, 'store'),
      CLAUDECLAW_ENV_DIR: join(scratch, 'envdir'),
    }
    if (pgUrl === '') delete env['MARVEEN_PG_URL']
    else env['MARVEEN_PG_URL'] = pgUrl
    const r = spawnSync(TSX, [RUNNER, ...args], {
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

describe('the script runner (scripts/with-config.ts), as a child process', () => {
  it('(a) an unknown name is refused with exit 2 and a usage line', () => {
    const { status, output } = run('', ['no-such-script'])
    expect(status).toBe(2)
    expect(output).toContain('usage: tsx scripts/with-config.ts')
  }, 120_000)

  it('(b) a PostgreSQL URL with no server: fails at the snapshot step, before the script is imported', () => {
    const { status, output } = run(UNREACHABLE, ['dashboard-url'])
    expect(status).not.toBe(0)
    expect(output).toContain('system_config snapshot could not be read')
    expect(output).not.toContain('ConfigSnapshotMissingError')
    expect(output).not.toContain(PASSWORD)
  }, 120_000)

  it('(c) no PostgreSQL URL: the snapshot step is skipped and the script runs (it talks to the dashboard, which is not up here)', () => {
    const { status, output } = run('', ['dashboard-url'])
    expect(status).not.toBe(2)
    expect(output).toContain('dashboard')
    expect(output).not.toContain('system_config snapshot')
  }, 120_000)

  // the argv contract: the script sees its own path as argv[1] (its entry guard runs) and its own arguments from argv[2]
  it('(d) argv[1] is the script: an entry-guarded script runs its body through the runner (guard output appears)', () => {
    const { output } = run('', ['migrate-legacy-store-docs'])
    expect(output).toContain('legacy .md files found')
  }, 120_000)

  it('(e) the script gets its own arguments, not the runner name: a script that dispatches on argv[2] is not refused as usage', () => {
    const { status, output } = run('', ['agent-tokens', 'archive-shared-age', join(tmpdir(), 'carl-no-such-archive-placeholder.db')])
    // agent-tokens prints its own 'Usage:' (exit 2) when argv[2] is not its command: that is what a missing shift produces
    expect(output).not.toContain('Usage:')
    expect(status).not.toBeNull()
  }, 120_000)
})
