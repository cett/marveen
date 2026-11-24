// The SHAPE of the row-level-security policies of migration 0009, one representative table per class, claimed through the app
// role with real contexts (`runAs`). The admin pool seeds and is the oracle: a "sees nothing" is only worth something next to
// an oracle row that exists, so every family asserts the seeded rows first. S4 does the exhaustive families; this file pins
// one table per class and the special branches (the empty-string tenant, `_multi_`, the NULL tenant, the global skill, the
// own-row branch, the append-only findings).
//
// The nine contexts: tenant A, tenant B, agent A (tenant A), the `_multi_` sentinel as a tenant, system, admin, viewer,
// public, and no context at all. `npm run test:pg`. Fixtures are neutral.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runAs, withDbContext } from '../../db/context.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import type { PgDbx } from '../../db/pg/dbx.js'

let db: PgTestDb
let dbx: PgDbx
let ids: { userA: number; userB: number; userAdmin: number; userNone: number }
let mem: { a1: number; a2: number; b1: number }

type Run = <T>(fn: () => Promise<T>) => Promise<T>
const CONTEXTS: Record<string, Run> = {
  'tenant A': (fn) => runAs.tenant('tenant-a', fn),
  'tenant B': (fn) => runAs.tenant('tenant-b', fn),
  'tenant C': (fn) => runAs.tenant('tenant-c', fn),
  'agent A': (fn) => runAs.agent('agent-a', 'tenant-a', fn),
  '_multi_': (fn) => runAs.tenant('_multi_', fn),
  system: (fn) => runAs.system('shape-cell', fn),
  admin: (fn) => runAs.admin('shape-cell', fn),
  viewer: (fn) => runAs.viewer('shape-cell', fn),
  public: (fn) => runAs.public('shape-cell', fn),
  empty: (fn) => fn(), // no context at all: fail closed
}
const PRIVILEGED = ['system', 'admin']
const TENANTLESS = ['viewer', 'public', 'empty']
const asUser = (userId: number): Run => (fn) => withDbContext({ role: 'viewer', name: 'shape-cell', userId: String(userId) }, fn)
const asTenantUser = (tenantId: string, userId: number): Run =>
  (fn) => withDbContext({ role: 'tenant', tenantId, userId: String(userId) }, fn)

const keys = async (run: Run, sql: string): Promise<string[]> => (await run(() => dbx.all<{ k: string }>(sql))).map((r) => r.k)
const oracle = async (sql: string): Promise<string[]> => (await db.pool.query<{ k: string }>(sql)).rows.map((r) => r.k)
const changes = async (run: Run, sql: string): Promise<number> => (await run(() => dbx.run(sql))).changes
const refused = (run: Run, sql: string) => expect(run(() => dbx.run(sql))).rejects.toMatchObject({ code: '42501' })

beforeAll(async () => {
  db = await createPgTestDb()
  dbx = db.appDbx()
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-a', 'Tenant A', 1), ('tenant-b', 'Tenant B', 1) ON CONFLICT DO NOTHING")
})
afterAll(async () => { await db.close() })

// every cell starts from the same seeded rows (the oracle writes them, the policies do not apply to it)
beforeEach(async () => {
  const q = (sql: string) => db.pool.query(sql)
  await q("DELETE FROM kanban_comments WHERE author LIKE 'shape-%'")
  await q("DELETE FROM kanban_cards WHERE id LIKE 'shape-%'")
  await q("DELETE FROM agent_audit_log WHERE entity LIKE 'shape-%'")
  await q("DELETE FROM memories WHERE content LIKE 'shape-%'") // the links cascade
  await q("DELETE FROM autonomy_categories WHERE key LIKE 'shape-%'")
  await q("DELETE FROM system_config WHERE key LIKE 'shape-%'")
  await q("DELETE FROM homoglyph_findings WHERE src_id LIKE 'shape-%'")
  await q("DELETE FROM auth_sessions WHERE id_hash LIKE 'shape-%'")
  await q("DELETE FROM dashboard_users WHERE username LIKE 'shape-u-%'")
  await q("DELETE FROM skill_tenant_access WHERE skill_id LIKE 'shape-sk-%'")
  await q("DELETE FROM skill_revisions WHERE skill_id LIKE 'shape-sk-%'")
  await q("DELETE FROM skills WHERE id LIKE 'shape-sk-%'")  // the files cascade

  // class A: one row per tenant value, including the sentinel and the EMPTY STRING (the missing-NULLIF mutant lives there)
  await q(`INSERT INTO kanban_cards (id, title, created_at, updated_at, tenant_id) VALUES
    ('shape-a', 'plain', 1, 1, 'tenant-a'), ('shape-b', 'plain', 1, 1, 'tenant-b'),
    ('shape-m', 'plain', 1, 1, '_multi_'), ('shape-e', 'plain', 1, 1, '')`)
  // class B: the same, and one row without a tenant
  await q(`INSERT INTO agent_audit_log (agent_id, entity, action, tenant_id) VALUES
    ('agent-x', 'shape-a', 'act', 'tenant-a'), ('agent-x', 'shape-b', 'act', 'tenant-b'),
    ('agent-x', 'shape-m', 'act', '_multi_'), ('agent-x', 'shape-e', 'act', ''), ('agent-x', 'shape-n', 'act', NULL)`)
  // class C: comments on those cards, and memories with links
  await q(`INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES
    ('shape-a', 'shape-c-a', 'x', 1), ('shape-b', 'shape-c-b', 'x', 1), ('shape-m', 'shape-c-m', 'x', 1), ('shape-e', 'shape-c-e', 'x', 1)`)
  const m = async (t: string, n: string): Promise<number> =>
    (await q(`INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, tenant_id)
      VALUES ('chat-x', 'shape-${n}', 'semantic', 1, 1, '${t}') RETURNING id`) as unknown as { rows: Array<{ id: number }> }).rows[0].id
  mem = { a1: await m('tenant-a', 'a1'), a2: await m('tenant-a', 'a2'), b1: await m('tenant-b', 'b1') }
  await q(`INSERT INTO memory_links (src_id, dst_id, link_type) VALUES
    (${mem.a1}, ${mem.a2}, 'explicit'), (${mem.a1}, ${mem.b1}, 'explicit'), (${mem.b1}, ${mem.b1}, 'explicit')`)
  // class D
  await q("INSERT INTO autonomy_categories (key, label) VALUES ('shape-cat', 'x')")
  await q("INSERT INTO system_config (key, value) VALUES ('shape-key', 'x')")
  await q("INSERT INTO homoglyph_findings (src_table, src_id, sample, found_at) VALUES ('kanban_cards', 'shape-seed', 'x', 1)")
  // class E
  const u = async (name: string, role: string, tenant: string | null): Promise<number> =>
    (await q(`INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role, tenant_id)
      VALUES ('${name}', 'hash-x', 1, 1, '${role}', ${tenant === null ? 'NULL' : `'${tenant}'`}) RETURNING id`) as unknown as { rows: Array<{ id: number }> }).rows[0].id
  ids = {
    userA: await u('shape-u-a', 'viewer', 'tenant-a'), userB: await u('shape-u-b', 'viewer', 'tenant-b'),
    userAdmin: await u('shape-u-admin', 'admin', 'tenant-a'), userNone: await u('shape-u-none', 'viewer', null),
  }
  await q(`INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES
    ('shape-s-a', ${ids.userA}, 'shape-u-a', 1, 1), ('shape-s-b', ${ids.userB}, 'shape-u-b', 1, 1)`)
  // class F: skills (one global, one granted) and the grants
  await q(`INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES
    ('shape-sk-a', 'n', 'x', 'tenant-a', 0), ('shape-sk-b', 'n', 'x', 'tenant-b', 0),
    ('shape-sk-g', 'n', 'x', 'tenant-b', 1), ('shape-sk-grant', 'n', 'x', 'tenant-b', 0)`)
  await q("INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by) VALUES ('shape-sk-grant', 'tenant-a', 'agent-x'), ('shape-sk-grant', 'tenant-c', 'agent-x')")
  // one file and one revision per skill (the revision of the global skill is the history of a skill every tenant sees)
  await q(`INSERT INTO skill_files (skill_id, rel_path, content) VALUES
    ('shape-sk-a', 'f.txt', decode('61', 'hex')), ('shape-sk-b', 'f.txt', decode('61', 'hex')),
    ('shape-sk-g', 'f.txt', decode('61', 'hex')), ('shape-sk-grant', 'f.txt', decode('61', 'hex'))`)
  await q(`INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES
    ('shape-sk-a', 'tenant-a', 1, 'create', 'system'), ('shape-sk-b', 'tenant-b', 1, 'create', 'system'),
    ('shape-sk-g', 'tenant-b', 1, 'create', 'system')`)
})

