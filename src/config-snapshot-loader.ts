// Reads the system_config overrides from PostgreSQL for the config snapshot (phase 3, step 6c-3). It runs in the bootstrap
// (src/index.ts), before config.ts evaluates, so it imports nothing from config.ts or the db layer: only the driver.
//
// One short-lived client (not the pool), with a connect timeout; the client ends on success and on error. Only SQLSTATE 42P01
// (relation does not exist: a fresh database whose baseline has not run yet; the migrations run after config evaluates) is
// an empty snapshot. Every other failure throws, and the message names no URL and no password. The match is on the error
// code, never on the message text.
//
// The one query (SYSTEM_CONFIG_QUERY) is the place a privileged read goes: system_config is a global table, and the
// row-level security step (plan/pg-rls, class D2) changes this one query, nothing else.
import pg from 'pg'

export const SYSTEM_CONFIG_QUERY = 'SELECT key, value FROM system_config'

const UNDEFINED_TABLE = '42P01'

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

// What the error says, without any driver text: a SQLSTATE (five characters, from the server), a Node error code for a
// transport failure (ECONNREFUSED, ENOTFOUND, ...), or nothing.
function reasonOf(err: unknown): string {
  const code = codeOf(err)
  if (code === undefined) return 'no error code'
  // SQLSTATE: a digit-led class, or the internal class XX; a five-letter Node code (EPERM, EBUSY, EPIPE) is not one
  return /^(?:[0-9][0-9A-Z]{4}|XX[0-9A-Z]{3})$/.test(code) ? `SQLSTATE ${code}` : `error code ${code}`
}

/**
 * The system_config rows of the database at `url` as a key -> value map. `{}` only for SQLSTATE 42P01 (a database without the
 * table yet); any other error throws with a message that carries the SQLSTATE and nothing else from the driver.
 */
export async function loadSystemConfigSnapshot(url: string, connectTimeoutMs = 5000): Promise<Record<string, string>> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: connectTimeoutMs })
  try {
    await client.connect()
    const res = await client.query(SYSTEM_CONFIG_QUERY)
    const out: Record<string, string> = {}
    for (const row of res.rows as { key: string; value: string }[]) out[row.key] = row.value
    return out
  } catch (err) {
    if (codeOf(err) === UNDEFINED_TABLE) return {}
    throw new Error(`system_config snapshot could not be read (${reasonOf(err)})`)
  } finally {
    await client.end().catch(() => { /* never connected, or already closed */ })
  }
}
