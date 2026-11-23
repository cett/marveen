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
 * The role preflight (RLS step S2, c3): the role the dashboard SERVES with must be one that row-level security binds. A role
 * that is a superuser, has BYPASSRLS, or owns a table in the database reads past every policy, so a database that is served
 * through it has no tenant isolation at all, whatever the policies say. So does a MEMBER of such a role: a member of the
 * owner role (INHERIT) has the owner's rights, a member without INHERIT can SET ROLE into it, and the same holds for a
 * superuser or BYPASSRLS role. Refused unconditionally: there is no override.
 *
 * Two roles are judged, each with the same conditions: `current_user` (the role the policies are evaluated for) and
 * `session_user` (the role that logged in). They differ when the login carries a startup `role` option or the role has a
 * `ALTER ROLE ... SET role` default: a superuser login that starts as the app role shows the app role as `current_user`,
 * and `SET ROLE <login role>` makes the session the superuser again, so the login role must be a clean one too.
 *
 * It is a fact about the connected roles, needs no data and no policy, and is checked per role in this order: superuser,
 * BYPASSRLS, owns (or is a member of the owner of) a table in any non-system schema of the database, is a member of a superuser or
 * BYPASSRLS role, has CREATEROLE, is a member of a built-in role that reaches the server host. A role that cannot be found in
 * pg_roles, or an attribute that is not exactly `false`, is refused too (fail closed). The message names the condition (and
 * whether it is the login role), never the role and never the URL. Run it on the SERVING pool, not on the migration pool
 * (the owner).
 *
 * CREATEROLE: on PostgreSQL 16 it is hardening, not a closed exploit (a CREATEROLE role can only hand out roles it has the
 * ADMIN option on); on 15 and older it could grant itself the owner role. The app role never needs it, so the rule holds on
 * any major without a version table.
 */
export async function pgRolePreflight(q: PgPreflightQueryable): Promise<void> {
  const rows = (
    await q.query(
      // One row per judged name: `w` carries current_user and session_user, joined to pg_roles (a name that is not there drops
      // its row, and the missing row is a refusal below).
      // owned: tables of EVERY non-system schema whose owner the role IS or is a MEMBER of (a role is a member of itself). Not
      // only current_schema(): a search_path that starts with an empty schema would hide the owner's tables from that check,
      // while unqualified names still resolve to them. Every pg_* schema is skipped (PostgreSQL reserves that prefix: the
      // catalog, and the temporary tables of other sessions, none of which a policy is about; information_schema holds only
      // views, which pg_tables does not list). Any membership
      // counts, with or without INHERIT: a member with INHERIT has the owner's rights, and one without can SET ROLE into the
      // owner; policies do not bind an owner unless the table is FORCEd.
      // member_of_privileged: roles that are a superuser or have BYPASSRLS and that the role is a MEMBER of (any membership,
      // with or without INHERIT or SET): SET ROLE to one of them lifts row-level security from inside the session.
      // member_of_server_reach: the three built-in roles that reach the server host (COPY ... PROGRAM, server-side files).
      `SELECT w.which, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
              (SELECT count(*)::int FROM pg_tables t
                WHERE left(t.schemaname, 3) <> 'pg_' AND pg_has_role(w.name, t.tableowner, 'MEMBER')) AS owned,
              (SELECT count(*)::int FROM pg_roles x
                WHERE (x.rolsuper OR x.rolbypassrls) AND x.rolname <> w.name
                  AND pg_has_role(w.name, x.rolname, 'MEMBER')) AS member_of_privileged,
              (SELECT count(*)::int FROM pg_roles x
                WHERE x.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
                  AND x.rolname <> w.name AND pg_has_role(w.name, x.rolname, 'MEMBER')) AS member_of_server_reach
         FROM (VALUES ('current', current_user::name), ('session', session_user::name)) AS w(which, name)
         JOIN pg_roles r ON r.rolname = w.name`,
    )
  ).rows
  for (const [which, subject] of [
    ['current', 'the connected role'],
    ['session', 'the login role of the session'],
  ] as const) {
    const row = rows.find((r) => r['which'] === which)
    if (row === undefined) {
      throw new PgPreflightError(`${subject} is not visible in pg_roles, so it cannot be proven to be bound by row-level security`)
    }
    if (row['rolsuper'] !== false) {
      throw new PgPreflightError(`${subject} is a superuser: it bypasses row-level security, the dashboard must serve as the app role`)
    }
    if (row['rolbypassrls'] !== false) {
      throw new PgPreflightError(`${subject} has BYPASSRLS: it reads past row-level security, the dashboard must serve as the app role`)
    }
    const owned = Number(row['owned'])
    if (!Number.isInteger(owned) || owned !== 0) {
      throw new PgPreflightError(
        `${subject} owns a table in the database, or is a member of the role that does: an owner is not bound by row-level security, the dashboard must serve as the app role (the owner role only migrates)`,
      )
    }
    const privileged = Number(row['member_of_privileged'])
    if (!Number.isInteger(privileged) || privileged !== 0) {
      throw new PgPreflightError(
        `${subject} is a member of a role that is a superuser or has BYPASSRLS: SET ROLE would lift row-level security, the dashboard must serve as the app role`,
      )
    }
    if (row['rolcreaterole'] !== false) {
      throw new PgPreflightError(
        `${subject} has CREATEROLE: it can create roles and manage memberships, the dashboard must serve as the app role (hardening: on PostgreSQL 16 a CREATEROLE role cannot hand out the owner role, on older majors it can)`,
      )
    }
    const reach = Number(row['member_of_server_reach'])
    if (!Number.isInteger(reach) || reach !== 0) {
      throw new PgPreflightError(
        `${subject} is a member of a built-in role that reaches the server host (pg_execute_server_program, pg_read_server_files or pg_write_server_files): the dashboard must serve as the app role`,
      )
    }
  }
}

/**
 * Checks, in this order: the server encoding is UTF8 (the text functions assume it); the unaccent extension is installed
 * (the search configuration needs it, and the migration creates it); the vector extension is installed (the embedding
 * tables of migration 0007 need it, and the migration creates it). Locale C or POSIX is a warning, not a refusal: the
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
  const vec = await q.query("SELECT 1 AS present FROM pg_extension WHERE extname = 'vector'")
  if (vec.rows.length === 0) {
    // server_version_num is e.g. '160015' for 16.15: the major is the number divided by 10000
    const num = Number((await q.query('SHOW server_version_num')).rows[0]?.['server_version_num'] ?? 0)
    const major = Math.floor(num / 10000)
    throw new PgPreflightError(
      `the vector extension is not installed (PostgreSQL ${major}: install pgvector for this major, see docs/local-pgvector.md, then CREATE EXTENSION vector)`,
    )
  }
  const warnings: string[] = []
  const ctype = (await q.query('SELECT datctype FROM pg_database WHERE datname = current_database()')).rows[0]?.['datctype']
  if (ctype === 'C' || ctype === 'POSIX') {
    warnings.push(`lc_ctype is ${String(ctype)}: the normalizer's [[:alnum:]] class is ASCII-only in this database`)
  }
  return { warnings }
}
