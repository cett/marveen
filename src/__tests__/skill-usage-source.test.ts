import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  initDatabase, getDb, logSkillUsage, getSkillUsageRows, getSkillUsageStats, getSkillUsageSummary,
} from '../db.js'
import { applyMigrations } from '../db-migrations.js'
import { tryHandleSkillUsage } from '../web/routes/skill-usage.js'
import type { RouteContext } from '../web/routes/types.js'

// Skill usage capture beyond the Skill tool: every row carries a `source` (migration 0070), the route
// validates it, and a repeat inside 60 s is one use. These run against the REAL db functions and the REAL
// route handler (the older skill-usage tests re-implement the SQL in a scratch database and so would
// stay green if the production statements broke).

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext, out }
}

async function post(body: object) {
  const { ctx, out } = makeCtx('POST', '/api/skill-usage', body)
  expect(await tryHandleSkillUsage(ctx)).toBe(true)
  return out
}

function rows(agent: string) {
  return getDb().prepare('SELECT * FROM skill_usage WHERE agent_id = ? ORDER BY id').all(agent) as any[]
}

function insertRaw(agent: string, skill: string, trigger: string, session: string | null, createdAt: number, source: string | null = null) {
  getDb().prepare(
    'INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at, source) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(agent, skill, trigger, session, createdAt, source)
}

const now = () => Math.floor(Date.now() / 1000)

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => { getDb().exec("DELETE FROM skill_usage WHERE agent_id LIKE 'src-%'") })
afterAll(() => { getDb().exec("DELETE FROM skill_usage WHERE agent_id LIKE 'src-%'") })

describe('POST /api/skill-usage with a source', () => {
  it('stores the source next to the trigger_type', async () => {
    const out = await post({ agent_id: 'src-a', skill_name: 'x', trigger_type: 'skill_read', session_id: 's1', source: 'bash_script' })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
    const [row] = rows('src-a')
    expect(row.source).toBe('bash_script')
    expect(row.trigger_type).toBe('skill_read')
  })

  it.each([
    ['skill_tool', 'tool_call'],
    ['read_tool', 'skill_read'],
    ['bash_read', 'skill_read'],
    ['bash_script', 'skill_read'],
    ['api_read', 'skill_read'],
    ['slash', 'tool_call'],
  ])('accepts %s with trigger_type %s', async (source, trigger) => {
    const out = await post({ agent_id: 'src-a', skill_name: `s-${source}`, trigger_type: trigger, session_id: 's', source })
    expect(out.status).toBe(200)
    expect(rows('src-a').find((r) => r.skill_name === `s-${source}`)?.source).toBe(source)
  })

  it('a request without source stays valid (an old hook) and stores NULL', async () => {
    const out = await post({ agent_id: 'src-a', skill_name: 'x', trigger_type: 'tool_call', session_id: 's1' })
    expect(out.status).toBe(200)
    expect(rows('src-a')[0].source).toBeNull()
  })

  it('an explicit null source is accepted like a missing one', async () => {
    const out = await post({ agent_id: 'src-a', skill_name: 'x', trigger_type: 'skill_read', source: null })
    expect(out.status).toBe(200)
    expect(rows('src-a')[0].source).toBeNull()
  })

  it.each(['nope', '', 'BASH_READ', 'toString', '__proto__', 'constructor'])('rejects the unknown source %j with 400 invalid_value on source', async (source) => {
    const out = await post({ agent_id: 'src-a', skill_name: 'x', trigger_type: 'skill_read', source })
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('source')
    // Reported as an unknown value, not as a trigger mismatch (an inherited key such as toString must not pass the lookup).
    expect(out.body.hint).toContain('must be one of')
    expect(rows('src-a')).toHaveLength(0)
  })

  it.each([
    ['skill_tool', 'skill_read'],
    ['bash_read', 'tool_call'],
    ['api_read', 'tool_call'],
    ['slash', 'skill_read'],
  ])('rejects source %s paired with trigger_type %s', async (source, trigger) => {
    const out = await post({ agent_id: 'src-a', skill_name: 'x', trigger_type: trigger, source })
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('source')
    expect(rows('src-a')).toHaveLength(0)
  })

  it('a bad trigger_type is still reported on trigger_type', async () => {
    const out = await post({ agent_id: 'src-a', skill_name: 'x', trigger_type: 'weird', source: 'bash_read' })
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('trigger_type')
  })

  it('missing required fields still 400', async () => {
    expect((await post({ agent_id: 'src-a', skill_name: 'x' })).status).toBe(400)
  })
})

