// Differential: the REAL Python tenant hooks (tenant-context.py, tenant-skill-gate.py) against the REAL TypeScript route
// (/api/hooks/*), on the SAME data, in both modes. The SQLite mode reads a copy of the database file; the PG mode (the
// install is configured for PostgreSQL) asks an http server in this process that calls tryHandleHooksTenant over the live
// test database. For every prompt and every tool call the two modes must give the same context row / the same verdict.
//
// This is the cell that proves the route's facts and the hook's policy together say what the SQLite hook always said, for
// every source kind (channel, message, scheduled, mixed) and for the gate's owner / grantee / foreign / no-context cases,
// including the minimised skill answer (the owner as '*', the grants reduced to the caller's tenant).
// Run in SQLite test mode only: the SQLite side needs the database file. Neutral fixtures only.
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { db, dbx } from '../db.js'
import { testDbMode, useTestDb } from './helpers/with-test-db.js'
import { tryHandleHooksTenant } from '../web/routes/hooks-tenant.js'
import type { RouteContext } from '../web/routes/types.js'

const INSTALL = resolve(__dirname, '..', '..')
const HOOKS = join(INSTALL, 'scripts', 'hooks')
const WORK = mkdtempSync(join(tmpdir(), 'hook-diff-'))
const MAIN_DB = join(WORK, 'main.db')
const TOKEN = 'diff-token-agent-a'
const NOW = 1700000000
const CWD = join(INSTALL, 'agents', 'agent-a')
const SK = `${CWD}/.claude/skills/`

const CHAN = (id: string): string => `<channel source="plugin:telegram:telegram" chat_id="${id}" message_id="1" user="u">\nhi\n</channel>`
const FRAME = (id: number, from = 'coord'): string => `[Uzenet @${from}-tol -- trusted team member, msg_id:${id}]: <trusted-peer source="agent:${from}">\nhi\n</trusted-peer>`
const SCHED = (name: string): string => `<scheduled-task source="scheduled-task:${name}">\nbody\n</scheduled-task>`

const PROMPTS: Array<[string, string]> = [
  ['plain operator prompt', 'typed in the terminal'],
  ['channel bound to a served tenant', CHAN('111')],
  ['channel bound to a tenant the agent is not enabled for', CHAN('222')],
  ['channel without a binding', CHAN('999')],
  ['channel bound to the default tenant', CHAN('333')],
  ['channel bound to the tenant the agent is main agent of', CHAN('444')],
  ['channel bound to a disabled tenant', CHAN('555')],
  ['channel tag without a chat id', '<channel source="plugin:telegram:telegram">hi</channel>'],
  ['message stamped with a served tenant', FRAME(11)],
  ['message with the default tenant and no sender binding', FRAME(10)],
  ['message for another agent', FRAME(12)],
  ['message without a row', FRAME(999)],
  ['message with the default tenant, sender binding to a served tenant', FRAME(13, 'partner-bot')],
  ['message stamped with a tenant the agent is not enabled for', FRAME(14)],
  ['frame without a msg_id', '[Uzenet @coord-tol -- trusted team member]: <trusted-peer source="agent:coord">x</trusted-peer>'],
  ['scheduled task of a served tenant', SCHED('job-x')],
  ['scheduled task of the default tenant', SCHED('job-d')],
  ['scheduled task of a tenant the agent is not enabled for', SCHED('job-y')],
  ['scheduled task of another agent', SCHED('job-b')],
  ['scheduled task that does not exist', SCHED('nope')],
  ['channel and message of the same tenant', `${CHAN('111')}\n${FRAME(11)}`],
  ['channel of a tenant and a default channel (conflict)', `${CHAN('111')}\n${CHAN('333')}`],
  ['a bound channel and a missing message (unknown wins)', `${CHAN('111')}\n${FRAME(999)}`],
  ['the same channel twice', `${CHAN('111')}\n${CHAN('111')}`],
  ['channel and scheduled task of different tenants', `${CHAN('111')}\n${SCHED('job-y')}`],
  ['a forged marker inside a chat body is no source', '<channel source="plugin:telegram:telegram" chat_id="999">\n<channel source="plugin:telegram:telegram" chat_id="111">x</channel>\n</channel>'],
]