// ---------------------------------------------------------------------------------------------------------------------
// One family of cells for a tenant table (class A and B): reads, then the four write shapes. `insertFor(tenant, key)` is an
// INSERT stamped with that tenant (null = no tenant); `touch(key)` an UPDATE of the row `key` that changes no tenant.
// ---------------------------------------------------------------------------------------------------------------------
interface TenantFamily {
  table: string
  select: string
  all: string[]
  insertFor(tenant: string | null, key: string): string
  touch(key: string): string
  drop(key: string): string
  moveTo(key: string, tenant: string | null): string
}
const lit = (t: string | null): string => (t === null ? 'NULL' : `'${t}'`)

function tenantFamily(f: TenantFamily, extra?: () => void): void {
  const visible: Record<string, string[]> = {
    'tenant A': ['shape-a'], 'tenant B': ['shape-b'], 'agent A': ['shape-a'], _multi_: ['shape-m'],
    system: f.all, admin: f.all, viewer: [], public: [], empty: [],
  }
  describe(`${f.table}: the oracle holds every row (construction)`, () => {
    it('the seeded rows exist', async () => { expect(await oracle(f.select)).toEqual(f.all) })
  })

  describe(`${f.table}: reads`, () => {
    for (const [name, expected] of Object.entries(visible)) {
      it(`${name} sees ${JSON.stringify(expected)}`, async () => { expect(await keys(CONTEXTS[name], f.select)).toEqual(expected) })
    }
    it('a connection that ran a tenant transaction reads the EMPTY setting as no tenant: the empty-string row stays invisible', async () => {
      // the same connection serves tenant A, then a transaction that leaves the setting at '' ; the next work sees nothing
      const c = await db.appPool.connect()
      try {
        await c.query('BEGIN')
        await c.query("SELECT set_config('app.tenant_id', 'tenant-a', true), set_config('app.role', 'tenant', true)")
        expect((await c.query<{ k: string }>(f.select)).rows.map((r) => r.k)).toEqual(['shape-a'])
        await c.query('COMMIT')
        expect((await c.query("SELECT current_setting('app.tenant_id', true) AS v")).rows[0].v).toBe('') // the leftover is '', not NULL
        expect((await c.query('SELECT app.tenant() AS v')).rows[0].v).toBeNull() // and the helper turns it into NULL
        expect((await c.query<{ k: string }>(f.select)).rows).toEqual([]) // the '' tenant row does not match
      } finally { c.release() }
    })
  })

  describe(`${f.table}: a tenant or agent context writes only its own rows`, () => {
    for (const name of ['tenant A', 'agent A']) {
      const run = CONTEXTS[name]
      it(`${name}: UPDATE and DELETE of another tenant's row touch 0 rows (the row is still there)`, async () => {
        expect(await changes(run, f.touch('shape-b'))).toBe(0)
        expect(await changes(run, f.drop('shape-b'))).toBe(0)
        expect(await oracle(f.select)).toEqual(f.all)
      })
      it(`${name}: an INSERT stamped with another tenant, the empty string or the sentinel fails with 42501`, async () => {
        await refused(run, f.insertFor('tenant-b', 'shape-x'))
        await refused(run, f.insertFor('', 'shape-x'))
        await refused(run, f.insertFor('_multi_', 'shape-x'))
        expect(await oracle(f.select)).toEqual(f.all)
      })
      it(`${name}: moving its own row to another tenant fails with 42501, and its own insert and update work`, async () => {
        await refused(run, f.moveTo('shape-a', 'tenant-b'))
        await refused(run, f.moveTo('shape-a', ''))
        await changes(run, f.insertFor('tenant-a', 'shape-x'))
        expect(await changes(run, f.touch('shape-a'))).toBe(1)
        expect(await oracle(f.select)).toContain('shape-x')
      })
    }
    it('the sentinel is no wildcard: a real tenant never sees or touches the sentinel row, the sentinel context sees only its own', async () => {
      expect(await changes(CONTEXTS['tenant A'], f.touch('shape-m'))).toBe(0)
      expect(await changes(CONTEXTS['_multi_'], f.touch('shape-a'))).toBe(0)
      expect(await changes(CONTEXTS['_multi_'], f.touch('shape-m'))).toBe(1)
    })
  })

  describe(`${f.table}: a context without a tenant writes nothing`, () => {
    for (const name of TENANTLESS) {
      it(`${name}: UPDATE and DELETE touch 0 rows, an INSERT fails with 42501`, async () => {
        const run = CONTEXTS[name]
        expect(await changes(run, f.touch('shape-a'))).toBe(0)
        expect(await changes(run, f.drop('shape-a'))).toBe(0)
        await refused(run, f.insertFor('tenant-a', 'shape-x'))
        await refused(run, f.insertFor('', 'shape-x'))
        expect(await oracle(f.select)).toEqual(f.all)
      })
    }
  })

  describe(`${f.table}: system and admin see and write every row`, () => {
    for (const name of PRIVILEGED) {
      it(`${name}: updates another tenant's row, inserts for any tenant, deletes`, async () => {
        const run = CONTEXTS[name]
        expect(await changes(run, f.touch('shape-b'))).toBe(1)
        await changes(run, f.insertFor('tenant-b', 'shape-x'))
        expect(await changes(run, f.drop('shape-x'))).toBe(1)
      })
    }
  })
  extra?.()
}

