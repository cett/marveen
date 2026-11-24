// Migration 0009 against a real server: the catalog (every table of the registry has row-level security ENABLED and FORCED
// and a PERMISSIVE policy, the helpers and the auth gateway have the shape the design needs) and the behaviour of the
// gateway functions through the app role. `npm run test:pg`. The admin pool is the oracle ("the row exists" is asserted
// before every "sees nothing"); the owner pool is the FORCE proof; fixtures are neutral (agent-a, tenant-a, user-a).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { PG_SET_CONTEXT_SQL, pgContextValues } from '../../db/pg/dbx.js'
import type { DbContext } from '../../db/context.js'
import { RLS_REGISTRY, RLS_TABLES, rlsEntryFor } from '../../db/pg/rls-registry.js'
import { createPgTestDb, PG_TEST_APP_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'

let db: PgTestDb
beforeAll(async () => { db = await createPgTestDb() })
afterAll(async () => { await db.close() })

const HELPERS = ['agent', 'job', 'privileged', 'role', 'tenant', 'user_id']
const GATEWAY = ['auth_login_user', 'auth_session_create', 'auth_session_revoke', 'auth_user_counts']

/** Runs `fn` on a connection of `pool` inside one transaction with the given context set the way the facade sets it. */
async function inContext<T>(pool: pg.Pool, ctx: DbContext | undefined, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    if (ctx) await c.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues(ctx) })
    return await fn(c)
  } finally {
    await c.query('ROLLBACK').catch(() => undefined) // nothing a cell does stays, and a failed cell never hands back an aborted connection
    c.release()
  }
}
const asApp = <T>(ctx: DbContext | undefined, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => inContext(db.appPool, ctx, fn)

/** The tables of the public schema, as the catalog has them. */
async function catalogTables(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ relname: string }>(
    "SELECT relname FROM pg_class WHERE relkind IN ('r', 'p') AND relnamespace = 'public'::regnamespace ORDER BY relname")
  return r.rows.map((x) => x.relname)
}

