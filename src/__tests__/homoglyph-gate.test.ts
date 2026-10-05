import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectHomoglyphs, formatHomoglyphWarning, triggerLikeClause, TRIGGER_CHARS,
} from '../homoglyph.js'
import { initDatabase, getDb } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { tryHandleDailyLog } from '../web/routes/daily-log.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { tryHandleHomoglyphs } from '../web/routes/homoglyphs.js'
import type { RouteContext } from '../web/routes/types.js'

// GATEHOMOGLIFSWEEP816 (ported). Design pinned by these tests, in order of importance:
//  1. the gate WARNS and journals -- it never blocks and never rewrites
//     (four measured categories of legitimate Cyrillic/Greek content exist);
//  2. warnings cite CODEPOINTS, not the raw character, so the warning text
//     itself is not the next scan's hit;
//  3. the sqlite trigger path (agents write kanban via sqlite3, bypassing the
//     API) journals the same measured character set the detector knows.
// Strings below build the Cyrillic chars from codepoints on purpose -- a
// literal would make this file a hit for the fleet's artifact sweep.

const CYR_E = String.fromCodePoint(0x0435) // looks like 'e'
const CYR_ER = String.fromCodePoint(0x0440) // looks like 'p', reads 'r'

describe('detectHomoglyphs', () => {
  it('finds a Cyrillic letter inside a Hungarian word and cites its codepoint', () => {
    const findings = detectHomoglyphs(`a fej mer${CYR_E}se kesz`)
    expect(findings).toHaveLength(1)
    expect(findings[0].codepoint).toBe('U+0435')
    expect(findings[0].script).toBe('CYRILLIC')
    expect(findings[0].context).toContain('mer')
  })

  it('returns nothing for clean Hungarian text with real accents', () => {
    expect(detectHomoglyphs('árvíztűrő tükörfúrógép, mérése kész')).toHaveLength(0)
  })

  it('flags Greek letters too -- classification stays with the reader', () => {
    const findings = detectHomoglyphs('a route jele: λ')
    expect(findings).toHaveLength(1)
    expect(findings[0].script).toBe('GREEK')
  })
})

describe('formatHomoglyphWarning', () => {
  it('cites the codepoint and never the raw character', () => {
    const warning = formatHomoglyphWarning(detectHomoglyphs(`me${CYR_ER}es`))
    expect(warning).toContain('U+0440')
    expect(warning).not.toContain(CYR_ER)
    // and it must say the text was saved -- warn, not block
    expect(warning).toContain('Saved unchanged')
  })
})

describe('the shipped migration: kanban journal triggers on the real schema', () => {
  beforeAll(() => { initDatabase(':memory:') })
  const insertCard = (id: string, title: string) =>
    getDb().prepare('INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)').run(id, title, 'planned', 'normal')

  it('journals a corrupted comment without touching the row itself', () => {
    insertCard('C-HG1', 'clean title')
    const dirty = `a kartya mer${CYR_E}se kesz`
    getDb().prepare("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('C-HG1','t',?,1)").run(dirty)
    const rows = getDb().prepare("SELECT * FROM homoglyph_findings WHERE src_table = 'kanban_comments'").all() as { sample: string; resolved_at: number | null }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].sample).toContain('kartya')
    expect(rows[0].resolved_at).toBeNull()
    // never block, never rewrite: the stored comment is byte-identical
    const stored = getDb().prepare("SELECT content FROM kanban_comments WHERE card_id = 'C-HG1'").get() as { content: string }
    expect(stored.content).toBe(dirty)
  })

  it('journals a corrupted card title too', () => {
    insertCard('C-HG2', `cim ${CYR_E}s teszt`)
    const rows = getDb().prepare("SELECT src_id FROM homoglyph_findings WHERE src_table = 'kanban_cards'").all() as { src_id: string }[]
    expect(rows.map((r) => r.src_id)).toContain('C-HG2')
  })

  it('mutation control: a clean Hungarian insert journals nothing', () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM homoglyph_findings').get() as { n: number }).n
    insertCard('C-HG3', 'tiszta magyar szoveg, mérése kész, árvíztűrő')
    getDb().prepare("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('C-HG3','t',?,1)").run('tiszta, mérése kész')
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM homoglyph_findings').get() as { n: number }).n).toBe(before)
  })

  it('the migration and the detector agree on every journaled character', () => {
    const sql = readFileSync(join(__dirname, '..', 'migrations', '0069_homoglyph_findings.sql'), 'utf-8')
    // the WHEN clause in the migration is exactly the one the module generates
    expect(sql).toContain(triggerLikeClause('NEW.content'))
    expect(sql).toContain(triggerLikeClause('NEW.title'))
    for (const ch of TRIGGER_CHARS) {
      const findings = detectHomoglyphs(`x${ch}x`)
      expect(findings, `detector must flag U+${ch.codePointAt(0)?.toString(16)}`).toHaveLength(1)
      expect(findings[0].script).toBe('CYRILLIC')
    }
  })
})

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

