// The process boot as a real child process (tsx), against a PostgreSQL URL that refuses the connection. Two cells, both without
// the application's own dependencies running:
//  (a) the entry (src/index.ts): the bootstrap reads the snapshot before config.ts evaluates, so the failure is the connection
//      error (SQLSTATE or error code in the message, never the password), NOT ConfigSnapshotMissingError;
//  (b) the application body (src/main.ts) started directly: config.ts refuses (ConfigSnapshotMissingError), the stale launcher case.
// A static import of config.ts in the entry makes (a) fail with ConfigSnapshotMissingError: that is the mutant this pins.
// Privacy: the password is a placeholder; the cells check that it does not reach the output.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PASSWORD = 'placeholder-password-x7'
// port 1 on the loopback: nothing listens there, so the connection is refused at once
const UNREACHABLE = `postgres://user:${PASSWORD}@127.0.0.1:1/marveen`

function runEntry(entry: string): { status: number | null; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'carl-boot-spawn-'))
  mkdirSync(join(scratch, 'store'))
  mkdirSync(join(scratch, 'envdir'))
  try {
    const r = spawnSync(TSX, [join(ROOT, entry)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        MARVEEN_PG_URL: UNREACHABLE,
        MARVEEN_STORE_DIR: join(scratch, 'store'),
        CLAUDECLAW_ENV_DIR: join(scratch, 'envdir'),
      },
    })
    return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe('the process boot as a child process, against an unreachable PostgreSQL', () => {
  it('(a) the entry src/index.ts fails on the connection (the bootstrap reads the snapshot first), without the password', () => {
    const { status, output } = runEntry('src/index.ts')
    expect(status).not.toBe(0)
    expect(output).not.toContain('ConfigSnapshotMissingError')
    expect(output).toContain('system_config snapshot could not be read')
    expect(output).toContain('ECONNREFUSED')
    expect(output).not.toContain(PASSWORD)
  }, 120_000)

  it('(b) the application body src/main.ts started directly refuses with ConfigSnapshotMissingError (the stale launcher case)', () => {
    const { status, output } = runEntry('src/main.ts')
    expect(status).not.toBe(0)
    expect(output).toContain('ConfigSnapshotMissingError')
    expect(output).not.toContain(PASSWORD)
  }, 120_000)
})