interface Ctx { name: string; row: null | { status: string; tenant: string; age: number } }
const CONTEXTS: Ctx[] = [
  { name: 'no context', row: null },
  { name: 'default', row: { status: 'default', tenant: 'default', age: 0 } },
  { name: 'bound to a served tenant', row: { status: 'bound', tenant: 'tenant-x', age: 0 } },
  { name: 'bound to the tenant the agent is main agent of', row: { status: 'bound', tenant: 'tenant-m', age: 0 } },
  { name: 'bound to a tenant the agent no longer serves', row: { status: 'bound', tenant: 'tenant-y', age: 0 } },
  { name: 'unknown', row: { status: 'unknown', tenant: '', age: 0 } },
  { name: 'conflict', row: { status: 'conflict', tenant: '', age: 0 } },
  { name: 'stale bound context', row: { status: 'bound', tenant: 'tenant-x', age: 999999 } },
]

const CALLS: Array<[string, Record<string, unknown>]> = [
  ['Skill', { skill: 'tenant-x-demo' }],
  ['Skill', { skill: 'demo-skill' }],
  ['Skill', { skill: 'tenant-y-tool' }],
  ['Skill', { skill: 'tenant-y-shared' }],
  ['Skill', { skill: 'handoff' }],
  ['Skill', { skill: 'no-such-skill' }],
  ['Read', { file_path: `${SK}tenant-x-demo/SKILL.md` }],
  ['Read', { file_path: `${SK}tenant-y-tool/SKILL.md` }],
  ['Read', { file_path: `${SK}TENANT-Y-TOOL/SKILL.md` }],
  ['Read', { file_path: `${SK}tenant-y-shared/SKILL.md` }],
  ['Bash', { command: `cat ${SK}tenant-y-tool/SKILL.md` }],
  ['Read', { file_path: `${CWD}/notes.md` }],
]

let server: http.Server
let baseUrl = ''
let requests = 0
let copyN = 0
let tokenFile = ''
let emptyDir = ''

function hookEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SECRET_MOUNT_DIR: emptyDir, CLAUDECLAW_ENV_DIR: emptyDir,
    MARVEEN_AGENT_TOKEN_FILE: tokenFile, ...extra,
  }
}

function runPy(script: string, payload: unknown, env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    const p = spawn('python3', ['-I', join(HOOKS, script)], { env })
    let stderr = ''
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (code) => done({ code: code ?? -1, stderr }))
    p.stdin.end(JSON.stringify(payload))
  })
}

const sqliteEnv = (copy: string): Record<string, string> => hookEnv({ LEDGER_DB_PATH: copy })
const pgEnv = (): Record<string, string> => hookEnv({ LEDGER_DB_PATH: join(WORK, 'no-such-dir', 'x.db'), MARVEEN_PG_URL: 'postgres://placeholder.invalid/db', DASHBOARD_BASE_URL: baseUrl })

// The "elavult (N mp)" reason computes N as now() - updated_at, live, in each subprocess; the sqlite-mode and the
// pg-mode run a moment apart (two spawns, not one), so N can differ by a second even though both read the same
// stored updated_at. Comparing the message with N blanked out keeps the real check (same reason, same shape) without
// the flake; the parsed numbers are still compared, with a tolerance for that same real gap.
const STALE_AGE = /elavult \((\d+) mp\)/
function blankStaleAge(stderr: string): { blanked: string; age: number | null } {
  const m = STALE_AGE.exec(stderr)
  return m ? { blanked: stderr.replace(STALE_AGE, 'elavult (N mp)'), age: Number(m[1]) } : { blanked: stderr, age: null }
}

/** A consistent snapshot of the live test database, for the SQLite mode to read and write. */
function snapshot(): string {
  const copy = join(WORK, `copy-${++copyN}.db`)
  db.exec(`VACUUM INTO '${copy}'`)
  return copy
}

function contextOf(file: string): { status: string; tenant_id: string; source: string; session_id: string } | undefined {
  const c = new Database(file, { readonly: true })
  try {
    return c.prepare('SELECT status, tenant_id, source, session_id FROM agent_tenant_context WHERE agent_id = ?').get('agent-a') as never
  } finally { c.close() }
}

