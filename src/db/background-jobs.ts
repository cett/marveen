// The background jobs of the dashboard and the db context each one runs in.
//
// A timer, a file watcher or a boot task that touches the database has no request to take a context from, and the
// context carrier (context.ts) does not reach a callback created outside `runAs`. Every such job opens its own context
// with the helpers below; this table is the classification they are checked against (a test pins that each entry is
// really bound in its file and that no file with an interval or a watcher is missing from here).
//
//   system         the job is the dashboard itself: sweepers, pollers, monitors, the file watchers. `runAs.system(name)`.
//   agent          the job acts for one agent at a time: `runAs.agent(agentId, tenantId)` per agent, the tenant looked up
//                  once and kept for a while (setAgentTenantResolver; the default is the `default` tenant).
//   hybrid         a system job that switches to the tenant of the item it handles for the writes (message router, schedule runner).
//   tenant-loop    a system job today that visits every tenant (token usage, import crawler, the daily digest). The row-level
//                  security step turns each visit into its own `runAs.tenant`; until then the loop is one system context.
//
// `NOT_DB_TIMER_FILES` are the files that own an interval or a watcher and, by a static call-graph pass over the whole
// of src (the recipe is in docs/db-facade.md), never reach a facade call. The counter confirms it in operation: such a
// file showing up in `getDbContextStats().sites` is a classification bug.

import { runAs } from './context.js'

export type JobRole = 'system' | 'agent' | 'hybrid' | 'tenant-loop'

export interface BackgroundJob {
  /** The file that starts the job. */
  file: string
  role: JobRole
  /** What the job does and, for hybrid and tenant-loop, what the PostgreSQL step has to do with it. */
  note: string
}