describe('the write paths warn, never block', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('POST /api/memories: a lookalike is saved and comes back as homoglyph_warning', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'agent-a', content: `Kafe ${CYR_E}xpress rendeles`, category: 'warm' })
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(String(out.body.homoglyph_warning)).toContain('U+0435')
  })

  it('POST /api/memories: clean content carries no homoglyph_warning field', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'agent-a', content: 'plain latin text, 40 µs, H₂O', category: 'warm' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).not.toHaveProperty('homoglyph_warning')
  })

  it('POST /api/daily-log: warns on a lookalike, silent on clean text', async () => {
    const dirty = makeCtx('POST', '/api/daily-log', { agent_id: MAIN_AGENT_ID, content: `mer${CYR_E}se kesz` })
    await tryHandleDailyLog(dirty.ctx)
    expect(dirty.out.status).toBe(200)
    expect(String(dirty.out.body.homoglyph_warning)).toContain('U+0435')
    const clean = makeCtx('POST', '/api/daily-log', { agent_id: MAIN_AGENT_ID, content: 'mérése kész' })
    await tryHandleDailyLog(clean.ctx)
    expect(clean.out.body).toEqual({ ok: true })
  })

  it('POST /api/messages: a lookalike is accepted with 200 and a homoglyph_warning', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: `Kafe ${CYR_E}xpress order` })
    expect(await tryHandleMessages(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.id).toBeTruthy()
    expect(String(out.body.homoglyph_warning)).toContain('U+0435')
  })

  it('POST /api/messages: clean content (incl. 40 µs, H₂O) carries no homoglyph_warning', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'plain latin text, 40 µs, H₂O' })
    await tryHandleMessages(ctx)
    expect(out.status).toBe(200)
    expect(out.body).not.toHaveProperty('homoglyph_warning')
  })
})

describe('POST /api/messages: an unregistered local recipient is rejected at once (UNKNOWNTO924)', () => {
  const STOPPED = 'stopped-test-agent-homoglyph'
  beforeAll(() => { initDatabase(':memory:'); mkdirSync(agentDir(STOPPED), { recursive: true }) })
  afterAll(() => { rmSync(agentDir(STOPPED), { recursive: true, force: true }) })

  it('a placeholder recipient gets 400 and no message row', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', { from: MAIN_AGENT_ID, to: 'PLACEHOLDER', content: 'placeholder' })
    await tryHandleMessages(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('to')
    expect(String(out.body.hint)).toContain('unknown recipient')
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'PLACEHOLDER'").get() as { n: number }).n).toBe(0)
  })

  it('a registered but stopped agent keeps the retry path (accepted)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', { from: MAIN_AGENT_ID, to: STOPPED, content: 'ping' })
    await tryHandleMessages(ctx)
    expect(out.status).toBe(200)
  })

  it('the main agent as recipient is accepted', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'ping' })
    await tryHandleMessages(ctx)
    expect(out.status).toBe(200)
  })
})

describe('GET /api/homoglyphs (the read side of the journal)', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('is admin-only: it carries a text sample of other tenants\' kanban rows', () => {
    expect(resolveRequiredPermission('GET', '/api/homoglyphs')).toBeNull() // unmapped -> admin:all fallback
    expect(resolveRequiredPermission('POST', '/api/homoglyphs/1/resolve')).toBeNull()
  })

  it('lists unresolved findings and resolve closes one', async () => {
    getDb().prepare('INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)').run('C-HG9', `cim ${CYR_E}s`, 'planned', 'normal')
    const list = makeCtx('GET', '/api/homoglyphs')
    expect(await tryHandleHomoglyphs(list.ctx)).toBe(true)
    expect(list.out.body.findings).toHaveLength(1)
    const id = list.out.body.findings[0].id
    const resolve = makeCtx('POST', `/api/homoglyphs/${id}/resolve`)
    await tryHandleHomoglyphs(resolve.ctx)
    expect(resolve.out.body).toEqual({ ok: true, changed: 1 })
    const again = makeCtx('GET', '/api/homoglyphs')
    await tryHandleHomoglyphs(again.ctx)
    expect(again.out.body.findings).toHaveLength(0)
    const all = makeCtx('GET', '/api/homoglyphs?all=1')
    await tryHandleHomoglyphs(all.ctx)
    expect(all.out.body.findings).toHaveLength(1)
  })
})
