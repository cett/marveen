#!/usr/bin/env node
// headersHelper for an http MCP server: print one header, minted from a vault secret, as JSON.
//
//   vault-http-header-helper.mjs --secret <vault id> --header <name> [--prefix "Bearer "]
//
// The config names it as `headersHelper: "env -i HOME=... PATH=... node <this file> --secret ... --header ..."`;
// Claude Code runs it on every connection and prints nothing of its stderr anywhere, so every outcome (the
// success too, as a read audit) is appended here to store/http-header-helper.log: a JSON line with the outcome
// and the secret id, never a value. Any failure leaves stdout EMPTY and exits 1, so no credential is sent.
// The logic is in dist/web/http-mcp-header-helper.js; if that is missing this script still logs and fails closed.
import { appendFileSync, chmodSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// stdout is the result Claude Code parses: anything the app logger prints there (it logs to stdout by default)
// would corrupt the JSON. Must be set before the core is imported, the logger reads it at load.
process.env.LOG_TO_STDERR = '1'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOG = join(root, 'store', 'http-header-helper.log')
const LOG_MAX_BYTES = 512 * 1024

function log(entry) {
  // Best effort: a log problem must not turn into a leaked or a wrongly granted credential.
  try {
    try {
      if (statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, `${LOG}.1`)
    } catch { /* no log yet */ }
    appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 })
    chmodSync(LOG, 0o600)
  } catch { /* see above */ }
}

// The secret id for the log line when the core could not be loaded: only a well-formed one is written.
function secretIdFromArgs(argv) {
  const i = argv.indexOf('--secret')
  const v = i >= 0 ? argv[i + 1] : undefined
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v) ? v : undefined
}

const argv = process.argv.slice(2)
let core
try {
  core = await import(join(root, 'dist', 'web', 'http-mcp-header-helper.js'))
} catch (err) {
  log({ outcome: 'dist-missing', secretId: secretIdFromArgs(argv), error: err?.code ?? err?.name ?? 'Error' })
  process.exit(1)
}

let result
try {
  result = core.runHeaderHelper(argv)
} catch (err) {
  log({ outcome: 'helper-error', secretId: secretIdFromArgs(argv), error: err?.name ?? 'Error' })
  process.exit(1)
}

log(result.event)
if (result.code !== 0) process.exit(1)
process.stdout.write(result.stdout)