describe('the catalog against the registry', () => {
  it('every registry table exists and every table of the schema is in the registry (both directions), 88 of them', async () => {
    const tables = await catalogTables(db.pool)
    expect(tables.filter((t) => !RLS_TABLES.includes(t))).toEqual([])
    expect(RLS_TABLES.filter((t) => !tables.includes(t))).toEqual([])
    expect(tables).toHaveLength(88)
  })

  it('a table the owner creates and nobody classified is reported by the completeness check', async () => {
    await db.ownerPool.query('CREATE TABLE scratch_unclassified (id int)')
    const tables = await catalogTables(db.pool)
    expect(tables.filter((t) => !RLS_TABLES.includes(t))).toEqual(['scratch_unclassified'])
    expect(rlsEntryFor('scratch_unclassified')).toBeUndefined()
    await db.ownerPool.query('DROP TABLE scratch_unclassified')
  })

  it('row-level security is ENABLED and FORCED on all 88 tables', async () => {
    const r = await db.pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
          AND NOT (relrowsecurity AND relforcerowsecurity) ORDER BY relname`)
    expect(r.rows).toEqual([])
  })

  it('every table has at least one policy, and every policy is PERMISSIVE', async () => {
    const r = await db.pool.query<{ tablename: string; n: number }>(
      "SELECT tablename, count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename")
    const has = new Set(r.rows.map((x) => x.tablename))
    expect(RLS_TABLES.filter((t) => !has.has(t))).toEqual([])
    const restrictive = await db.pool.query("SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND permissive <> 'PERMISSIVE'")
    expect(restrictive.rows).toEqual([])
  })

  it('the class of a tenant table (A or B) equals the NOT NULL of its tenant_id in the catalog', async () => {
    const r = await db.pool.query<{ relname: string; notnull: boolean }>(
      `SELECT c.relname, a.attnotnull AS notnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE a.attname = 'tenant_id' AND NOT a.attisdropped AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace`)
    const catalog = new Map(r.rows.map((x) => [x.relname, x.notnull ? 'A' : 'B']))
    const registry = new Map<string, string>(RLS_REGISTRY.filter((e) => e.class === 'A' || e.class === 'B').map((e) => [e.table, e.class]))
    // a tenant column with a policy of its own: the grants table is class F ON PURPOSE (its tenant_id is the grantee, not the
    // writer), so it is the one tenant-column table the A/B comparison leaves out; the list is pinned, not open-ended
    const F_WITH_TENANT_COLUMN = ['skill_tenant_access']
    for (const t of F_WITH_TENANT_COLUMN) {
      expect(rlsEntryFor(t)?.class, t).toBe('F')
      registry.set(t, catalog.get(t) ?? 'missing')
    }
    expect([...catalog.entries()].sort()).toEqual([...registry.entries()].sort())
  })
})

/** The policy names a table of each class (plus its extension) carries: a policy of another class on a table must show. */
const POLICY_NAMES: Record<string, string[]> = {
  A: ['tenant_isolation'], 'A+F': ['global_or_granted', 'tenant_isolation'], B: ['tenant_isolation'], 'B+E': ['own_row', 'tenant_isolation'],
  C: ['via_parent'], 'C+F': ['own_tenant_skill', 'visible_through_skill'], D1: ['privileged_write', 'read_all'], D2: ['privileged_only'],
  D3: ['append_only', 'privileged_all'], E: ['own_session'],
}
const F_POLICY_NAMES: Record<string, string[]> = { tenants: ['own_tenant', 'privileged_write'], skill_tenant_access: ['own_grants', 'privileged_write'] }

describe('the policy names follow the class', () => {
  it('every table carries exactly the policy names of its registry class and extension (a D2 policy on an A table is a red cell)', async () => {
    const r = await db.pool.query<{ tablename: string; names: string[] }>(
      "SELECT tablename, array_agg(policyname::text ORDER BY policyname) AS names FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename")
    const got = new Map(r.rows.map((x) => [x.tablename, x.names]))
    expect([...got.keys()].sort()).toEqual([...RLS_TABLES].sort())
    for (const e of RLS_REGISTRY) {
      const want = e.class === 'F' ? F_POLICY_NAMES[e.table] : POLICY_NAMES[e.class + (e.extension ? `+${e.extension}` : '')]
      expect(got.get(e.table), e.table).toEqual(want)
    }
  })
})

describe('the helpers and the grants', () => {
  it('schema app holds exactly the six helpers and the four gateway functions, nothing else', async () => {
    const r = await db.pool.query<{ proname: string }>("SELECT proname FROM pg_proc WHERE pronamespace = 'app'::regnamespace ORDER BY proname")
    expect(r.rows.map((x) => x.proname)).toEqual([...HELPERS, ...GATEWAY].sort())
  })

  it('the helpers are STABLE, SECURITY INVOKER and not LEAKPROOF', async () => {
    const r = await db.pool.query<{ proname: string; provolatile: string; prosecdef: boolean; proleakproof: boolean }>(
      "SELECT proname, provolatile, prosecdef, proleakproof FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = ANY($1) ORDER BY proname", [HELPERS])
    expect(r.rows).toHaveLength(6)
    for (const f of r.rows) expect(f, f.proname).toMatchObject({ provolatile: 's', prosecdef: false, proleakproof: false })
  })

  it('the serving role has no TRUNCATE, REFERENCES or TRIGGER anywhere and no write on schema_version', async () => {
    const r = await db.pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
          AND (has_table_privilege($1, oid, 'TRUNCATE') OR has_table_privilege($1, oid, 'REFERENCES') OR has_table_privilege($1, oid, 'TRIGGER'))`, [PG_TEST_APP_ROLE])
    expect(r.rows).toEqual([])
    const sv = await db.pool.query<{ w: boolean }>(
      `SELECT (has_table_privilege($1, 'schema_version', 'INSERT') OR has_table_privilege($1, 'schema_version', 'UPDATE')
               OR has_table_privilege($1, 'schema_version', 'DELETE')) AS w`, [PG_TEST_APP_ROLE])
    expect(sv.rows[0].w).toBe(false)
  })

  it('FORCE binds the owner: with an empty context it sees ZERO rows of a seeded class A table and cannot insert one (42501)', async () => {
    await db.pool.query("INSERT INTO kanban_cards (id, title, tenant_id, created_at, updated_at) VALUES ('card-force', 't', 'tenant-a', 1, 1)")
    expect((await db.pool.query('SELECT 1 FROM kanban_cards WHERE id = $1', ['card-force'])).rowCount).toBe(1) // the oracle sees it
    expect((await db.ownerPool.query('SELECT 1 FROM kanban_cards')).rowCount).toBe(0)
    await expect(db.ownerPool.query("INSERT INTO kanban_cards (id, title, tenant_id, created_at, updated_at) VALUES ('card-owner', 't', 'tenant-a', 1, 1)"))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('a class C child follows its parent: a tenant sees the comment of its own card and not the comment of another tenant\'s card', async () => {
    await db.pool.query("INSERT INTO kanban_cards (id, title, tenant_id, created_at, updated_at) VALUES ('card-a', 't', 'tenant-a', 1, 1), ('card-b', 't', 'tenant-b', 1, 1)")
    await db.pool.query("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('card-a', 'agent-a', 'c-a', 1), ('card-b', 'agent-b', 'c-b', 1)")
    expect((await db.pool.query('SELECT 1 FROM kanban_comments')).rowCount).toBeGreaterThanOrEqual(2) // both exist for the oracle
    const seen = await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => (await c.query<{ content: string }>('SELECT content FROM kanban_comments ORDER BY content')).rows)
    expect(seen).toEqual([{ content: 'c-a' }])
    await expect(asApp({ role: 'tenant', tenantId: 'tenant-a' }, (c) =>
      c.query("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('card-b', 'agent-a', 'x', 1)"))).rejects.toMatchObject({ code: '42501' })
  })
})

