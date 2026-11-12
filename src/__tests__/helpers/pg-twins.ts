// The twin rule between the SQLite migration chain and the PostgreSQL one.
//
// The PG baseline (src/migrations-pg/0001) is the SQLite end state at version 95. From there every new SQLite
// migration has to come with a PG twin, or the PG schema silently falls behind the one the application runs on. The
// numbers map by a fixed offset: PG 0001 is SQLite 95, so SQLite NNNN (NNNN > 95) is PG NNNN - 94 (0096 <-> 0002).

/** The SQLite version the PG baseline was cut at. */
export const PG_BASELINE_SQLITE_VERSION = 95
/** sqlite version = pg number + this. */
export const PG_TO_SQLITE_OFFSET = PG_BASELINE_SQLITE_VERSION - 1

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

/**
 * What is wrong between the two chains, one line per problem, each saying what to add or remove. Empty = the chains
 * match. `sqliteNames` and `pgNames` are the file names of the two migration directories.
 */
export function twinProblems(sqliteNames: string[], pgNames: string[]): string[] {
  const sqlite = versionsOf(sqliteNames)
  const pgFiles = versionsOf(pgNames)
  const problems: string[] = []

  const wanted = new Map<number, string>() // pg number -> the sqlite file it twins
  for (const [v, name] of sqlite) {
    if (v > PG_BASELINE_SQLITE_VERSION) wanted.set(v - PG_TO_SQLITE_OFFSET, name)
  }
  for (const [n, sqliteName] of [...wanted].sort((a, b) => a[0] - b[0])) {
    if (!pgFiles.has(n)) {
      const suffix = sqliteName.replace(/^\d+_/, '')
      problems.push(`SQLite migration ${sqliteName} has no PostgreSQL twin: add src/migrations-pg/${pad(n)}_${suffix} (the PG number is the SQLite number minus ${PG_TO_SQLITE_OFFSET})`)
    }
  }
  for (const [n, pgName] of [...pgFiles].sort((a, b) => a[0] - b[0])) {
    if (n <= 1) continue // 0001 is the baseline
    if (!wanted.has(n)) {
      problems.push(`PostgreSQL migration ${pgName} has no SQLite twin: SQLite ${pad(n + PG_TO_SQLITE_OFFSET)}_* does not exist (the PG number plus ${PG_TO_SQLITE_OFFSET} is the SQLite number)`)
    }
  }
  if (!pgFiles.has(1)) problems.push('src/migrations-pg has no 0001 baseline file')
  return problems
}
