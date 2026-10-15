import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scripts/claude-update.sh is the only place Claude Code gets updated. These
// tests run the real script against a fake `claude` and a fake `npm` (the real
// ones must never be touched: an update changes the binary every session uses).
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'claude-update.sh')

let tmp: string
let storeDir: string
let binDir: string

const state = (): Record<string, unknown> => JSON.parse(readFileSync(join(storeDir, 'claude-update.json'), 'utf-8'))
const calls = (): string => (existsSync(join(tmp, 'calls.log')) ? readFileSync(join(tmp, 'calls.log'), 'utf-8') : '')

/** Fake claude: version in <tmp>/version; `update` moves it to <tmp>/next-version. */
function installFakeClaude(opts: { npmLayout?: boolean; version: string; next?: string; brokenAfterUpdate?: boolean }): string {
  writeFileSync(join(tmp, 'version'), opts.version)
  writeFileSync(join(tmp, 'next-version'), opts.next ?? opts.version)
  const body = `#!/bin/bash
case "$1" in
  --version)
    [ -f "${tmp}/broken" ] && exit 1
    echo "$(cat "${tmp}/version") (Claude Code)" ;;
  update)
    echo "claude update env=[\${DISABLE_AUTOUPDATER:-unset}]" >> "${tmp}/calls.log"
    cp "${tmp}/next-version" "${tmp}/version"
    ${opts.brokenAfterUpdate ? `touch "${tmp}/broken"` : ':'} ;;
esac
`
  if (opts.npmLayout) {
    const pkg = join(tmp, 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'cli.sh'), body)
    chmodSync(join(pkg, 'cli.sh'), 0o755)
    symlinkSync(join(pkg, 'cli.sh'), join(binDir, 'claude'))
  } else {
    writeFileSync(join(binDir, 'claude'), body)
    chmodSync(join(binDir, 'claude'), 0o755)
  }
  return join(binDir, 'claude')
}

/** Fake npm: `view` prints <tmp>/latest; `install -g pkg@v` moves the fake claude to v. */
function installFakeNpm(latest: string, opts: { installFails?: boolean } = {}): string {
  writeFileSync(join(tmp, 'latest'), latest)
  const body = `#!/bin/bash
case "$1" in
  view) cat "${tmp}/latest" ;;
  install)
    echo "npm install env=[\${DISABLE_AUTOUPDATER:-unset}] $*" >> "${tmp}/calls.log"
    ${opts.installFails ? 'exit 1' : `echo "\${3##*@}" > "${tmp}/version"`} ;;
esac
`
  writeFileSync(join(binDir, 'npm'), body)
  chmodSync(join(binDir, 'npm'), 0o755)
  return join(binDir, 'npm')
}

function run(extraEnv: Record<string, string> = {}, args: string[] = []) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: tmp,
      MARVEEN_STORE_DIR: storeDir,
      CLAUDE_UPDATE_CLAUDE_BIN: join(binDir, 'claude'),
      CLAUDE_UPDATE_NPM: join(binDir, 'npm'),
      CLAUDE_UPDATE_AVXLESS: '0',
      // the real wrapper sets this in every session; the script must unset it for the update child
      DISABLE_AUTOUPDATER: '1',
      ...extraEnv,
    },
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claude-update-'))
  storeDir = join(tmp, 'store')
  binDir = join(tmp, 'bin')
  mkdirSync(binDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('native install', () => {
  it('runs `claude update` when a newer version exists and records the moment of the change', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    const r = run()
    expect(r.status).toBe(0)
    expect(state()).toMatchObject({
      status: 'updated', installed: '2.1.310', previous: '2.1.300', latest: '2.1.310',
      method: 'native',
    })
    expect(typeof state()['updatedAt']).toBe('number')
    expect(typeof state()['checkedAt']).toBe('number')
    // the in-session switch is on in every session; the explicit update must not be blocked by it
    expect(calls()).toContain('claude update env=[unset]')
    expect(existsSync(join(storeDir, 'claude-update.lock'))).toBe(false)
  })

  it('does nothing when already current and keeps the time of the last real update', () => {
    installFakeClaude({ version: '2.1.310', next: '2.1.999' })
    installFakeNpm('2.1.310')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'claude-update.json'), JSON.stringify({ updatedAt: 42 }))
    const r = run()
    expect(r.status).toBe(0)
    expect(calls()).toBe('')
    expect(state()).toMatchObject({ status: 'up-to-date', installed: '2.1.310', updatedAt: 42 })
  })

  it('treats an installed version newer than the registry as current', () => {
    installFakeClaude({ version: '2.1.320' })
    installFakeNpm('2.1.310')
    expect(run().status).toBe(0)
    expect(calls()).toBe('')
    expect(state()).toMatchObject({ status: 'up-to-date' })
  })

  it('fails (and records no update moment) when the update leaves a binary that does not run', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310', brokenAfterUpdate: true })
    installFakeNpm('2.1.310')
    const r = run()
    expect(r.status).toBe(1)
    expect(state()).toMatchObject({ status: 'failed' })
    expect(state()['updatedAt']).toBeUndefined()
    expect(existsSync(join(storeDir, 'claude-update.lock'))).toBe(false)
  })

  it('fails when the update ran but the version did not move', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.300' })
    installFakeNpm('2.1.310')
    const r = run()
    expect(r.status).toBe(1)
    expect(state()).toMatchObject({ status: 'failed' })
    expect(String(state()['message'])).toContain('still 2.1.300')
  })
})