describe('GET /api/skill-usage', () => {
  it('returns the source, and derives it for rows written before the column existed', async () => {
    const t = now()
    insertRaw('src-g', 'old-tool', 'tool_call', null, t - 5, null)
    insertRaw('src-g', 'old-read', 'skill_read', null, t - 4, null)
    insertRaw('src-g', 'new-bash', 'skill_read', 's', t - 3, 'bash_script')
    const { ctx, out } = makeCtx('GET', '/api/skill-usage?agent_id=src-g')
    await tryHandleSkillUsage(ctx)
    const bySkill = Object.fromEntries((out.body as any[]).map((r) => [r.skill_name, r.source]))
    expect(bySkill).toEqual({ 'old-tool': 'skill_tool', 'old-read': 'read_tool', 'new-bash': 'bash_script' })
  })

  it('getSkillUsageRows reports the derived legacy value too', () => {
    insertRaw('src-g', 'legacy', 'tool_call', null, now(), null)
    expect(getSkillUsageRows({ agentId: 'src-g' })[0].source).toBe('skill_tool')
  })
})

describe('60 second dedup', () => {
  it('the same agent, skill, session and source inside the window is one row', () => {
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_script')).toBe(true)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_script')).toBe(false)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_script')).toBe(false)
    expect(rows('src-d')).toHaveLength(1)
  })

  it('through the route too', async () => {
    const body = { agent_id: 'src-d', skill_name: 'x', trigger_type: 'skill_read', session_id: 's1', source: 'bash_read' }
    expect((await post(body)).status).toBe(200)
    expect((await post(body)).status).toBe(200)
    expect(rows('src-d')).toHaveLength(1)
  })

  it('a different session, source, skill or agent is a new row', () => {
    logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_script')
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's2', 'bash_script')).toBe(true)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_read')).toBe(true)
    expect(logSkillUsage('src-d', 'y', 'skill_read', 's1', 'bash_script')).toBe(true)
    expect(logSkillUsage('src-d2', 'x', 'skill_read', 's1', 'bash_script')).toBe(true)
    getDb().exec("DELETE FROM skill_usage WHERE agent_id = 'src-d2'")
    expect(rows('src-d')).toHaveLength(4)
  })

  it('writes again once the window has passed', () => {
    insertRaw('src-d', 'x', 'skill_read', 's1', now() - 61, 'bash_script')
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_script')).toBe(true)
    expect(rows('src-d')).toHaveLength(2)
  })

  it('still dedups right at the edge of the window', () => {
    insertRaw('src-d', 'x', 'skill_read', 's1', now() - 59, 'bash_script')
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_script')).toBe(false)
  })

  it('a missing session_id dedups against a missing session_id', () => {
    expect(logSkillUsage('src-d', 'x', 'skill_read', null, 'bash_read')).toBe(true)
    expect(logSkillUsage('src-d', 'x', 'skill_read', undefined, 'bash_read')).toBe(false)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_read')).toBe(true)
  })

  it('the Skill-tool row and the SKILL.md read of one invocation both persist', () => {
    expect(logSkillUsage('src-d', 'x', 'tool_call', 's1', 'skill_tool')).toBe(true)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'read_tool')).toBe(true)
    expect(rows('src-d')).toHaveLength(2)
  })

  it('an old hook (no source) keeps that pair apart: dedup keys on the derived source, not on NULL', () => {
    expect(logSkillUsage('src-d', 'x', 'tool_call', 's1')).toBe(true)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1')).toBe(true)
    expect(logSkillUsage('src-d', 'x', 'tool_call', 's1')).toBe(false)
    expect(rows('src-d')).toHaveLength(2)
  })

  it('an old-hook row and a new-hook row of the same path dedup each other', () => {
    insertRaw('src-d', 'x', 'skill_read', 's1', now(), null)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'read_tool')).toBe(false)
    expect(logSkillUsage('src-d', 'x', 'skill_read', 's1', 'bash_read')).toBe(true)
  })
})