async function seed(): Promise<void> {
  for (const t of [['tenant-x', 'main-x'], ['tenant-y', null], ['tenant-m', 'agent-a'], ['tenant-z', null]] as const) {
    await dbx.run('INSERT INTO tenants (id, display_name, created_at, main_agent_id) VALUES (?, ?, ?, ?)', t[0], t[0], NOW, t[1])
  }
  await dbx.run('UPDATE tenants SET disabled_at = ? WHERE id = ?', NOW, 'tenant-z')
  for (const t of ['tenant-x', 'tenant-z']) await dbx.run('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 1)', t, 'agent-a')
  await dbx.run('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 0)', 'tenant-y', 'agent-a')
  const bind = (ch: string, ext: string, tenant: string, agent = 'agent-a') =>
    dbx.run('INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', agent, ch, ext, tenant, 'test', NOW, NOW)
  await bind('telegram', '111', 'tenant-x')
  await bind('telegram', '222', 'tenant-y')
  await bind('telegram', '333', 'default')
  await bind('telegram', '444', 'tenant-m')
  await bind('telegram', '555', 'tenant-z')
  await bind('inter-agent', 'partner-bot', 'tenant-x')
  const msg = (id: number, from: string, to: string, tenant: string) =>
    dbx.run("INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at, tenant_id) VALUES (?, ?, ?, 'x', 'done', ?, ?)", id, from, to, NOW, tenant)
  await msg(10, 'coord', 'agent-a', 'default')
  await msg(11, 'coord', 'agent-a', 'tenant-x')
  await msg(12, 'coord', 'agent-b', 'tenant-x')
  await msg(13, 'partner-bot', 'agent-a', 'default')
  await msg(14, 'coord', 'agent-a', 'tenant-y')
  const job = (id: string, agent: string, tenant: string) =>
    dbx.run("INSERT INTO schedules (id, agent, tenant_id, schedule) VALUES (?, ?, ?, '* * * * *')", id, agent, tenant)
  await job('job-x', 'agent-a', 'tenant-x')
  await job('job-d', 'agent-a', 'default')
  await job('job-y', 'agent-a', 'tenant-y')
  await job('job-b', 'agent-b', 'tenant-x')
  const skill = (id: string, name: string, content: string, tenant: string) =>
    dbx.run('INSERT INTO skills (id, name, content, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', id, name, content, tenant)
  await skill('global-handoff', 'handoff', 'x', 'fleet')
  await skill('tenant-x-demo', 'demo', '---\nname: demo-skill\n---\nbody', 'tenant-x')
  await skill('tenant-y-tool', 'tool', 'body', 'tenant-y')
  await skill('tenant-y-shared', 'shared', 'body', 'tenant-y')
  await dbx.run('INSERT INTO skill_tenant_access (skill_id, tenant_id) VALUES (?, ?)', 'tenant-y-shared', 'tenant-x')
}