describe('what a tenant must not do to the tables that decide access (skills, dashboard_users) and what a privileged role must reach', () => {
  it('a tenant cannot make its own skill global (INSERT or UPDATE to is_global = 1: 42501); a privileged role can; is_global = 0 stays writable', async () => {
    await db.pool.query("INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('skill-own-a', 'own', 'x', 'tenant-a', 0) ON CONFLICT DO NOTHING")
    const ins = (id: string, g: number): string => `INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('${id}', 'n', 'x', 'tenant-a', ${g})`
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query(ins('skill-glob', 1))).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query("UPDATE skills SET is_global = 1 WHERE id = 'skill-own-a'")).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'agent', agentId: 'agent-a', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query(ins('skill-glob-ag', 1))).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      expect((await c.query(ins('skill-local', 0))).rowCount).toBe(1) // a local skill of its own tenant is fine
      expect((await c.query("UPDATE skills SET content = 'y' WHERE id = 'skill-own-a'")).rowCount).toBe(1)
    })
    await asApp({ role: 'admin', name: 'http-admin' }, async (c) => {
      expect((await c.query(ins('skill-glob-admin', 1))).rowCount).toBe(1)
      expect((await c.query("UPDATE skills SET is_global = 1 WHERE id = 'skill-own-a'")).rowCount).toBe(1)
    })
    // an ALREADY global skill of the own tenant: no UPDATE (not even back to 0), no DELETE from a tenant or agent; it stays readable
    await db.pool.query("INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES ('skill-glob-own', 'g', 'x', 'tenant-a', 1) ON CONFLICT DO NOTHING")
    for (const ctx of [{ role: 'tenant', tenantId: 'tenant-a' }, { role: 'agent', agentId: 'agent-a', tenantId: 'tenant-a' }] as DbContext[]) {
      await asApp(ctx, async (c) => {
        expect((await c.query("UPDATE skills SET is_global = 0 WHERE id = 'skill-glob-own'")).rowCount).toBe(0)
        expect((await c.query("UPDATE skills SET content = 'y' WHERE id = 'skill-glob-own'")).rowCount).toBe(0)
        expect((await c.query("DELETE FROM skills WHERE id = 'skill-glob-own'")).rowCount).toBe(0)
        expect((await c.query("SELECT 1 FROM skills WHERE id = 'skill-glob-own'")).rowCount).toBe(1)
      })
    }
    expect((await db.pool.query("SELECT 1 FROM skills WHERE id = 'skill-glob-own' AND is_global = 1 AND content = 'x'")).rowCount).toBe(1) // oracle: untouched
    await asApp({ role: 'admin', name: 'http-admin' }, async (c) => {
      expect((await c.query("DELETE FROM skills WHERE id = 'skill-glob-own'")).rowCount).toBe(1)
    })
    await db.pool.query("DELETE FROM skills WHERE id = 'skill-glob-own'")
  })

  it('the files and revisions of a GLOBAL skill are a privileged role\'s: a tenant context cannot write them (42501 or no row), a local skill and a deleted skill stay writable', async () => {
    await db.pool.query(`INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES
      ('sk-glob', 'g', 'x', 'tenant-a', 1), ('sk-loc', 'l', 'x', 'tenant-a', 0) ON CONFLICT DO NOTHING`)
    await db.pool.query("INSERT INTO skill_files (skill_id, rel_path, content) VALUES ('sk-glob', 'old.txt', 'x'), ('sk-loc', 'old.txt', 'x') ON CONFLICT DO NOTHING")
    const file = (skill: string, path: string): string => `INSERT INTO skill_files (skill_id, rel_path, content) VALUES ('${skill}', '${path}', 'y')`
    const rev = (skill: string, seq: number): string => `INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('${skill}', 'tenant-a', ${seq}, 'modify', 'human')`
    for (const ctx of [{ role: 'tenant', tenantId: 'tenant-a' }, { role: 'agent', agentId: 'agent-a', tenantId: 'tenant-a' }] as DbContext[]) {
      await asApp(ctx, async (c) => { await expect(c.query(file('sk-glob', 'new.txt'))).rejects.toMatchObject({ code: '42501' }) })
      await asApp(ctx, async (c) => { await expect(c.query(rev('sk-glob', 1))).rejects.toMatchObject({ code: '42501' }) })
      await asApp(ctx, async (c) => {
        expect((await c.query("UPDATE skill_files SET content = 'z' WHERE skill_id = 'sk-glob'")).rowCount).toBe(0)
        expect((await c.query("DELETE FROM skill_files WHERE skill_id = 'sk-glob'")).rowCount).toBe(0)
      })
    }
    expect((await db.pool.query("SELECT 1 FROM skill_files WHERE skill_id = 'sk-glob' AND content = 'x'")).rowCount).toBe(1) // oracle: untouched
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      expect((await c.query(file('sk-loc', 'new.txt'))).rowCount).toBe(1) // a local skill's file
      expect((await c.query(rev('sk-loc', 1)).then((r) => r.rowCount))).toBe(1)
      expect((await c.query(rev('sk-gone', 1)).then((r) => r.rowCount))).toBe(1) // the revision of a skill whose row is already deleted
      expect((await c.query("SELECT 1 FROM skill_files WHERE skill_id = 'sk-glob'")).rowCount).toBe(1) // reading a global skill's files stays open
    })
    await asApp({ role: 'admin', name: 'http-admin' }, async (c) => {
      expect((await c.query(file('sk-glob', 'new.txt'))).rowCount).toBe(1)
      expect((await c.query(rev('sk-glob', 1)).then((r) => r.rowCount))).toBe(1)
    })
    // the revision FILES follow their revision: a tenant cannot add a file to the revision of a global skill
    const revId = Number((await db.pool.query<{ id: string }>("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('sk-glob', 'tenant-a', 90, 'modify', 'human') RETURNING id")).rows[0].id)
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query(`INSERT INTO skill_revision_files (revision_id, rel_path, content) VALUES (${revId}, 'f.txt', 'y')`)).rejects.toMatchObject({ code: '42501' })
    })
    await db.pool.query('DELETE FROM skill_revisions WHERE id = $1', [revId])
  })

  it('a tenant cannot make a user the global admin: UPDATE role to admin and INSERT of an admin row fail (42501); another role change inside the tenant works', async () => {
    await db.pool.query("INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES ('tenant-user-a', 'h', 'viewer', 'tenant-a', 1, 1)")
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query("UPDATE dashboard_users SET role = 'admin' WHERE username = 'tenant-user-a'")).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'agent', agentId: 'agent-a', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query("UPDATE dashboard_users SET role = 'admin' WHERE username = 'tenant-user-a'")).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query("INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES ('new-admin', 'h', 'admin', 'tenant-a', 1, 1)"))
        .rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      expect((await c.query("UPDATE dashboard_users SET role = 'read_only' WHERE username = 'tenant-user-a'")).rowCount).toBe(1)
    })
    await asApp({ role: 'admin', name: 'http-admin' }, async (c) => {
      expect((await c.query("UPDATE dashboard_users SET role = 'admin' WHERE username = 'tenant-user-a'")).rowCount).toBe(1) // a privileged role may
    })
    expect((await db.pool.query<{ role: string }>("SELECT role FROM dashboard_users WHERE username = 'tenant-user-a'")).rows).toEqual([{ role: 'viewer' }]) // oracle: nothing stuck
    await db.pool.query("DELETE FROM dashboard_users WHERE username = 'tenant-user-a'") // the clone is shared by the cells: leave no user behind
  })

  it('a privileged role reaches an ORPHAN child (kanban_comments has no foreign key): system and admin delete it, a tenant does not even see it', async () => {
    await db.pool.query("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('card-that-is-gone', 'agent-a', 'orphan-c', 1)")
    expect((await db.pool.query("SELECT 1 FROM kanban_comments WHERE content = 'orphan-c'")).rowCount).toBe(1) // the oracle
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      expect((await c.query("SELECT 1 FROM kanban_comments WHERE content = 'orphan-c'")).rowCount).toBe(0)
    })
    await asApp({ role: 'system', name: 'cell-orphan' }, async (c) => {
      expect((await c.query("DELETE FROM kanban_comments WHERE content = 'orphan-c'")).rowCount).toBe(1)
    })
    await asApp({ role: 'admin', name: 'http-admin' }, async (c) => {
      expect((await c.query("DELETE FROM kanban_comments WHERE content = 'orphan-c'")).rowCount).toBe(1)
    })
    await db.pool.query("DELETE FROM kanban_comments WHERE content = 'orphan-c'") // leave nothing behind in the shared clone
  })

  it('every class C child policy carries the privileged branch in its USING (the orphan cell above is one table; this is all twelve)', async () => {
    const r = await db.pool.query<{ tablename: string; qual: string }>("SELECT tablename, qual FROM pg_policies WHERE schemaname = 'public' AND policyname = 'via_parent'")
    expect(r.rows.map((x) => x.tablename).sort()).toEqual(RLS_REGISTRY.filter((e) => e.class === 'C' && !e.extension).map((e) => e.table).sort())
    for (const x of r.rows) expect(x.qual, x.tablename).toContain('app.privileged()')
  })
})

