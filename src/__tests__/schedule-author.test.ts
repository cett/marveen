// The pure parts of the author check: the decision table, the per-tick memo, the mode word, the ledger kind and its
// precedence, the dead-letter view, and the live-data cell built through the real migration chain.
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../db-migrations.js'
import { authorGateMode, createAuthorChecker, decideAuthor, parseAuthorGateMode, type AuthorUser } from '../web/schedule-author.js'
import {
  MASS_SKIP_MIN_TASKS, SKIP_STATUS_AUTHOR_INACTIVE, SKIP_STATUS_AUTHOR_UNVERIFIABLE, classifyTask, createSkipTracker, type SkipLedgerDeps,
} from '../web/schedule-skip-ledger.js'
import { DEAD_LETTER_RUN_STATUSES } from '../db/tasks.js'
import { rowToTask, type ScheduledTask } from '../web/scheduled-tasks-io.js'
import { cronPrevOccurrence } from '../web/cron.js'

const user = (over: Partial<AuthorUser> = {}): AuthorUser => ({ disabled: 0, role: 'admin', tenant_id: null, ...over })
const t = (over: { authorUserId?: number; tenantId?: string | null } = {}) => ({ authorUserId: 1, tenantId: 'default', ...over })

describe('decideAuthor', () => {
  it.each([
    ['no user-bound author', t({ authorUserId: undefined }), 'error' as const, 'ok'],
    ['lookup failed', t(), 'error' as const, 'unverifiable'],
    ['user row gone', t(), undefined, 'inactive'],
    ['user disabled', t(), user({ disabled: 1 }), 'inactive'],
    // a tenant that matches the task: only the missing schedules:write right can make these inactive
    ['viewer of the task tenant', t({ tenantId: 'tenant-a' }), user({ role: 'viewer', tenant_id: 'tenant-a' }), 'inactive'],
    ['read_only of the task tenant', t({ tenantId: 'tenant-a' }), user({ role: 'read_only', tenant_id: 'tenant-a' }), 'inactive'],
    ['viewer', t(), user({ role: 'viewer' }), 'inactive'],
    ['admin, NULL tenant, task in default (THE critical cell)', t({ tenantId: 'default' }), user({ role: 'admin', tenant_id: null }), 'ok'],
    ['admin, NULL tenant, task with no tenant', t({ tenantId: null }), user({ role: 'admin', tenant_id: null }), 'ok'],
    ['admin, a tenant of its own, task in default', t({ tenantId: 'default' }), user({ role: 'admin', tenant_id: 'tenant-a' }), 'ok'],
    ['admin, another tenant, task in a third', t({ tenantId: 'tenant-b' }), user({ role: 'admin', tenant_id: 'tenant-a' }), 'ok'],
    ['admin disabled', t(), user({ role: 'admin', disabled: 1 }), 'inactive'],
    ['agent, same non-default tenant', t({ tenantId: 'tenant-a' }), user({ role: 'agent', tenant_id: 'tenant-a' }), 'ok'],
    ['agent, another tenant', t({ tenantId: 'tenant-b' }), user({ role: 'agent', tenant_id: 'tenant-a' }), 'inactive'],
    ['agent, task in default', t({ tenantId: 'default' }), user({ role: 'agent', tenant_id: 'default' }), 'inactive'],
    ['agent, task with no tenant (reads as default)', t({ tenantId: null }), user({ role: 'agent', tenant_id: 'default' }), 'inactive'],
    ['agent with no tenant', t({ tenantId: 'tenant-a' }), user({ role: 'agent', tenant_id: null }), 'inactive'],
  ])('%s -> %s', (_label, task, found, expected) => {
    expect(decideAuthor(task, found)).toBe(expected)
  })
})

