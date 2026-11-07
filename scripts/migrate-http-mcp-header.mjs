#!/usr/bin/env node
// Move an http MCP server's header from a live token to the vault-fed headers helper (or back).
//
//   migrate-http-mcp-header.mjs --server <name> --header <Header> --secret <vault id> [--apply] [--revert]
//                               [--node <absolute node path>] [--prefix <text>] <config.json> [...]
//
// --prefix is the text in front of the value in the header (default "Bearer "). A first migration reads it from
// the file; give it for a header of another form ("Basic ", or "" for a bare token) to --revert it, and to
// re-run --apply on a file that was already migrated. A prefix the helper would refuse is rejected (exit 2).
//
// DRY RUN unless --apply. A file is rewritten only when its header holds exactly the vault secret's value; the
// static header is removed (a leftover one is the fail-open path when the helper fails). --revert is the exact
// inverse. Output is one line per file with the outcome only: no token, no part of one, is ever printed.
// A path that is a symlink is migrated THROUGH the link (the real file is rewritten, the link stays a link);
// two paths that lead to the same real file are done once, the second is reported as `duplicate`.
// Run it with the owning agent STOPPED (a running Claude Code may write the old header back).
// The secret must already be in the vault (Vault UI / API); rotating a token that was ever on disk is a separate
// decision of the owner and is not done here.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: migrate-http-mcp-header.mjs --server <name> --header <Header> --secret <vault id> [--apply] [--revert] [--node <abs path>] [--prefix <text>] <config.json> [...]'
const BAD = new Set(['unreadable', 'token-mismatch', 'bad-prefix', 'dangling-link', 'other-helper', 'write-failed'])

function parse(argv) {
  const o = { apply: false, revert: false, files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--revert') o.revert = true
    else if (a === '--server' || a === '--header' || a === '--secret' || a === '--node' || a === '--prefix') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) return null
      o[a.slice(2)] = v
    } else if (a.startsWith('--')) return null
    else o.files.push(a)
  }
  return o.server && o.header && o.secret && o.files.length > 0 ? o : null
}

const o = parse(process.argv.slice(2))
if (!o) {
  process.stderr.write(`${USAGE}\n`)
  process.exit(2)
}

const { getSecret } = await import(join(root, 'dist', 'web', 'vault.js'))
const { migrateHttpHeaderFile, revertHttpHeaderFile, MigrateOptionsError } = await import(join(root, 'dist', 'web', 'http-mcp-header-migrate.js'))

const nodePath = o.node ?? (existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath)
const opts = {
  server: o.server, header: o.header, secretId: o.secret, apply: o.apply,
  nodePath, home: homedir(), secretValue: (id) => getSecret(id),
  ...(o.prefix !== undefined ? { prefix: o.prefix } : {}),
}
const fn = o.revert ? revertHttpHeaderFile : migrateHttpHeaderFile

// The real path of an argument, or its absolute form when it cannot be resolved (missing, dangling): the key
// that tells two arguments are the same file.
const realKey = (file) => { try { return realpathSync(file) } catch { return resolve(file) } }
const seen = new Set()

let bad = false
for (const file of o.files) {
  const key = realKey(file)
  if (seen.has(key)) {
    process.stdout.write(`duplicate\t${file}\n`)
    continue
  }
  seen.add(key)
  try {
    const r = fn(file, opts)
    process.stdout.write(`${r.status}\t${r.file}\n`)
    if (BAD.has(r.status)) bad = true
  } catch (err) {
    if (err instanceof MigrateOptionsError) {
      process.stderr.write(`refused: ${err.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`error\t${file}\t${err?.name ?? 'Error'}\n`)
    bad = true
  }
}
if (!o.apply) process.stdout.write('dry run: nothing was written (add --apply)\n')
process.exit(bad ? 1 : 0)
