import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalConfigDir, configDirHash } from '../web/plan-config-hash.js'
import {
  countPlanSnapshotFiles,
  PLAN_SNAPSHOT_FILE_NOTICE_THRESHOLD,
  readPlanSnapshot,
} from '../web/plan-usage-source.js'
import { classifyPlanHealth } from '../claude-plan-health.js'

const SCRIPT = resolve(__dirname, '../../scripts/statusline-ratelimit.sh')
const NOW_S = 1_800_000_000
const NOW_MS = NOW_S * 1000

let root: string // a real (symlink-free) temp root
let home: string
let store: string
let planDir: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-usage-')))
  home = join(root, 'home')
  store = join(root, 'install', 'store')
  planDir = join(store, '.claude-rate-limits.d')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(store, { recursive: true })
  mkdirSync(join(root, 'install', 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(root, 'install', 'scripts', 'statusline-ratelimit.sh'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const mkDir = (name: string): string => {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}

const sha8 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)

/** Run the REAL statusLine script. `configDir === undefined` leaves the
 *  variable unset; any string (also '') sets it. */
function runStatusline(payload: unknown, configDir?: string, homeOverride?: string): string {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homeOverride ?? home }
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir
  return execFileSync('bash', [join(root, 'install', 'scripts', 'statusline-ratelimit.sh')], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env,
    encoding: 'utf8',
  })
}

const RL = {
  five_hour: { used_percentage: 42, resets_at: NOW_S + 3600 },
  seven_day: { used_percentage: 7, resets_at: NOW_S + 86400 },
}
const payload = (rl: unknown = RL) => ({
  session_id: 'sess-1',
  cwd: '/work/x',
  model: { display_name: 'M' },
  context_window: { used_percentage: 12 },
  rate_limits: rl,
})

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

