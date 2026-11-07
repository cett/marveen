// One-time migration of an http MCP server's header from a live token to a vault-fed placeholder.
//
//   before:  headers.Authorization = "Bearer <live token>"
//   after:   headers.Authorization = "Bearer ${NAME}", env.NAME = "vault:<secret-id>"
//
// (the shape http-mcp-header-env.ts reads at agent launch).
//
// Safe by construction:
//   - dry run is the default; nothing is written without `apply`.
//   - the file is only rewritten when its current header ends with EXACTLY the vault secret's value, so the
//     live token can never be replaced by a placeholder whose secret does not hold it (no lost credential).
//   - the result of a run names files and outcomes only; no token and no part of one is ever returned or logged.
//   - the file is replaced atomically with mode 0600 and nothing else in it is changed.
//
// Run it with the agent that owns the file STOPPED: a running Claude Code keeps its config in memory and may
// write the old header back over the migrated file.
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-write.js'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_ID = /^[A-Za-z0-9._-]{1,128}$/
// A shorter secret could match the tail of an unrelated header value by accident.
const MIN_SECRET_LENGTH = 16

export type MigrateStatus =
  | 'would-migrate' | 'migrated' | 'already-migrated'
  | 'no-file' | 'unreadable' | 'no-server' | 'no-header' | 'token-mismatch' | 'write-failed'

export interface MigrateOptions {
  server: string
  header: string
  varName: string
  secretId: string
  apply: boolean
  /** The vault value of `secretId`, or null when it is not there. Never logged. */
  secretValue: (id: string) => string | null
}

export interface MigrateResult {
  file: string
  status: MigrateStatus
}

export class MigrateOptionsError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function migrateHttpHeaderFile(file: string, opts: MigrateOptions): MigrateResult {
  if (!ENV_NAME.test(opts.varName)) throw new MigrateOptionsError('varName is not a valid variable name')
  if (!SECRET_ID.test(opts.secretId) || opts.secretId.startsWith('ssh-key-')) throw new MigrateOptionsError('secretId is not an injectable vault id')
  const secret = opts.secretValue(opts.secretId)
  if (secret === null) throw new MigrateOptionsError('the vault has no secret with that id')
  if (secret.length < MIN_SECRET_LENGTH) throw new MigrateOptionsError('the vault secret is too short to be matched safely')

  if (!existsSync(file)) return { file, status: 'no-file' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return { file, status: 'unreadable' }
  }
  const servers = isPlainObject(parsed) && isPlainObject(parsed.mcpServers) ? parsed.mcpServers : null
  const server = servers?.[opts.server]
  if (!isPlainObject(server) || typeof server.url !== 'string') return { file, status: 'no-server' }
  const headers = isPlainObject(server.headers) ? server.headers : null
  const current = headers?.[opts.header]
  if (!headers || typeof current !== 'string') return { file, status: 'no-header' }

  const placeholder = `\${${opts.varName}}`
  const ref = `vault:${opts.secretId}`
  const env = isPlainObject(server.env) ? server.env : {}
  if (current.endsWith(placeholder) && !current.includes(secret) && env[opts.varName] === ref) {
    return { file, status: 'already-migrated' }
  }
  if (!current.endsWith(secret)) {
    return { file, status: 'token-mismatch' }
  }
  if (!opts.apply) return { file, status: 'would-migrate' }

  headers[opts.header] = `${current.slice(0, current.length - secret.length)}${placeholder}`
  server.env = { ...env, [opts.varName]: ref }
  try {
    atomicWriteFileSync(file, JSON.stringify(parsed, null, 2), { mode: 0o600 })
  } catch {
    return { file, status: 'write-failed' }
  }
  return { file, status: 'migrated' }
}
