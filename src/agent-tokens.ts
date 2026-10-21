// Issuing the per-agent API tokens (api_tokens.agent_id). One token file per agent, readable by that
// agent's own OS user only (0600), next to the agent's other private files; the raw token never
// appears on a command line, in a log line or in a return value. The shared dashboard token
// (store/.dashboard-token) stays as it is: the consumers move over in a later phase.
//
//   fleet agent   role fleet_agent, name `fleet-agent:<id>`, file agents/<id>/.agent-token
//   main agent    role admin,       name `main-agent:<id>`,  file <project root>/.agent-token
//                 (an admin token that is NAMED and revocable, with the agent id as its identity label)
//   operator      role admin,       name `operator`,         file store/.operator-token
//
// Issuing is idempotent: when the file holds a token that is still active nothing changes (the mode
// is only re-tightened). The file is written before the row, so a failure in between leaves a file
// nothing recognises (the next run replaces it), never a valid token nobody holds.

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, STORE_DIR } from './config.js'
import {
  archiveDashboardTokenCreatedAt, getApiTokenRowByHash, latestActiveDashboardTokenAt, listActiveApiTokensByName,
  replaceActiveApiToken, rotateSharedDashboardToken,
} from './db.js'
import { readEnvFile } from './env.js'
import { atomicWriteFileSync } from './web/atomic-write.js'
import { agentConfigRoot } from './web/agent-config.js'
import { dashboardTokenFilePath } from './web/dashboard-auth.js'

export const AGENT_TOKEN_FILENAME = '.agent-token'
export const OPERATOR_TOKEN_FILENAME = '.operator-token'

export type IssueStatus = 'issued' | 'kept' | 'rotated'

export interface IssueResult {
  /** The agent id, or `operator`. */
  subject: string
  role: 'fleet_agent' | 'admin'
  status: IssueStatus
  /** Where the token file is. The token itself is never part of a result. */
  path: string
  tokenId: number
}

interface Spec {
  subject: string
  name: string
  role: 'fleet_agent' | 'admin'
  agentId: string | null
  path: string
}

const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex')

export function agentTokenPath(agentId: string): string {
  return join(agentConfigRoot(agentId), AGENT_TOKEN_FILENAME)
}

export function operatorTokenPath(): string {
  return join(STORE_DIR, OPERATOR_TOKEN_FILENAME)
}

function agentSpec(agentId: string): Spec {
  const isMain = agentId === MAIN_AGENT_ID
  return {
    subject: agentId,
    name: `${isMain ? 'main-agent' : 'fleet-agent'}:${agentId}`,
    role: isMain ? 'admin' : 'fleet_agent',
    agentId,
    path: agentTokenPath(agentId),
  }
}

function readTokenHash(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    return raw ? sha256(raw) : null
  } catch {
    return null
  }
}

function issue(spec: Spec, opts: { rotate?: boolean; now?: number }): IssueResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const active = listActiveApiTokensByName(spec.name, now)
  const fileHash = readTokenHash(spec.path)
  const current = fileHash ? active.find(r => r.token_hash === fileHash) : undefined

  if (current && !opts.rotate) {
    if ((statSync(spec.path).mode & 0o077) !== 0) chmodSync(spec.path, 0o600)
    return { subject: spec.subject, role: spec.role, status: 'kept', path: spec.path, tokenId: current.id }
  }

  const raw = randomBytes(32).toString('hex')
  atomicWriteFileSync(spec.path, `${raw}\n`, { mode: 0o600 })
  const hash = sha256(raw)

  // One transaction in the db layer: rotate the matching row (or, when the file held nothing active, revoke
  // what was active under the name, which nobody can reach any more) and mint the replacement.
  const row = replaceActiveApiToken({ current, active, tokenHash: hash, name: spec.name, role: spec.role, agentId: spec.agentId, now })
  return { subject: spec.subject, role: spec.role, status: current ? 'rotated' : 'issued', path: spec.path, tokenId: row.id }
}

/** Issues (or keeps, or rotates) the token of one agent. The agent's directory must exist. */
export function issueAgentToken(agentId: string, opts: { rotate?: boolean; now?: number } = {}): IssueResult {
  const spec = agentSpec(agentId)
  if (!existsSync(agentConfigRoot(agentId))) throw new Error(`agent '${agentId}' has no directory`)
  return issue(spec, opts)
}

/** The operator's own named admin token (for the scripts an operator runs), instead of the shared file token. */
export function issueOperatorToken(opts: { rotate?: boolean; now?: number } = {}): IssueResult {
  return issue({ subject: 'operator', name: 'operator', role: 'admin', agentId: null, path: operatorTokenPath() }, opts)
}

export interface RotateSharedResult {
  /** `rotated` when an active `dashboard` row was replaced, `issued` when there was none. */
  status: 'rotated' | 'issued'
  /** Where the new token file is. The token itself is never part of a result. */
  path: string
  tokenId: number
}

/** Thrown when the shared token lives in DASHBOARD_TOKEN (env or .env): that value overrides the file. */
export class SharedTokenInEnvError extends Error {
  constructor() {
    super('DASHBOARD_TOKEN is set in the environment or .env: it overrides store/.dashboard-token, so a rotation of the file would change nothing. Remove it first.')
    this.name = 'SharedTokenInEnvError'
  }
}