export const BACKGROUND_JOBS = {
  'memory-decay': { file: 'src/index.ts', role: 'system', note: 'daily decay of the memory tiers, once at boot and then every 24 hours' },
  'daily-digest': { file: 'src/index.ts', role: 'tenant-loop', note: 'daily log at 23:00 from the memories of the owner chat' },
  'store-watcher': { file: 'src/store-watcher.ts', role: 'system', note: 'file watcher on the store directory writing the audit trail' },
  'auth-state-sweep': { file: 'src/web.ts', role: 'system', note: 'hourly sweep of expired browser sessions and device keys' },
  'token-usage-collector': { file: 'src/web.ts', role: 'tenant-loop', note: 'transcript token usage per agent, each agent written under its tenant' },
  'approval-timeout-sweeper': { file: 'src/web/routes/approvals.ts', role: 'system', note: 'expires pending approvals every minute' },
  'blackboard-stale-sweeper': { file: 'src/web/blackboard-stale-sweeper.ts', role: 'system', note: 'marks stale blackboard rows and plan bindings' },
  'channel-credential-drift': { file: 'src/web/channel-credentials.ts', role: 'system', note: 'compares channel credentials with their stored baseline' },
  'channel-monitor': { file: 'src/web/channel-monitor.ts', role: 'system', note: 'channel session health check, may stop or restart a session' },
  'channel-request-watcher': { file: 'src/web/channel-request-watcher.ts', role: 'system', note: 'channel audit trail into the pending channel requests' },
  'egress-baseline': { file: 'src/web/egress-allowlist-baseline.ts', role: 'system', note: 'tamper check of the allow-lists, a change queues an agent message' },
  'federation-poller': { file: 'src/web/federation/poller.ts', role: 'system', note: 'peer manifest poll, reads the federation config' },
  'capability-runner': { file: 'src/web/federation/capability-runner.ts', role: 'system', note: 'capability summary generation, reads the federation config' },
  'inbound-probe': { file: 'src/web/inbound-probe.ts', role: 'system', note: 'userbot inbound-deafness probe, reads settings' },
  'stuck-tool-call': { file: 'src/web/stuck-tool-call-watcher.ts', role: 'system', note: 'stuck tool-call detector, may restart a session' },
  'inbox-nudge-watcher': { file: 'src/web/inbox-nudge-watcher.ts', role: 'system', note: 'nudges an agent whose pending messages wait' },
  'model-fallback': { file: 'src/web/model-fallback-runner.ts', role: 'system', note: 'usage-limit fallback, restarts the session on the other model' },
  'otel-push-exporter': { file: 'src/web/otel-push-exporter.ts', role: 'system', note: 'ships spans, logs and metrics, keeps its cursor in the db' },
  'rbac-mode-refresh': { file: 'src/web/rbac-mode.ts', role: 'system', note: 'refreshes the cached RBAC mode from system_config' },
  'reauth-healer': { file: 'src/web/reauth-healer.ts', role: 'system', note: 'logs a session back in after a credential loss' },
  'workspace-docs-ttl-sweeper': { file: 'src/web/workspace-docs-ttl-sweeper.ts', role: 'system', note: 'deletes expired workspace documents' },
  'import-crawler': { file: 'src/web/import-crawler.ts', role: 'tenant-loop', note: 'due import sources of every tenant' },
  'message-router': { file: 'src/web/message-router.ts', role: 'hybrid', note: 'delivers the pending agent messages; the writes of one message use the tenant of that message' },
  'schedule-runner': { file: 'src/web/schedule-runner.ts', role: 'hybrid', note: 'runs the due scheduled tasks; the writes of one run use the tenant of that task' },
  'auto-restart': { file: 'src/web/auto-restart-runner.ts', role: 'agent', note: 'scheduled restart of one agent session' },
  'context-guard': { file: 'src/web/context-guard-runner.ts', role: 'agent', note: 'context saturation guard of one agent' },
  'context-restart-gate': { file: 'src/web/context-restart-gate-runner.ts', role: 'agent', note: 'context restart gate of one agent' },
  'background-task': { file: 'src/web/routes/background-tasks.ts', role: 'agent', note: 'poll and timeout of one background task of an agent' },
  'boot-sequence': { file: 'src/index.ts', role: 'system', note: 'the fire-and-forget backfills and passes started while the dashboard boots' },
  'http-gate': { file: 'src/web.ts', role: 'system', note: 'the request before a principal is known: the auth lookups, the RBAC gate and the shadow counters' },
  'http-public': { file: 'src/db/background-jobs.ts', role: 'system', note: 'a route served without a credential: login, auth status, avatars, the static files' },
  'http-admin': { file: 'src/db/background-jobs.ts', role: 'system', note: 'a global admin session (role admin, no tenant)' },
  'http-global-viewer': { file: 'src/db/background-jobs.ts', role: 'system', note: 'an authenticated caller of any other role without a tenant (a global viewer); what it may see under row-level security is a PostgreSQL-step decision' },
  'http-metrics': { file: 'src/otel-http.ts', role: 'system', note: 'the request counters written when a response is done (an event callback does not carry the request context)' },
  'shutdown-flush': { file: 'src/web.ts', role: 'system', note: 'flushes the running state on SIGTERM' },
} as const satisfies Record<string, BackgroundJob>

export type BackgroundJobName = keyof typeof BACKGROUND_JOBS
export type AgentJobName = { [K in BackgroundJobName]: (typeof BACKGROUND_JOBS)[K]['role'] extends 'agent' ? K : never }[BackgroundJobName]

