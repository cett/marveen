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
/** Distinct call sites and job names kept; one more is folded into "(other)" so the maps cannot grow without bound. */
const MAX_SITES = 100
const MAX_JOBS = 200
/** Every call without a context is sampled for its call site until this many were seen, then one in SAMPLE_EVERY. */
const SAMPLE_ALL_UNTIL = 256
const SAMPLE_EVERY = 16
const OTHER = '(other)'

// The boot phase: module-load reads (config values, migrations) run before any `runAs` can exist. They are counted
// apart (`duringBoot`) and are not "unexpected". The dashboard ends the phase once it listens; a test starts in the
// running phase (the reset hooks below), so a test never inherits the boot allowance.
let booting = true

let total = 0
let withoutContext = 0
let duringBoot = 0
let lastCallSite: string | null = null
let lastWarnAt = 0
let sampledSeen = 0
const callSites = new Map<string, { count: number; boot: boolean }>()
const jobCalls = new Map<string, number>()
const roleCalls: Record<DbRole, number> = { system: 0, tenant: 0, agent: 0 }

export interface DbContextSite {
  /** The first stack frame outside src/db. */
  site: string
  /** Sampled count: a lower bound once the sampling has started. */
  count: number
  /** Seen before the boot phase ended. */
  boot: boolean
}

export interface DbContextStats {
  /** Every facade call since start. */
  total: number
  /** Calls that carried no context, boot phase included. */
  withoutContext: number
  /** Of those, the ones made before the boot phase ended: module-load reads and the boot sequence itself. */
  duringBoot: number
  /** `withoutContext - duringBoot`: the number the Phase 1 measurement window must hold at 0. */
  unexpected: number
  /** Calls with a context, by role. */
  byRole: Record<DbRole, number>
  /** Calls of `runAs.system(name)`, by job name: shows which classified jobs actually touch the db. */
  byJob: Record<string, number>
  /** Where calls without a context came from, most frequent first. Sampled (see SAMPLE_*), so the counts are lower bounds. */
  sites: DbContextSite[]
  /** Where a call without a context came from. Sampled: updated when the warning is logged (at most once per minute), not on every call. */
  lastCallSite: string | null
  /** True until `endDbBootPhase()` ran. */
  booting: boolean
}

/** The first stack line outside src/db and node internals: the module that called the db function, not the db function itself. */
function callerSite(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(1)
  const outside = lines.find((l) => !/[\\/]src[\\/]db[\\/]|[\\/]src[\\/]db\.[jt]s|node:internal/.test(l))
  return (outside ?? lines[0] ?? 'unknown').trim()
}

function bump(map: Map<string, number>, key: string, cap: number): void {
  const k = map.has(key) || map.size < cap ? key : OTHER
  map.set(k, (map.get(k) ?? 0) + 1)
}

/** Called by the facade on every call (statement or transaction). Cheap on the hot path: a stack is captured only for a sampled call without a context. */
export function noteDbCall(): void {
  total += 1
  const ctx = store.getStore()
  if (ctx !== undefined) {
    roleCalls[ctx.role] += 1
    if (ctx.role === 'system' && ctx.name) bump(jobCalls, ctx.name, MAX_JOBS)
    return
  }
  withoutContext += 1
  if (booting) duringBoot += 1
  if (sampledSeen < SAMPLE_ALL_UNTIL || withoutContext % SAMPLE_EVERY === 0) {
    sampledSeen += 1
    const site = callerSite()
    const key = booting ? `boot|${site}` : site
    const known = callSites.get(key)
    if (known) known.count += 1
    else if (callSites.size < MAX_SITES) callSites.set(key, { count: 1, boot: booting })
    else {
      const other = callSites.get(OTHER)
      if (other) other.count += 1
      else callSites.set(OTHER, { count: 1, boot: false })
    }
  }
  if (booting) return
  const now = Date.now()
  if (now - lastWarnAt < WARN_INTERVAL_MS && lastWarnAt !== 0) return
  lastWarnAt = now
  lastCallSite = captureOrigin()
  logger.warn({ callSite: lastCallSite, withoutContext, unexpected: withoutContext - duringBoot, total }, 'db: call without a db context (runAs.system / tenant / agent); not enforced yet')
}

/** The dashboard is up: from here a call without a context is unexpected. */
export function endDbBootPhase(): void {
  booting = false
}

export function getDbContextStats(): DbContextStats {
  const sites = [...callSites.entries()]
    .map(([key, v]) => ({ site: v.boot ? key.slice('boot|'.length) : key, count: v.count, boot: v.boot }))
    .sort((a, b) => b.count - a.count)
  return {
    total,
    withoutContext,
    duringBoot,
    unexpected: withoutContext - duringBoot,
    byRole: { ...roleCalls },
    byJob: Object.fromEntries(jobCalls),
    sites,
    lastCallSite,
    booting,
  }
}

/** Test hook: zero the counters and the warning timer, and leave the boot phase (a test counts as running). */
export function resetDbContextStats(): void {
  total = 0
  withoutContext = 0
  duringBoot = 0
  lastCallSite = null
  lastWarnAt = 0
  sampledSeen = 0
  callSites.clear()
  jobCalls.clear()
  roleCalls.system = 0
  roleCalls.tenant = 0
  roleCalls.agent = 0
  booting = false
}

/** Test hook: the counters AND the carrier itself (a leaked `runAs` from a previous test must not reach the next one). */
export function resetDbContextForTest(): void {
  resetDbContextStats()
  store.disable()
}
