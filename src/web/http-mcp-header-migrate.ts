// One-time migration of an http MCP server's header from a live token to a vault-fed headersHelper.
//
//   before:  headers.Authorization = "Bearer <live token>"
//   after:   headersHelper = "env -i HOME=.. PATH=.. <node> <repo>/scripts/vault-http-header-helper.mjs
//                              --secret <id> --header Authorization --prefix 'Bearer '"
//            and NO static headers.Authorization
//
// The static header MUST go: Claude Code uses the helper's header over a static one of the same name, but when
// the helper fails it falls back to the static value, so a leftover token would turn every helper failure into a
// live-token send (fail open). A file that already has the helper but still carries the static header is cleaned.
//
// Safe by construction:
//   - dry run is the default; nothing is written without `apply`.
//   - the file is only rewritten when its current header ends with EXACTLY the vault secret's value, so the live
//     token can never be dropped unless the vault holds it (no lost credential).
//   - a result names files and outcomes only; no token and no part of one is ever returned or logged.
//   - the file is replaced atomically with mode 0600 and nothing else in it changes.
//   - `revertHttpHeaderFile` is the exact inverse (puts the static header back from the vault).
//
// Run it with the agent that owns the file STOPPED: a running Claude Code keeps its config in memory and may
// write the old header back over the migrated file.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './atomic-write.js'
import { SECRET_ID, HEADER_NAME, isValidHelperPrefix } from './http-mcp-header-rules.js'

// A shorter secret could match the tail of an unrelated header value by accident.
const MIN_SECRET_LENGTH = 16
const HELPER_PATH = fileURLToPath(new URL('../../scripts/vault-http-header-helper.mjs', import.meta.url))
const HELPER_PATH_VAR = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

export type MigrateStatus =
  | 'would-migrate' | 'migrated' | 'already-migrated'
  | 'would-revert' | 'reverted' | 'not-migrated'
  | 'no-file' | 'unreadable' | 'no-server' | 'no-header' | 'token-mismatch' | 'bad-prefix' | 'other-helper' | 'write-failed'

export interface MigrateOptions {
  server: string
  header: string
  secretId: string
  apply: boolean
  /** Absolute path of the node binary the helper runs under, and the HOME it gets (the Keychain needs it). */
  nodePath: string
  home: string
  /** The vault value of `secretId`, or null when it is not there. Never logged. */
  secretValue: (id: string) => string | null
  /** What goes before the value in the header; revert only (a migration derives it from the file). */
  prefix?: string
}

export interface MigrateResult {
  file: string
  status: MigrateStatus
}

export class MigrateOptionsError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// POSIX single quotes: every argument is quoted, so no path or id can end the word.
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The command Claude Code runs. `env -i` gives the helper only HOME and PATH: it inherits nothing else from the
 * `claude` process (measured: a user-scope helper otherwise sees the whole parent environment), and it finds the
 * vault from its own location, not from an inherited variable.
 */
export function buildHelperCommand(o: { nodePath: string, home: string, secretId: string, header: string, prefix: string }): string {
  return [
    'env -i', `HOME=${sq(o.home)}`, `PATH=${sq(HELPER_PATH_VAR)}`,
    sq(o.nodePath), sq(HELPER_PATH),
    '--secret', sq(o.secretId), '--header', sq(o.header), '--prefix', sq(o.prefix),
  ].join(' ')
}

function checkOptions(opts: MigrateOptions): string {
  if (!HEADER_NAME.test(opts.header)) throw new MigrateOptionsError('header is not a valid header name')
  if (!SECRET_ID.test(opts.secretId) || opts.secretId.startsWith('ssh-key-')) throw new MigrateOptionsError('secretId is not an injectable vault id')
  if (!opts.nodePath.startsWith('/') || !opts.home.startsWith('/')) throw new MigrateOptionsError('nodePath and home must be absolute')
  const secret = opts.secretValue(opts.secretId)
  if (secret === null) throw new MigrateOptionsError('the vault has no secret with that id')
  if (secret.length < MIN_SECRET_LENGTH) throw new MigrateOptionsError('the vault secret is too short to be matched safely')
  return secret
}

interface Loaded {
  parsed: unknown
  server: Record<string, unknown>
}

