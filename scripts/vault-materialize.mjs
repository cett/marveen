#!/usr/bin/env node
// Get/set a vault secret's raw content for file materialization.
// Companion to vault-file-materializer.sh -- secret content only ever flows
// through stdin/stdout pipes here, never through a log line or argv.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

// Dynamic import from compiled dist, matching vault-resolve.mjs's pattern.
const { getSecret, setSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

const [, , mode, vaultId, label] = process.argv

if (mode === 'get') {
  if (!vaultId) {
    process.stderr.write('usage: vault-materialize.mjs get <vaultId>\n')
    process.exit(1)
  }
  const value = getSecret(vaultId)
  if (value === null) {
    process.stderr.write(`vault-materialize: secret "${vaultId}" not found\n`)
    process.exit(1)
  }
  process.stdout.write(value)
} else if (mode === 'set') {
  if (!vaultId) {
    process.stderr.write('usage: vault-materialize.mjs set <vaultId> [label]\n')
    process.exit(1)
  }
  const input = await new Promise(resolve => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
  })
  setSecret(vaultId, label || vaultId, input)
} else {
  process.stderr.write('usage: vault-materialize.mjs get <vaultId> | set <vaultId> [label]\n')
  process.exit(1)
}
