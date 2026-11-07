// The body of scripts/vault-http-header-helper.mjs: mint one HTTP header from a vault secret.
//
// An http MCP server's config names this helper in `headersHelper`. Claude Code runs it on every connection
// (and again after a 401/403), reads a JSON object of string headers from its stdout, and uses them in place of
// the static `headers` of the same name. The secret therefore lives only in this short-lived process: not in the
// config file, not in the environment of the `claude` process, not in the launch command.
//
//   --secret <vault id>   --header <header name>   [--prefix <text put before the value, e.g. "Bearer ">]
//
// Fail closed: on ANY problem the result is exit code 1 and an EMPTY stdout, so no Authorization is sent (the
// client then does not authenticate). The failure is described in `event`, by outcome and secret id, NEVER by
// value; the caller logs it, because Claude Code shows the helper's stderr nowhere.
import { getSecret } from './vault.js'

const SECRET_ID = /^[A-Za-z0-9._-]{1,128}$/
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const MAX_PREFIX = 32

export type HelperOutcome = 'ok' | 'bad-args' | 'ssh-key' | 'unresolved' | 'bad-value' | 'vault-error'

export interface HelperEvent {
  outcome: HelperOutcome
  /** The vault id when the arguments held a well-formed one. Never a value. */
  secretId?: string
}

export interface HelperResult {
  code: 0 | 1
  stdout: string
  event: HelperEvent
}

export interface HelperArgs {
  secretId: string
  header: string
  prefix: string
}

/** Strict parse: exactly --secret and --header, optional --prefix, each once, nothing else. */
export function parseHelperArgs(argv: readonly string[]): HelperArgs | null {
  const seen = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!['--secret', '--header', '--prefix'].includes(flag) || value === undefined || seen.has(flag)) return null
    seen.set(flag, value)
  }
  const secretId = seen.get('--secret')
  const header = seen.get('--header')
  const prefix = seen.get('--prefix') ?? ''
  if (secretId === undefined || header === undefined) return null
  if (!SECRET_ID.test(secretId) || !HEADER_NAME.test(header)) return null
  // Printable ASCII only: a control character in the prefix would be a header-injection vector.
  if (prefix.length > MAX_PREFIX || !/^[\x20-\x7e]*$/.test(prefix)) return null
  return { secretId, header, prefix }
}

export function runHeaderHelper(argv: readonly string[], lookup: (id: string) => string | null = getSecret): HelperResult {
  const fail = (outcome: HelperOutcome, secretId?: string): HelperResult =>
    ({ code: 1, stdout: '', event: secretId === undefined ? { outcome } : { outcome, secretId } })

  const args = parseHelperArgs(argv)
  if (!args) return fail('bad-args')
  const { secretId, header, prefix } = args
  // An SSH private key must never become a header value (same rule as every other resolver).
  if (secretId.startsWith('ssh-key-')) return fail('ssh-key', secretId)

  let value: string | null
  try {
    value = lookup(secretId)
  } catch {
    return fail('vault-error', secretId)
  }
  if (value === null) return fail('unresolved', secretId)
  // A value with a line break would split the header; an empty value is no credential.
  if (value.length === 0 || /[\r\n\0]/.test(value)) return fail('bad-value', secretId)

  return { code: 0, stdout: `${JSON.stringify({ [header]: `${prefix}${value}` })}\n`, event: { outcome: 'ok', secretId } }
}