function load(file: string, name: string): Loaded | MigrateResult {
  if (!existsSync(file)) return { file, status: 'no-file' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return { file, status: 'unreadable' }
  }
  const servers = isPlainObject(parsed) && isPlainObject(parsed.mcpServers) ? parsed.mcpServers : null
  const server = servers?.[name]
  if (!isPlainObject(server) || typeof server.url !== 'string') return { file, status: 'no-server' }
  return { parsed, server }
}

function write(file: string, parsed: unknown): boolean {
  try {
    atomicWriteFileSync(file, JSON.stringify(parsed, null, 2), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function migrateHttpHeaderFile(file: string, opts: MigrateOptions): MigrateResult {
  const secret = checkOptions(opts)
  const loaded = load(file, opts.server)
  if ('status' in loaded) return loaded
  const { parsed, server } = loaded
  const headers = isPlainObject(server.headers) ? server.headers : {}
  // HTTP header names are case-insensitive: a static lower-case name is the same fail-open path.
  const staticKey = Object.keys(headers).find(k => k.toLowerCase() === opts.header.toLowerCase())
  const current = staticKey === undefined ? undefined : headers[staticKey]
  const hasStatic = typeof current === 'string'

  if (server.headersHelper !== undefined) {
    // The server already has a helper. Ours (same secret, same header): done, but a leftover static header is a
    // fail-open path and is removed. Anything else is somebody else's helper and is not touched.
    const ours = typeof server.headersHelper === 'string'
      && server.headersHelper === buildHelperCommand({ nodePath: opts.nodePath, home: opts.home, secretId: opts.secretId, header: opts.header, prefix: prefixOf(current, secret, opts.prefix) })
    if (!ours) return { file, status: 'other-helper' }
    if (staticKey === undefined) return { file, status: 'already-migrated' }
    if (!opts.apply) return { file, status: 'would-migrate' }
    dropHeader(server, headers, opts.header)
    return write(file, parsed) ? { file, status: 'migrated' } : { file, status: 'write-failed' }
  }

  if (!hasStatic) return { file, status: 'no-header' }
  if (!current.endsWith(secret)) return { file, status: 'token-mismatch' }
  const prefix = current.slice(0, current.length - secret.length)
  // The prefix becomes a helper argument. One the helper refuses (over 32 characters, a tab, non-ASCII) would
  // turn into a silent loss of authentication once the static header is dropped, and a revert could not
  // restore it either. Judged before the dry-run answer, so a dry run reports it too.
  if (!isValidHelperPrefix(prefix)) return { file, status: 'bad-prefix' }
  if (!opts.apply) return { file, status: 'would-migrate' }

  server.headersHelper = buildHelperCommand({ nodePath: opts.nodePath, home: opts.home, secretId: opts.secretId, header: opts.header, prefix })
  dropHeader(server, headers, opts.header)
  return write(file, parsed) ? { file, status: 'migrated' } : { file, status: 'write-failed' }
}

/** The exact inverse: the static header comes back from the vault, the helper goes. */
export function revertHttpHeaderFile(file: string, opts: MigrateOptions): MigrateResult {
  const secret = checkOptions(opts)
  const loaded = load(file, opts.server)
  if ('status' in loaded) return loaded
  const { parsed, server } = loaded
  const prefix = opts.prefix ?? 'Bearer '
  const expected = buildHelperCommand({ nodePath: opts.nodePath, home: opts.home, secretId: opts.secretId, header: opts.header, prefix })
  if (server.headersHelper === undefined) return { file, status: 'not-migrated' }
  if (server.headersHelper !== expected) return { file, status: 'other-helper' }
  if (!opts.apply) return { file, status: 'would-revert' }

  const headers = isPlainObject(server.headers) ? server.headers : {}
  headers[opts.header] = `${prefix}${secret}`
  server.headers = headers
  delete server.headersHelper
  return write(file, parsed) ? { file, status: 'reverted' } : { file, status: 'write-failed' }
}

// The prefix in front of the value: taken from the static header when it still ends with the secret, else the
// caller's, else the common bearer form.
function prefixOf(current: unknown, secret: string, given: string | undefined): string {
  if (typeof current === 'string' && current.endsWith(secret)) return current.slice(0, current.length - secret.length)
  return given ?? 'Bearer '
}

function dropHeader(server: Record<string, unknown>, headers: Record<string, unknown>, name: string): void {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
  if (Object.keys(headers).length === 0) delete server.headers
  else server.headers = headers
}
