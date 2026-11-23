// The twin rule between the SQLite migration chain and the PostgreSQL one.
//
// The PG baseline (src/migrations-pg/0001) is the SQLite end state at version 95. From there every new SQLite migration
// has to come with a PG twin, or the PG schema silently falls behind the one the application runs on. The PG numbers
// are assigned by ORDER: the SQLite migrations above 95, sorted, take the PG slots 0002, 0003, ... in turn, skipping the
// numbers of the PG-only migrations (below). Today 0096 <-> 0002; the next SQLite migration (0097) <-> 0008 once the five
// PG-only numbers are taken.

/** The SQLite version the PG baseline was cut at. */
export const PG_BASELINE_SQLITE_VERSION = 95

/**
 * PostgreSQL migrations with no SQLite twin: the full-text migrations of phase 3 step 6a (the SQLite side keeps its FTS5
 * tables), the vector embedding tables of step 6b (the SQLite side keeps its vec0 tables), and the cost_budgets amount type
 * of step 6c-2 (SQLite's INTEGER column takes a REAL amount; PostgreSQL needs double precision). Retired with the SQLite
 * chain. A listed name must exist in the PG directory, and a listed number is skipped when the SQLite migrations take
 * their PG slots. Empty for every synthetic cell.
 */
export const PG_ONLY_MIGRATIONS: readonly string[] = [
  '0003_fts_config.sql',
  '0004_memories_fts.sql',
  '0005_artifacts_fts.sql',
  '0006_workspace_docs_fts.sql',
  '0007_vec_embeddings.sql',
  '0008_cost_budgets_amount.sql',
]

const FILE = /^(\d{4,})_(.+)\.sql$/

function versionsOf(names: string[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const n of names) {
    const m = FILE.exec(n)
    if (m) out.set(parseInt(m[1]!, 10), n)
  }
  return out
}

const pad = (n: number): string => String(n).padStart(4, '0')
const numberOf = (name: string): number => parseInt(FILE.exec(name)?.[1] ?? 'NaN', 10)

/**
 * What is wrong between the two chains, one line per problem, each saying what to add or remove. Empty = the chains
 * match. `sqliteNames` and `pgNames` are the file names of the two migration directories; `pgOnly` names the PG-only files
 * (default: none, so the chains are held exactly as before).
 */
export function twinProblems(sqliteNames: string[], pgNames: string[], pgOnly: readonly string[] = []): string[] {
  const sqlite = versionsOf(sqliteNames)
  const pgFiles = versionsOf(pgNames)
  const problems: string[] = []

  // a .sql file the runners do not recognise never runs: a typo in a migration name must not pass as "no migration"
  for (const [dirName, names] of [['src/migrations', sqliteNames], ['src/migrations-pg', pgNames]] as const) {
    for (const n of names) {
      if (n.endsWith('.sql') && !FILE.test(n)) problems.push(`${dirName}/${n} does not match NNNN_description.sql, so the runner would never apply it`)
    }
  }

  // the PG-only list cannot hide anything: a listed file must exist (a rename must not pass silently), and none is the baseline
  for (const name of pgOnly) {
    if (!pgNames.includes(name)) problems.push(`PG-only migration ${name} is listed but missing: update PG_ONLY_MIGRATIONS`)
    if (numberOf(name) <= 1) problems.push(`PG-only migration ${name} is at or below 0001 (the baseline): the baseline and the first twin slot are not PG-only`)
  }
  const pgOnlyNumbers = new Set(pgOnly.map(numberOf))

  // the SQLite migrations above the baseline take the PG slots in order, skipping the PG-only numbers
  const wanted = new Map<number, string>() // pg number -> the sqlite file it twins
  let slot = 2
  for (const [, sqliteName] of [...sqlite].filter(([v]) => v > PG_BASELINE_SQLITE_VERSION).sort((a, b) => a[0] - b[0])) {
    while (pgOnlyNumbers.has(slot)) slot++
    wanted.set(slot, sqliteName)
    slot++
  }
  // the next SQLite number, for the message about a PG file with no SQLite twin
  const nextSqlite = Math.max(PG_BASELINE_SQLITE_VERSION, ...sqlite.keys()) + 1

  for (const [n, sqliteName] of [...wanted].sort((a, b) => a[0] - b[0])) {
    const have = pgFiles.get(n)
    const suffix = sqliteName.replace(/^\d+_/, '')
    if (have !== undefined && have.replace(/^\d+_/, '') !== suffix) {
      problems.push(`PostgreSQL migration ${have} is the twin of SQLite ${sqliteName} by order, but the names differ: rename it to ${pad(n)}_${suffix}`)
    }
    if (!pgFiles.has(n)) {
      problems.push(`SQLite migration ${sqliteName} has no PostgreSQL twin: add src/migrations-pg/${pad(n)}_${suffix} (the next PG slot after the PG-only numbers)`)
    }
  }
  for (const [n, pgName] of [...pgFiles].sort((a, b) => a[0] - b[0])) {
    if (n <= 1) continue // 0001 is the baseline
    if (pgOnly.includes(pgName)) continue // a named PG-only file has no SQLite twin by design
    if (!wanted.has(n)) {
      problems.push(`PostgreSQL migration ${pgName} has no SQLite twin: the next SQLite migration (${pad(nextSqlite)}_*) would take this slot, or name it in PG_ONLY_MIGRATIONS`)
    }
  }
  if (!pgFiles.has(1)) problems.push('src/migrations-pg has no 0001 baseline file')
  return problems
}