describe('configDirHash / canonicalConfigDir', () => {
  it('is 8 lowercase hex chars and equals sha256(realpath)[0:8]', () => {
    const d = mkDir('cfg-a')
    expect(configDirHash(d, home)).toBe(sha8(d))
    expect(configDirHash(d, home)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('trailing slash, dot segments and a symlink all land on the same id', () => {
    const d = mkDir('cfg-a')
    const link = join(root, 'link-to-a')
    symlinkSync(d, link)
    const base = configDirHash(d, home)
    expect(configDirHash(d + '/', home)).toBe(base)
    expect(configDirHash(join(d, '..', 'cfg-a'), home)).toBe(base)
    expect(configDirHash(link, home)).toBe(base)
  })

  it('different directories get different ids', () => {
    expect(configDirHash(mkDir('cfg-a'), home)).not.toBe(configDirHash(mkDir('cfg-b'), home))
  })

  it('expands ~ against the injected home', () => {
    expect(configDirHash('~/.claude', home)).toBe(sha8(join(home, '.claude')))
    expect(canonicalConfigDir('~', home)).toBe(home)
  })

  it('a ~user form is not expanded and does not resolve', () => {
    expect(configDirHash('~someone/.claude', home)).toBeNull()
  })

  it('a directory that does not exist yet still has a canonical form (nearest real ancestor + normalised tail)', () => {
    const base = mkDir('cfg-a')
    const link = join(root, 'link-to-a')
    symlinkSync(base, link)
    // missing tail below a REAL dir and below a SYMLINKED dir: both resolve through the ancestor
    expect(canonicalConfigDir(join(base, 'sub', 'x'), home)).toBe(join(base, 'sub', 'x'))
    expect(canonicalConfigDir(join(link, 'sub', 'x'), home)).toBe(join(base, 'sub', 'x'))
    expect(canonicalConfigDir(join(base, 'sub', '..', 'x'), home)).toBe(join(base, 'x'))
  })

  it('a path with no canonical form yields null: empty, NUL byte, relative', () => {
    expect(configDirHash('', home)).toBeNull()
    expect(configDirHash('/tmp/a\0b', home)).toBeNull()
    expect(configDirHash('relative/cfg', home)).toBeNull()
    expect(configDirHash('./cfg', home)).toBeNull()
  })

  it('a path whose parent is a FILE (ENOTDIR) is still walked to the real ancestor', () => {
    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    expect(canonicalConfigDir(join(file, 'child'), home)).toBe(join(file, 'child'))
  })
})

describe('statusline-ratelimit.sh writer (real script)', () => {
  it('env dir: writes the legacy file AND the plan file named by the TS hash', () => {
    const d = mkDir('cfg-a')
    const out = runStatusline(payload(), d)
    expect(out.trim()).toBe('M | ctx 12% | 5h 42% | 7d 7%')

    const id = configDirHash(d, home)!
    const plan = readJson(join(planDir, `${id}.json`))
    expect(plan.config_dir).toBe(d)
    expect(plan.config_dir_source).toBe('env')
    expect(plan.rate_limits).toEqual(RL)
    expect(plan.session_id).toBe('sess-1')
    expect(typeof plan.written_at).toBe('number')

    const legacy = readJson(join(store, '.claude-rate-limits.json'))
    // legacy keys intact for limit-monitor and the dashboard strip
    expect(legacy.rate_limits).toEqual(RL)
    expect(legacy.cwd).toBe('/work/x')
    expect(legacy.session_id).toBe('sess-1')
    expect(typeof legacy.written_at).toBe('number')
  })

  it('a symlinked CLAUDE_CONFIG_DIR is recorded and named by its REAL path', () => {
    const d = mkDir('cfg-a')
    const link = join(root, 'link-to-a')
    symlinkSync(d, link)
    runStatusline(payload(), link)
    const id = configDirHash(d, home)!
    expect(existsSync(join(planDir, `${id}.json`))).toBe(true)
    expect(readJson(join(planDir, `${id}.json`)).config_dir).toBe(d)
  })

  it('variable unset -> default ~/.claude, source "default"', () => {
    runStatusline(payload())
    const id = configDirHash('~/.claude', home)!
    const rec = readJson(join(planDir, `${id}.json`))
    expect(rec.config_dir).toBe(join(home, '.claude'))
    expect(rec.config_dir_source).toBe('default')
  })

  // Each blank form runs ALONE against a fresh plan dir: a shared run would let
  // the second one pass on the file the first one left behind.
  for (const blank of ['', '   ']) {
    it(`variable set to ${JSON.stringify(blank)} counts as unset (default dir, source "default")`, () => {
      runStatusline(payload(), blank)
      const id = configDirHash('~/.claude', home)!
      const rec = readJson(join(planDir, `${id}.json`))
      expect(rec.config_dir_source).toBe('default')
      expect(rec.config_dir).toBe(join(home, '.claude'))
      expect(readdirSync(planDir)).toEqual([`${id}.json`])
    })
  }

  it('a config dir that does not exist still gets the normalised-path id (same as the TS side)', () => {
    const missingDir = join(root, 'does-not-exist')
    runStatusline(payload(), missingDir)
    expect(existsSync(join(store, '.claude-rate-limits.json'))).toBe(true)
    expect(readdirSync(planDir)).toEqual([`${configDirHash(missingDir, home)}.json`])
  })

  it('a RELATIVE CLAUDE_CONFIG_DIR: legacy file written, NO plan file (the id would depend on the cwd)', () => {
    runStatusline(payload(), 'relative/cfg')
    expect(existsSync(join(store, '.claude-rate-limits.json'))).toBe(true)
    expect(existsSync(planDir)).toBe(false)
  })

  it('the writer never deletes: a noise file of another session survives and a render does not touch it', () => {
    mkdirSync(planDir, { recursive: true })
    const noise = join(planDir, 'deadbeef.json')
    writeFileSync(noise, '{"keep":"me"}')
    runStatusline(payload(), mkDir('cfg-a'))
    expect(readFileSync(noise, 'utf8')).toBe('{"keep":"me"}')
  })

  it('two plans get two files; the legacy file is the last renderer', () => {
    const a = mkDir('cfg-a')
    const b = mkDir('cfg-b')
    runStatusline(payload({ five_hour: { used_percentage: 11, resets_at: NOW_S + 60 } }), a)
    runStatusline(payload({ five_hour: { used_percentage: 99, resets_at: NOW_S + 60 } }), b)
    expect(readJson(join(planDir, `${configDirHash(a, home)}.json`)).rate_limits.five_hour.used_percentage).toBe(11)
    expect(readJson(join(planDir, `${configDirHash(b, home)}.json`)).rate_limits.five_hour.used_percentage).toBe(99)
    expect(readJson(join(store, '.claude-rate-limits.json')).rate_limits.five_hour.used_percentage).toBe(99)
  })

  it('payload without rate_limits writes nothing at all (an empty write would look healthy)', () => {
    runStatusline({ session_id: 's', model: { display_name: 'M' } }, mkDir('cfg-a'))
    runStatusline(payload({}), mkDir('cfg-b'))
    expect(existsSync(join(store, '.claude-rate-limits.json'))).toBe(false)
    expect(existsSync(planDir)).toBe(false)
  })

  it('garbage stdin never fails the status line and writes nothing', () => {
    expect(runStatusline('not json at all', mkDir('cfg-a')).trim()).toBe('')
    expect(existsSync(join(store, '.claude-rate-limits.json'))).toBe(false)
  })

  it('leaves no temp files behind', () => {
    runStatusline(payload(), mkDir('cfg-a'))
    runStatusline(payload(), mkDir('cfg-a'))
    const files = [...readdirSync(store), ...readdirSync(planDir)]
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([])
  })
})

describe('readPlanSnapshot (reader, fixtures written by hand)', () => {
  const write = (cfg: string, rec: Record<string, unknown>) => {
    mkdirSync(planDir, { recursive: true })
    writeFileSync(join(planDir, `${configDirHash(cfg, home)}.json`), JSON.stringify(rec))
  }
  const base = (cfg: string, over: Record<string, unknown> = {}) => ({
    written_at: NOW_S - 30,
    config_dir: realpathSync(cfg),
    config_dir_source: 'env',
    rate_limits: RL,
    ...over,
  })
  const read = (cfg: string) => readPlanSnapshot({ configDir: cfg }, NOW_S, { dir: planDir, home })

  it('ok: windows, age and writtenAt come through', () => {
    const d = mkDir('cfg-a')
    write(d, base(d))
    const r = read(d)
    expect(r.detail).toBe('ok')
    expect(r.writtenAt).toBe(NOW_S - 30)
    expect(r.snapshot).toEqual({
      kind: 'snapshot',
      ageSec: 30,
      windows: {
        five_hour: { usedPercent: 42, resetsAt: NOW_S + 3600 },
        seven_day: { usedPercent: 7, resetsAt: NOW_S + 86400 },
      },
    })
  })

  it('a plan configDir given through a symlink finds the same file', () => {
    const d = mkDir('cfg-a')
    write(d, base(d))
    const link = join(root, 'plan-link')
    symlinkSync(d, link)
    expect(read(link).detail).toBe('ok')
  })

  it('no file', () => {
    expect(read(mkDir('cfg-a')).detail).toBe('no-file')
    expect(read(mkDir('cfg-a')).snapshot).toEqual({ kind: 'missing' })
  })

  it('plan configDir that does not exist yet has an id but no file', () => {
    expect(read(join(root, 'nope')).detail).toBe('no-file')
  })

  it('plan configDir without a canonical form (relative) -> no-config-dir', () => {
    expect(read('relative/cfg').detail).toBe('no-config-dir')
  })

  it('noise files of other sessions in the directory are never read for a plan', () => {
    const a = mkDir('cfg-a')
    const other = mkDir('agent-x-config')
    // a PERFECT-looking record, but it belongs to another dir's id
    write(other, base(other, { rate_limits: { five_hour: { used_percentage: 100, resets_at: NOW_S + 60 } } }))
    expect(read(a).detail).toBe('no-file')
  })

  it('corrupt JSON, array and scalar files are unreadable', () => {
    const d = mkDir('cfg-a')
    mkdirSync(planDir, { recursive: true })
    const file = join(planDir, `${configDirHash(d, home)}.json`)
    for (const body of ['{not json', '[1,2]', '42', 'null']) {
      writeFileSync(file, body)
      expect(read(d).detail).toBe('unreadable')
    }
  })

  it('an oversized file is not read', () => {
    const d = mkDir('cfg-a')
    write(d, base(d, { pad: 'x'.repeat(70 * 1024) }))
    expect(read(d).detail).toBe('unreadable')
  })

  it('record written for another config dir is rejected (misplaced file / collision)', () => {
    const a = mkDir('cfg-a')
    const b = mkDir('cfg-b')
    write(a, base(b))
    expect(read(a).detail).toBe('config-dir-mismatch')
  })

  it('record without config_dir (a legacy-style record) is rejected', () => {
    const a = mkDir('cfg-a')
    write(a, base(a, { config_dir: undefined }))
    expect(read(a).detail).toBe('config-dir-mismatch')
  })

  it('NON-default plan: a record whose source is "default" never counts', () => {
    const a = mkDir('cfg-a')
    write(a, base(a, { config_dir_source: 'default' }))
    expect(read(a).detail).toBe('not-env-sourced')
  })

  it('NON-default plan: a missing source field never counts', () => {
    const a = mkDir('cfg-a')
    write(a, base(a, { config_dir_source: undefined }))
    expect(read(a).detail).toBe('not-env-sourced')
  })

  it('DEFAULT plan (~/.claude): source "default" and "env" both count', () => {
    const d = join(home, '.claude')
    write(d, base(d, { config_dir_source: 'default' }))
    expect(read(d).detail).toBe('ok')
    write(d, base(d, { config_dir_source: 'env' }))
    expect(read(d).detail).toBe('ok')
  })

  it('no rate_limits / empty rate_limits / only null windows', () => {
    const a = mkDir('cfg-a')
    for (const rl of [undefined, null, {}, [], { five_hour: null, seven_day: null }]) {
      write(a, base(a, { rate_limits: rl }))
      expect(read(a).detail).toBe('no-rate-limits')
    }
  })

  it('a record with no usable written_at is missing, never "age 0"', () => {
    const a = mkDir('cfg-a')
    for (const w of [undefined, 0, -5, 'x', Number.NaN]) {
      write(a, base(a, { written_at: w }))
      expect(read(a).detail).toBe('no-written-at')
    }
  })

  it('one core window only is fine, the other stays null', () => {
    const a = mkDir('cfg-a')
    write(a, base(a, { rate_limits: { seven_day: RL.seven_day } }))
    const r = read(a)
    expect(r.detail).toBe('ok')
    expect(r.snapshot.kind === 'snapshot' && r.snapshot.windows.five_hour).toBeNull()
  })

  it('a PRESENT but malformed window is not skipped: it reaches the classifier as unknown', () => {
    const a = mkDir('cfg-a')
    write(a, base(a, { rate_limits: { five_hour: { used_percentage: '93', resets_at: NOW_S + 60 }, seven_day: RL.seven_day } }))
    const r = read(a)
    expect(r.detail).toBe('ok')
    const h = classifyPlanHealth(r.snapshot, NOW_MS)
    expect(h.status).toBe('unknown')
    expect(h.reason).toBe('malformed-window:five_hour')
  })

  it('a record from the future keeps a NEGATIVE age so the classifier can refuse it', () => {
    const a = mkDir('cfg-a')
    write(a, base(a, { written_at: NOW_S + 600 }))
    const r = read(a)
    expect(r.snapshot.kind === 'snapshot' && r.snapshot.ageSec).toBe(-600)
    expect(classifyPlanHealth(r.snapshot, NOW_MS).reason).toBe('snapshot-from-future')
  })
})

// One fixture, two implementations. The vectors were generated with Python
// (the writer's side) and are checked here against the TS util AND the real
// script, so neither can drift without a red cell.
interface HashVector {
  name: string
  input: string
  canonical: string
  hash: string
}
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/plan-config-hash-vectors.json'), 'utf8'),
) as { home: string; vectors: HashVector[] }

describe('hash parity: shared fixture vectors', () => {
  it('the fixture is non-trivial (guards against an emptied vector list passing vacuously)', () => {
    expect(FIXTURE.vectors.length).toBeGreaterThanOrEqual(10)
    expect(new Set(FIXTURE.vectors.map((v) => v.hash)).size).toBeGreaterThanOrEqual(4)
  })

  for (const v of FIXTURE.vectors) {
    it(`TS util: ${v.name} (${v.input})`, () => {
      expect(canonicalConfigDir(v.input, FIXTURE.home)).toBe(v.canonical)
      expect(configDirHash(v.input, FIXTURE.home)).toBe(v.hash)
    })

    it(`real script: ${v.name} (${v.input})`, () => {
      rmSync(planDir, { recursive: true, force: true })
      runStatusline(payload(), v.input, FIXTURE.home)
      expect(readdirSync(planDir)).toEqual([`${v.hash}.json`])
      expect(readJson(join(planDir, `${v.hash}.json`)).config_dir).toBe(v.canonical)
    })
  }
})

describe('countPlanSnapshotFiles', () => {
  it('0 for a missing directory', () => {
    expect(countPlanSnapshotFiles(join(root, 'nope'))).toBe(0)
  })

  it('counts only <8 hex>.json files (temp files and strangers are not snapshots)', () => {
    mkdirSync(planDir, { recursive: true })
    for (const f of ['aaaaaaaa.json', '01234567.json', 'aaaaaaaa.json.tmp.123', 'README', 'AAAAAAAA.json', 'abc.json']) {
      writeFileSync(join(planDir, f), '{}')
    }
    expect(countPlanSnapshotFiles(planDir)).toBe(2)
  })

  it('the notice threshold is 50: one file above it is the first that counts', () => {
    expect(PLAN_SNAPSHOT_FILE_NOTICE_THRESHOLD).toBe(50)
  })
})

describe('end to end: real script -> reader -> classifier (the incident chain)', () => {
  it('a high reading written 3 hours ago stays sticky pressure until its window resets', () => {
    const d = mkDir('cfg-a')
    runStatusline(
      payload({ five_hour: { used_percentage: 96, resets_at: NOW_S + 7200 }, seven_day: RL.seven_day }),
      d,
    )
    // The script stamps written_at with the REAL clock. "3 hours later" no new
    // render happens (the session is frozen), so move the window reset to stay
    // open at that later instant.
    const later = Math.floor(Date.now() / 1000) + 3 * 3600
    const file = join(planDir, `${configDirHash(d, home)}.json`)
    const rec = readJson(file)
    rec.rate_limits.five_hour.resets_at = later + 3600
    writeFileSync(file, JSON.stringify(rec))
    const r2 = readPlanSnapshot({ configDir: d }, later, { dir: planDir, home })
    expect(r2.detail).toBe('ok')
    const h = classifyPlanHealth(r2.snapshot, later * 1000)
    expect(h.status).toBe('pressure')
    expect(h.sticky).toBe(true)
    expect(h.window).toBe('five_hour')
  })

  it('the same frozen reading, once its window has reset, is no longer evidence', () => {
    const d = mkDir('cfg-a')
    runStatusline(payload({ five_hour: { used_percentage: 100, resets_at: NOW_S + 7200 } }), d)
    const later = NOW_S + 3 * 3600 // past the reset
    const rec = readJson(join(planDir, `${configDirHash(d, home)}.json`))
    rec.written_at = NOW_S - 100
    writeFileSync(join(planDir, `${configDirHash(d, home)}.json`), JSON.stringify(rec))
    const r = readPlanSnapshot({ configDir: d }, later, { dir: planDir, home })
    expect(classifyPlanHealth(r.snapshot, later * 1000).status).toBe('unknown')
  })

  it('sub-agent style render (its own dir) never leaks into another plan file', () => {
    const planA = mkDir('plan-a')
    const agentDir = mkDir('agent-x-config')
    runStatusline(payload({ five_hour: { used_percentage: 99, resets_at: NOW_S + 3600 } }), agentDir)
    const r = readPlanSnapshot({ configDir: planA }, NOW_S, { dir: planDir, home })
    expect(r.detail).toBe('no-file')
  })
})