describe('skill grants (class F): only a privileged role grants, the grantee reads', () => {
  const seedSkills = async (): Promise<void> => {
    await db.pool.query(`INSERT INTO skills (id, name, content, tenant_id, is_global) VALUES
      ('skill-of-a', 'skill-of-a', 'x', 'tenant-a', 0), ('skill-of-b', 'skill-of-b', 'x', 'tenant-b', 0) ON CONFLICT DO NOTHING`)
  }
  const GRANT = "INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by) VALUES ($1, $2, 'agent-a')"

  it('the self-grant is refused: a tenant context cannot grant itself the skill of another tenant (42501), and the skill stays invisible', async () => {
    await seedSkills()
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => {
      expect((await c.query("SELECT 1 FROM skills WHERE id = 'skill-of-b'")).rowCount).toBe(0) // construction: not visible before
      await expect(c.query(GRANT, ['skill-of-b', 'tenant-a'])).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (c) => { // a grant of its own tenant to somebody else is refused too
      await expect(c.query(GRANT, ['skill-of-a', 'tenant-b'])).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'agent', agentId: 'agent-a', tenantId: 'tenant-a' }, async (c) => {
      await expect(c.query(GRANT, ['skill-of-b', 'tenant-a'])).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('the legitimate grant works from a privileged context (admin and system): the grantee then sees the skill', async () => {
    await seedSkills()
    await asApp({ role: 'admin', name: 'http-admin' }, async (c) => {
      expect((await c.query(GRANT, ['skill-of-a', 'tenant-b'])).rowCount).toBe(1)
      // the same transaction cannot show the tenant's view (one role per transaction): the committed view is below
    })
    const c = await db.appPool.connect()
    try {
      await c.query('BEGIN')
      await c.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'system', name: 'cell-grant' }) })
      await c.query(GRANT, ['skill-of-a', 'tenant-b'])
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    expect((await db.pool.query("SELECT 1 FROM skill_tenant_access WHERE skill_id = 'skill-of-a' AND tenant_id = 'tenant-b'")).rowCount).toBe(1) // the oracle
    await asApp({ role: 'tenant', tenantId: 'tenant-b' }, async (t) => {
      expect((await t.query("SELECT 1 FROM skills WHERE id = 'skill-of-a'")).rowCount).toBe(1) // visible through the grant
      expect((await t.query('SELECT skill_id FROM skill_tenant_access')).rows).toEqual([{ skill_id: 'skill-of-a' }]) // its own grant row
    })
    await asApp({ role: 'tenant', tenantId: 'tenant-a' }, async (t) => {
      expect((await t.query('SELECT 1 FROM skill_tenant_access')).rowCount).toBe(0) // the grantor tenant does not read the grantee's row
    })
  })

  it('a tenant cannot revoke or change a grant: its own DELETE and UPDATE touch zero rows', async () => {
    await seedSkills()
    await db.pool.query("INSERT INTO skill_tenant_access (skill_id, tenant_id) VALUES ('skill-of-a', 'tenant-b') ON CONFLICT DO NOTHING")
    await asApp({ role: 'tenant', tenantId: 'tenant-b' }, async (c) => {
      expect((await c.query('SELECT 1 FROM skill_tenant_access')).rowCount).toBe(1) // construction: it sees its own grant
      expect((await c.query("DELETE FROM skill_tenant_access WHERE skill_id = 'skill-of-a'")).rowCount).toBe(0)
      expect((await c.query("UPDATE skill_tenant_access SET granted_by = 'x' WHERE skill_id = 'skill-of-a'")).rowCount).toBe(0)
    })
    expect((await db.pool.query("SELECT 1 FROM skill_tenant_access WHERE skill_id = 'skill-of-a' AND tenant_id = 'tenant-b'")).rowCount).toBe(1)
    await asApp({ role: 'admin', name: 'http-admin' }, async (c) => {
      expect((await c.query("DELETE FROM skill_tenant_access WHERE skill_id = 'skill-of-a'")).rowCount).toBe(1) // the privileged revoke works
    })
  })
})

describe('the auth gateway', () => {
  it('four functions: plpgsql, SECURITY INVOKER, only the search_path is function-level, one elevation and one restore, no EXECUTE in the body, executable by the app role and not by PUBLIC', async () => {
    const r = await db.pool.query<{ proname: string; prosecdef: boolean; proconfig: string[]; prosrc: string; lang: string; app_ok: boolean; public_ok: boolean }>(
      `SELECT proname, prosecdef, proconfig, prosrc, (SELECT lanname FROM pg_language WHERE oid = prolang) AS lang,
              has_function_privilege($2, oid, 'EXECUTE') AS app_ok, has_function_privilege('public', oid, 'EXECUTE') AS public_ok
         FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = ANY($1) ORDER BY proname`, [GATEWAY, PG_TEST_APP_ROLE])
    expect(r.rows.map((x) => x.proname)).toEqual(GATEWAY)
    for (const f of r.rows) {
      expect(f.prosecdef, f.proname).toBe(false)
      expect(f.lang, f.proname).toBe('plpgsql')
      expect(f.proconfig, f.proname).toEqual(['search_path=pg_catalog, pg_temp']) // no function-level app.role: the elevation is in the body
      expect(/\bEXECUTE\b/i.test(f.prosrc), f.proname).toBe(false)
      // the save, the one transaction-local elevation, the restore of the saved value: exactly once each, nothing session-level
      const count = (re: RegExp): number => (f.prosrc.match(re) ?? []).length
      expect(count(/v_prev := coalesce\(current_setting\('app\.role', true\), ''\);/g), f.proname).toBe(1)
      expect(count(/PERFORM set_config\('app\.role', 'system', true\);/g), f.proname).toBe(1)
      expect(count(/PERFORM set_config\('app\.role', v_prev, true\);/g), f.proname).toBe(1)
      expect(count(/set_config\(/g), f.proname).toBe(2)
      expect(f.app_ok, f.proname).toBe(true)
      expect(f.public_ok, f.proname).toBe(false)
    }
  })

  it('the result types are pinned: login is four named columns, counts is two', async () => {
    const r = await db.pool.query<{ proname: string; res: string }>(
      "SELECT proname, pg_get_function_result(oid) AS res FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname IN ('auth_login_user', 'auth_user_counts')")
    const by = Object.fromEntries(r.rows.map((x) => [x.proname, x.res]))
    expect(by.auth_login_user).toBe('TABLE(id bigint, username text, password_hash text, disabled smallint)')
    expect(by.auth_user_counts).toBe('TABLE(enabled bigint, total bigint)')
  })

  let userA = 0 // the id of User-A: the sequence moves on with every cell, so never a literal
  async function seedUsers(): Promise<void> {
    await db.pool.query(`INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, disabled)
      VALUES ('User-A', 'hash-a', 1, 1, 0), ('user-off', 'hash-off', 1, 1, 1) ON CONFLICT DO NOTHING`) // the clone is shared by the cells
    userA = Number((await db.pool.query("SELECT id FROM dashboard_users WHERE username = 'User-A'")).rows[0].id)
  }

  it('the public context reads NOTHING of the two tables directly, while the oracle shows the rows, yet the gateway works there', async () => {
    await seedUsers()
    await db.pool.query(`INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('hash-sess', ${userA}, 'User-A', 1, 1)`)
    expect((await db.pool.query('SELECT 1 FROM dashboard_users')).rowCount).toBe(2)
    expect((await db.pool.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(1)
    await asApp({ role: 'public', name: 'http-public' }, async (c) => {
      expect((await c.query('SELECT 1 FROM dashboard_users')).rowCount).toBe(0)
      expect((await c.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(0)
    })
    await asApp({ role: 'public', name: 'http-public' }, async (c) => { // its own transaction: the refused statement aborts it
      await expect(c.query("INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('direct', 1, 'x', 1, 1)")).rejects.toMatchObject({ code: '42501' })
    })
    await asApp({ role: 'public', name: 'http-public' }, async (c) => {
      const login = await c.query('SELECT * FROM app.auth_login_user($1)', ['user-a']) // ASCII case folded: User-A
      expect(login.rows).toEqual([{ id: expect.anything(), username: 'User-A', password_hash: 'hash-a', disabled: 0 }])
      const counts = await c.query<{ enabled: number; total: number }>('SELECT enabled::int, total::int FROM app.auth_user_counts()')
      expect(counts.rows[0]).toEqual({ enabled: 1, total: 2 })
    })
  })

  it('the same counts in a tenant context as in an admin context (the gateway answers for every context)', async () => {
    await seedUsers()
    const counts = (c: pg.PoolClient): Promise<unknown> => c.query('SELECT enabled::int, total::int FROM app.auth_user_counts()').then((r) => r.rows[0])
    const asTenant = await asApp({ role: 'tenant', tenantId: 'tenant-a' }, counts)
    const asAdmin = await asApp({ role: 'admin', name: 'http-admin' }, counts)
    expect(asTenant).toEqual({ enabled: 1, total: 2 })
    expect(asTenant).toEqual(asAdmin)
  })

  it('the role does not leak out of a call: after it, in the same transaction, the caller\'s role is back and a direct SELECT is still empty', async () => {
    await seedUsers()
    await asApp({ role: 'public', name: 'http-public' }, async (c) => {
      await c.query('SELECT * FROM app.auth_login_user($1)', ['user-a'])
      await c.query(`SELECT app.auth_session_create('h-leak', ${userA}, 'User-A', 5, NULL, NULL)`)
      expect((await c.query("SELECT current_setting('app.role', true) AS r")).rows[0].r).toBe('public')
      expect((await c.query('SELECT 1 FROM dashboard_users')).rowCount).toBe(0)
      expect((await c.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(0)
    })
  })

  const roleNow = async (c: pg.PoolClient): Promise<string | null> =>
    (await c.query<{ r: string | null }>("SELECT NULLIF(current_setting('app.role', true), '') AS r")).rows[0].r

  it('the caller\'s role is back after EVERY function, on the no-row path, the no-delete path and the error path (a savepoint rolls back to the caller\'s value)', async () => {
    await seedUsers()
    await asApp({ role: 'viewer', name: 'http-global-viewer', userId: '999' }, async (c) => {
      await c.query('SELECT * FROM app.auth_login_user($1)', ['no-such-user']) // the empty result
      expect(await roleNow(c)).toBe('viewer')
      await c.query('SELECT enabled FROM app.auth_user_counts()')
      expect(await roleNow(c)).toBe('viewer')
      await c.query("SELECT app.auth_session_revoke('no-such-hash')") // deletes nothing
      expect(await roleNow(c)).toBe('viewer')
      await c.query('SAVEPOINT s1')
      await expect(c.query(`SELECT app.auth_session_create(NULL, ${userA}, 'User-A', 5, NULL, NULL)`)).rejects.toMatchObject({ code: '23502' }) // NOT NULL breach inside the function
      await c.query('ROLLBACK TO SAVEPOINT s1')
      expect(await roleNow(c)).toBe('viewer')
      expect((await c.query('SELECT 1 FROM dashboard_users')).rowCount).toBe(0) // and the direct read is still closed
      expect((await c.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(0)
    })
  })

  it('a caller with NO role set reads as no role after a call (not as system), and the next transaction of the same connection starts clean', async () => {
    await seedUsers()
    const c = await db.appPool.connect()
    try {
      await c.query('BEGIN')
      await c.query('SELECT * FROM app.auth_login_user($1)', ['user-a'])
      expect(await roleNow(c)).toBeNull() // the saved value of an unset setting is the empty string, which reads as no role
      expect((await c.query('SELECT 1 FROM dashboard_users')).rowCount).toBe(0)
      await c.query('COMMIT')
      await c.query('BEGIN')
      expect(await roleNow(c)).toBeNull() // a session-level setting would survive the commit as system
      expect((await c.query('SELECT 1 FROM dashboard_users')).rowCount).toBe(0)
      await c.query('COMMIT')
    } finally {
      c.release()
    }
  })

  it('nothing the gateway sets outlives the transaction: after a commit the next transaction of the connection holds neither system nor the old caller\'s role', async () => {
    await seedUsers()
    const c = await db.appPool.connect()
    try {
      await c.query('BEGIN')
      await c.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'viewer', name: 'http-global-viewer', userId: '999' }) })
      await c.query('SELECT * FROM app.auth_login_user($1)', ['user-a'])
      await c.query(`SELECT app.auth_session_create('h-commit', ${userA}, 'User-A', 5, NULL, NULL)`)
      await c.query("SELECT app.auth_session_revoke('h-commit')")
      await c.query('SELECT enabled FROM app.auth_user_counts()')
      expect(await roleNow(c)).toBe('viewer')
      await c.query('COMMIT')
      await c.query('BEGIN')
      expect(await roleNow(c)).toBeNull() // a session-level setting (the elevation or the restore) would still be here
      await c.query('COMMIT')
    } finally {
      c.release()
    }
  })

  it('a session is created and revoked through the gateway in the context of ANOTHER user (the cookie edge)', async () => {
    // asApp rolls back, so the create and the revoke share one transaction; the committed create below is read by the oracle
    await asApp({ role: 'viewer', name: 'http-global-viewer', userId: '999' }, async (c) => {
      await c.query(`SELECT app.auth_session_create('h-new', ${userA}, 'User-A', 5, 'ua', 'note')`)
      await c.query("SELECT app.auth_session_revoke('h-new')")
    })
    const c = await db.appPool.connect()
    try {
      await c.query('BEGIN')
      await c.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'public', name: 'http-public' }) })
      await c.query(`SELECT app.auth_session_create('h-keep', ${userA}, 'User-A', 5, 'ua', 'note')`)
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    const row = await db.pool.query<{ created_at: number; last_seen_at: number; user_agent: string }>("SELECT created_at, last_seen_at, user_agent FROM auth_sessions WHERE id_hash = 'h-keep'")
    expect(row.rows).toEqual([{ created_at: 5, last_seen_at: 5, user_agent: 'ua' }])
  })

  it('the session create mints a session only for an ENABLED user under exactly this id AND name: anything else raises 28000 and writes nothing', async () => {
    await seedUsers()
    const ids = (await db.pool.query<{ username: string; id: string }>("SELECT username, id FROM dashboard_users WHERE username IN ('User-A', 'user-off')")).rows
    const idOf = (name: string): number => Number(ids.find((x) => x.username === name)!.id)
    const cases: Array<[string, number, string]> = [
      ['the id of one user with the name of another', idOf('user-off'), 'User-A'],
      ['the name of one user with the id of another', idOf('User-A'), 'user-off'],
      ['an id that does not exist', 987654321, 'User-A'],
      ['the right id and a name that differs in case', idOf('User-A'), 'user-a'],
      ['a disabled user, id and name matching', idOf('user-off'), 'user-off'],
    ]
    for (const [label, id, name] of cases) {
      await asApp({ role: 'public', name: 'http-public' }, async (c) => {
        await expect(c.query('SELECT app.auth_session_create($1, $2, $3, 5, NULL, NULL)', ['h-bad', id, name]), label).rejects.toMatchObject({ code: '28000' })
      })
    }
    expect((await db.pool.query("SELECT 1 FROM auth_sessions WHERE id_hash = 'h-bad'")).rowCount).toBe(0)
    await asApp({ role: 'public', name: 'http-public' }, async (c) => { // construction: the matching enabled user does get a session
      await c.query('SELECT app.auth_session_create($1, $2, $3, 5, NULL, NULL)', ['h-good', idOf('User-A'), 'User-A'])
    })
  })

  it('the revoke deletes the presented session and only that one, from a public context (the oracle reads the committed rows)', async () => {
    await db.pool.query(`INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at)
      VALUES ('h-del', ${userA}, 'User-A', 1, 1), ('h-other', ${userA}, 'User-A', 1, 1)`)
    const c = await db.appPool.connect()
    try {
      await c.query('BEGIN')
      await c.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'public', name: 'http-public' }) })
      await c.query("SELECT app.auth_session_revoke('h-del')")
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    const left = await db.pool.query<{ id_hash: string }>("SELECT id_hash FROM auth_sessions WHERE id_hash IN ('h-del', 'h-other') ORDER BY id_hash")
    expect(left.rows).toEqual([{ id_hash: 'h-other' }])
  })

  it('names that could enumerate users return no row and no error: %, _, the empty string and a 10 KB string', async () => {
    await seedUsers()
    await asApp({ role: 'public', name: 'http-public' }, async (c) => {
      for (const name of ['%', '_', '', 'x'.repeat(10 * 1024), 'user-%']) {
        const r = await c.query('SELECT * FROM app.auth_login_user($1)', [name])
        expect(r.rows, name.slice(0, 8)).toEqual([])
      }
    })
  })

  // What this cell proves: a temp table of the caller does not stand in for the real one. It does NOT tell whether the
  // `SET search_path` clause is there: the bodies schema-qualify every table (public.), which alone already defeats this. The
  // clause itself (defence in depth for an unqualified name) is pinned by the proconfig assertion of the shape cell above.
  it('a temp table of the caller named dashboard_users does not stand in for the real one', async () => {
    await seedUsers()
    await asApp({ role: 'public', name: 'http-public' }, async (c) => {
      await c.query('CREATE TEMP TABLE dashboard_users (id bigint, username text, password_hash text, disabled smallint)')
      await c.query("INSERT INTO pg_temp.dashboard_users VALUES (7, 'user-a', 'planted', 0)")
      await c.query("SET LOCAL search_path = pg_temp, public") // the temp table now comes first for the caller
      expect((await c.query<{ password_hash: string }>('SELECT password_hash FROM dashboard_users')).rows).toEqual([{ password_hash: 'planted' }]) // construction
      const r = await c.query<{ password_hash: string }>('SELECT password_hash FROM app.auth_login_user($1)', ['user-a'])
      expect(r.rows).toEqual([{ password_hash: 'hash-a' }])
    })
  })

  it('a malformed user id in the context gives zero rows, not an error', async () => {
    await seedUsers()
    await db.pool.query(`INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('hash-own', ${userA}, 'User-A', 1, 1)`)
    await asApp({ role: 'viewer', name: 'http-global-viewer', userId: String(userA) }, async (c) => {
      expect((await c.query("SELECT 1 FROM auth_sessions WHERE id_hash = 'hash-own'")).rowCount).toBe(1) // construction: the own session by user id
    })
    for (const bad of ['abc', '1; DROP TABLE x', '99999999999999999999', ' 1']) {
      await asApp({ role: 'viewer', name: 'http-global-viewer', userId: bad }, async (c) => {
        expect((await c.query('SELECT 1 FROM auth_sessions')).rowCount, bad).toBe(0)
        expect((await c.query('SELECT 1 FROM dashboard_users')).rowCount, bad).toBe(0)
      })
    }
  })
})
