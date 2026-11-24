import { allowNewerFromEnv, pgRuntimeStatus } from '../../db/pg-boot.js'
import { loadPgMigrationFiles } from '../../db-migrations-pg.js'
import { json } from '../http-helpers.js'
import { requireGlobalAdmin } from './global-admin.js'
import type { RouteContext } from './types.js'

// GET /api/admin/pg-runtime-status - the database backend this process runs on, and whether the PostgreSQL schema is
// newer than this build (the state the last successful boot recorded, set by bootPgBackend; nothing is recomputed per
// request). The answer is {backend, runningOnNewerDatabase, overrideEnabled, databaseHighest, shippedHighest}: versions
// only. It never carries the URL, a password, or the marker value. Read-only. Admin-only: named in the RBAC table
// (src/web/rbac.ts), not left to the unlisted-route fallback.
export function tryHandlePgRuntimeStatus(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/admin/pg-runtime-status' || ctx.method !== 'GET') return Promise.resolve(false)
  // The RBAC gate already refuses a non-admin; this holds in shadow mode too. Global admin only.
  if (!requireGlobalAdmin(ctx)) return Promise.resolve(true)
  const state = pgRuntimeStatus()
  const shipped = Math.max(0, ...loadPgMigrationFiles().map((f) => f.version))
  const padded = (v: number | null | undefined): string | null => (v == null ? null : String(v).padStart(4, '0'))
  json(ctx.res, {
    backend: state ? 'pg' : 'sqlite',
    runningOnNewerDatabase: state?.runningOnNewerDatabase ?? false,
    overrideEnabled: allowNewerFromEnv(),
    databaseHighest: padded(state?.databaseHighest ?? null),
    shippedHighest: String(shipped).padStart(4, '0'),
  })
  return Promise.resolve(true)
}
