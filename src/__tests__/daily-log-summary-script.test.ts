// scripts/daily-log-summary.py against a fake API wrapper: what it writes for a busy day and an empty day, that it
// writes once a day, and which answers make it fail. The wrapper is replaced through DAILY_LOG_SUMMARY_API; the real
// one needs a dashboard. Git is switched off (DAILY_LOG_SUMMARY_GIT=0): the merge list is not under test here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'daily-log-summary.py')
const DAY = '2026-10-16'
const midnight = new Date(2026, 9, 16).getTime() / 1000
const during = midnight + 12 * 3600
const before = midnight - 3600

let dir: string
let fakeApi: string

// The fake is called as: <wrapper> --token main --max-time N METHOD PATH [BODY]. It answers "<dir>/<name>.body" with
// exit code "<dir>/<name>.rc" (default 0), name = "<method>-<first path segment after /api/, query dropped>", and
// appends every call to "<dir>/calls".
function writeFake(): void {
  fakeApi = join(dir, 'fake-api.sh')
  writeFileSync(fakeApi, [
    '#!/usr/bin/env bash',
    'echo "$5 $6" >> "$FAKE_DIR/calls"',
    '[ -n "${7:-}" ] && printf "%s" "$7" > "$FAKE_DIR/posted-body"',
    'p="${6#/api/}"; p="${p%%\\?*}"',
    'name="$5-$p"',
    'cat "$FAKE_DIR/$name.body" 2>/dev/null',
    'rc=0; [ -f "$FAKE_DIR/$name.rc" ] && rc=$(cat "$FAKE_DIR/$name.rc")',
    'exit "$rc"',
    '',
  ].join('\n'))
  chmodSync(fakeApi, 0o755)
}

const answer = (name: string, body: unknown, rc = 0): void => {
  writeFileSync(join(dir, `${name}.body`), typeof body === 'string' ? body : JSON.stringify(body))
  if (rc !== 0) writeFileSync(join(dir, `${name}.rc`), String(rc))
}
const calls = (): string[] => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf-8').trim().split('\n') : [])
const posted = (): { agent_id: string; content: string } | null =>
  existsSync(join(dir, 'posted-body')) ? JSON.parse(readFileSync(join(dir, 'posted-body'), 'utf-8')) : null

function run(args: string[] = ['main-agent', '--date', DAY]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('python3', ['-I', SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, DAILY_LOG_SUMMARY_API: fakeApi, DAILY_LOG_SUMMARY_GIT: '0', FAKE_DIR: dir },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daily-log-summary-'))
  writeFake()
  answer('GET-daily-log', [])
  answer('GET-memories', [])
  answer('GET-kanban', [])
  answer('GET-workspace', { items: [], total: 0 })
  answer('POST-daily-log', { ok: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('daily-log-summary.py', () => {
  it('writes one headed entry for the main agent with the day\'s memories, cards and documents', () => {
    answer('GET-memories', [
      { id: 1, agent_id: 'alpha', tenant_id: 'default', content: 'Decided to move the backup to 03:00', created_at: during },
      { id: 2, agent_id: 'alpha', content: 'second one', created_at: during + 60 },
      { id: 3, agent_id: 'beta', tenant_id: 'default', content: 'beta note', created_at: during },
      { id: 4, agent_id: 'alpha', tenant_id: 'default', content: 'yesterday\'s memory', created_at: before },
      { id: 5, agent_id: 'gamma', tenant_id: 'acme', content: 'another tenant\'s secret', created_at: during },
    ])
    answer('GET-kanban', [
      { id: 'k1', title: 'New card', status: 'planned', assignee: 'alpha', created_at: during, updated_at: during },
      { id: 'k2', title: 'Finished card', status: 'done', assignee: 'beta', created_at: before, updated_at: during },
      { id: 'k3', title: 'Moved card', status: 'in_progress', assignee: 'alpha', created_at: before, updated_at: during },
      { id: 'k4', title: 'Old done card', status: 'done', assignee: 'alpha', created_at: before, updated_at: before },
      { id: 'k5', title: 'Other tenant card', status: 'done', tenant_id: 'acme', created_at: before, updated_at: during },
    ])
    answer('GET-workspace', { items: [
      { id: 'd1', title: 'Weekly plan', agent_id: 'alpha', tenant_id: 'default', created_at: before, updated_at: during },
      { id: 'd2', title: 'Old doc', agent_id: 'alpha', tenant_id: 'default', created_at: before, updated_at: before },
    ], total: 2 })

    const r = run()
    expect(r.code).toBe(0)
    const body = posted()!
    expect(body.agent_id).toBe('main-agent')
    const c = body.content
    expect(c.split('\n')[0]).toBe(`## Napi összefoglaló ${DAY}`)
    expect(c).toContain('Új memória: 3 (alpha 2, beta 1)')
    expect(c).toContain('Decided to move the backup to 03:00')
    expect(c).toContain('Új kanban kártya: 1')
    expect(c).toContain('- New card (alpha)')
    expect(c).toContain('Lezárt kanban kártya: 1')
    expect(c).toContain('- Finished card (beta)')
    expect(c).toContain('Mozgott kanban kártya: 1')
    expect(c).toContain('- Moved card -> in_progress')
    expect(c).toContain('Munkadokumentum: 1')
    expect(c).toContain('- Weekly plan [alpha]')
    // Nothing from another day or another tenant, and no em dash.
    for (const leaked of ['yesterday', 'secret', 'Old done card', 'Other tenant card', 'Old doc']) expect(c).not.toContain(leaked)
    expect(c).not.toContain(String.fromCharCode(0x2014))
  })

  it('caps a long list and says how many more there are', () => {
    answer('GET-memories', Array.from({ length: 11 }, (_, i) => ({ id: i, agent_id: 'alpha', content: `memory ${i}`, created_at: during + i })))
    const c = (run(), posted()!.content)
    expect(c).toContain('Új memória: 11 (alpha 11)')
    expect(c).toContain('- és még 3')
    expect(c).not.toContain('memory 10')
  })

  it('files a day without activity as a one-line entry instead of leaving a gap', () => {
    const r = run()
    expect(r.code).toBe(0)
    expect(posted()!.content).toBe(`## Napi összefoglaló ${DAY}\nNem volt rögzített aktivitás (memória, kanban, munkadokumentum, merge).`)
  })

  it('writes once a day: a log that already has the day\'s header is left alone', () => {
    answer('GET-daily-log', [{ id: 1, content: `## Napi összefoglaló ${DAY}\nearlier run`, created_at: during }])
    const r = run()
    expect(r.code).toBe(0)
    expect(calls().filter(l => l.startsWith('POST'))).toEqual([])
    expect(posted()).toBeNull()
  })

  it('does not take another day\'s header for today\'s', () => {
    answer('GET-daily-log', [{ id: 1, content: '## Napi összefoglaló 2026-10-15\nyesterday', created_at: before }])
    expect(run().code).toBe(0)
    expect(posted()).not.toBeNull()
  })

  it('fails (exit 1) and writes nothing when a data call fails', () => {
    answer('GET-kanban', 'boom', 22)
    const r = run()
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('GET /api/kanban failed')
    expect(posted()).toBeNull()
  })

  it('fails (exit 1) when the write itself fails', () => {
    answer('POST-daily-log', 'nope', 22)
    expect(run().code).toBe(1)
  })

  it('refuses a missing agent and a malformed date (exit 2)', () => {
    expect(run([]).code).toBe(2)
    expect(run(['main-agent', '--date', 'yesterday']).code).toBe(2)
    expect(calls()).toEqual([])
  })
})
