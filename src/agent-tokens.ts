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
import { getDb, insertApiToken, listActiveApiTokensByName, rotateApiToken, revokeApiToken } from './db.js'
import { atomicWriteFileSync } from './web/atomic-write.js'
import { agentConfigRoot } from './web/agent-config.js'

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

  const row = getDb().transaction(() => {
    if (current) {
      const next = rotateApiToken(current, hash, now, null)
      for (const stale of active) if (stale.id !== current.id) revokeApiToken(stale.id, now)
      return next
    }
    // The file was missing or held nothing active: whatever was active under this name is unreachable
    // now (nobody holds its secret), so it goes before the replacement comes.
    for (const stale of active) revokeApiToken(stale.id, now)
    return insertApiToken({ tokenHash: hash, name: spec.name, role: spec.role, tenantId: 'default', createdAt: now, expiresAt: null, agentId: spec.agentId })
  })()
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
