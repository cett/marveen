import * as config from '../config.js'
import { getDashboardUserById } from '../db.js'
import { hasPermission } from './rbac.js'

// Run-time check of a task's author: before a live task fires, the dashboard user who last wrote its content (the
// `author_user_id` of the row) must still be allowed to write schedules. The decision is pure (decideAuthor) and
// the checker (createAuthorChecker) memoises the lookup per author for the life of one tick.
//
//   author_user_id NULL        -> 'ok', and no lookup at all (a seed, a token, an agent, a row with no user-bound author)
//   the lookup fails           -> 'unverifiable'  (fail closed, but only for a task that has a user-bound author)
//   user row gone / disabled   -> 'inactive'
//   role without schedules:write (viewer, read_only) -> 'inactive'
//   role admin                 -> 'ok': the tenant is NOT compared. A global admin has a NULL tenant and the tasks of
//                                 the fleet are in 'default'; comparing the two would read as "another tenant" and
//                                 stop everything. This branch has to stay ahead of the tenant branch.
//   any other role (agent)     -> 'ok' only with a tenant of its own that is the task's tenant, and that tenant is
//                                 not 'default' (only an admin writes the default tenant's tasks)

export type AuthorVerdict = 'ok' | 'inactive' | 'unverifiable'
export type AuthorBlock = Exclude<AuthorVerdict, 'ok'>

export interface AuthorUser { disabled: number; role: string; tenant_id: string | null }

/** What the check reads of a task: the stored author and tenant (a missing tenant reads as the default one). */
export interface AuthoredTask { authorUserId?: number; tenantId?: string | null }

const DEFAULT_TENANT = 'default'

export function decideAuthor(
  task: AuthoredTask,
  user: AuthorUser | undefined | 'error',
): AuthorVerdict {
  if (task.authorUserId == null) return 'ok'
  if (user === 'error') return 'unverifiable'
  if (user === undefined) return 'inactive'
  if (user.disabled !== 0) return 'inactive'
  if (!hasPermission(user.role as Parameters<typeof hasPermission>[0], 'schedules:write')) return 'inactive'
  if (user.role === 'admin') return 'ok'
  const taskTenant = task.tenantId ?? DEFAULT_TENANT
  if (user.tenant_id == null || user.tenant_id !== taskTenant || taskTenant === DEFAULT_TENANT) return 'inactive'
  return 'ok'
}

/** One lookup per distinct author per checker (create one per tick); the lookup is injectable for tests. */
export function createAuthorChecker(
  lookup?: (id: number) => Promise<AuthorUser | undefined>,
): (task: AuthoredTask) => Promise<AuthorVerdict> {
  const memo = new Map<number, Promise<AuthorUser | undefined | 'error'>>()
  return async (task) => {
    const id = task.authorUserId
    if (id == null) return 'ok'
    let found = memo.get(id)
    if (found === undefined) {
      // the default lookup is resolved only here, so a task with no user-bound author never touches the database module
      // (and a throw from the lookup itself, synchronous or not, is an unverifiable verdict)
      found = (async () => (lookup ?? getDashboardUserById)(id))().catch((): 'error' => 'error')
      memo.set(id, found)
    }
    return decideAuthor(task, await found)
  }
}

export type AuthorGateMode = 'enforce' | 'shadow'

/** Only the exact word `shadow` loosens the gate. Unset, blank, a misspelling or anything else is `enforce`. */
export function parseAuthorGateMode(raw: unknown): AuthorGateMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'shadow' ? 'shadow' : 'enforce'
}

/**
 * The mode asked for through the environment file, read once at start (config.ts): there is no API and no
 * run-time write, so a token cannot loosen the gate; a change is a restart. A config module that cannot be read
 * (a failure, a mock without the key) is `enforce`.
 */
export function authorGateMode(): AuthorGateMode {
  try { return parseAuthorGateMode((config as unknown as Record<string, unknown>)['SCHEDULE_AUTHOR_GATE']) }
  catch { return 'enforce' }
}
