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
    timeout: 20_000,
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

  it('scrubs credentials out of every quoted text before it reaches the log', () => {
    // The fixtures are assembled from pieces so no key-shaped literal sits in the source.
    const sk = 'sk' + '-' + 'a1B2c3D4e5F6g7H8i9J0'
    const gh = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
    const jwt = ['eyJ' + 'hbGciOi', 'eyJ' + 'zdWIiOjE', 'sig' + 'nature123'].join('.')
    const pem = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIBVQIBADANBgkq\n-----END ' + 'PRIVATE KEY-----'
    const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP'
    const blob = 'Zm9vYmFy' + '1234567890abcdefghijklmnopqrstuvwx'
    answer('GET-memories', [
      // The secret starts before the 90-character cut and ends after it: scrubbing after the cut would leave a stub.
      // (Only the first 8 memories are listed, so the cases below stay within 8 rows.)
      { id: 0, agent_id: 'alpha', content: 'x'.repeat(80) + ' ' + sk + ' tail', created_at: during },
      { id: 1, agent_id: 'alpha', content: `anthropic key ${sk} was pasted`, created_at: during },
      { id: 2, agent_id: 'alpha', content: `github ${gh} leaked`, created_at: during },
      { id: 3, agent_id: 'alpha', content: 'curl -H "Authorization: Bearer abcdefgh12345678" postgres://admin:s3cretpw@db.example/app', created_at: during },
      { id: 4, agent_id: 'alpha', content: 'password=hunter2hunter2 and jelszó: titkosjelszo99', created_at: during },
      { id: 5, agent_id: 'alpha', content: `token ${jwt} ${aws}`, created_at: during },
      { id: 6, agent_id: 'alpha', content: `key file:\n${pem}\nend`, created_at: during },
      { id: 7, agent_id: 'alpha', content: `blob ${blob} and home /home/someone/secret-dir`, created_at: during },
    ])
    answer('GET-kanban', [{ id: 'k1', title: `Rotate ${sk} now`, status: 'planned', assignee: 'alpha', created_at: during, updated_at: during }])
    const r = run()
    expect(r.code).toBe(0)
    const c = posted()!.content
    for (const secret of [sk, 'a1B2c3D4e5', gh, 'A1b2C3d4E5', 'abcdefgh12345678', 'hunter2', 'titkosjelszo99', jwt,
      aws, 'MIIBVQIBADAN', 'PRIVATE KEY', blob, 'someone', 's3cretpw', 'sk-a1B']) {
      expect(c).not.toContain(secret)
    }
    expect(c).toContain('***')
    // The texts around the secrets survive.
    expect(c).toContain('anthropic key ***')
    expect(c).toContain('password=***')
  })

  it('keeps hyphenated doc keys and names readable, still catches real blobs and e-mail addresses, leaves paths and ids', () => {
    const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo' + '0123456789+/abcdef'
    // A base64url token keeps its hyphen and underscore, so the plain blob rule would split it into short pieces.
    const urlSafe = 'aB3-dE6_gH9' + 'jK2-mN5_pQ8sT1-vW4_yZ7aB0cD'
    answer('GET-memories', [
      { id: 6, agent_id: 'alpha', content: `session ${urlSafe} closed`, created_at: during },
      { id: 1, agent_id: 'alpha', content: 'see report/ecfcec5c-workspace-search-delta-qa and', created_at: during },
      { id: 2, agent_id: 'alpha', content: 'series-998/part-2-facts-and-figures-for-readers ok hot_1017_phase0_phase1_prep_drafts', created_at: during },
      { id: 3, agent_id: 'alpha', content: `blob ${blob} end`, created_at: during },
      { id: 4, agent_id: 'alpha', content: 'write to jane.doe+x@example.org please', created_at: during },
      // Only the e-mail part of the log-text shapes is ported: a path and a hex id stay as they are.
      { id: 5, agent_id: 'alpha', content: 'ran /var/log/app/run and id deadbeefdeadbeef', created_at: during },
    ])
    const c = (run(), posted()!.content)
    expect(c).toContain('see report/ecfcec5c-workspace-search-delta-qa and')
    expect(c).toContain('series-998/part-2-facts-and-figures-for-readers ok hot_1017_phase0_phase1_prep_drafts')
    expect(c).toContain('blob *** end')
    expect(c).not.toContain('QUJDREVG')
    expect(c).toContain('session *** closed')
    expect(c).not.toContain('jK2-mN5')
    expect(c).toContain('write to [email] please')
    expect(c).not.toContain('jane.doe')
    expect(c).toContain('ran /var/log/app/run and id deadbeefdeadbeef')
  })

  it('still scrubs separator-joined tokens (Stripe-style, hex digest, mixed-case pieces) that are not identifiers', () => {
    const stripe = 'sk' + '_test_' + '51HxAbCdEfGhIjKlMnOpQr'
    const stripeLower = 'secret_' + 'a8f3c2e1b7d94f60a1b2c3d4e5f6a7b8'
    const hexDigest = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
    const camel = 'token_' + 'Ab12Cd34_Ef56Gh78_Ij90Kl12_Mn34Op56'
    answer('GET-memories', [
      { id: 1, agent_id: 'alpha', content: `stripe ${stripe} here`, created_at: during },
      { id: 2, agent_id: 'alpha', content: `lower ${stripeLower} here`, created_at: during },
      { id: 3, agent_id: 'alpha', content: `digest ${hexDigest} here`, created_at: during },
      { id: 4, agent_id: 'alpha', content: `piece ${camel} here`, created_at: during },
      { id: 5, agent_id: 'alpha', content: 'uuid 123e4567-e89b-12d3-a456-426614174000 stays', created_at: during },
    ])
    expect(run().code).toBe(0)
    const c = posted()!.content
    for (const secret of ['51HxAbCd', 'a8f3c2e1b7d9', hexDigest, 'Ab12Cd34']) expect(c).not.toContain(secret)
    expect(c).toContain('uuid 123e4567-e89b-12d3-a456-426614174000 stays')
  })

  it('handles a huge text without a number or separator in time (no quadratic scrub)', () => {
    answer('GET-memories', [
      { id: 1, agent_id: 'alpha', content: 'a'.repeat(300_000), created_at: during },
      { id: 2, agent_id: 'alpha', content: 'abcdef-'.repeat(60_000), created_at: during },
      { id: 3, agent_id: 'alpha', content: ('word' + 'x'.repeat(40) + ' ').repeat(20_000), created_at: during },
    ])
    const started = Date.now()
    expect(run().code).toBe(0)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(posted()!.content).toContain('Új memória: 3')
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