describe('counters are untouched for existing rows', () => {
  it('summary and stats count NULL-source rows exactly as before', () => {
    const t = now()
    insertRaw('src-s', 'counted', 'tool_call', null, t - 100, null)
    insertRaw('src-s', 'counted', 'skill_read', null, t - 50, null)
    insertRaw('src-s', 'counted', 'skill_read', 's', t - 10, 'bash_script')
    const summary = getSkillUsageSummary().find((r) => r.skill_name === 'counted')!
    expect(summary.total_count).toBe(3)
    expect(summary.count_30d).toBe(3)
    expect(summary.last_used_at).toBe(t - 10)
    const stat = getSkillUsageStats().find((r) => r.skill_name === 'counted')!
    expect(stat.call_count).toBe(1)
    expect(stat.read_count).toBe(2)
    expect(stat.total_count).toBe(3)
  })

  it('the dream-engine bucket query shape (skill_name only) sees every source alike', () => {
    const t = now()
    insertRaw('src-s', 'dream-skill', 'skill_read', 's', t - 10, 'api_read')
    insertRaw('src-s', 'dream-skill', 'tool_call', 's', t - 20, null)
    const r = getDb().prepare(
      'SELECT skill_name, COUNT(*) AS n, MAX(created_at) AS last FROM skill_usage WHERE created_at > ? AND skill_name = ? GROUP BY skill_name',
    ).get(t - 86400, 'dream-skill') as any
    expect(r.n).toBe(2)
    expect(r.last).toBe(t - 10)
  })
})

describe('migration 0070', () => {
  function migrationsBefore70(dir: string) {
    for (const f of readdirSync(MIGRATIONS_DIR)) {
      if (f.endsWith('.sql') && f < '0070') copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f))
    }
  }

  it('a fresh database has the nullable source column', () => {
    const db = new Database(':memory:')
    applyMigrations(db, MIGRATIONS_DIR)
    const col = (db.prepare("PRAGMA table_info('skill_usage')").all() as any[]).find((c) => c.name === 'source')
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0)
    expect(col.dflt_value).toBeNull()
  })

  it('adds the column to a populated database (794 rows) without touching a row, then runs once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-usage-0070-'))
    try {
      migrationsBefore70(dir)
      const db = new Database(':memory:')
      applyMigrations(db, dir)
      const ins = db.prepare('INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES (?, ?, ?, ?, ?)')
      db.transaction(() => {
        for (let i = 0; i < 794; i++) ins.run(`agent-${i % 7}`, `skill-${i % 90}`, i % 9 === 0 ? 'skill_read' : 'tool_call', i % 5 ? `s${i}` : null, 1_700_000_000 + i)
      })()
      const before = db.prepare('SELECT id, agent_id, skill_name, trigger_type, session_id, created_at FROM skill_usage ORDER BY id').all()
      expect(before).toHaveLength(794)

      copyFileSync(join(MIGRATIONS_DIR, '0070_skill_usage_source.sql'), join(dir, '0070_skill_usage_source.sql'))
      applyMigrations(db, dir)

      const after = db.prepare('SELECT id, agent_id, skill_name, trigger_type, session_id, created_at FROM skill_usage ORDER BY id').all()
      expect(after).toEqual(before)
      expect((db.prepare('SELECT COUNT(*) AS n FROM skill_usage WHERE source IS NULL').get() as any).n).toBe(794)
      // The runner records it, and a second run does not try to add the column again.
      expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 70').get() as any).n).toBe(1)
      expect(() => applyMigrations(db, dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the trigger_type CHECK: the new value set never needed a table rebuild', () => {
    const db = new Database(':memory:')
    applyMigrations(db, MIGRATIONS_DIR)
    expect(() => db.prepare("INSERT INTO skill_usage (agent_id, skill_name, trigger_type, created_at) VALUES ('a','b','bash_read',1)").run()).toThrow()
  })
})