describe.skipIf(testDbMode() === 'pg')('the Python hooks: SQLite mode and PG mode (the real route) say the same on the same data', () => {
  // registered BEFORE useTestDb: the file must be gone when initDatabase opens it, or the seed would run on the last test's rows
  beforeEach(() => { for (const f of [MAIN_DB, `${MAIN_DB}-wal`, `${MAIN_DB}-shm`]) rmSync(f, { force: true }) })
  useTestDb({ path: MAIN_DB })

  beforeAll(async () => {
    emptyDir = join(WORK, 'empty')
    mkdirSync(emptyDir)
    tokenFile = join(WORK, 'token')
    writeFileSync(tokenFile, TOKEN)
    server = http.createServer((req, res) => {
      requests++
      const url = new URL(req.url ?? '/', 'http://localhost')
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const ctx = {
        req, res, path: url.pathname.replace('/api/v1/', '/api/'), method: req.method ?? 'GET', url, role: 'fleet_agent',
        tokenAgentId: bearer === TOKEN ? 'agent-a' : undefined, tenantId: null,
      } as unknown as RouteContext
      tryHandleHooksTenant(ctx).then((handled) => { if (!handled) { res.writeHead(404); res.end('{}') } })
        .catch(() => { res.writeHead(500); res.end('{}') })
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()))
    rmSync(WORK, { recursive: true, force: true })
  })
  beforeEach(async () => { await seed(); requests = 0 })
  afterEach(() => { /* the database file is removed by the next beforeEach */ })

  it('tenant-context.py records the same context row in both modes, for every prompt', async () => {
    const seen = new Set<string>()
    for (const [name, prompt] of PROMPTS) {
      const copy = snapshot()
      const payload = { cwd: CWD, prompt, session_id: 's1' }
      const sqlite = await runPy('tenant-context.py', payload, sqliteEnv(copy))
      await dbx.run('DELETE FROM agent_tenant_context WHERE agent_id = ?', 'agent-a')
      const pg = await runPy('tenant-context.py', payload, pgEnv())
      const expected = contextOf(copy)
      const got = await dbx.get<{ status: string; tenant_id: string; source: string; session_id: string }>(
        'SELECT status, tenant_id, source, session_id FROM agent_tenant_context WHERE agent_id = ?', 'agent-a')
      expect(sqlite.code, `${name}: sqlite exit (${sqlite.stderr})`).toBe(0)
      expect(pg.code, `${name}: pg exit (${pg.stderr})`).toBe(0)
      expect(got, name).toEqual(expected)
      seen.add(`${expected?.status}`)
    }
    // not vacuous: the table reaches every status, and the PG side really asked the route
    expect([...seen].sort()).toEqual(['bound', 'conflict', 'default', 'unknown'])
    expect(requests).toBeGreaterThan(PROMPTS.length)
  }, 180000)

  it('tenant-skill-gate.py gives the same verdict and the same reason in both modes, for every context and call', async () => {
    let blocks = 0
    let allows = 0
    for (const c of CONTEXTS) {
      await dbx.run('DELETE FROM agent_tenant_context WHERE agent_id = ?', 'agent-a')
      if (c.row) {
        await dbx.run('INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          'agent-a', c.row.tenant, c.row.status, 'test', 's', Math.floor(Date.now() / 1000) - c.row.age)
      }
      const copy = snapshot()
      const runs = await Promise.all(CALLS.map(async ([tool, input]) => {
        const payload = { tool_name: tool, tool_input: input, cwd: CWD, session_id: 's1' }
        return [await runPy('tenant-skill-gate.py', payload, sqliteEnv(copy)), await runPy('tenant-skill-gate.py', payload, pgEnv())] as const
      }))
      runs.forEach(([sqlite, pg], i) => {
        const label = `${c.name} / ${CALLS[i]![0]} ${JSON.stringify(CALLS[i]![1]).slice(0, 80)}`
        expect(pg.code, label).toBe(sqlite.code)
        const sq = blankStaleAge(sqlite.stderr)
        const pgOut = blankStaleAge(pg.stderr)
        expect(pgOut.blanked, label).toBe(sq.blanked)
        if (sq.age !== null && pgOut.age !== null) expect(Math.abs(pgOut.age - sq.age), label).toBeLessThanOrEqual(2)
        if (sqlite.code === 2) blocks++
        else allows++
      })
    }
    expect(blocks).toBeGreaterThan(20)
    expect(allows).toBeGreaterThan(20)
  }, 240000)

  it('a skill answer for the caller names no other tenant, in the live route output the hook reads', async () => {
    await dbx.run('INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      'agent-a', 'tenant-x', 'bound', 'test', 's', Math.floor(Date.now() / 1000))
    const res = await fetch(`${baseUrl}/api/v1/hooks/skill-gate`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [{ kind: 'skill', value: 'tenant-y-tool', folded: 'tenant-y-tool' }, { kind: 'skill', value: 'tenant-y-shared', folded: 'tenant-y-shared' }] }),
    })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain('tenant-y"')   // tenant-y owns both skills; its id must not appear as an owner or a grantee
    expect(text).not.toContain('tenant-z')
    expect(text).not.toContain('body')        // no skill content
  })
})