describe('createAuthorChecker', () => {
  it('a task with no user-bound author never calls the lookup', async () => {
    const lookup = vi.fn<(id: number) => Promise<AuthorUser | undefined>>().mockRejectedValue(new Error('down'))
    const check = createAuthorChecker(lookup)
    expect(await check({ authorUserId: undefined, tenantId: 'default' })).toBe('ok')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('looks an author up once per checker, however many tasks (and concurrently)', async () => {
    const lookup = vi.fn<(id: number) => Promise<AuthorUser | undefined>>().mockResolvedValue(user())
    const check = createAuthorChecker(lookup)
    const verdicts = await Promise.all(Array.from({ length: 10 }, () => check(t())))
    expect(verdicts.every(v => v === 'ok')).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
    await check(t({ authorUserId: 2 }))
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('a rejected lookup is unverifiable, and a new checker asks again', async () => {
    const lookup = vi.fn<(id: number) => Promise<AuthorUser | undefined>>().mockRejectedValueOnce(new Error('down')).mockResolvedValue(user())
    expect(await createAuthorChecker(lookup)(t())).toBe('unverifiable')
    expect(await createAuthorChecker(lookup)(t())).toBe('ok')
  })
})

describe('the mode word', () => {
  it.each([['shadow', 'shadow'], [' SHADOW ', 'shadow'], ['enforce', 'enforce'], ['', 'enforce'], ['shadwo', 'enforce'], ['off', 'enforce'], ['0', 'enforce'], [undefined, 'enforce'], [1, 'enforce']])(
    '%j -> %s', (raw, expected) => { expect(parseAuthorGateMode(raw)).toBe(expected) })

  it('a config module without the key reads as enforce', () => {
    expect(authorGateMode()).toBe('enforce')
  })
})

describe('ledger kind and precedence', () => {
  it('author_blocked comes after disabled, not_live and tenant_mismatch, and only for a runnable task', () => {
    const live = { enabled: true, status: 'live' as const }
    expect(classifyTask(live, false, true)).toBe('author_blocked')
    expect(classifyTask(live, true, true)).toBe('tenant_mismatch')
    expect(classifyTask({ enabled: true, status: 'draft' }, true, true)).toBe('not_live')
    expect(classifyTask({ enabled: false, status: 'live' }, true, true)).toBe('disabled')
    expect(classifyTask(live, false, false)).toBe('runnable')
  })

  const MIN = 60_000
  const T0 = Date.UTC(2026, 8, 28, 22, 5, 0)
  const mk = (name: string): ScheduledTask => ({
    name, description: '', prompt: 'p', schedule: '*/30 * * * *', agent: 'agent-a', enabled: true,
    createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false, status: 'live', tenantId: 'default',
  }) as ScheduledTask
  const ledger = (blocked: Map<string, 'inactive' | 'unverifiable'>, mismatch = new Set<string>()) => {
    const rows: string[] = []
    const deps: SkipLedgerDeps = {
      cronPrevOccurrence: (s, from, to) => cronPrevOccurrence(s, from, to),
      targets: x => [x.agent],
      appendTaskRun: (name, agent, status) => { rows.push(`${name}|${agent}|${status}`) },
      tenantMismatch: x => mismatch.has(x.name),
      authorBlocked: x => blocked.get(x.name) ?? null,
    }
    return { rows, deps, tracker: createSkipTracker() }
  }

  it('one row per due occurrence, with the reason in the status; a task with a valid author gets none', () => {
    const { rows, deps, tracker } = ledger(new Map([['a', 'inactive'], ['b', 'unverifiable']]))
    tracker.scan([mk('a'), mk('b'), mk('ok')], T0 + 20 * MIN, T0 + 30 * MIN, deps)
    expect(rows.sort()).toEqual([`a|agent-a|${SKIP_STATUS_AUTHOR_INACTIVE}`, `b|agent-a|${SKIP_STATUS_AUTHOR_UNVERIFIABLE}`])
  })

  it('precedence: a task that is both a tenant mismatch and author-blocked leaves ONE row, the tenant one', () => {
    const { rows, deps, tracker } = ledger(new Map([['x', 'inactive']]), new Set(['x']))
    tracker.scan([mk('x')], T0 + 20 * MIN, T0 + 30 * MIN, deps)
    expect(rows).toEqual(['x|agent-a|skipped_tenant_mismatch'])
  })

  it('author-blocked tasks count as held for the mass-skip alert (threshold MASS_SKIP_MIN_TASKS)', () => {
    const names = Array.from({ length: MASS_SKIP_MIN_TASKS }, (_, i) => `m${i}`)
    const all = ledger(new Map(names.map(n => [n, 'inactive'] as const)))
    expect(all.tracker.scan(names.map(mk), T0 + 20 * MIN, T0 + 30 * MIN, all.deps).alert).toBe(true)
    const one = ledger(new Map([['m0', 'inactive']]))
    expect(one.tracker.scan(names.map(mk), T0 + 20 * MIN, T0 + 30 * MIN, one.deps).alert).toBe(false)
  })
})

describe('dead-letter statuses', () => {
  it('lists both author statuses (so the view shows what the author check held back)', () => {
    expect(DEAD_LETTER_RUN_STATUSES).toContain('skipped_author_inactive')
    expect(DEAD_LETTER_RUN_STATUSES).toContain('skipped_author_unverifiable')
  })
})

describe('live data through the real migration chain: 28 schedules of the default tenant, admin id 1 with no tenant', () => {
  const SRC = join(__dirname, '..', 'migrations')
  const build = (): { db: Database.Database; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'author-live-'))
    const files = readdirSync(SRC).filter(f => f.endsWith('.sql')).sort()
    for (const f of files.filter(x => x < '0096')) copyFileSync(join(SRC, f), join(dir, f))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    db.prepare("INSERT INTO dashboard_users (id, username, password_hash, role, tenant_id, disabled, created_at, updated_at) VALUES (1, 'admin-a', 'h', 'admin', NULL, 0, 1, 1)").run()
    const ins = db.prepare("INSERT INTO schedules (id, prompt, description, schedule, agent, type, enabled, tenant_id, status, command, created_at, updated_at) VALUES (?, 'p', 'd', '0 9 * * *', 'agent-a', ?, 1, 'default', 'live', ?, 1, 1)")
    for (const [type, n] of [['command', 9], ['heartbeat', 12], ['task', 7]] as const) {
      for (let i = 0; i < n; i++) ins.run(`${type}-${i}`, type, type === 'command' ? 'echo hi' : null)
    }
    copyFileSync(join(SRC, files.find(f => f.startsWith('0096'))!), join(dir, files.find(f => f.startsWith('0096'))!))
    applyMigrations(db, dir)
    return { db, dir }
  }
  const lookupIn = (db: Database.Database) => vi.fn((id: number) => Promise.resolve(db.prepare('SELECT disabled, role, tenant_id FROM dashboard_users WHERE id = ?').get(id) as AuthorUser | undefined))

  it('all 28 pass the check with one lookup; with the admin disabled all 28 are blocked (the cell measures)', async () => {
    const { db, dir } = build()
    try {
      const tasks = (db.prepare('SELECT * FROM schedules ORDER BY id').all() as Parameters<typeof rowToTask>[0][]).map(rowToTask)
      expect(tasks).toHaveLength(28)
      expect(tasks.every(x => x.authorUserId === 1 && x.tenantId === 'default')).toBe(true)
      const lookup = lookupIn(db)
      const check = createAuthorChecker(lookup)
      expect(await Promise.all(tasks.map(check))).toEqual(Array(28).fill('ok'))
      expect(lookup).toHaveBeenCalledTimes(1)

      db.prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = 1').run()
      const blocked = createAuthorChecker(lookupIn(db))
      expect(await Promise.all(tasks.map(blocked))).toEqual(Array(28).fill('inactive'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
