// The PG module run under the APP role (MARVEEN_TEST_PG_ROLE=app, `npm run test:pg-modules-app`).
//
// The module suite normally talks to PostgreSQL as the superuser of the test server: it sees every row whatever the
// policies say, so a module that works there can still fail as the role the dashboard runs as (marveen_app: DML rights
// only, owns nothing, row-level security applies, FORCE on). This switch runs the SAME tests as that role, with the real
// policies and the real `app.role` that the adapter sets from the db context. What it catches: a missing right, a DML or
// ownership assumption, a write a policy refuses under a context the test did set. What it does NOT catch: the silent-empty
// class (a call with no context that sees no row and swallows it), because such a call gets the system context below;
// that class is pinned by the bare cells in src/__tests__/pg/ (no wrapper).
//
// The one thing a test has to be given is a default context. The tests call db functions straight from the test body,
// outside any `runAs`, the way no production path does (a request, a job and the boot each carry a context, or open one).
// Under the app role a call with no context sees nothing and is refused any write, so such a call gets the SYSTEM
// context, the widest one a process job has: what the test means is "the module works", and the isolation between
// tenants is pinned by the cells that run in a tenant context on purpose. A call that DOES carry a context keeps it.
// Only a call whose five settings are all empty is touched; nothing here changes a policy or what the adapter sends
// for a real context.
import type pg from 'pg'
import { PG_SET_CONTEXT_SQL, type PgClientLike, type PgPoolLike } from '../../db/pg/dbx.js'

/** The job name the default context carries, so a grep of a failure finds it. */
export const APP_ROLE_DEFAULT_JOB = 'test-default-context'

export const TEST_PG_ROLE_ENV = 'MARVEEN_TEST_PG_ROLE'

/** The role the dashboard serves with; pg-test-db.ts creates it under this name. */
export const PG_TEST_APP_ROLE = 'marveen_app'

/** `app` when MARVEEN_TEST_PG_ROLE=app, `admin` when it is unset or `admin`; any other value is an error (a typo must not run the superuser quietly). */
export function testPgRole(env: NodeJS.ProcessEnv = process.env): 'admin' | 'app' {
  const v = env[TEST_PG_ROLE_ENV]
  if (v === undefined || v === '' || v === 'admin') return 'admin'
  if (v === 'app') return 'app'
  throw new Error(`${TEST_PG_ROLE_ENV} must be "app" or "admin" (or unset), got "${v}"`)
}

/** The five settings of a call with no db context: all empty (pgContextValues(undefined)). */
function isNoContext(cfg: pg.QueryConfig): boolean {
  return cfg.text === PG_SET_CONTEXT_SQL && Array.isArray(cfg.values) && cfg.values.length === 5 && cfg.values.every((v) => v === '')
}

/**
 * A pool whose clients answer a call with no db context as the system context (see the header). The client is a view
 * (a Proxy), not a patched object: `query` is looked up on the real client at the moment of the call, so a test that
 * spies on the driver's `Client.prototype.query` (it records the control statements) still sees every statement.
 */
export function withDefaultSystemContext(pool: PgPoolLike): PgPoolLike {
  return {
    on: pool.on ? (event, listener) => pool.on?.(event, listener) : undefined,
    async connect(): Promise<PgClientLike> {
      const client = await pool.connect()
      return new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return (cfg: pg.QueryConfig) =>
              target.query(isNoContext(cfg) ? { ...cfg, values: ['', 'system', '', APP_ROLE_DEFAULT_JOB, ''] } : cfg)
          }
          const value: unknown = Reflect.get(target, prop, target)
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      })
    },
  }
}
