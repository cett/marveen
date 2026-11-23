// The row-level-security registry (src/db/pg/rls-registry.ts): the static cells. No server: the registry is held against
// itself and against the CREATE TABLE text of the PG migration files, so a table added without an entry (or an entry for
// a table that is gone) fails in the default suite. The catalog cells of migration 0009 hold it against a real server.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RLS_CLASSES, RLS_REGISTRY, RLS_TABLES, rlsEntryFor, type RlsClass, type RlsEntry } from '../db/pg/rls-registry.js'

/** The number of tables of the PG schema (migrations 0001 to 0008). A new table is a two-place edit: the migration and the registry. */
const TABLE_COUNT = 88

const DIR = fileURLToPath(new URL('../migrations-pg', import.meta.url))

interface SqlTable {
  name: string
  /** The text between the parentheses of the CREATE TABLE. */
  body: string
}

/** Text of every PG migration file in order, with the `--` comments taken out. */
function migrationTexts(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(path.join(DIR, f), 'utf8').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'))
}

/** The CREATE TABLE statements of all files (a DROP TABLE removes one; a rename is refused, see the cell). */
function schemaTables(): Map<string, SqlTable> {
  const tables = new Map<string, SqlTable>()
  for (const text of migrationTexts()) {
    for (const m of text.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(/gi)) {
      let depth = 1
      let i = m.index! + m[0].length
      const start = i
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '(') depth++
        else if (text[i] === ')') depth--
      }
      tables.set(m[1]!, { name: m[1]!, body: text.slice(start, i - 1) })
    }
    for (const m of text.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)) tables.delete(m[1]!)
  }
  return tables
}

/** `tenant_id` of a CREATE TABLE body: absent, NOT NULL (own words or a PRIMARY KEY that names it), or nullable. */
function tenantColumn(body: string): 'absent' | 'not-null' | 'nullable' {
  const own = /^\s*"?tenant_id"?\s+[^\n]*$/m.exec(body)
  if (!own) return 'absent'
  if (/\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(own[0])) return 'not-null'
  const pk = [...body.matchAll(/\bPRIMARY\s+KEY\s*\(([^)]*)\)/gi)].some((m) => /\btenant_id\b/.test(m[1]!))
  return pk ? 'not-null' : 'nullable'
}

const byClass = (c: RlsClass): RlsEntry[] => RLS_REGISTRY.filter((e) => e.class === c)
const sql = schemaTables()

describe('the registry against itself', () => {
  it('every entry has one of the eight classes', () => {
    expect(RLS_CLASSES).toEqual(['A', 'B', 'C', 'D1', 'D2', 'D3', 'E', 'F'])
    expect(RLS_REGISTRY.filter((e) => !RLS_CLASSES.includes(e.class)).map((e) => e.table)).toEqual([])
  })

  it('no table has two entries (the tables with two classes are one entry with an extension)', () => {
    const seen = new Set<string>()
    const twice = RLS_TABLES.filter((t) => (seen.has(t) ? true : (seen.add(t), false)))
    expect(twice).toEqual([])
    expect(RLS_TABLES.every((t) => /^[a-z][a-z0-9_]*$/.test(t))).toBe(true)
  })

  it(`the total is pinned at ${TABLE_COUNT}, and so is every class (a new table is a visible edit)`, () => {
    expect(RLS_REGISTRY).toHaveLength(TABLE_COUNT)
    const counts = Object.fromEntries(RLS_CLASSES.map((c) => [c, byClass(c).length]))
    expect(counts).toEqual({ A: 36, B: 13, C: 13, D1: 6, D2: 16, D3: 1, E: 1, F: 2 })
  })

  it('a class C entry names a parent and its columns; no other class does', () => {
    for (const e of RLS_REGISTRY) {
      if (e.class === 'C') {
        expect(e.parent, e.table).toBeTruthy()
        expect(e.fk?.length ?? 0, `${e.table} fk`).toBeGreaterThan(0)
        expect(new Set(e.fk).size, `${e.table} fk twice`).toBe(e.fk!.length)
      } else {
        expect(e.parent, e.table).toBeUndefined()
        expect(e.fk, e.table).toBeUndefined()
      }
    }
  })

  it('the parent of a child is in the registry, is not itself a child, and carries a tenant column (class A or B)', () => {
    for (const e of byClass('C')) {
      const parent = rlsEntryFor(e.parent!)
      expect(parent, `${e.table} -> ${e.parent}`).toBeDefined()
      expect(['A', 'B'], `${e.table} -> ${e.parent} is ${parent?.class}`).toContain(parent!.class)
      expect(e.parent).not.toBe(e.table)
    }
  })

  it('a reason (one line, no dash of the long kind) is there for D1, D2, D3, E, F and every extension', () => {
    for (const e of RLS_REGISTRY) {
      if (['D1', 'D2', 'D3', 'E', 'F'].includes(e.class) || e.extension) expect(e.reason?.trim().length ?? 0, `${e.table} reason`).toBeGreaterThan(10)
      if (e.reason !== undefined) {
        expect(e.reason, e.table).not.toMatch(/\n/)
        expect(e.reason, e.table).not.toContain(String.fromCharCode(0x2014))
      }
    }
  })

  it('the three tables with a second class are exactly skills (A+F), skill_files (C+F) and dashboard_users (B+E)', () => {
    const withExt = RLS_REGISTRY.filter((e) => e.extension).map((e) => `${e.table}:${e.class}+${e.extension}`).sort()
    expect(withExt).toEqual(['dashboard_users:B+E', 'skill_files:C+F', 'skills:A+F'])
  })

  it('a table nobody classified has NO entry: there is no default class that would silently apply', () => {
    expect(rlsEntryFor('a_table_nobody_classified')).toBeUndefined()
    expect(rlsEntryFor('memories')?.class).toBe('A')
  })
})