/** Files that own an interval or a watcher and never reach a facade call (static pass, confirmed by the counter in operation). */
export const NOT_DB_TIMER_FILES: Record<string, string> = {
  'src/heartbeat.ts': 'legacy native heartbeat: initHeartbeat is imported but never started (src/index.ts)',
  'src/web/agent-process-identity.ts': 'tmux polling',
  'src/web/channel-health-monitor.ts': 'tmux pane checks',
  'src/web/channel-invites.ts': 'invite files',
  'src/web/claude-update-runner.ts': 'tmux and the update script',
  'src/web/command-task.ts': 'child process timing',
  'src/web/mcp-list.ts': 'cached connector list',
  'src/web/routes/agent-terminal.ts': 'tmux stream',
  'src/agent.ts': 'typing indicator while the model runs',
  'src/web/db-context-report.ts': 'reads the counter, no db',
  'src/web/stuck-input-watcher.ts': 'tmux panes',
  'src/web/update-checker.ts': 'git fetch',
  'src/web/worker-liveness.ts': 'worker session liveness',
}

// ---- Helpers --------------------------------------------------------------------------------------------

/**
 * The context of a request, from what the auth gate resolved: an agent token runs as that agent in its tenant, a
 * tenant caller as the tenant, and a caller without a credential as the named system job `http-public`.
 *
 * A caller without a tenant (a global session) gets the unrestricted `http-admin` context ONLY when its role is `admin`.
 * Any other authenticated session role without a tenant is the separate, expected job `http-global-viewer`, so the unexpected count
 * stays clean and the PostgreSQL step can give it its own, restricted role. What it may read across tenants is decided there.
 */
export function runAsRequest<T>(who: { authenticated: boolean; role: string | undefined; agentId?: string; tenantId: string | null }, fn: () => T): T {
  if (!who.authenticated) return runAs.system('http-public', fn)
  // An agent token without a tenant runs as the agent in the `default` tenant, the fallback of `resolveTenantId`. That is
  // today's rule, not the final one (Phase 2 decides it).
  if (who.agentId) return runAs.agent(who.agentId, who.tenantId ?? 'default', fn)
  if (who.tenantId === null && who.role === 'admin') return runAs.system('http-admin', fn)
  if (who.tenantId === null) return runAs.system('http-global-viewer', fn)
  return runAs.tenant(who.tenantId, fn)
}

/** The same function, every call running in `runAs.system(name)`. For a timer or an event callback created OUTSIDE a `runAs`. */
export function systemJob<A extends unknown[], R>(name: BackgroundJobName, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => runAs.system(name, () => fn(...args))
}

const TENANT_TTL_MS = 5 * 60_000

type TenantResolver = (agentId: string) => Promise<string>
let resolveTenant: TenantResolver = () => Promise.resolve('default')
const tenantCache = new Map<string, { tenantId: string; at: number }>()

/**
 * How `runAsAgentJob` finds the tenant of an agent. The dashboard sets it at boot (the tenant availability lookup); the
 * default answers the `default` tenant, which keeps a unit test free of any database.
 */
export function setAgentTenantResolver(fn: TenantResolver): void {
  resolveTenant = fn
  tenantCache.clear()
}

/** Test hook: back to the default resolver with an empty cache. */
export function resetAgentTenantResolver(): void {
  resolveTenant = () => Promise.resolve('default')
  tenantCache.clear()
}

async function tenantOf(job: BackgroundJobName, agentId: string): Promise<string> {
  const hit = tenantCache.get(agentId)
  if (hit && Date.now() - hit.at < TENANT_TTL_MS) return hit.tenantId
  // The lookup itself is a db call of this job, made before the agent context exists.
  const tenantId = await runAs.system(job, () => resolveTenant(agentId))
  tenantCache.set(agentId, { tenantId, at: Date.now() })
  return tenantId
}

/**
 * Runs `fn` as `runAs.agent(agentId, tenant)` for a job whose work belongs to one agent. A failed tenant lookup does not
 * stop the job: it runs under the `default` tenant and the failure is not cached.
 */
export async function runAsAgentJob<T>(job: AgentJobName, agentId: string, fn: () => T | Promise<T>): Promise<T> {
  let tenantId: string
  try {
    tenantId = await tenantOf(job, agentId)
  } catch {
    tenantId = 'default'
  }
  return runAs.agent(agentId, tenantId, async () => fn())
}
