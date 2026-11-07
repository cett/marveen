// HTTP MCP server headers that take their secret from the environment instead of the config file.
//
// A type:http MCP server keeps its credential in `headers` (e.g. `Authorization: Bearer <token>`), and the
// config file is a plain JSON file on disk. Claude Code expands `${NAME}` / `${NAME:-default}` inside
// `headers` from the environment of the `claude` process, so the file can hold only the placeholder
// (`Bearer ${NAME}`) and the value can reach the process at launch:
//
//   - the file:   headers.Authorization = "Bearer ${NAME}", env.NAME = "vault:<secret-id>"
//                 (the `env` block of an http server is ignored by Claude Code; the vault binding sync already
//                 writes `env.<VAR> = vault:<id>` there, so it doubles as the name -> secret map and is
//                 subject to the same per-secret allowlist as every other binding)
//   - the launch: `export NAME='vault:<id>'` and the real `claude` started through vault-env-wrapper.sh, which
//                 swaps the reference for the value inside the process and then execs, so the value is never
//                 in the tmux command line, on disk, or in a template/restore cycle.
//
// Fail-closed shape: a reference that cannot be turned into an export (no vault reference, a malformed id,
// an SSH private key, a secret that is not in the vault, two files that disagree) is SKIPPED and reported by
// name and secret id, never by value. A skipped name is simply not exported: Claude Code then warns about the
// missing variable and sends the literal `${NAME}` placeholder, i.e. the server rejects the call and no live
// token is ever sent by mistake.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getSecret } from './vault.js'
import { shSingleQuote } from './agent-process-session.js'

// `${NAME}` and `${NAME:-default}`; only the name matters here.
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g
// Same character set and length as the env wrapper (vault-env-wrapper.sh ID_RE) and the fleet import.
const SECRET_ID = /^[A-Za-z0-9._-]{1,128}$/

export type SkipReason = 'no-vault-binding' | 'bad-id' | 'ssh-key' | 'unresolved' | 'conflict' | 'unreadable'

export interface HttpHeaderExport {
  name: string
  id: string
}

export interface HttpHeaderSkip {
  name: string
  /** The secret id when there is a well-formed one; never a value. */
  id?: string
  reason: SkipReason
}

export interface HttpHeaderEnv {
  exports: HttpHeaderExport[]
  skipped: HttpHeaderSkip[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Reads the given MCP config files and works out which `${NAME}` placeholders in http-server headers
 * can be fed from a vault reference. Pure apart from reading the files; `secretExists` decides whether
 * an id is in the vault (it must not hand the value anywhere).
 */
export function collectHttpHeaderEnv(
  files: readonly string[],
  secretExists: (id: string) => boolean = (id) => getSecret(id) !== null,
): HttpHeaderEnv {
  const wanted = new Map<string, Set<string>>() // NAME -> the distinct vault ids the files bind to it
  const skipped: HttpHeaderSkip[] = []

  for (const file of files) {
    if (!existsSync(file)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      // A config we cannot read yields no export; the file itself is named by the caller's log, not here.
      skipped.push({ name: '*', reason: 'unreadable' })
      continue
    }
    const servers = isPlainObject(parsed) && isPlainObject(parsed.mcpServers) ? parsed.mcpServers : {}
    for (const server of Object.values(servers)) {
      // An http-transport server has a url and no command; stdio servers are the env wrapper's business.
      if (!isPlainObject(server) || typeof server.url !== 'string' || typeof server.command === 'string') continue
      const headers = isPlainObject(server.headers) ? server.headers : {}
      const env = isPlainObject(server.env) ? server.env : {}
      const names = new Set<string>()
      for (const value of Object.values(headers)) {
        if (typeof value !== 'string') continue
        for (const m of value.matchAll(PLACEHOLDER)) names.add(m[1])
      }
      for (const name of names) {
        const ref = env[name]
        if (typeof ref !== 'string' || !ref.startsWith('vault:')) {
          skipped.push({ name, reason: 'no-vault-binding' })
          continue
        }
        const id = ref.slice('vault:'.length)
        if (!SECRET_ID.test(id)) {
          skipped.push({ name, reason: 'bad-id' })
          continue
        }
        // An SSH private key must never become a header value (same rule as the other resolvers).
        if (id.startsWith('ssh-key-')) {
          skipped.push({ name, id, reason: 'ssh-key' })
          continue
        }
        const ids = wanted.get(name) ?? new Set<string>()
        ids.add(id)
        wanted.set(name, ids)
      }
    }
  }

  const exports: HttpHeaderExport[] = []
  for (const [name, ids] of wanted) {
    if (ids.size > 1) {
      // Two servers/files bind the same variable to different secrets: one process env cannot hold both.
      skipped.push({ name, reason: 'conflict' })
      continue
    }
    const [id] = [...ids]
    if (!secretExists(id)) {
      skipped.push({ name, id, reason: 'unresolved' })
      continue
    }
    exports.push({ name, id })
  }
  return { exports, skipped }
}

const WRAPPER_PATH = fileURLToPath(new URL('../../scripts/vault-env-wrapper.sh', import.meta.url))

export interface HttpHeaderLaunch {
  /** `export NAME='vault:<id>' && ...` (empty when nothing is exported). */
  envPrefix: string
  /** The wrapper that swaps the references for values and execs the command; empty when nothing is exported. */
  execPrefix: string
  skipped: HttpHeaderSkip[]
}

/** The two shell fragments the agent launch command needs; both empty when no header takes its value from the vault. */
export function buildHttpHeaderLaunch(
  files: readonly string[],
  secretExists?: (id: string) => boolean,
): HttpHeaderLaunch {
  const { exports, skipped } = collectHttpHeaderEnv(files, secretExists)
  if (exports.length === 0) return { envPrefix: '', execPrefix: '', skipped }
  const envPrefix = exports.map(e => `export ${e.name}=${shSingleQuote(`vault:${e.id}`)} && `).join('')
  return { envPrefix, execPrefix: `${shSingleQuote(WRAPPER_PATH)} `, skipped }
}