describe('npm-global install', () => {
  it('installs the exact latest version with one npm run', () => {
    installFakeClaude({ npmLayout: true, version: '2.1.300' })
    installFakeNpm('2.1.310')
    const r = run()
    expect(r.status).toBe(0)
    expect(calls()).toContain('npm install env=[unset] install -g @anthropic-ai/claude-code@2.1.310')
    expect(state()).toMatchObject({ status: 'updated', installed: '2.1.310', method: 'npm' })
  })

  it('a failing npm install is a failure and the version stays', () => {
    installFakeClaude({ npmLayout: true, version: '2.1.300' })
    installFakeNpm('2.1.310', { installFails: true })
    const r = run()
    expect(r.status).toBe(1)
    expect(state()).toMatchObject({ status: 'failed', installed: '2.1.300' })
    expect(state()['updatedAt']).toBeUndefined()
  })

  it('cannot proceed without a known latest version', () => {
    installFakeClaude({ npmLayout: true, version: '2.1.300' })
    installFakeNpm('not-a-version')
    const r = run()
    expect(r.status).toBe(1)
    expect(String(state()['message'])).toContain('latest')
  })
})

describe('pins', () => {
  it('a pin file holds the version', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'claude-pin'), '2.1.300\n')
    const r = run()
    expect(r.status).toBe(0)
    expect(calls()).toBe('')
    expect(state()).toMatchObject({ status: 'pinned', installed: '2.1.300' })
    expect(String(state()['message'])).toContain('2.1.300')
  })

  it('CLAUDE_UPDATE_PIN holds the version too', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    expect(run({ CLAUDE_UPDATE_PIN: '2.1.300' }).status).toBe(0)
    expect(calls()).toBe('')
    expect(state()).toMatchObject({ status: 'pinned' })
  })

  it('an AVX-less host is never updated (the pinned Node build must not be swapped for the Bun binary)', () => {
    installFakeClaude({ version: '2.1.110', next: '2.1.310' })
    installFakeNpm('2.1.310')
    expect(run({ CLAUDE_UPDATE_AVXLESS: '1' }).status).toBe(0)
    expect(calls()).toBe('')
    expect(state()).toMatchObject({ status: 'pinned' })
    expect(String(state()['message'])).toContain('AVX-less')
  })
})

describe('lock', () => {
  it('skips quietly while a live run holds it', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    mkdirSync(join(storeDir, 'claude-update.lock'), { recursive: true })
    writeFileSync(join(storeDir, 'claude-update.lock', 'pid'), String(process.pid))
    const r = run()
    expect(r.status).toBe(0)
    expect(calls()).toBe('')
    expect(r.stdout).toContain('holds the lock')
    // a run that did not update must not leave the other run's lock behind or take it
    expect(existsSync(join(storeDir, 'claude-update.lock', 'pid'))).toBe(true)
  })

  it('takes over a lock whose owner is gone', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    mkdirSync(join(storeDir, 'claude-update.lock'), { recursive: true })
    writeFileSync(join(storeDir, 'claude-update.lock', 'pid'), '2147483646')
    expect(run().status).toBe(0)
    expect(state()).toMatchObject({ status: 'updated' })
  })

  it('takes over a lock older than the stale limit even if the pid file is missing', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    const lock = join(storeDir, 'claude-update.lock')
    mkdirSync(lock, { recursive: true })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(lock, old, old)
    expect(run().status).toBe(0)
    expect(state()).toMatchObject({ status: 'updated' })
  })
})

describe('--check', () => {
  it('reports and changes nothing', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    const r = run({}, ['--check'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('installed=2.1.300 latest=2.1.310')
    expect(calls()).toBe('')
    expect(existsSync(join(storeDir, 'claude-update.json'))).toBe(false)
  })
})

describe('state file', () => {
  it('keeps keys it does not own', () => {
    installFakeClaude({ version: '2.1.300', next: '2.1.310' })
    installFakeNpm('2.1.310')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'claude-update.json'), JSON.stringify({ custom: 'x', note: 'y' }))
    expect(run().status).toBe(0)
    expect(state()).toMatchObject({ custom: 'x', note: 'y', status: 'updated' })
  })

  it('a missing claude binary is a recorded failure', () => {
    const r = run({ CLAUDE_UPDATE_CLAUDE_BIN: join(binDir, 'nope') })
    expect(r.status).toBe(1)
    expect(state()).toMatchObject({ status: 'failed' })
  })
})
