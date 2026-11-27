// The SQLite writer of gate_audit_lib.py and the PostgreSQL-mode path (the hook against the REAL route) say the same about the same
// sequence of gate decisions: the same running counts per (gate, decision, reason) and the same deny rows (the fixed fields).
// The SQLite side is the file writer on a database built by the real migrations; the route side is the real Python hook
// (PG mode, one HTTP call per deny, an aggregated counts file for the allows) talking to the real route handler over HTTP, on the
// in-memory test database. The sequence ends with a deny, which is the call that flushes the aggregated allow counts (an idle agent's
// allow counts wait for its next gate call by design, see the runbook).
// The deliberate difference: an allow is buffered in PG mode (the differential reads the state after the closing deny).
// Neutral fixtures only (agent-a).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { dbx } from '../db/facade.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { tryHandleHooksGateAudit } from '../web/routes/hooks-gate-audit.js'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(__dirname, '..', '..')
const HOOKS = join(ROOT, 'scripts', 'hooks')
const TOKEN = 'differential-token-agent-a'

// [gate, decision, reason, deny_row, session id]
type Step = [string, string, string, boolean, string | null]
const SEQUENCE: Step[] = [
  ['destructive-gate', 'allow', '', true, null],
  ['destructive-gate', 'allow', '', true, null],
  ['secret-read-gate', 'allow', '', false, 'sess-aaaa-1111'],
  ['email-approval-gate', 'deny', 'denied', true, 'sess-aaaa-1111'],
  ['outgoing-copy-gate', 'deny', 'input_too_large', true, null],
  ['destructive-gate', 'deny', 'denied', false, 'sess-bbbb-2222'], // a gate that posts its own row: the count only
  ['tenant-skill-gate', 'error', 'gate_error', true, null],
  ['shell-rescan-guard', 'error', 'exit_code', false, 'w3c-shouldbedropped'],
  ['auth-admin-gate', 'allow', '', true, null],
  ['tenant-skill-gate', 'deny', 'denied', true, 'has spaces and a\nnewline'], // an unusable session id: no trace id
  ['tenant-skill-gate', 'deny', 'denied', true, 'sess-cccc-3333'],
]

const DRIVER = `
import json, os, sys
sys.path.insert(0, sys.argv[1])
import gate_audit_lib as lib
mode, db, steps = sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
for gate, decision, reason, deny_row, session in steps:
    kwargs = dict(agent_id='agent-a', deny_row=deny_row, session_id=session)
    if mode == 'sqlite':
        kwargs['db_path'] = db
    lib.record(gate, decision, reason, **kwargs)
`

function runDriver(mode: 'sqlite' | 'pg', db: string, env: Record<string, string>): Promise<number> {
  return new Promise((done) => {
    const p = spawn('python3', ['-I', '-c', DRIVER, HOOKS, mode, db, JSON.stringify(SEQUENCE)], { env })
    p.on('close', (code) => done(code ?? -1))
  })
}

interface CountRow { gate: string; decision: string; reason: string; count: number }
interface DenyRow { agent_id: string | null; hook_type: string; verdict: string; tool_name: string | null; content_hash: string | null; reason: string | null; session_id: string | null; trigger_source: string | null; tenant_id: string | null; trace_id: string | null }

const sortKey = (r: object) => JSON.stringify(r)

