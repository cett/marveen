// POST /api/fleet/import?apply=true writes the autonomy_categories table (level, locked, max_level straight from the
// body). It is the second door to the same escalation the dashboard route closed: raising a level is for a person logged
// in to the dashboard. The import validates every autonomy row and refuses, before anything is staged or written, an apply
// that WIDENS (a higher level or max_level, an unlocked category, a new category above level 1) without a dashboard
// session. Lowering and equal rows pass on a token, every level change is audited, a dry run lists the widenings.
// Real in-memory SQLite and the real importFleet; the same throwaway-directory harness as fleet-transfer-store-configs.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase, db, upsertAutonomyCategory, getAutonomyCategory } from '../db.js'

const { TMP_ROOT, STORE_DIR, TASKS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'fleet-autonomy-gate-test-'))
  const store = join(root, 'store')
  mkdirSync(store, { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: store, TASKS_DIR: join(root, 'tasks') }
})
afterAll(() => {
  const { rmSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => TMP_ROOT }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/mock/agents', listAgentNames: () => [], invalidateModelProfileMapCache: () => {} }))
vi.mock('../web/atomic-write.js', async () => {
  const { writeFileSync } = await import('node:fs')
  return { atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8') }
})
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: TASKS_DIR }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT, STORE_DIR, MAIN_AGENT_ID: 'agent-a', BOT_NAME: 'TestBot', BRAND_NAME: 'TestBot', OWNER_NAME: 'test', CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))

import { importFleet, checkAutonomyRows, AutonomyImportRefusedError } from '../web/fleet-transfer.js'

const row = (key: string, level: number, o: Record<string, unknown> = {}) => ({ key, label: key, level, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'src', ...o })
const fleet = (autonomy: unknown) => JSON.stringify({
  schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', sourceHost: 'test-host', agents: [], skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
  kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] }, ideaBox: { ideas: [], comments: [], statusLog: [] }, schedules: [], importSources: [],
  dashboardSettings: { autonomy, autoRestart: {}, agentsDesired: {}, norbertPersonal: {}, modelFallback: {}, federation: {}, costopsConfig: {}, egressAllowlist: {} },
})
const TOKEN = { apply: true, actor: 'main-token' }
const PERSON = { apply: true, humanSession: true, actor: 'owner' }
const stored = async (key: string) => { const r = await getAutonomyCategory(key); return r ? { level: r.level, locked: r.locked, max_level: r.max_level } : undefined }
const audits = () => (db.prepare("SELECT agent_id, entity_id, detail FROM agent_audit_log WHERE entity = 'approval' ORDER BY id").all() as Array<{ agent_id: string; entity_id: string; detail: string }>)
  .map((a) => ({ ...a, detail: JSON.parse(a.detail) as Record<string, unknown> }))
const refusal = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as AutonomyImportRefusedError } return null }

beforeEach(async () => {
  initDatabase(':memory:')
  vi.clearAllMocks()
  db.prepare('DELETE FROM agent_audit_log').run()
  await upsertAutonomyCategory({ key: 'skill_patch', label: 'Skill patch', level: 2, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })
  await upsertAutonomyCategory({ key: 'capped', label: 'Capped', level: 2, locked: 0, max_level: 2, timeout_minutes: null, updated_by: 'db' })
  await upsertAutonomyCategory({ key: 'payment', label: 'Payment', level: 1, locked: 1, max_level: 1, timeout_minutes: null, updated_by: 'db' })
})

describe('an apply that widens needs a dashboard session', () => {
  it('a token raising a level is refused with human_session_required, naming the key, and nothing is written', async () => {
    const e = await refusal(importFleet(fleet([row('skill_patch', 3)]), TOKEN))
    expect(e).toBeInstanceOf(AutonomyImportRefusedError)
    expect(e?.kind).toBe('human_session_required')
    expect(e?.message).toContain('skill_patch')
    expect(await stored('skill_patch')).toEqual({ level: 2, locked: 0, max_level: 3 })
    expect(audits()).toEqual([])
  })

  it('a token unlocking a locked category is refused, the category stays locked', async () => {
    const e = await refusal(importFleet(fleet([row('payment', 1, { max_level: 1, locked: 0 })]), TOKEN))
    expect(e?.kind).toBe('human_session_required')
    expect((await stored('payment'))?.locked).toBe(1)
  })

  it('a token raising max_level (the level itself unchanged) is refused', async () => {
    const e = await refusal(importFleet(fleet([row('capped', 2, { max_level: 3 })]), TOKEN))
    expect(e?.kind).toBe('human_session_required')
    expect((await stored('capped'))?.max_level).toBe(2)
  })

  it('a token adding a NEW category above level 1 is refused, at level 1 it is imported', async () => {
    expect((await refusal(importFleet(fleet([row('brand_new', 3)]), TOKEN)))?.kind).toBe('human_session_required')
    expect(await stored('brand_new')).toBeUndefined()
    const ok = await importFleet(fleet([row('brand_new', 1)]), TOKEN) as { ok: boolean }
    expect(ok.ok).toBe(true)
    expect(await stored('brand_new')).toEqual({ level: 1, locked: 0, max_level: 3 })
  })

  it('one widening row refuses the whole import: the rows that would only lower are not applied either', async () => {
    const e = await refusal(importFleet(fleet([row('capped', 1, { max_level: 2 }), row('skill_patch', 3)]), TOKEN))
    expect(e?.kind).toBe('human_session_required')
    expect((await stored('capped'))?.level).toBe(2)
  })

  it('a person logged in applies the widening, and the change is audited with who, from and to', async () => {
    const res = await importFleet(fleet([row('skill_patch', 3)]), PERSON) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect((await stored('skill_patch'))?.level).toBe(3)
    expect(audits()).toEqual([{ agent_id: 'owner', entity_id: 'skill_patch', detail: { autonomy_category: 'skill_patch', level_from: 2, level_to: 3 } }])
  })
})

