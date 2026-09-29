import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { readFileOr, AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { getSecret, listSecrets } from './vault.js'
import { getExternalProjectPaths } from './dashboard-settings.js'
import {
  listVaultBindings, upsertVaultBinding, deleteVaultBinding, deleteVaultBindingsForSecret,
  type VaultBinding, type VaultBindingTarget,
} from '../db/vault-bindings.js'
import { logger } from '../logger.js'

const VAULT_WRAPPER_PATH = join(PROJECT_ROOT, 'scripts', 'vault-env-wrapper.sh')

export type { VaultBinding, VaultBindingTarget }

const SENSITIVE_PATTERNS = [
  /_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /_PASSWORD$/i, /_PASS$/i,
  /^API_/i, /^AUTH_/i, /^OAUTH_/i,
  /PASSWORD/i, /CREDENTIAL/i, /ACCESS_KEY/i,
]

const NON_SENSITIVE_VALUE_PATTERNS = [
  /^(true|false)$/i,
  /^https?:\/\//,
  /^\d+$/,
  /^\//,
  /^\$\{/,
]

export interface ScanFinding {
  mcpFilePath: string
  serverName: string
  envVar: string
  maskedValue: string
  suggestedVaultId: string
  alreadyInVault: boolean
  existingVaultId?: string
}

export interface SyncResult {
  updated: number
  errors: string[]
}

// DB-backed (vault_bindings table, migration 0062, #985 group 7/8) -- the
// store/vault-bindings.json file is fully retired (see
// retireVaultBindingsFile in db/index.ts). Every function below keeps its
// pre-migration signature and semantics; only the storage underneath moved.
// tenant_id is hardcoded to 'default' here, same MVP scope as costBudgets
// (group 6/8) -- the table has the column for future multi-tenancy, but no
// caller of this module (connectors.ts routes) is tenant-aware yet.
export function getBindings(): VaultBinding[] {
  return listVaultBindings('default')
}

export function addBinding(binding: VaultBinding): void {
  upsertVaultBinding('default', binding)
}

export function removeBinding(vaultSecretId: string, envVar: string): boolean {
  return deleteVaultBinding('default', vaultSecretId, envVar)
}

export function removeBindingsForSecret(vaultSecretId: string): void {
  // Fetch-then-delete (not delete-then-use-return-value): the DB layer
  // already returns the deleted rows, so their targets are still available
  // here for the per-target MCP-file cleanup below.
  const toRemove = deleteVaultBindingsForSecret('default', vaultSecretId)
  for (const binding of toRemove) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const serverCfg = content.mcpServers?.[target.serverName]
        if (!serverCfg?.env) continue
        delete serverCfg.env[binding.envVar]
        if (!serverHasVaultRefs(serverCfg.env)) unwrapCommand(serverCfg)
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2), { mode: 0o600 })
      } catch { /* skip */ }
    }
  }
}

export function collectAllMcpFilePaths(): Array<{ path: string, label: string }> {
  const paths: Array<{ path: string, label: string }> = []
  const projectMcp = join(PROJECT_ROOT, '.mcp.json')
  if (existsSync(projectMcp)) paths.push({ path: projectMcp, label: 'project' })
  const userMcp = join(homedir(), '.claude.json')
  if (existsSync(userMcp)) paths.push({ path: userMcp, label: 'user' })

  for (const agentName of listAgentNames()) {
    const agentMcp = join(AGENTS_BASE_DIR, agentName, '.mcp.json')
    if (existsSync(agentMcp)) paths.push({ path: agentMcp, label: `agent:${agentName}` })
    const projectsDir = join(AGENTS_BASE_DIR, agentName, 'projects')
    if (existsSync(projectsDir)) {
      try {
        for (const proj of readdirSync(projectsDir)) {
          if (!statSync(join(projectsDir, proj)).isDirectory()) continue
          const projMcp = join(projectsDir, proj, '.mcp.json')
          if (existsSync(projMcp)) paths.push({ path: projMcp, label: `project:${agentName}/${proj}` })
        }
      } catch { /* ignore */ }
    }
  }
  for (const extPath of getExternalProjectPaths()) {
    const extMcp = join(extPath, '.mcp.json')
    if (existsSync(extMcp)) paths.push({ path: extMcp, label: `external:${basename(extPath)}` })
  }
  return paths
}

function maskValue(val: string): string {
  if (val.length <= 6) return '***'
  return val.slice(0, 3) + '...' + val.slice(-3)
}

function looksLikeSensitiveValue(val: string): boolean {
  if (!val || val.length < 8) return false
  if (val.startsWith('vault:')) return false
  for (const p of NON_SENSITIVE_VALUE_PATTERNS) {
    if (p.test(val)) return false
  }
  return true
}

function looksLikeSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(key))
}

export function scanMcpConfigs(): ScanFinding[] {
  const findings: ScanFinding[] = []
  const mcpFiles = collectAllMcpFilePaths()
  const existingSecrets = listSecrets()

  const vaultValues = new Map<string, string>()
  for (const s of existingSecrets) {
    const val = getSecret(s.id)
    if (val) vaultValues.set(val, s.id)
  }

  for (const { path: mcpPath } of mcpFiles) {
    try {
      const parsed = JSON.parse(readFileOr(mcpPath, '{}'))
      const servers = parsed.mcpServers || {}
      for (const [serverName, cfg] of Object.entries(servers) as Array<[string, any]>) {
        const env = cfg?.env || {}
        for (const [envVar, envVal] of Object.entries(env) as Array<[string, string]>) {
          if (!looksLikeSensitiveKey(envVar)) continue
          if (!looksLikeSensitiveValue(String(envVal))) continue

          const existingVaultId = vaultValues.get(String(envVal))
          findings.push({
            mcpFilePath: mcpPath,
            serverName,
            envVar,
            maskedValue: maskValue(String(envVal)),
            suggestedVaultId: `${serverName}-${envVar}`,
            alreadyInVault: !!existingVaultId,
            existingVaultId,
          })
        }
      }
    } catch { /* skip unreadable files */ }
  }
  return findings
}

function wrapCommand(serverCfg: any): void {
  if (serverCfg.command === VAULT_WRAPPER_PATH) return
  serverCfg._vaultOriginalCommand = serverCfg.command
  if (serverCfg.args?.length) serverCfg._vaultOriginalArgs = serverCfg.args
  serverCfg.args = [serverCfg.command, ...(serverCfg.args || [])]
  serverCfg.command = VAULT_WRAPPER_PATH
}

function unwrapCommand(serverCfg: any): void {
  if (serverCfg.command !== VAULT_WRAPPER_PATH) return
  if (!serverCfg._vaultOriginalCommand) return
  serverCfg.command = serverCfg._vaultOriginalCommand
  serverCfg.args = serverCfg._vaultOriginalArgs || []
  delete serverCfg._vaultOriginalCommand
  delete serverCfg._vaultOriginalArgs
}

function serverHasVaultRefs(env: Record<string, string> | undefined): boolean {
  if (!env) return false
  return Object.values(env).some(v => typeof v === 'string' && v.startsWith('vault:'))
}

export function syncSecret(vaultSecretId: string): SyncResult {
  const bindings = getBindings().filter(b => b.vaultSecretId === vaultSecretId)
  if (bindings.length === 0) return { updated: 0, errors: [] }

  const secret = getSecret(vaultSecretId)
  if (secret === null) return { updated: 0, errors: [`Vault secret "${vaultSecretId}" not found`] }

  let updated = 0
  const errors: string[] = []

  for (const binding of bindings) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const serverCfg = content.mcpServers?.[target.serverName]
        if (!serverCfg) {
          errors.push(`Server "${target.serverName}" not found in ${target.mcpFilePath}`)
          continue
        }
        if (!serverCfg.env) serverCfg.env = {}
        serverCfg.env[binding.envVar] = `vault:${vaultSecretId}`
        if (serverCfg.command && !serverCfg.url) wrapCommand(serverCfg)
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2), { mode: 0o600 })
        updated++
      } catch (err: any) {
        errors.push(`Failed to update ${target.mcpFilePath}: ${err.message}`)
      }
    }
  }

  if (updated > 0) logger.info({ vaultSecretId, updated }, 'Vault secret synced to .mcp.json files')
  return { updated, errors }
}

export function unsyncBinding(vaultSecretId: string, envVar: string): void {
  const bindings = getBindings().filter(
    b => b.vaultSecretId === vaultSecretId && b.envVar === envVar,
  )
  for (const binding of bindings) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const serverCfg = content.mcpServers?.[target.serverName]
        if (!serverCfg?.env) continue
        delete serverCfg.env[envVar]
        if (!serverHasVaultRefs(serverCfg.env)) unwrapCommand(serverCfg)
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2), { mode: 0o600 })
      } catch { /* skip */ }
    }
  }
}

export function syncAllBindings(): SyncResult {
  const allBindings = getBindings()
  const secretIds = new Set(allBindings.map(b => b.vaultSecretId))
  let totalUpdated = 0
  const allErrors: string[] = []

  for (const id of secretIds) {
    const result = syncSecret(id)
    totalUpdated += result.updated
    allErrors.push(...result.errors)
  }
  return { updated: totalUpdated, errors: allErrors }
}