describe.skipIf(testDbMode() === 'pg')('the hook: the SQLite writer and the route say the same on the same decisions', () => {
  useTestDb()
  let server: http.Server
  let work = ''
  let base = ''
  let tokenFile = ''

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'gate-audit-diff-'))
    mkdirSync(join(work, 'empty'))
    tokenFile = join(work, 'token')
    writeFileSync(tokenFile, TOKEN)
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const ctx = {
        req, res, path: url.pathname.replace('/api/v1/', '/api/'), method: req.method ?? 'GET', url, role: 'fleet_agent',
        tokenAgentId: bearer === TOKEN ? 'agent-a' : undefined, tenantId: null,
      } as unknown as RouteContext
      tryHandleHooksGateAudit(ctx).then((handled) => { if (!handled) { res.writeHead(404); res.end('{}') } }).catch(() => { res.writeHead(500); res.end('{}') })
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()))
    rmSync(work, { recursive: true, force: true })
  })

  it('same counts and same deny rows (the fixed fields) through the file writer and through hook + route', async () => {
    // --- the SQLite writer, on a file database built by the real migrations
    const sqliteDb = join(work, 'sqlite-side.db')
    const build = spawn('python3', ['-I', '-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('t', sys.argv[1])
t = importlib.util.module_from_spec(spec); spec.loader.exec_module(t)
t.make_audit_db(sys.argv[2])
import sqlite3
con = sqlite3.connect(sys.argv[2])
con.execute('ALTER TABLE hook_audit_log ADD COLUMN trace_id TEXT')
con.execute('ALTER TABLE hook_audit_log ADD COLUMN span_id TEXT')
con.commit()
`, join(ROOT, 'scripts', '__tests__', 'gate-audit-lib.test.py'), sqliteDb], { env: { PATH: process.env.PATH ?? '' } })
    expect(await new Promise<number>((done) => { build.on('close', (c) => done(c ?? -1)) })).toBe(0)
    expect(await runDriver('sqlite', sqliteDb, { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' })).toBe(0)
    const sqlite = await readSqlite(sqliteDb)

    // --- the hook in PG mode against the real route (the in-memory database behind this test)
    const store = join(work, 'store')
    mkdirSync(store, { recursive: true })
    const code = await runDriver('pg', '', {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SECRET_MOUNT_DIR: join(work, 'empty'), CLAUDECLAW_ENV_DIR: join(work, 'empty'),
      MARVEEN_PG_CONFIGURED: '1', DASHBOARD_BASE_URL: base, MARVEEN_AGENT_TOKEN_FILE: tokenFile, LEDGER_DB_PATH: join(store, 'claudeclaw.db'),
    })
    expect(code).toBe(0)
    const counts = await dbx.all<CountRow>('SELECT gate, decision, reason, count FROM gate_decision_counts')
    const denies = await dbx.all<DenyRow>('SELECT agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id, trace_id FROM hook_audit_log')

    expect(counts.map(sortKey).sort()).toEqual(sqlite.counts.map(sortKey).sort())
    // the ONE deliberate difference: the file writer leaves the tenant NULL (a gate process cannot resolve it), the route stamps the
    // tenant the server resolves for the token's agent (agent-a serves none here: 'default')
    const sansTenant = (r: DenyRow) => ({ ...r, tenant_id: undefined })
    expect(denies.map((r) => sortKey(sansTenant(r))).sort()).toEqual(sqlite.denies.map((r) => sortKey(sansTenant(r))).sort())
    expect(sqlite.denies.every((r) => r.tenant_id === null)).toBe(true)
    expect(denies.every((r) => r.tenant_id === 'default')).toBe(true)
    // and the comparison is not vacuous: the sequence produced rows on both sides, with the unusable session ids dropped
    expect(sqlite.denies.length).toBeGreaterThan(3)
    expect(counts.length).toBeGreaterThan(5)
    expect(denies.map((d) => d.trace_id)).toEqual(expect.arrayContaining(['sess-aaaa-1111', 'sess-cccc-3333']))
    expect(denies.every((d) => d.trace_id === null || /^sess-/.test(d.trace_id))).toBe(true)
  }, 60_000)
})

async function readSqlite(path: string): Promise<{ counts: CountRow[]; denies: DenyRow[] }> {
  const run = (query: string) => new Promise<string>((done, fail) => {
    const p = spawn('python3', ['-I', '-c', 'import json, sqlite3, sys\ncon = sqlite3.connect(sys.argv[1])\ncon.row_factory = sqlite3.Row\nprint(json.dumps([dict(r) for r in con.execute(sys.argv[2])]))', path, query], { env: { PATH: process.env.PATH ?? '' } })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', (c) => (c === 0 ? done(out) : fail(new Error(`sqlite read failed ${c}`))))
  })
  const denyCols = 'agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id, trace_id'
  return {
    counts: JSON.parse(await run('SELECT gate, decision, reason, count FROM gate_decision_counts')) as CountRow[],
    denies: JSON.parse(await run(`SELECT ${denyCols} FROM hook_audit_log`)) as DenyRow[],
  }
}
