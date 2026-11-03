// LOG_TO_STDERR=1 sends the shared logger to stderr (a command-line tool whose stdout is its result);
// without it the logger keeps writing to stdout as before (the dashboard service splits the two streams
// into separate files, so the default must not move). Run in a child process: the destination is chosen
// when src/logger.ts loads.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

function probe(env: Record<string, string>) {
  const r = spawnSync(TSX, ['-e', "import('./src/logger.ts').then((m) => { m.logger.info({ field: 1 }, 'probe-line') })"], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, LOG_TO_STDERR: '', ...env },
  })
  expect(r.status, r.stderr).toBe(0)
  return { out: r.stdout.includes('probe-line'), err: r.stderr.includes('probe-line') }
}

describe('logger destination', () => {
  it.each(['production', 'development'])('LOG_TO_STDERR=1 writes to stderr only (NODE_ENV=%s)', (nodeEnv) => {
    expect(probe({ NODE_ENV: nodeEnv, LOG_TO_STDERR: '1' })).toEqual({ out: false, err: true })
  })

  it.each(['production', 'development'])('unset keeps stdout (NODE_ENV=%s)', (nodeEnv) => {
    expect(probe({ NODE_ENV: nodeEnv })).toEqual({ out: true, err: false })
  })

  it('a value other than 1 keeps stdout', () => {
    expect(probe({ NODE_ENV: 'production', LOG_TO_STDERR: 'true' })).toEqual({ out: true, err: false })
  })
})
