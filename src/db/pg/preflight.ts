// Capability preflight for the PostgreSQL backend (phase 3, c1): the server must have what the full-text search and the
// later vector search rely on, or the database is refused (fail closed). Exported as a function; NO production pool calls
// it yet (there is no production PostgreSQL pool in this phase): the test harness runs it on its pool, and the boot wiring
// comes with the pool itself. A warning is returned, not thrown, for a locale that makes [[:alnum:]] ASCII-only.

export interface PgPreflightReport {
  /** Non-fatal findings the operator should read (the database is still accepted). */
  warnings: string[]
}

/** The narrow query surface the preflight needs: a pg.Pool or pg.Client satisfies it. */
export interface PgPreflightQueryable {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Thrown when a required capability is missing: the message names the capability, the database is not used. */
export class PgPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PgPreflightError'
  }
}

/**
 * Checks, in this order: the server encoding is UTF8 (the text functions assume it); the unaccent extension is installed
 * (the search configuration needs it, and the migration creates it). Locale C or POSIX is a warning, not a refusal: the
 * normalizer's character class is then ASCII-only, which the search tests pin as a known difference.
 */
export async function pgPreflight(q: PgPreflightQueryable): Promise<PgPreflightReport> {
  const enc = (await q.query('SHOW server_encoding')).rows[0]?.['server_encoding']
  if (enc !== 'UTF8') {
    throw new PgPreflightError(`the server encoding is ${String(enc)}, the search needs UTF8`)
  }
  const ext = await q.query("SELECT 1 AS present FROM pg_extension WHERE extname = 'unaccent'")
  if (ext.rows.length === 0) {
    throw new PgPreflightError('the unaccent extension is not installed (CREATE EXTENSION unaccent needs to run first)')
  }
  const warnings: string[] = []
  const ctype = (await q.query('SELECT datctype FROM pg_database WHERE datname = current_database()')).rows[0]?.['datctype']
  if (ctype === 'C' || ctype === 'POSIX') {
    warnings.push(`lc_ctype is ${String(ctype)}: the normalizer's [[:alnum:]] class is ASCII-only in this database`)
  }
  return { warnings }
}
