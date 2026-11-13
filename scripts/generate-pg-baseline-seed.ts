// Generates the seed-data block at the end of src/migrations-pg/0001_baseline.sql.
//
// The SQLite migration chain seeds a handful of tables (tenants, system_config, autonomy_categories, model_profile_map,
// egress_allowlist, otel_metrics_export_state). A fresh PostgreSQL install built from the baseline alone needs the same
// rows, so they are read out of an empty database after applyMigrations and written as INSERT ... ON CONFLICT DO NOTHING.
// Nothing here is typed by hand: a seed that changes in a SQLite migration changes here by re-running the script.
//
//   npx tsx scripts/generate-pg-baseline-seed.ts           rewrite the block in the baseline in place
//   npx tsx scripts/generate-pg-baseline-seed.ts --check   exit 1 when the block in the baseline is not what the chain produces
//
// Left out of the INSERTs on purpose:
//  - every column whose SQLite default is unixepoch() (created_at, updated_at, added_at): the value is the time of the
//    migration run, so it differs between two runs; PostgreSQL fills it from its own default at install time;
//  - egress_allowlist.id: a bigint identity, assigned in insertion order (the rows are emitted in SQLite id order);
//    the unique key (value, type, tenant_id) is what makes the INSERT idempotent.
//
// A guard stops the script when the chain seeds a table that is not listed in SEED_TABLES: that table would silently be
// missing from a fresh PostgreSQL install.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.LOG_LEVEL = 'silent' // applyMigrations logs one INFO line per migration; keep the output the generated block only

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'migrations-pg', '0001_baseline.sql')
const BEGIN_MARK = '-- BEGIN GENERATED SEED (scripts/generate-pg-baseline-seed.ts, do not edit by hand)'
const END_MARK = '-- END GENERATED SEED'

interface SeedTable {
  name: string
  /** ORDER BY of the SELECT: the emitted row order, so the output is reproducible. */
  orderBy: string
  /** Columns left out in addition to the unixepoch()-default ones. */
  omit?: string[]
}

export const SEED_TABLES: SeedTable[] = [
  { name: 'tenants', orderBy: 'id' },
  { name: 'system_config', orderBy: 'key' },
  { name: 'autonomy_categories', orderBy: 'key' },
  { name: 'model_profile_map', orderBy: 'profile_id' },
  { name: 'egress_allowlist', orderBy: 'id', omit: ['id'] },
  { name: 'otel_metrics_export_state', orderBy: 'id' },
]

/** Tables that may hold rows after applyMigrations without being seed data. */
const NOT_SEED = new Set(['schema_version'])

function literal(v: unknown): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`seed value is not a safe integer: ${v}`)
    return String(v)
  }
  if (typeof v === 'string') {
    // PostgreSQL strings with standard_conforming_strings: only the quote needs doubling; NUL cannot be stored in text
    if (v.includes('\0')) throw new Error('seed text contains a NUL character')
    return `'${v.replace(/'/g, "''")}'`
  }
  throw new Error(`unsupported seed value type: ${typeof v}`)
}

export async function renderSeedBlock(): Promise<string> {
  const { default: Database } = await import('better-sqlite3')
  const { applyMigrations } = await import('../src/db-migrations.js')
  const db = new Database(':memory:')
  applyMigrations(db)

  const tables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND name NOT LIKE '%\\_fts%' ESCAPE '\\' AND name NOT LIKE 'vec\\_%' ESCAPE '\\' ORDER BY name`,
  ).all() as { name: string }[]).map((r) => r.name)

  const seeded = tables.filter((t) => (db.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get() as unknown) !== undefined && !NOT_SEED.has(t))
  const listed = SEED_TABLES.map((t) => t.name).sort()
  if (JSON.stringify(seeded) !== JSON.stringify(listed)) {
    throw new Error(`the SQLite chain seeds [${seeded.join(', ')}] but SEED_TABLES lists [${listed.join(', ')}]: update SEED_TABLES`)
  }

  const out: string[] = [BEGIN_MARK]
  for (const t of SEED_TABLES) {
    const info = db.prepare(`SELECT name, dflt_value FROM pragma_table_info('${t.name}') ORDER BY cid`).all() as { name: string; dflt_value: string | null }[]
    const cols = info.filter((c) => c.dflt_value !== 'unixepoch()' && !(t.omit ?? []).includes(c.name)).map((c) => c.name)
    const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t.name}" ORDER BY ${t.orderBy}`).all() as Record<string, unknown>[]
    if (rows.length === 0) throw new Error(`${t.name} has no rows in the SQLite chain`)
    out.push('')
    out.push(`-- ${t.name}: ${rows.length} row${rows.length === 1 ? '' : 's'}`)
    out.push(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES`)
    out.push(rows.map((r) => `  (${cols.map((c) => literal(r[c])).join(', ')})`).join(',\n'))
    out.push('ON CONFLICT DO NOTHING;')
  }
  out.push('')
  out.push(END_MARK)
  return out.join('\n')
}

/** The baseline with its generated block replaced by `block` (appended when the markers are not there yet). */
export function spliceBlock(baseline: string, block: string): string {
  const b = baseline.indexOf(BEGIN_MARK)
  const e = baseline.indexOf(END_MARK)
  if (b === -1 && e === -1) return baseline.replace(/\n*$/, '\n\n') + block + '\n'
  if (b === -1 || e === -1 || e < b) throw new Error('the baseline has only one of the two seed markers')
  return baseline.slice(0, b) + block + baseline.slice(e + END_MARK.length)
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const current = readFileSync(BASELINE, 'utf8')
  const next = spliceBlock(current, await renderSeedBlock())
  if (check) {
    if (next !== current) {
      console.error('0001_baseline.sql seed block is stale: run `npx tsx scripts/generate-pg-baseline-seed.ts`')
      process.exit(1)
    }
    console.log('seed block up to date')
    return
  }
  if (next !== current) writeFileSync(BASELINE, next)
  console.log(next === current ? 'seed block already up to date' : 'seed block written')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