describe('equal and lowering rows stay on the token', () => {
  it('equal rows import (no audit row), a lowered level imports and is audited with the token name', async () => {
    const res = await importFleet(fleet([row('skill_patch', 2), row('capped', 1, { max_level: 2 })]), TOKEN) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect((await stored('capped'))?.level).toBe(1)
    expect(audits()).toEqual([{ agent_id: 'main-token', entity_id: 'capped', detail: { autonomy_category: 'capped', level_from: 2, level_to: 1 } }])
  })

  it('lowering max_level and locking a category are tightening: a token may', async () => {
    const res = await importFleet(fleet([row('skill_patch', 2, { max_level: 2 }), row('capped', 1, { locked: 1, max_level: 1 })]), TOKEN) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(await stored('capped')).toEqual({ level: 1, locked: 1, max_level: 1 })
  })
})

describe('an invalid row is a 400 before anything is written', () => {
  const cases: Array<[string, unknown, string]> = [
    ['a level above 3', row('skill_patch', 4), 'level'],
    ['a level of 0', row('skill_patch', 0), 'level'],
    ['a fractional level', row('skill_patch', 2.5), 'level'],
    ['a level that is a string', row('skill_patch', 2, { level: '2' }), 'level'],
    ['a max_level of 0', row('skill_patch', 2, { max_level: 0 }), 'max_level'],
    ['a max_level above 3', row('skill_patch', 2, { max_level: 4 }), 'max_level'],
    ['locked as a boolean', row('skill_patch', 2, { locked: true }), 'locked'],
    ['locked as 2', row('skill_patch', 2, { locked: 2 }), 'locked'],
    ['a level above max_level', row('skill_patch', 3, { max_level: 2 }), 'level'],
    ['a locked row above level 1', row('skill_patch', 2, { locked: 1 }), 'locked'],
    ['a row without a key', { ...row('x', 1), key: '' }, 'key'],
    ['a row that is not an object', 'skill_patch', 'key'],
  ]
  for (const [label, bad, field] of cases) {
    it(`${label}: invalid_value naming the field, the table and the audit log unchanged (a valid row next to it is not applied)`, async () => {
      const e = await refusal(importFleet(fleet([row('capped', 1, { max_level: 2 }), bad]), PERSON))
      expect(e).toBeInstanceOf(AutonomyImportRefusedError)
      expect(e?.kind).toBe('invalid_value')
      expect(e?.field).toBe(field)
      expect((await stored('capped'))?.level).toBe(2)
      expect(audits()).toEqual([])
    })
  }
})

describe('a dry run lists the widenings instead of refusing', () => {
  it('apply=false with a widening row: no refusal, a warning names it, nothing is written', async () => {
    const report = await importFleet(fleet([row('skill_patch', 3)]), { apply: false }) as { warnings: string[] }
    expect(report.warnings.some((w) => w.includes('skill_patch') && w.includes('bővülne'))).toBe(true)
    expect((await stored('skill_patch'))?.level).toBe(2)
  })

  it('a dry run still refuses an invalid row', async () => {
    expect((await refusal(importFleet(fleet([row('skill_patch', 9)]), { apply: false })))?.kind).toBe('invalid_value')
  })
})

describe('checkAutonomyRows (the rule itself)', () => {
  const was = [{ key: 'a', label: 'a', level: 2, locked: 0, max_level: 3, timeout_minutes: null, updated_at: 0, updated_by: 'db', human_only: 0 }] as unknown as Parameters<typeof checkAutonomyRows>[1]
  it('names exactly the widening keys', () => {
    expect(checkAutonomyRows([row('a', 3), row('b', 1), row('c', 2)], was)).toEqual({ invalid: null, widenings: ['a', 'c'] })
    expect(checkAutonomyRows([row('a', 2), row('a', 1)], was).widenings).toEqual([])
  })
})
