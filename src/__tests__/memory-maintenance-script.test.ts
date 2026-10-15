// scripts/memory-maintenance.sh against a fake API wrapper: which answers are a failure (exit 1), a finding (exit 42)
// or a clean run (exit 0). The wrapper is replaced through MEMORY_MAINTENANCE_API; the real one needs a dashboard.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'memory-maintenance.sh')

let dir: string
let fakeApi: string

// The fake answers "<dir>/<name>.body" with exit code "<dir>/<name>.rc" (default 0), name = the path's last segment,
// and appends every call's arguments to "<dir>/calls".
function writeFake(): void {
  fakeApi = join(dir, 'fake-api.sh')
  writeFileSync(fakeApi, [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$FAKE_DIR/calls"',
    'name="${6##*/}"',
    'cat "$FAKE_DIR/$name.body" 2>/dev/null',
    'rc=0; [ -f "$FAKE_DIR/$name.rc" ] && rc=$(cat "$FAKE_DIR/$name.rc")',
    'exit "$rc"',
    '',
  ].join('\n'))
  chmodSync(fakeApi, 0o755)
}

const answer = (name: string, body: string, rc = 0): void => {
  writeFileSync(join(dir, `${name}.body`), body)
  if (rc !== 0) writeFileSync(join(dir, `${name}.rc`), String(rc))
}

function run(args: string[] = ['main-agent']): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, MEMORY_MAINTENANCE_API: fakeApi, FAKE_DIR: dir },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

const calls = (): string[] => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf-8').trim().split('\n') : [])

const OK_RESORT = '{"ok":true,"warmToCold":1,"coldToWarm":0,"prunedVersions":2}'
const okLinks = (failed: number): string =>
  `{"ok":true,"reembedded":0,"linksCreated":4,"linksFailed":${failed},"memoriesAttempted":9,"linksPruned":0,"orphans":0}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memmaint-'))
  writeFake()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('memory-maintenance.sh', () => {
  it('exits 0 when both calls succeed and no memory failed, calling resort first as the given agent', () => {
    answer('resort', OK_RESORT)
    answer('maintain', okLinks(0))
    const r = run()
    expect(r.code).toBe(0)
    expect(calls()).toEqual([
      '--agent main-agent --max-time 120 POST /api/memories/resort {}',
      '--agent main-agent --max-time 300 POST /api/memories/links/maintain {}',
    ])
  })

  it('exits 42 (a finding) when some memories could not be linked, naming how many', () => {
    answer('resort', OK_RESORT)
    answer('maintain', okLinks(3))
    const r = run()
    expect(r.code).toBe(42)
    expect(r.stderr).toContain('3 memories')
  })

  it('exits 1 and never calls the link maintenance when the resort fails', () => {
    answer('resort', '{"error":"internal_error"}', 22)
    answer('maintain', okLinks(0))
    const r = run()
    expect(r.code).toBe(1)
    expect(calls()).toHaveLength(1)
    expect(r.stderr).toContain('/api/memories/resort failed')
  })

  it('exits 1 when the resort answers 2xx without "ok":true', () => {
    answer('resort', '{"warmToCold":0}')
    expect(run().code).toBe(1)
  })

  it('exits 1 (not 42) when the link maintenance fails, whatever its body says', () => {
    answer('resort', OK_RESORT)
    answer('maintain', '{"error":"internal_error","hint":"Link maintenance failed for 5 of 6 memories"}', 22)
    const r = run()
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('5 of 6 memories')
  })

  it('exits 1 when the link maintenance has no "ok":true even with exit 0', () => {
    answer('resort', OK_RESORT)
    answer('maintain', '{"linksFailed":0}')
    expect(run().code).toBe(1)
  })

  it('treats a response from an older dashboard without linksFailed as clean', () => {
    answer('resort', OK_RESORT)
    answer('maintain', '{"ok":true,"reembedded":0,"linksCreated":4,"linksPruned":0,"orphans":0}')
    expect(run().code).toBe(0)
  })

  it('exits 2 without an agent id and calls nothing', () => {
    const r = run([])
    expect(r.code).toBe(2)
    expect(calls()).toEqual([])
  })
})