describe('the registry against the CREATE TABLE text of the migration files', () => {
  it('the files are read the way the cells below need (no rename of a table, which this reader would not follow)', () => {
    expect(migrationTexts().filter((t) => /\bALTER\s+TABLE\s+"?\w+"?\s+RENAME\s+TO\b/i.test(t))).toEqual([])
    expect(sql.size).toBeGreaterThan(80)
  })

  it('every table the files create has an entry, and every entry has a table (both directions)', () => {
    const files = new Set(sql.keys())
    const registry = new Set<string>(RLS_TABLES)
    expect([...files].filter((t) => !registry.has(t)).sort(), 'created by a migration, not in the registry').toEqual([])
    expect([...registry].filter((t) => !files.has(t)).sort(), 'in the registry, not created by a migration').toEqual([])
    expect(files.size).toBe(TABLE_COUNT)
  })

  it('A is exactly the tenant tables whose tenant_id is NOT NULL, B the ones where it is nullable, and no other table has the column', () => {
    const want = (kind: 'not-null' | 'nullable'): string[] => [...sql.values()].filter((t) => tenantColumn(t.body) === kind).map((t) => t.name).sort()
    // The one table with a tenant column that is class F on purpose: its tenant_id is the grantee, not the writer, so the tenant
    // shape would let a tenant grant itself another tenant's skill. The list is pinned, not open-ended.
    const F_WITH_TENANT_COLUMN = ['skill_tenant_access']
    for (const t of F_WITH_TENANT_COLUMN) expect(rlsEntryFor(t)?.class, t).toBe('F')
    expect([...byClass('A').map((e) => e.table), ...F_WITH_TENANT_COLUMN].sort()).toEqual(want('not-null'))
    expect(byClass('B').map((e) => e.table).sort()).toEqual(want('nullable'))
    const tenantless = [...sql.values()].filter((t) => tenantColumn(t.body) === 'absent').map((t) => t.name).sort()
    expect(RLS_REGISTRY.filter((e) => e.class !== 'A' && e.class !== 'B' && !F_WITH_TENANT_COLUMN.includes(e.table)).map((e) => e.table).sort()).toEqual(tenantless)
  })

  it('the columns a child is checked through exist in the child\'s CREATE TABLE', () => {
    for (const e of byClass('C')) {
      const body = sql.get(e.table)!.body
      for (const col of e.fk!) expect(new RegExp(`^\\s*"?${col}"?\\s`, 'm').test(body), `${e.table}.${col}`).toBe(true)
    }
  })
})

describe('the decisive classifications, pinned by name (a flip is a visible edit, not a quiet one)', () => {
  const where = (table: string): string => {
    const e = rlsEntryFor(table)!
    return `${e.class}${e.extension ? `+${e.extension}` : ''}${e.parent ? `:${e.parent}(${e.fk!.join(',')})` : ''}`
  }

  it('the children and their parents', () => {
    expect(where('kanban_comments')).toBe('C:kanban_cards(card_id)')
    expect(where('kanban_card_labels')).toBe('C:kanban_cards(card_id)')
    expect(where('kanban_card_events')).toBe('C:kanban_cards(card_id)')
    expect(where('idea_comments')).toBe('C:idea_box(idea_id)')
    expect(where('idea_status_log')).toBe('C:idea_box(idea_id)')
    expect(where('memory_versions')).toBe('C:memories(memory_id)')
    expect(where('skill_files')).toBe('C+F:skills(skill_id)')
    expect(where('skill_revision_files')).toBe('C:skill_revisions(revision_id)')
    expect(where('memory_embeddings')).toBe('C:memories(memory_id)')
    expect(where('workspace_doc_embeddings')).toBe('C:workspace_docs(doc_id)')
    expect(where('artifact_embeddings')).toBe('C:artifacts(artifact_id)')
  })

  it('memory_links needs BOTH ends visible, and span_reads follows memories (it was D2 before the read path was traced)', () => {
    expect(where('memory_links')).toBe('C:memories(src_id,dst_id)')
    expect(where('span_reads')).toBe('C:memories(memory_id)')
  })

  it('the global tables: the six readable by all, the one append-only, and the tables of the auth and tenant bootstrap', () => {
    expect(byClass('D1').map((e) => e.table).sort()).toEqual(
      ['agent_blackboard_tier', 'autonomy_categories', 'claude_plans_registry', 'cost_sources', 'model_profile_map', 'schema_version'])
    expect(byClass('D3').map((e) => e.table)).toEqual(['homoglyph_findings'])
    expect(where('auth_sessions')).toBe('E')
    expect(where('tenants')).toBe('F')
    expect(where('skill_tenant_access')).toBe('F') // not A: under the tenant shape a tenant could grant itself another tenant's skill
    expect(where('skills')).toBe('A+F')
    expect(where('dashboard_users')).toBe('B+E')
  })

  it('the tables that carry secrets or the installation settings are privileged only (D2)', () => {
    for (const t of ['system_config', 'otel_logs_hash_salt', 'sessions', 'pending_channel_requests', 'scheduled_tasks']) expect(rlsEntryFor(t)?.class, t).toBe('D2')
  })

  it('a tenant-bearing table that is not NOT NULL in the catalog is B: the unattributed rows stay privileged-only (agent_audit_log, otel_spans)', () => {
    expect(rlsEntryFor('agent_audit_log')?.class).toBe('B')
    expect(rlsEntryFor('otel_spans')?.class).toBe('B')
    expect(rlsEntryFor('kanban_cards')?.class).toBe('A')
  })
})
