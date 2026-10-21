// The db context carrier: WHO runs a db call, carried through `await`s with an
// AsyncLocalStorage, so the PostgreSQL phase can set the row-level-security role per call without every
// db function growing a parameter.
//
//   runAs.system('heartbeat', () => ...)          a job of the dashboard itself
//   runAs.tenant('acme', () => ...)               a request of a tenant
//   runAs.agent('agent-a', 'acme', () => ...)        a request of an agent token
//
// For now the carrier only RECORDS and COUNTS: a call without a context is not refused and nothing is
// filtered by it (that comes with the PostgreSQL step). Every facade call reads the context; a call without one bumps a counter
// and, at most once per interval, logs a warning with the call site, so the places that still need a
// `runAs` show up before enforcement exists.
//
// ALS traps (each one has a test):
//   - the context follows `await` and a `setTimeout` created INSIDE `runAs`,
//   - it does NOT reach a `setInterval` / `setTimeout` callback created BEFORE `runAs`: that callback keeps the
//     context of where it was created. A tick that touches the db has to open its own `runAs` (waves 3 and 4),
//   - a nested `runAs` replaces the context and the outer one is back when it returns,
//   - this store is independent of the transaction scope in tx-lock.ts and of the tenant request context.

import { AsyncLocalStorage } from 'node:async_hooks'
import { logger } from '../logger.js'
import { captureOrigin } from './tx-lock.js'

export type DbRole = 'system' | 'tenant' | 'agent'

export interface DbContext {
  role: DbRole
  /** system: the name of the job. */
  name?: string
  tenantId?: string
  agentId?: string
}

const store = new AsyncLocalStorage<DbContext>()

function requireId(kind: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`runAs.${kind}: a non-empty id is required`)
  return value
}

export const runAs = {
  system<T>(name: string, fn: () => T): T {
    return store.run({ role: 'system', name: requireId('system', name) }, fn)
  },
  tenant<T>(tenantId: string, fn: () => T): T {
    return store.run({ role: 'tenant', tenantId: requireId('tenant', tenantId) }, fn)
  },
  agent<T>(agentId: string, tenantId: string, fn: () => T): T {
    return store.run({ role: 'agent', agentId: requireId('agent', agentId), tenantId: requireId('agent', tenantId) }, fn)
  },
}

/** The context of the running call, or undefined when none was set. */
export function currentDbContext(): DbContext | undefined {
  return store.getStore()
}

// ---- Counting calls without a context ---------------------------------------------------------------------

const WARN_INTERVAL_MS = 60_000

let total = 0
let withoutContext = 0
let lastCallSite: string | null = null
let lastWarnAt = 0

export interface DbContextStats {
  /** Every facade call since start. */
  total: number
  /** Calls that carried no context. */
  withoutContext: number
  /** Where a call without a context came from. Sampled: updated when the warning is logged (at most once per minute), not on every call. */
  lastCallSite: string | null
}

/** Called by the facade on every call (statement or transaction). Cheap on the hot path: no stack is captured unless a warning is due. */
export function noteDbCall(): void {
  total += 1
  if (store.getStore() !== undefined) return
  withoutContext += 1
  const now = Date.now()
  if (now - lastWarnAt < WARN_INTERVAL_MS && lastWarnAt !== 0) return
  lastWarnAt = now
  lastCallSite = captureOrigin()
  logger.warn({ callSite: lastCallSite, withoutContext, total }, 'db: call without a db context (runAs.system / tenant / agent); not enforced yet')
}

export function getDbContextStats(): DbContextStats {
  return { total, withoutContext, lastCallSite }
}

/** Test hook: zero the counters and the warning timer. */
export function resetDbContextStats(): void {
  total = 0
  withoutContext = 0
  lastCallSite = null
  lastWarnAt = 0
}

/** Test hook: the counters AND the carrier itself (a leaked `runAs` from a previous test must not reach the next one). */
export function resetDbContextForTest(): void {
  resetDbContextStats()
  store.disable()
}
