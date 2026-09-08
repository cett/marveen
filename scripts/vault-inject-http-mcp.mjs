#!/usr/bin/env node
// Resolve/restore vault: references inside an MCP config file's HTTP-transport
// server headers (e.g. mcpServers.uptimerobot.headers.Authorization).
//
// Companion to vault-env-wrapper.sh, which only covers spawned STDIO servers'
// env vars -- HTTP-transport servers configure headers directly in the config
// file, with no process-launch hook to intercept them at.
//
// Usage: vault-inject-http-mcp.mjs <inject|restore> [target-file]
//   inject:  save the current (template) content to "<target>.vault-template",
//            then overwrite <target> with vault: references resolved to real
//            values in every mcpServers.*.headers.* string.
//   restore: overwrite <target> with the saved template and remove it.
//
// Both modes are no-ops (exit 0) when there is nothing to do, so the caller
// can invoke this unconditionally on every launch/exit without checking state
// first. `inject` never touches the target if any referenced vault id fails
// to resolve -- callers get a live token only in an all-or-nothing config.
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const VAULT_REF = /vault:([A-Za-z0-9._-]+)/g

function fail(message) {
  process.stderr.write(`vault-inject-http-mcp: ${message}\n`)
  process.exit(1)
}

async function atomicWrite(path, data) {
  const { atomicWriteFileSync } = await import(join(projectRoot, 'dist', 'web', 'atomic-write.js'))
  atomicWriteFileSync(path, data, { mode: 0o600 })
}

// Applies fn(value) to every string under mcpServers.*.headers.*; fn returns
// the replacement or `undefined` to leave the value untouched. Mutates
// mcpServers in place and reports whether anything changed.
function walkHeaders(mcpServers, fn) {
  let changed = false
  for (const server of Object.values(mcpServers ?? {})) {
    const headers = server && typeof server === 'object' ? server.headers : undefined
    if (!headers || typeof headers !== 'object') continue
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue
      const next = fn(value)
      if (next !== undefined && next !== value) {
        headers[key] = next
        changed = true
      }
    }
  }
  return changed
}

async function inject(target, templatePath) {
  if (existsSync(templatePath)) {
    // A previous inject was never restored (crash, kill -9) -- the template
    // backup is the only safe copy of the real vault:-reference config.
    // Re-injecting now would overwrite it with an already-resolved copy and
    // permanently lose the template. Treat this as already-injected and stop.
    process.stderr.write(`vault-inject-http-mcp: ${templatePath} already exists, assuming already injected -- skipping\n`)
    return
  }
  if (!existsSync(target)) return // nothing to inject into

  const raw = readFileSync(target, 'utf-8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    fail(`cannot parse ${target} as JSON, leaving it untouched: ${err.message}`)
  }

  const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))
  const missing = []
  const changed = walkHeaders(parsed.mcpServers, (value) => {
    if (!value.includes('vault:')) return undefined
    return value.replace(VAULT_REF, (whole, id) => {
      const secret = getSecret(id)
      if (secret === null) { missing.push(id); return whole }
      return secret
    })
  })

  if (missing.length) fail(`unresolved vault id(s), leaving ${target} untouched: ${missing.join(', ')}`)
  if (!changed) return // no vault: references in any header, nothing to do

  // Template first: if the process dies right after this line, `target`
  // still holds the vault:-reference version and the next inject is a no-op
  // recovery (the check above sees the template and skips cleanly).
  await atomicWrite(templatePath, raw)
  await atomicWrite(target, JSON.stringify(parsed, null, 2))
}

async function restore(target, templatePath) {
  if (!existsSync(templatePath)) return // nothing was injected
  const template = readFileSync(templatePath, 'utf-8')
  await atomicWrite(target, template)
  unlinkSync(templatePath)
}

const [, , mode, targetArg] = process.argv
const target = targetArg || join(homedir(), '.claude.json')
const templatePath = `${target}.vault-template`

if (mode === 'inject') await inject(target, templatePath)
else if (mode === 'restore') await restore(target, templatePath)
else fail(`unknown mode '${mode}', expected 'inject' or 'restore'`)