tenantFamily({
  table: 'class A kanban_cards',
  select: "SELECT id AS k FROM kanban_cards WHERE id LIKE 'shape-%' ORDER BY id",
  all: ['shape-a', 'shape-b', 'shape-e', 'shape-m'],
  insertFor: (t, k) => `INSERT INTO kanban_cards (id, title, created_at, updated_at, tenant_id) VALUES ('${k}', 'plain', 1, 1, ${lit(t)})`,
  touch: (k) => `UPDATE kanban_cards SET title = 'changed' WHERE id = '${k}'`,
  drop: (k) => `DELETE FROM kanban_cards WHERE id = '${k}'`,
  moveTo: (k, t) => `UPDATE kanban_cards SET tenant_id = ${lit(t)} WHERE id = '${k}'`,
})

tenantFamily({
  table: 'class B agent_audit_log',
  select: "SELECT entity AS k FROM agent_audit_log WHERE entity LIKE 'shape-%' ORDER BY entity",
  all: ['shape-a', 'shape-b', 'shape-e', 'shape-m', 'shape-n'],
  insertFor: (t, k) => `INSERT INTO agent_audit_log (agent_id, entity, action, tenant_id) VALUES ('agent-x', '${k}', 'act', ${lit(t)})`,
  touch: (k) => `UPDATE agent_audit_log SET action = 'changed' WHERE entity = '${k}'`,
  drop: (k) => `DELETE FROM agent_audit_log WHERE entity = '${k}'`,
  moveTo: (k, t) => `UPDATE agent_audit_log SET tenant_id = ${lit(t)} WHERE entity = '${k}'`,
}, () => {
  describe('class B: the NULL tenant', () => {
    it('a tenant, an agent and the sentinel context neither read nor touch the unattributed row; system and admin do', async () => {
      const sel = "SELECT entity AS k FROM agent_audit_log WHERE entity = 'shape-n'"
      for (const name of ['tenant A', 'tenant B', 'agent A', '_multi_', 'viewer', 'public', 'empty']) expect(await keys(CONTEXTS[name], sel)).toEqual([])
      for (const name of PRIVILEGED) expect(await keys(CONTEXTS[name], sel)).toEqual(['shape-n'])
      expect(await changes(CONTEXTS['tenant A'], "UPDATE agent_audit_log SET action = 'changed' WHERE entity = 'shape-n'")).toBe(0)
      expect(await changes(CONTEXTS['tenant A'], "DELETE FROM agent_audit_log WHERE entity = 'shape-n'")).toBe(0)
    })
    it('a tenant cannot write a NULL-tenant row, neither by INSERT nor by clearing the tenant of its own row (42501)', async () => {
      await refused(CONTEXTS['tenant A'], "INSERT INTO agent_audit_log (agent_id, entity, action, tenant_id) VALUES ('agent-x', 'shape-x', 'act', NULL)")
      await refused(CONTEXTS['agent A'], "INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-x', 'shape-x', 'act')") // tenant column omitted = NULL
      await refused(CONTEXTS['tenant A'], "UPDATE agent_audit_log SET tenant_id = NULL WHERE entity = 'shape-a'")
      expect(await oracle("SELECT tenant_id AS k FROM agent_audit_log WHERE entity = 'shape-a'")).toEqual(['tenant-a'])
    })
    it('system may write a NULL-tenant row', async () => {
      await changes(CONTEXTS.system, "INSERT INTO agent_audit_log (agent_id, entity, action, tenant_id) VALUES ('agent-x', 'shape-x', 'act', NULL)")
      expect(await oracle("SELECT entity AS k FROM agent_audit_log WHERE entity = 'shape-x'")).toEqual(['shape-x'])
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('class C: a child follows its parent', () => {
  const COMMENTS = "SELECT author AS k FROM kanban_comments WHERE author LIKE 'shape-%' ORDER BY author"
  const ALL = ['shape-c-a', 'shape-c-b', 'shape-c-e', 'shape-c-m']
  it('the oracle holds every comment (construction)', async () => { expect(await oracle(COMMENTS)).toEqual(ALL) })

  const visible: Record<string, string[]> = {
    'tenant A': ['shape-c-a'], 'tenant B': ['shape-c-b'], 'agent A': ['shape-c-a'], _multi_: ['shape-c-m'],
    system: ALL, admin: ALL, viewer: [], public: [], empty: [],
  }
  for (const [name, expected] of Object.entries(visible)) {
    it(`kanban_comments: ${name} sees ${JSON.stringify(expected)}`, async () => { expect(await keys(CONTEXTS[name], COMMENTS)).toEqual(expected) })
  }

  it('kanban_comments: a comment on a card of another tenant, or on an invisible card, cannot be inserted (42501)', async () => {
    await refused(CONTEXTS['tenant A'], "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('shape-b', 'shape-c-x', 'x', 1)")
    await refused(CONTEXTS['tenant A'], "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('shape-e', 'shape-c-x', 'x', 1)")
    await refused(CONTEXTS['tenant A'], "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('no-such-card', 'shape-c-x', 'x', 1)")
    for (const name of TENANTLESS) await refused(CONTEXTS[name], "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('shape-a', 'shape-c-x', 'x', 1)")
    expect(await oracle(COMMENTS)).toEqual(ALL)
  })
  it('kanban_comments: a comment on its own card works; re-pointing it at another tenant card fails (42501); another tenant comment is untouchable', async () => {
    await changes(CONTEXTS['tenant A'], "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('shape-a', 'shape-c-x', 'x', 1)")
    await refused(CONTEXTS['tenant A'], "UPDATE kanban_comments SET card_id = 'shape-b' WHERE author = 'shape-c-a'")
    expect(await changes(CONTEXTS['tenant A'], "UPDATE kanban_comments SET content = 'changed' WHERE author = 'shape-c-b'")).toBe(0)
    expect(await changes(CONTEXTS['tenant A'], "DELETE FROM kanban_comments WHERE author = 'shape-c-b'")).toBe(0)
    expect(await oracle("SELECT card_id AS k FROM kanban_comments WHERE author = 'shape-c-a'")).toEqual(['shape-a'])
  })
  it('kanban_comments: system writes a comment on any card', async () => {
    await changes(CONTEXTS.system, "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('shape-b', 'shape-c-x', 'x', 1)")
    expect(await oracle("SELECT author AS k FROM kanban_comments WHERE author = 'shape-c-x'")).toEqual(['shape-c-x'])
  })

  // memory_links has TWO parents: a link with one invisible end is invisible
  const linkCount = async (run: Run): Promise<number> =>
    (await run(() => dbx.get<{ n: number }>(`SELECT count(*)::int AS n FROM memory_links WHERE src_id IN (${mem.a1}, ${mem.a2}, ${mem.b1})`)))?.n ?? -1
  it('memory_links: the oracle holds three links (construction)', async () => {
    expect((await db.pool.query(`SELECT 1 FROM memory_links WHERE src_id IN (${mem.a1}, ${mem.a2}, ${mem.b1})`)).rowCount).toBe(3)
  })
  it('memory_links: a link is visible only when BOTH ends are (a1 to a2 for tenant A, b1 to b1 for tenant B, a1 to b1 for neither)', async () => {
    expect(await linkCount(CONTEXTS['tenant A'])).toBe(1)
    expect(await linkCount(CONTEXTS['tenant B'])).toBe(1)
    expect(await linkCount(CONTEXTS['agent A'])).toBe(1)
    expect(await linkCount(CONTEXTS.system)).toBe(3)
    expect(await linkCount(CONTEXTS.admin)).toBe(3)
    for (const name of [...TENANTLESS, '_multi_']) expect(await linkCount(CONTEXTS[name])).toBe(0)
  })
  it('memory_links: a link to a memory of another tenant cannot be written (42501), an own link can', async () => {
    await refused(CONTEXTS['tenant A'], `INSERT INTO memory_links (src_id, dst_id, link_type) VALUES (${mem.a2}, ${mem.b1}, 'explicit')`)
    await refused(CONTEXTS['tenant A'], `INSERT INTO memory_links (src_id, dst_id, link_type) VALUES (${mem.b1}, ${mem.a2}, 'explicit')`)
    await changes(CONTEXTS['tenant A'], `INSERT INTO memory_links (src_id, dst_id, link_type) VALUES (${mem.a2}, ${mem.a1}, 'explicit')`)
    expect(await changes(CONTEXTS['tenant A'], `DELETE FROM memory_links WHERE src_id = ${mem.a1} AND dst_id = ${mem.b1}`)).toBe(0)
    expect((await db.pool.query(`SELECT 1 FROM memory_links WHERE src_id = ${mem.a1} AND dst_id = ${mem.b1}`)).rowCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('class D1: readable by every context, written by the privileged roles', () => {
  const SEL = "SELECT key AS k FROM autonomy_categories WHERE key LIKE 'shape-%'"
  it('the oracle holds the row (construction)', async () => { expect(await oracle(SEL)).toEqual(['shape-cat']) })
  for (const name of Object.keys(CONTEXTS)) {
    it(`${name} reads the row`, async () => { expect(await keys(CONTEXTS[name], SEL)).toEqual(['shape-cat']) })
  }
  for (const name of Object.keys(CONTEXTS).filter((n) => !PRIVILEGED.includes(n))) {
    it(`${name} cannot write it: INSERT 42501, UPDATE and DELETE touch 0 rows`, async () => {
      await refused(CONTEXTS[name], "INSERT INTO autonomy_categories (key, label) VALUES ('shape-new', 'x')")
      expect(await changes(CONTEXTS[name], "UPDATE autonomy_categories SET label = 'changed' WHERE key = 'shape-cat'")).toBe(0)
      expect(await changes(CONTEXTS[name], "DELETE FROM autonomy_categories WHERE key = 'shape-cat'")).toBe(0)
      expect(await oracle("SELECT label AS k FROM autonomy_categories WHERE key = 'shape-cat'")).toEqual(['x'])
    })
  }
  for (const name of PRIVILEGED) {
    it(`${name} writes it`, async () => {
      expect(await changes(CONTEXTS[name], "UPDATE autonomy_categories SET label = 'changed' WHERE key = 'shape-cat'")).toBe(1)
      await changes(CONTEXTS[name], "INSERT INTO autonomy_categories (key, label) VALUES ('shape-new', 'x')")
      expect(await changes(CONTEXTS[name], "DELETE FROM autonomy_categories WHERE key = 'shape-new'")).toBe(1)
    })
  }
})

describe('class D2: the privileged roles only', () => {
  const SEL = "SELECT key AS k FROM system_config WHERE key LIKE 'shape-%'"
  it('the oracle holds the row (construction)', async () => { expect(await oracle(SEL)).toEqual(['shape-key']) })
  for (const name of Object.keys(CONTEXTS)) {
    const priv = PRIVILEGED.includes(name)
    it(`${name} ${priv ? 'reads and writes' : 'reads nothing and writes nothing'}`, async () => {
      expect(await keys(CONTEXTS[name], SEL)).toEqual(priv ? ['shape-key'] : [])
      if (priv) {
        expect(await changes(CONTEXTS[name], "UPDATE system_config SET value = 'changed' WHERE key = 'shape-key'")).toBe(1)
      } else {
        await refused(CONTEXTS[name], "INSERT INTO system_config (key, value) VALUES ('shape-new', 'x')")
        expect(await changes(CONTEXTS[name], "UPDATE system_config SET value = 'changed' WHERE key = 'shape-key'")).toBe(0)
        expect(await changes(CONTEXTS[name], "DELETE FROM system_config WHERE key = 'shape-key'")).toBe(0)
        expect(await oracle("SELECT value AS k FROM system_config WHERE key = 'shape-key'")).toEqual(['x'])
      }
    })
  }
})

describe('class D3: append-only findings', () => {
  const SEL = "SELECT src_id AS k FROM homoglyph_findings WHERE src_id LIKE 'shape-%' ORDER BY src_id"
  it('the oracle holds the seeded finding (construction)', async () => { expect(await oracle(SEL)).toEqual(['shape-seed']) })
  for (const name of Object.keys(CONTEXTS)) {
    const priv = PRIVILEGED.includes(name)
    it(`${name} can append a finding, ${priv ? 'reads it and may change it' : 'cannot read, change or delete any'}`, async () => {
      await changes(CONTEXTS[name], `INSERT INTO homoglyph_findings (src_table, src_id, sample, found_at) VALUES ('kanban_cards', 'shape-from-${name.replace(/\W/g, '')}', 'x', 1)`)
      expect((await oracle(SEL)).length).toBe(2)
      if (priv) {
        expect((await keys(CONTEXTS[name], SEL)).length).toBe(2)
        expect(await changes(CONTEXTS[name], "UPDATE homoglyph_findings SET sample = 'changed' WHERE src_id = 'shape-seed'")).toBe(1)
      } else {
        expect(await keys(CONTEXTS[name], SEL)).toEqual([])
        expect(await changes(CONTEXTS[name], "UPDATE homoglyph_findings SET sample = 'changed' WHERE src_id = 'shape-seed'")).toBe(0)
        expect(await changes(CONTEXTS[name], "DELETE FROM homoglyph_findings WHERE src_id = 'shape-seed'")).toBe(0)
        expect(await oracle("SELECT sample AS k FROM homoglyph_findings WHERE src_id = 'shape-seed'")).toEqual(['x'])
      }
    })
  }
  it('a tenant INSERT of a card with a look-alike title succeeds through the real trigger, and the finding cannot be read back by the tenant', async () => {
    for (const name of ['tenant A', 'agent A']) {
      const id = `shape-h-${name.replace(/\W/g, '')}`
      await changes(CONTEXTS[name], `INSERT INTO kanban_cards (id, title, created_at, updated_at, tenant_id) VALUES ('${id}', 'titаle', 1, 1, 'tenant-a')`)
      expect(await oracle(`SELECT src_id AS k FROM homoglyph_findings WHERE src_id = '${id}'`)).toEqual([id]) // the trigger wrote it
      expect(await keys(CONTEXTS[name], `SELECT src_id AS k FROM homoglyph_findings WHERE src_id = '${id}'`)).toEqual([])
      expect(await keys(CONTEXTS.system, `SELECT src_id AS k FROM homoglyph_findings WHERE src_id = '${id}'`)).toEqual([id])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('class E: the auth tables, own row only', () => {
  const USERS = "SELECT username AS k FROM dashboard_users WHERE username LIKE 'shape-u-%' ORDER BY username"
  const SESSIONS = "SELECT id_hash AS k FROM auth_sessions WHERE id_hash LIKE 'shape-%' ORDER BY id_hash"
  it('the oracle holds four users and two sessions (construction)', async () => {
    expect(await oracle(USERS)).toEqual(['shape-u-a', 'shape-u-admin', 'shape-u-b', 'shape-u-none'])
    expect(await oracle(SESSIONS)).toEqual(['shape-s-a', 'shape-s-b'])
  })

  it('dashboard_users: a tenant sees the users of its own tenant except a global admin; without a user id nothing else', async () => {
    expect(await keys(CONTEXTS['tenant A'], USERS)).toEqual(['shape-u-a'])
    expect(await keys(CONTEXTS['agent A'], USERS)).toEqual(['shape-u-a'])
    expect(await keys(CONTEXTS['tenant B'], USERS)).toEqual(['shape-u-b'])
    expect(await keys(CONTEXTS['_multi_'], USERS)).toEqual([])
  })
  it('dashboard_users: the public, a viewer and the empty context without a user id see nothing', async () => {
    for (const name of TENANTLESS) expect(await keys(CONTEXTS[name], USERS)).toEqual([])
  })
  it('dashboard_users: a session user sees its OWN row, in any role; a tenant also keeps its tenant rows', async () => {
    expect(await keys(asUser(ids.userNone), USERS)).toEqual(['shape-u-none'])
    expect(await keys(asUser(ids.userA), USERS)).toEqual(['shape-u-a'])
    expect(await keys(asUser(ids.userAdmin), USERS)).toEqual(['shape-u-admin'])
    expect(await keys(asTenantUser('tenant-a', ids.userAdmin), USERS)).toEqual(['shape-u-a', 'shape-u-admin']) // the own_row branch, not the tenant one
    expect(await keys(asTenantUser('tenant-b', ids.userAdmin), USERS)).toEqual(['shape-u-admin', 'shape-u-b'])
  })
  it('dashboard_users: system and admin see all four', async () => {
    for (const name of PRIVILEGED) expect(await keys(CONTEXTS[name], USERS)).toEqual(['shape-u-a', 'shape-u-admin', 'shape-u-b', 'shape-u-none'])
  })
  it('dashboard_users: a malformed or out-of-range user id gives zero rows, not an error', async () => {
    const c = await db.appPool.connect()
    try {
      for (const bad of ['', 'abc', '1 OR 1=1', '-1', '1e3', '12345678901234567890', '0x10', ' 1']) {
        await c.query('BEGIN')
        await c.query("SELECT set_config('app.role', 'viewer', true), set_config('app.user_id', $1, true)", [bad])
        expect((await c.query('SELECT username FROM dashboard_users')).rows, `user id ${JSON.stringify(bad)}`).toEqual([])
        expect((await c.query('SELECT id_hash FROM auth_sessions')).rows).toEqual([])
        await c.query('COMMIT')
      }
    } finally { c.release() }
  })
  it('dashboard_users: the own-row branch compares the user id with the row id (a user id of another row shows that row only)', async () => {
    expect(await keys(asUser(ids.userB), USERS)).toEqual(['shape-u-b'])
    expect(await keys(asUser(ids.userB), USERS)).not.toContain('shape-u-a')
  })
  it('dashboard_users: only reading is open: a viewer cannot update or delete its own row, a public context cannot insert', async () => {
    expect(await changes(asUser(ids.userNone), "UPDATE dashboard_users SET display_name = 'changed' WHERE username = 'shape-u-none'")).toBe(0)
    expect(await changes(asUser(ids.userNone), "DELETE FROM dashboard_users WHERE username = 'shape-u-none'")).toBe(0)
    await refused(CONTEXTS.public, "INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES ('shape-u-new', 'h', 1, 1)")
    expect(await oracle("SELECT display_name AS k FROM dashboard_users WHERE username = 'shape-u-none'")).toEqual([null])
  })
  it('dashboard_users: a tenant cannot create or promote a global admin (42501) and cannot touch another tenant user', async () => {
    await refused(CONTEXTS['tenant A'], "INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role, tenant_id) VALUES ('shape-u-new', 'h', 1, 1, 'admin', 'tenant-a')")
    await refused(CONTEXTS['tenant A'], "UPDATE dashboard_users SET role = 'admin' WHERE username = 'shape-u-a'")
    await refused(CONTEXTS['tenant A'], "INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role, tenant_id) VALUES ('shape-u-new', 'h', 1, 1, 'viewer', 'tenant-b')")
    expect(await changes(CONTEXTS['tenant A'], "UPDATE dashboard_users SET display_name = 'changed' WHERE username = 'shape-u-b'")).toBe(0)
    expect(await changes(CONTEXTS['tenant A'], "DELETE FROM dashboard_users WHERE username = 'shape-u-b'")).toBe(0)
    expect(await oracle("SELECT role AS k FROM dashboard_users WHERE username = 'shape-u-a'")).toEqual(['viewer'])
  })
  it('dashboard_users: a tenant cannot read the password hash of another tenant user directly', async () => {
    expect(await keys(CONTEXTS['tenant A'], "SELECT password_hash AS k FROM dashboard_users WHERE username = 'shape-u-b'")).toEqual([])
  })

  it('auth_sessions: a session user sees its own sessions only, whatever the role; no user id sees none', async () => {
    expect(await keys(asUser(ids.userA), SESSIONS)).toEqual(['shape-s-a'])
    expect(await keys(asUser(ids.userB), SESSIONS)).toEqual(['shape-s-b'])
    expect(await keys(asTenantUser('tenant-a', ids.userA), SESSIONS)).toEqual(['shape-s-a'])
    for (const name of ['tenant A', 'tenant B', 'agent A', '_multi_', ...TENANTLESS]) expect(await keys(CONTEXTS[name], SESSIONS)).toEqual([])
    for (const name of PRIVILEGED) expect(await keys(CONTEXTS[name], SESSIONS)).toEqual(['shape-s-a', 'shape-s-b'])
  })
  it('auth_sessions: the public context can neither insert, update nor delete a session', async () => {
    await refused(CONTEXTS.public, `INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('shape-s-x', ${ids.userA}, 'x', 1, 1)`)
    expect(await changes(CONTEXTS.public, "UPDATE auth_sessions SET username = 'changed' WHERE id_hash = 'shape-s-a'")).toBe(0)
    expect(await changes(CONTEXTS.public, "DELETE FROM auth_sessions WHERE id_hash = 'shape-s-a'")).toBe(0)
    expect(await oracle(SESSIONS)).toEqual(['shape-s-a', 'shape-s-b'])
  })
  it('auth_sessions: a session user creates and revokes its own session, and cannot create or revoke another user\'s', async () => {
    await changes(asUser(ids.userA), `INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('shape-s-new', ${ids.userA}, 'shape-u-a', 1, 1)`)
    await refused(asUser(ids.userA), `INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('shape-s-x', ${ids.userB}, 'shape-u-b', 1, 1)`)
    expect(await changes(asUser(ids.userA), "DELETE FROM auth_sessions WHERE id_hash = 'shape-s-b'")).toBe(0)
    expect(await changes(asUser(ids.userA), "DELETE FROM auth_sessions WHERE id_hash = 'shape-s-new'")).toBe(1)
    expect(await oracle(SESSIONS)).toEqual(['shape-s-a', 'shape-s-b'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('class F: tenants, skills and the skill grants', () => {
  const TENANTS = "SELECT id AS k FROM tenants WHERE id IN ('tenant-a', 'tenant-b') ORDER BY id"
  const SKILLS = "SELECT id AS k FROM skills WHERE id LIKE 'shape-sk-%' ORDER BY id"
  const GRANTS = "SELECT skill_id || '>' || tenant_id AS k FROM skill_tenant_access WHERE skill_id LIKE 'shape-sk-%' ORDER BY 1"

  it('the oracle holds the tenants, four skills and two grants (construction)', async () => {
    expect(await oracle(TENANTS)).toEqual(['tenant-a', 'tenant-b'])
    expect(await oracle(SKILLS)).toEqual(['shape-sk-a', 'shape-sk-b', 'shape-sk-g', 'shape-sk-grant'])
    expect(await oracle(GRANTS)).toEqual(['shape-sk-grant>tenant-a', 'shape-sk-grant>tenant-c'])
  })

  it('tenants: a tenant sees its own row only; the others see none; privileged see both', async () => {
    expect(await keys(CONTEXTS['tenant A'], TENANTS)).toEqual(['tenant-a'])
    expect(await keys(CONTEXTS['agent A'], TENANTS)).toEqual(['tenant-a'])
    expect(await keys(CONTEXTS['tenant B'], TENANTS)).toEqual(['tenant-b'])
    for (const name of ['_multi_', ...TENANTLESS]) expect(await keys(CONTEXTS[name], TENANTS)).toEqual([])
    for (const name of PRIVILEGED) expect(await keys(CONTEXTS[name], TENANTS)).toEqual(['tenant-a', 'tenant-b'])
  })
  it('tenants: only a privileged role writes (a tenant cannot rename itself, delete itself or add a tenant)', async () => {
    expect(await changes(CONTEXTS['tenant A'], "UPDATE tenants SET display_name = 'changed' WHERE id = 'tenant-a'")).toBe(0)
    expect(await changes(CONTEXTS['tenant A'], "DELETE FROM tenants WHERE id = 'tenant-a'")).toBe(0)
    await refused(CONTEXTS['tenant A'], "INSERT INTO tenants (id, display_name) VALUES ('tenant-x', 'x')")
    expect(await oracle("SELECT display_name AS k FROM tenants WHERE id = 'tenant-a'")).toEqual(['Tenant A'])
    expect(await changes(CONTEXTS.admin, "UPDATE tenants SET display_name = 'Tenant A' WHERE id = 'tenant-a'")).toBe(1)
  })

  describe('skills', () => {
    const visible: Record<string, string[]> = {
      'tenant A': ['shape-sk-a', 'shape-sk-g', 'shape-sk-grant'], // its own, the global one, the granted one
      'tenant B': ['shape-sk-b', 'shape-sk-g', 'shape-sk-grant'],
      'tenant C': ['shape-sk-g', 'shape-sk-grant'], // granted too
      'agent A': ['shape-sk-a', 'shape-sk-g', 'shape-sk-grant'],
      _multi_: ['shape-sk-g'], // a tenant with no grant: only the global skill
      viewer: ['shape-sk-g'], public: ['shape-sk-g'], empty: ['shape-sk-g'],
      system: ['shape-sk-a', 'shape-sk-b', 'shape-sk-g', 'shape-sk-grant'],
      admin: ['shape-sk-a', 'shape-sk-b', 'shape-sk-g', 'shape-sk-grant'],
    }
    for (const [name, expected] of Object.entries(visible)) {
      it(`${name} sees ${JSON.stringify(expected)}`, async () => { expect(await keys(CONTEXTS[name], SKILLS)).toEqual(expected) })
    }
    it('a tenant cannot make its own skill global, neither on insert nor on update (42501); a privileged role can', async () => {
      await refused(CONTEXTS['tenant A'], "INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('shape-sk-new', 'n', 'x', 'tenant-a', 1)")
      await refused(CONTEXTS['tenant A'], "UPDATE skills SET is_global = 1 WHERE id = 'shape-sk-a'")
      await changes(CONTEXTS['tenant A'], "INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('shape-sk-new', 'n', 'x', 'tenant-a', 0)")
      expect(await oracle("SELECT is_global::text AS k FROM skills WHERE id = 'shape-sk-a'")).toEqual(['0'])
      expect(await changes(CONTEXTS.admin, "UPDATE skills SET is_global = 1 WHERE id = 'shape-sk-a'")).toBe(1)
    })
    it('a tenant context may not edit or delete its own is_global = 1 skill; a privileged one does', async () => {
      expect(await changes(CONTEXTS['tenant B'], "UPDATE skills SET content = 'changed' WHERE id = 'shape-sk-g'")).toBe(0)
      expect(await changes(CONTEXTS['tenant B'], "UPDATE skills SET is_global = 0 WHERE id = 'shape-sk-g'")).toBe(0)
      expect(await changes(CONTEXTS['tenant B'], "DELETE FROM skills WHERE id = 'shape-sk-g'")).toBe(0)
      expect(await oracle("SELECT is_global::text AS k FROM skills WHERE id = 'shape-sk-g'")).toEqual(['1'])
      expect(await changes(CONTEXTS.system, "UPDATE skills SET content = 'changed' WHERE id = 'shape-sk-g'")).toBe(1)
    })
    it('a tenant cannot write another tenant skill, neither the granted nor the global one', async () => {
      for (const id of ['shape-sk-b', 'shape-sk-g', 'shape-sk-grant']) {
        expect(await changes(CONTEXTS['tenant A'], `UPDATE skills SET content = 'changed' WHERE id = '${id}'`)).toBe(0)
        expect(await changes(CONTEXTS['tenant A'], `DELETE FROM skills WHERE id = '${id}'`)).toBe(0)
      }
      await refused(CONTEXTS['tenant A'], "INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('shape-sk-new', 'n', 'x', 'tenant-b', 0)")
      for (const name of TENANTLESS) await refused(CONTEXTS[name], "INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('shape-sk-new', 'n', 'x', 'tenant-a', 0)")
    })
  })

  // The files and the revisions of a skill follow the skill, with one extra rule: the files and the history of a GLOBAL skill
  // (every tenant sees it) are written by a privileged role only, even by the tenant that owns it.
  describe('skill_files and skill_revisions: the write gate of a global skill', () => {
    const FILES = "SELECT skill_id AS k FROM skill_files WHERE skill_id LIKE 'shape-sk-%' ORDER BY skill_id"
    const REVS = "SELECT skill_id AS k FROM skill_revisions WHERE skill_id LIKE 'shape-sk-%' ORDER BY skill_id"
    const newFile = (skill: string): string => `INSERT INTO skill_files (skill_id, rel_path, content) VALUES ('${skill}', 'new.txt', decode('62', 'hex'))`
    const newRev = (skill: string, tenant: string): string =>
      `INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('${skill}', '${tenant}', 9, 'modify', 'system')`

    it('the oracle holds four files and three revisions (construction)', async () => {
      expect(await oracle(FILES)).toEqual(['shape-sk-a', 'shape-sk-b', 'shape-sk-g', 'shape-sk-grant'])
      expect(await oracle(REVS)).toEqual(['shape-sk-a', 'shape-sk-b', 'shape-sk-g'])
    })

    const filesSeen: Record<string, string[]> = {
      'tenant A': ['shape-sk-a', 'shape-sk-g', 'shape-sk-grant'], // its own, the global one, the granted one
      'tenant B': ['shape-sk-b', 'shape-sk-g', 'shape-sk-grant'],
      'tenant C': ['shape-sk-g', 'shape-sk-grant'],
      _multi_: ['shape-sk-g'], viewer: ['shape-sk-g'], public: ['shape-sk-g'], empty: ['shape-sk-g'], // the global files are readable by all
      system: ['shape-sk-a', 'shape-sk-b', 'shape-sk-g', 'shape-sk-grant'],
      admin: ['shape-sk-a', 'shape-sk-b', 'shape-sk-g', 'shape-sk-grant'],
    }
    for (const [name, expected] of Object.entries(filesSeen)) {
      it(`skill_files: ${name} sees the files of ${JSON.stringify(expected)}`, async () => { expect(await keys(CONTEXTS[name], FILES)).toEqual(expected) })
    }

    it('skill_files: the owner writes the files of its own private skill (insert, update, delete)', async () => {
      await changes(CONTEXTS['tenant B'], newFile('shape-sk-b'))
      expect(await changes(CONTEXTS['tenant B'], "UPDATE skill_files SET mode = 493 WHERE skill_id = 'shape-sk-b' AND rel_path = 'f.txt'")).toBe(1)
      expect(await changes(CONTEXTS['tenant B'], "DELETE FROM skill_files WHERE skill_id = 'shape-sk-b' AND rel_path = 'new.txt'")).toBe(1)
    })
    it('skill_files: the owner of a GLOBAL skill cannot add (42501), change or delete its files (0 rows); it still reads them', async () => {
      await refused(CONTEXTS['tenant B'], newFile('shape-sk-g'))
      expect(await changes(CONTEXTS['tenant B'], "UPDATE skill_files SET mode = 493 WHERE skill_id = 'shape-sk-g'")).toBe(0)
      expect(await changes(CONTEXTS['tenant B'], "DELETE FROM skill_files WHERE skill_id = 'shape-sk-g'")).toBe(0)
      expect(await keys(CONTEXTS['tenant B'], "SELECT skill_id AS k FROM skill_files WHERE skill_id = 'shape-sk-g'")).toEqual(['shape-sk-g'])
      expect(await oracle("SELECT mode::text AS k FROM skill_files WHERE skill_id = 'shape-sk-g'")).toEqual(['420'])
    })
    it('skill_files: another tenant writes neither a private skill nor a skill granted to it nor a global one', async () => {
      for (const skill of ['shape-sk-b', 'shape-sk-grant', 'shape-sk-g']) {
        await refused(CONTEXTS['tenant A'], newFile(skill))
        expect(await changes(CONTEXTS['tenant A'], `UPDATE skill_files SET mode = 493 WHERE skill_id = '${skill}'`)).toBe(0)
        expect(await changes(CONTEXTS['tenant A'], `DELETE FROM skill_files WHERE skill_id = '${skill}'`)).toBe(0)
      }
      for (const name of [...TENANTLESS, '_multi_']) await refused(CONTEXTS[name], newFile('shape-sk-b'))
      expect(await oracle(FILES)).toEqual(['shape-sk-a', 'shape-sk-b', 'shape-sk-g', 'shape-sk-grant'])
    })
    it('skill_files: a privileged role writes the files of a global skill', async () => {
      for (const name of PRIVILEGED) expect(await changes(CONTEXTS[name], "UPDATE skill_files SET mode = 493 WHERE skill_id = 'shape-sk-g'")).toBe(1)
    })

    const revsSeen: Record<string, string[]> = {
      'tenant A': ['shape-sk-a'], 'tenant B': ['shape-sk-b'], // the history of the global skill is not the tenant's
      'agent A': ['shape-sk-a'], _multi_: [], viewer: [], public: [], empty: [],
      system: ['shape-sk-a', 'shape-sk-b', 'shape-sk-g'], admin: ['shape-sk-a', 'shape-sk-b', 'shape-sk-g'],
    }
    for (const [name, expected] of Object.entries(revsSeen)) {
      it(`skill_revisions: ${name} sees the revisions of ${JSON.stringify(expected)}`, async () => { expect(await keys(CONTEXTS[name], REVS)).toEqual(expected) })
    }
    it('skill_revisions: the owner writes a revision of its private skill; of its GLOBAL skill it cannot (42501), nor change or delete the history (0 rows)', async () => {
      await changes(CONTEXTS['tenant B'], newRev('shape-sk-b', 'tenant-b'))
      await refused(CONTEXTS['tenant B'], newRev('shape-sk-g', 'tenant-b'))
      expect(await changes(CONTEXTS['tenant B'], "UPDATE skill_revisions SET reason = 'changed' WHERE skill_id = 'shape-sk-g'")).toBe(0)
      expect(await changes(CONTEXTS['tenant B'], "DELETE FROM skill_revisions WHERE skill_id = 'shape-sk-g'")).toBe(0)
      expect(await oracle("SELECT skill_id AS k FROM skill_revisions WHERE skill_id = 'shape-sk-g'")).toEqual(['shape-sk-g'])
    })
    it('skill_revisions: a revision stamped with another tenant fails (42501); a privileged role writes the history of a global skill', async () => {
      await refused(CONTEXTS['tenant A'], newRev('shape-sk-a', 'tenant-b'))
      for (const name of TENANTLESS) await refused(CONTEXTS[name], newRev('shape-sk-a', 'tenant-a'))
      for (const name of PRIVILEGED) expect(await changes(CONTEXTS[name], "UPDATE skill_revisions SET reason = 'changed' WHERE skill_id = 'shape-sk-g'")).toBe(1)
    })
  })

  describe('skill_tenant_access (characterization: the grantee reads its own grant row, only a privileged role writes)', () => {
    it('a tenant context lists only its own grant row', async () => {
      expect(await keys(CONTEXTS['tenant A'], GRANTS)).toEqual(['shape-sk-grant>tenant-a'])
      expect(await keys(CONTEXTS['agent A'], GRANTS)).toEqual(['shape-sk-grant>tenant-a'])
      expect(await keys(CONTEXTS['tenant C'], GRANTS)).toEqual(['shape-sk-grant>tenant-c'])
    })
    it('the OWNER tenant of the skill sees none of the grants it handed out; the others see none either', async () => {
      for (const name of ['tenant B', '_multi_', ...TENANTLESS]) expect(await keys(CONTEXTS[name], GRANTS)).toEqual([])
    })
    it('system and admin see all grants', async () => {
      for (const name of PRIVILEGED) expect(await keys(CONTEXTS[name], GRANTS)).toEqual(['shape-sk-grant>tenant-a', 'shape-sk-grant>tenant-c'])
    })
    it('a tenant cannot grant itself a skill (42501), nor revoke or change a grant (0 rows)', async () => {
      await refused(CONTEXTS['tenant A'], "INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by) VALUES ('shape-sk-b', 'tenant-a', 'agent-x')")
      await refused(CONTEXTS['tenant B'], "INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by) VALUES ('shape-sk-b', 'tenant-a', 'agent-x')")
      expect(await changes(CONTEXTS['tenant A'], "DELETE FROM skill_tenant_access WHERE skill_id = 'shape-sk-grant'")).toBe(0)
      expect(await changes(CONTEXTS['tenant A'], "UPDATE skill_tenant_access SET granted_by = 'x' WHERE skill_id = 'shape-sk-grant'")).toBe(0)
      expect(await oracle(GRANTS)).toEqual(['shape-sk-grant>tenant-a', 'shape-sk-grant>tenant-c'])
    })
  })
})