/**
 * T4-5: rotates the shared dashboard token. Always mints a new one (there is no `kept`): after a restore
 * nobody can tell whether the archive predates a rotation, so a rotation that sometimes does nothing
 * would be the wrong default. The active `dashboard` row is revoked WITH its hash (rotateApiToken keeps
 * the row), which is what lets the auth gate recognise the old value as "the shared token, rotated away"
 * (shared_token_refused) instead of an unknown bearer. The new value goes into store/.dashboard-token
 * (0600) BEFORE the row is written, as issue() does: a failure in between leaves a file nothing
 * recognises, which the next dashboard start enrols (and which revokes the old row), never a valid token
 * nobody holds. Works with the dashboard stopped (direct database). Refuses when DASHBOARD_TOKEN is set.
 */
export function rotateSharedToken(opts: { now?: number } = {}): RotateSharedResult {
  const inEnv = (readEnvFile(['DASHBOARD_TOKEN']).DASHBOARD_TOKEN ?? '').trim() !== '' || (process.env.DASHBOARD_TOKEN ?? '').trim() !== ''
  if (inEnv) throw new SharedTokenInEnvError()
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const path = dashboardTokenFilePath(STORE_DIR)
  const raw = randomBytes(32).toString('hex')
  atomicWriteFileSync(path, raw, { mode: 0o600 })
  const hash = sha256(raw)

  const active = listActiveApiTokensByName('dashboard', now)
  const row = rotateSharedDashboardToken(active, hash, now)
  return { status: active.length > 0 ? 'rotated' : 'issued', path, tokenId: row.id }
}

export type ArchiveSharedAge = 'predates' | 'current' | 'unknown'

/**
 * Whether a backup's database holds an OLDER shared token than the live one. The archive carries the
 * `dashboard` token row and the token file, so restoring an archive taken before a rotation brings the
 * replaced shared token back to life: `predates` says so. `unknown` when either side has no active
 * `dashboard` row, or the archive database cannot be read (an older backup without the table).
 * `archiveDbPath` is a throwaway copy (verify-restore extracts it into a temp dir); only a SELECT runs
 * on it, but a database in WAL mode may get its sidecar files next to it, so never point this at a
 * live database file.
 */
export function archiveSharedTokenAge(archiveDbPath: string): ArchiveSharedAge {
  try {
    const archived = archiveDashboardTokenCreatedAt(archiveDbPath) ?? 0
    const live = latestActiveDashboardTokenAt()
    if (archived <= 0 || live <= 0) return 'unknown'
    return live > archived ? 'predates' : 'current'
  } catch {
    return 'unknown'
  }
}

export type CheckStatus =
  | 'ok'
  | 'missing'
  | 'unknown_hash'
  | 'revoked'
  | 'wrong_role'
  | 'shared_mismatch'
  | 'shared_in_env'

export interface CheckRow {
  /** The agent id, `operator`, or `shared` for the dashboard token. */
  subject: string
  status: CheckStatus
  /** The role the token file is expected to carry; '-' for the shared token. */
  role: string
  /** Where the token file is. The token itself is never part of a result. */
  path: string
}

export interface CheckResult {
  rows: CheckRow[]
  /** True when every row is `ok`. */
  ok: boolean
}

function checkSpec(spec: Spec, now: number): CheckRow {
  const row = (status: CheckStatus): CheckRow => ({ subject: spec.subject, status, role: spec.role, path: spec.path })
  const fileHash = readTokenHash(spec.path)
  if (!fileHash) return row('missing')
  const found = getApiTokenRowByHash(fileHash)
  if (!found) return row('unknown_hash')
  if (found.revoked_at !== null || (found.expires_at !== null && found.expires_at <= now)) return row('revoked')
  if (found.role !== spec.role || found.name !== spec.name || found.agent_id !== spec.agentId) return row('wrong_role')
  return row('ok')
}

/**
 * Read-only audit of the token files an install needs after a restore: one row per agent id given,
 * then the operator, saying whether the file holds a token the database still accepts for that subject.
 * Then the shared dashboard token: its file must hash to the active `dashboard` row (`shared_mismatch`
 * otherwise), and `shared_in_env` flags a DASHBOARD_TOKEN set in .env or the environment (the shared
 * token should not live there: the archive carries .env). A shared token file that does not exist is
 * not a finding (the dashboard draws a fresh one at its next start). Nothing is written and no token
 * value leaves this function.
 */
export function checkAgentTokens(agentIds: string[], opts: { now?: number; includeOperator?: boolean; includeShared?: boolean } = {}): CheckResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const rows: CheckRow[] = agentIds.map(id => checkSpec(agentSpec(id), now))
  if (opts.includeOperator !== false) {
    rows.push(checkSpec({ subject: 'operator', name: 'operator', role: 'admin', agentId: null, path: operatorTokenPath() }, now))
  }
  if (opts.includeShared !== false) {
    const sharedPath = dashboardTokenFilePath(STORE_DIR)
    const fileHash = readTokenHash(sharedPath)
    if (fileHash) {
      const matches = listActiveApiTokensByName('dashboard', now).some(r => r.token_hash === fileHash)
      rows.push({ subject: 'shared', status: matches ? 'ok' : 'shared_mismatch', role: '-', path: sharedPath })
    }
    const inEnv = (readEnvFile(['DASHBOARD_TOKEN']).DASHBOARD_TOKEN ?? '').trim() !== '' || (process.env.DASHBOARD_TOKEN ?? '').trim() !== ''
    if (inEnv) rows.push({ subject: 'shared', status: 'shared_in_env', role: '-', path: '.env' })
  }
  return { rows, ok: rows.every(r => r.status === 'ok') }
}
