// Guards for "the built-in Claude Code auto-updater is off in every local
// session". A fleet of sessions started together all update the one shared
// install at the same moment (npm-global: ENOTEMPTY on the package-dir rename);
// the single lock-guarded claude-update task is the only updater. Source-level
// on purpose, like headless-session-no-reader.test.ts: the launch commands are
// strings and a dropped export is silent at runtime.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

describe('DISABLE_AUTOUPDATER is set at every local launch site', () => {
  it('sub-agent spawn command exports it and puts it in the launch command', () => {
    const src = read('src/web/agent-process-spawn.ts')
    expect(src).toContain("const autoUpdateEnv = 'export DISABLE_AUTOUPDATER=1 && '")
    expect(src).toMatch(/\$\{surveyEnv\}\$\{autoUpdateEnv\}/)
  })

  it('worker session launch exports it', () => {
    expect(read('src/web/agent-worker.ts')).toContain("'export DISABLE_AUTOUPDATER=1; '")
  })

  it('background task launch exports it', () => {
    expect(read('src/web/routes/background-tasks.ts')).toContain('export DISABLE_AUTOUPDATER=1')
  })

  it('channels.sh exports it unconditionally, passes it to the main session and sets the tmux global env', () => {
    const src = read('scripts/channels.sh')
    // top level, not inside the AVX-only branch
    expect(src).toMatch(/^export DISABLE_AUTOUPDATER=1$/m)
    expect(src).toMatch(/MCP_BATCH_ENV="export [^"]*DISABLE_AUTOUPDATER=1/)
    expect(src).toMatch(/set-environment -g DISABLE_AUTOUPDATER 1/)
  })

  it('both watchdog respawn commands carry it', () => {
    expect(read('scripts/channel-watchdog.sh')).toMatch(/RESPAWN_CMD=.*DISABLE_AUTOUPDATER=1/)
    expect(read('scripts/watchdog.sh')).toMatch(/CMD=.*DISABLE_AUTOUPDATER=1/)
  })
})
