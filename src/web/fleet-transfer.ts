// Fleet export / import.
//
// Builds a single portable JSON snapshot of fleet content (agents, skills,
// scheduled tasks, DB tables, dashboard settings, optional vault) so it can
// be loaded into a freshly-installed, clean-git dashboard on another machine.
//
// Source code, build artefacts, OAuth tokens, and machine-specific paths are
// NOT included -- those come from a normal `npm ci && npm run build` install.

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync,
} from 'node:fs'
import { join, extname } from 'node:path'
import { homedir, hostname } from 'node:os'
import {
  randomBytes, createCipheriv, createDecipheriv, scryptSync,
} from 'node:crypto'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID, BOT_NAME, BRAND_NAME, OWNER_NAME, CHANNEL_PROVIDER } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { updateEnvFile } from '../env.js'
import { AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { safeJoin } from './sanitize.js'
import { SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { getBindings } from './vault-bindings.js'
import { backfillEmbeddings, listAllSkills, seedSkillIfAbsent, listAutonomyCategories, upsertAutonomyCategory, type AutonomyCategoryRow, listModelProfileMap, upsertModelProfileMapEntry, type ModelProfileMapRow, listEgressAllowlistRows, mergeEgressAllowlistEntries, type EgressAllowlistRow, listAgentSettingsByKey, setAgentSetting } from '../db.js'
import { getDesiredAgents, setDesiredAgents } from './agent-desired-state.js'
import { readModelFallbackFieldsRaw, writeModelFallbackFieldsRaw } from './model-fallback-store.js'
import type { ModelFallbackConfig } from '../model-fallback.js'
import { readTerminalInputEnabledRaw, writeTerminalInputEnabled } from './terminal-input-store.js'
import { listCostBudgets, replaceCostBudgets } from '../db/cost-budgets.js'
import {
  exportTableRows, exportMemoryRows, exportDailyLogRows, fleetRowIdExists, fleetRowExists, importFleetRows,
  listEnabledTenantIds, rebuildMemoriesFts, inFleetImportTransaction,
} from '../db/fleet-transfer.js'
import { validateConfig, type BudgetEntry } from '../costops/config.js'
import { listVaultBindings, replaceVaultBindings, type VaultBinding } from '../db/vault-bindings.js'
import { reloadSystemConfigCache } from '../db/config-cache.js'
import { reloadModelProfileMapCache } from '../db/model-profile-map-cache.js'
import { reloadAgentSettingsCache } from '../db/agent-settings-cache.js'
import { getFederationConfigRaw, setFederationConfigRaw } from '../db/federation.js'
import { invalidateFederationConfigCache, validateFederationConfig } from './federation/config.js'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Schema version -- bump when the JSON shape changes incompatibly.
// ---------------------------------------------------------------------------
export const FLEET_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// UserFacingError -- user-fixable condition; route maps to 400 (not 500).
// ---------------------------------------------------------------------------
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

// ---------------------------------------------------------------------------
// Name validation (used to guard all import-side path joins -- B1)
// ---------------------------------------------------------------------------
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

function assertSafeName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) {
    throw new Error(`Érvénytelen ${field} érték: "${String(value).slice(0, 60)}" -- csak [a-z0-9_-] megengedett.`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetJson {
  schemaVersion: 1
  exportedAt: string
  sourceHost: string
  mainAgent?: MainAgentExport
  agents: AgentExport[]
  skills: SkillExport[]
  scheduledTasks: ScheduledTaskExport[]
  memories: MemoryRow[]      // ALL agent_ids (main + sub-agents)
  dailyLogs: DailyLogRow[]   // ALL agent_ids
  kanban: KanbanExport
  ideaBox: IdeaBoxExport
  schedules: Record<string, unknown>[]
  importSources: Record<string, unknown>[]
  // P4: metadata only (id/label/username/public_key/fingerprint/key_type/vault_key_id,
  // and host/port/name/description) -- neither table has a private-key column. The
  // actual SSH private key is a generic vault secret (id = vault_key_id) and travels
  // ONLY inside the existing encrypted `vault` section below, never here in plaintext.
  vaultSshKeys: Record<string, unknown>[]
  vaultSshServers: Record<string, unknown>[]
  dashboardSettings: DashboardSettingsExport
  vault?: VaultExport
}

// Identity set transferred with the fleet so the target becomes an exact copy of the source.
// The identity keys mirrored into .env on import: exactly the FleetIdentity fields.
const FLEET_IDENTITY_ENV_KEYS = ['MAIN_AGENT_ID', 'BOT_NAME', 'BRAND_NAME', 'OWNER_NAME', 'CHANNEL_PROVIDER'] as const

export interface FleetIdentity {
  MAIN_AGENT_ID: string
  BOT_NAME: string
  BRAND_NAME: string
  OWNER_NAME: string
  CHANNEL_PROVIDER: string
}

// Main agent lives at PROJECT_ROOT (not under agents/), so it needs its own export section.
export interface MainAgentExport {
  agentId: string  // source MAIN_AGENT_ID -- kept for backward-compat; identity supersedes this
  identity?: FleetIdentity  // full identity set; absent in exports from older versions
  claudeMd: string
  soulMd: string
  config: Record<string, unknown>
  mcp: Record<string, unknown>
  settings: Record<string, unknown>
  channelsAccess: Record<string, unknown>  // provider -> access.json (pairing config, NOT bot token)
}

export interface AgentExport {
  name: string
  config: Record<string, unknown>
  claudeMd: string
  soulMd: string
  mcp: Record<string, unknown>
  settings: Record<string, unknown>
  channelsAccess: Record<string, unknown>
  avatar: string | null  // base64
  avatarExt: string      // 'png' or 'jpg'
  agentSkills: SkillExport[]
}

export interface SkillExport {
  name: string
  skillMd: string
}

export interface ScheduledTaskExport {
  dirName: string
  skillMd: string
  config: Record<string, unknown>
}

export interface KanbanExport {
  cards: Record<string, unknown>[]
  comments: Record<string, unknown>[]
  cardEvents: Record<string, unknown>[]
  labels: Record<string, unknown>[]
  cardLabels: Record<string, unknown>[]
}

export interface IdeaBoxExport {
  ideas: Record<string, unknown>[]
  comments: Record<string, unknown>[]
  statusLog: Record<string, unknown>[]
}

export interface DashboardSettingsExport {
  // DB-backed (autonomy_categories), not the retired JSON side-car --
  // exported/imported as the raw row array rather than the old {categories}
  // wrapper shape.
  autonomy: AutonomyCategoryRow[]
  // DB-backed (model_profile_map), same rationale as autonomy above.
  modelProfileMap: ModelProfileMapRow[]
  // DB-backed (agent_settings, setting_key='auto_restart', migration 0058,
  // #985 group 3/8), not the retired store/auto-restart.json -- exported as
  // { [agentId]: config }, same shape the old file held.
  autoRestart: Record<string, unknown>
  // DB-backed (system_config key 'agents_desired', #985 group 5/8), not the
  // retired store/agents-desired.json -- exported as a plain name array, same
  // shape the old file held. Whole-value replace on import (setDesiredAgents),
  // consistent with the identity-takeover model.
  agentsDesired: string[]
  norbertPersonal: Record<string, unknown>
  // DB-backed (system_config keys 'model_fallback_*', #985 group 5/8), not the
  // retired store/model-fallback.json. Exported via readModelFallbackFieldsRaw()
  // -- ONLY the fields an operator actually set, never the code-level defaults
  // readModelFallbackConfig() would substitute (chain[0] must match the model
  // the TARGET install actually runs, not the source's). A field absent here is
  // left untouched on import (writeModelFallbackFieldsRaw()), not reset -- see
  // the doc comments on those two functions in model-fallback-store.ts.
  modelFallback: Partial<ModelFallbackConfig>
  // DB-backed (system_config key 'federation_config_json', #985 group 5/8's
  // deferred part), not the retired store/federation.json. P3: overwrite
  // semantics (whole-value replace), same as the file used to get -- fleet
  // operational policy, consistent with the identity-takeover model. Still
  // the raw, unvalidated document (may contain an invalid peer) -- same
  // "validate only at read time" contract db/federation.ts's blob storage
  // preserves from the file.
  federation: Record<string, unknown>
  // File-backed still (version/currency/fixed_costs only -- see cost_budgets
  // below for the part that moved).
  costopsConfig: Record<string, unknown>
  // DB-backed (cost_budgets, #985 group 6/8), not the `budgets` field that
  // used to live inside costops-config.json. P3 overwrite semantics (whole-
  // value replace via replaceCostBudgets), matching the old whole-file
  // overwrite this field used to get as part of costopsConfig.
  costBudgets: BudgetEntry[]
  // DB-backed (system_config key 'terminal_input_enabled', #985 group 5/8), not
  // the retired store/terminal-input.json. undefined (omitted from the JSON,
  // via JSON.stringify) when the source never explicitly set this toggle --
  // security-sensitive, so an import must never silently flip a target's
  // deliberate opt-in back to OFF just because the source snapshot is silent
  // on it. See readTerminalInputEnabledRaw()'s doc comment.
  terminalInputEnabled?: boolean
  // DB-backed (egress_allowlist, migration 0056/#985), not the retired
  // store/egress-allowlist.json side-car -- exported as the raw row array
  // (mirrors autonomy above), imported with MERGE semantics (union, never
  // replace) via INSERT OR IGNORE on (value, type, tenant_id): an allowlist is
  // a security-positive control that can only ever be narrowed by an
  // overwrite, and a target machine may have its own already-approved domains
  // for integrations the source fleet never used -- losing those on import
  // would be a silent regression.
  egressAllowlist: EgressAllowlistRow[]
}

export interface MemoryRow {
  agent_id: string
  content: string
  sector: string
  salience: number
  created_at: number
  accessed_at: number
  category: string
  auto_generated: number
  keywords: string | null
}

export interface DailyLogRow {
  agent_id: string
  date: string
  content: string
  created_at: number
}

export interface VaultExport {
  vaultKey: string  // raw base64 content of .vault-key (safe: whole JSON is encrypted when password given)
  entries: Record<string, unknown>[]
  bindings: Record<string, unknown>[]
  // NOTE: channel .env (bot tokens) deliberately NOT exported -- re-pair model:
  // a Telegram bot accepts only one active poller; exporting+auto-activating tokens
  // would cause 409 errors and silent messages on the source. Target must re-pair manually.
}

export interface DiffReport {
  dryRun: true
  wouldCreate: {
    mainAgent: boolean
    agents: string[]
    globalSkills: number
    scheduledTasks: number
    memories: number
    kanbanCards: number
    kanbanComments: number
    labels: number
    dailyLogs: number
    ideaBox: number
    schedules: number
    importSources: number
    vaultSshKeys: number
    vaultSshServers: number
  }
  wouldOverwrite: {
    agents: string[]  // existing sub-agent names that would be overwritten
    mainAgent: boolean
  }
  warnings: string[]
  errors: string[]
}

export interface ImportResult {
  ok: true
  imported: {
    mainAgent: boolean
    agents: string[]
    globalSkills: number
    scheduledTasks: number
    memories: number
    kanbanCards: number
    labels: number
    dailyLogs: number
    ideaBox: number
    schedules: number
    importSources: number
    vaultSshKeys: number
    vaultSshServers: number
  }
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// Crypto helpers -- M7: versioned packed blob, scrypt N=2^17
// ---------------------------------------------------------------------------

const KDF_VERSION = 1
const KDF_N_LOG2 = 17   // N = 2^17 = 131072 (appropriate for user-chosen password on portable file)
const KDF_R = 8
const KDF_P = 1
const KDF_KEYLEN = 32
const KDF_SALT_LEN = 32
const GCM_IV_LEN = 12   // GCM standard is 12 bytes
const GCM_TAG_LEN = 16

// Packed format: [version:1][N_log2:1][r:1][p:1][salt:32][iv:12][tag:16][ciphertext:...]
function encryptWithPassword(plaintext: string, password: string): string {
  const salt = randomBytes(KDF_SALT_LEN)
  const key = scryptSync(password, salt, KDF_KEYLEN, { N: 2 ** KDF_N_LOG2, r: KDF_R, p: KDF_P, maxmem: 256 * 1024 * 1024 })
  const iv = randomBytes(GCM_IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_LEN })
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.from([KDF_VERSION, KDF_N_LOG2, KDF_R, KDF_P])
  return Buffer.concat([header, salt, iv, tag, enc]).toString('base64')
}

// Exported for unit testing (crypto round-trip verification)
export function _encryptForTest(plaintext: string, password: string): string {
  return encryptWithPassword(plaintext, password)
}
export function _decryptForTest(packed: string, password: string): string {
  return decryptWithPassword(packed, password)
}

function decryptWithPassword(packed: string, password: string): string {
  const buf = Buffer.from(packed, 'base64')
  const MIN_PACKED_LEN = 4 + KDF_SALT_LEN + GCM_IV_LEN + GCM_TAG_LEN
  if (buf.length < MIN_PACKED_LEN) {
    throw new Error(`Érvénytelen titkosított blob: várt legalább ${MIN_PACKED_LEN} byte, kapott ${buf.length}.`)
  }
  // version byte (offset 0) reserved for future format changes; currently always 1
  const nLog2 = buf[1]
  const r = buf[2]
  const p = buf[3]
  const off = 4
  const salt = buf.subarray(off, off + KDF_SALT_LEN)
  const iv = buf.subarray(off + KDF_SALT_LEN, off + KDF_SALT_LEN + GCM_IV_LEN)
  const tag = buf.subarray(off + KDF_SALT_LEN + GCM_IV_LEN, off + KDF_SALT_LEN + GCM_IV_LEN + GCM_TAG_LEN)
  const ciphertext = buf.subarray(off + KDF_SALT_LEN + GCM_IV_LEN + GCM_TAG_LEN)
  const key = scryptSync(password, salt, KDF_KEYLEN, { N: 2 ** nLog2, r, p, maxmem: 256 * 1024 * 1024 })
  // authTagLength pinned explicitly (matches encryptWithPassword's GCM_TAG_LEN)
  // so a malformed/short tag fails loudly instead of GCM silently accepting a
  // weaker-than-intended tag length (#817, Semgrep gcm-no-tag-length). The
  // MIN_PACKED_LEN check above already guarantees `tag` is exactly
  // GCM_TAG_LEN bytes, so this is defense-in-depth, not a behavior change.
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_LEN })
  decipher.setAuthTag(tag)
  // Buffer.concat avoids multi-byte UTF-8 split corruption at chunk boundary
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

export const MIN_VAULT_PASSWORD_LEN = 8

// ---------------------------------------------------------------------------
// Path normalization (H4: applied to the entire serialized FleetJson)
// ---------------------------------------------------------------------------

// Collision-resistant sentinels: namespaced so memory/skill content can't accidentally contain them
const PROJECT_ROOT_PLACEHOLDER = '{{FLEET:PROJECT_ROOT}}'
const HOME_PLACEHOLDER = '{{FLEET:HOME}}'

function normalizePaths(text: string): string {
  // Replace PROJECT_ROOT before HOME: on typical installs HOME is a prefix of PROJECT_ROOT.
  return text
    .replaceAll(PROJECT_ROOT, PROJECT_ROOT_PLACEHOLDER)
    .replaceAll(homedir(), HOME_PLACEHOLDER)
}

function denormalizePaths(text: string): string {
  return text
    .replaceAll(PROJECT_ROOT_PLACEHOLDER, PROJECT_ROOT)
    .replaceAll(HOME_PLACEHOLDER, homedir())
}

// ---------------------------------------------------------------------------
// .mcp.json placeholder handling (B2: scan env AND headers, entropy hard-fail)
// ---------------------------------------------------------------------------

// Patterns that suggest a value is NOT a secret (safe to export plaintext).
const NON_SECRET_VALUE_RE = [
  /^(true|false)$/i,
  /^https?:\/\//,
  /^\d+$/,
  /^\//,
  /^\$\{/,
  /^vault:/,
  /^\{\{VAULT:/,
  // Note: no /\s/ exemption -- "Bearer sk-live-..." contains whitespace but IS a secret
]

function looksLikeSecret(value: string): boolean {
  if (value.length < 16) return false
  for (const re of NON_SECRET_VALUE_RE) {
    if (re.test(value)) return false
  }
  return true
}

// Auth scheme prefixes to strip before entropy check on header values
const HEADER_AUTH_SCHEME_RE = /^(?:Bearer|Basic|Token|Digest)\s+/i
// Header keys that always carry secrets (unless already vault-bound)
const ALWAYS_SECRET_HEADER_KEY_RE = /^(authorization|x-api-key|x-auth-token|.*-token|.*-key)$/i
// Well-known non-secret header keys: content/transport metadata, never credentials
const NON_SECRET_HEADER_KEY_RE = /^(content-type|accept|accept-encoding|accept-language|content-length|user-agent|connection|host|origin|referer|cache-control|if-modified-since|if-none-match|pragma|transfer-encoding|upgrade)$/i
// Non-secret patterns for header values -- note: no URL exemption (https://user:cred@host IS a secret)
const NON_SECRET_HEADER_VALUE_RE = [
  /^(true|false)$/i,
  /^\d+$/,
  /^\//,
  /^\$\{/,
  /^vault:/,
  /^\{\{VAULT:/,
]

function looksLikeHeaderSecret(key: string, value: string): boolean {
  if (NON_SECRET_HEADER_KEY_RE.test(key)) return false
  if (ALWAYS_SECRET_HEADER_KEY_RE.test(key)) return true
  // Strip auth scheme prefix ("Bearer ", "Basic "…) then check the credential part
  const stripped = value.replace(HEADER_AUTH_SCHEME_RE, '')
  if (stripped.length < 16) return false
  for (const re of NON_SECRET_HEADER_VALUE_RE) {
    if (re.test(stripped)) return false
  }
  return true
}

// Build lookup: mcpFilePath -> serverName -> envVar -> vaultSecretId
async function buildBindingLookup(): Promise<Map<string, Map<string, Map<string, string>>>> {
  const lookup = new Map<string, Map<string, Map<string, string>>>()
  for (const binding of await getBindings()) {
    for (const target of binding.targets) {
      if (!lookup.has(target.mcpFilePath)) lookup.set(target.mcpFilePath, new Map())
      const byServer = lookup.get(target.mcpFilePath)!
      if (!byServer.has(target.serverName)) byServer.set(target.serverName, new Map())
      byServer.get(target.serverName)!.set(binding.envVar, binding.vaultSecretId)
    }
  }
  return lookup
}

// Scan env AND headers for secrets; convert known vault refs to {{VAULT:id}};
// hard-fail on unbound high-entropy literals (B2).
function placeholderMcp(
  mcpObj: Record<string, unknown>,
  mcpFilePath: string,
  lookup: Map<string, Map<string, Map<string, string>>>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(mcpObj)) as Record<string, unknown>
  const byServer = lookup.get(mcpFilePath)
  const servers = result.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (!servers) return result

  for (const [serverName, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const c = cfg as Record<string, unknown>
    const byEnv = byServer?.get(serverName)

    const blockingFields: string[] = []
    for (const field of ['env', 'headers'] as const) {
      const dict = c[field] as Record<string, string> | undefined
      if (!dict) continue
      for (const [key, val] of Object.entries(dict)) {
        if (typeof val !== 'string') continue
        if (val.startsWith('vault:')) {
          dict[key] = `{{VAULT:${val.slice(6)}}}`
        } else if (byEnv?.has(key)) {
          dict[key] = `{{VAULT:${byEnv.get(key)!}}}`
        } else {
          const isSecret = field === 'headers' ? looksLikeHeaderSecret(key, val) : looksLikeSecret(val)
          if (isSecret) {
            blockingFields.push(`mező="${field}", kulcs="${key}"`)
          }
        }
      }
    }

    // H1: also scan args (string[]) and url/command (string) for embedded secrets
    const args = c.args
    if (Array.isArray(args)) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (typeof arg === 'string' && looksLikeSecret(arg)) {
          blockingFields.push(`mező="args[${i}]"`)
        }
      }
    }
    for (const fld of ['url', 'command'] as const) {
      const val = c[fld]
      if (typeof val === 'string' && looksLikeSecret(val)) {
        blockingFields.push(`mező="${fld}"`)
      }
    }

    if (blockingFields.length > 0) {
      throw new UserFacingError(
        `Titkosítatlan secret az .mcp.json-ban: szerver="${serverName}": ${blockingFields.join('; ')}. ` +
        `Kösd be a vault-ba a dashboard Vault oldalán, majd próbáld újra az exportot.`
      )
    }
  }
  return result
}

// Reverse: {{VAULT:<id>}} -> vault:<id> (vault-env-wrapper.sh resolves at runtime)
function deplaceholderMcp(mcpObj: Record<string, unknown>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(mcpObj)) as Record<string, unknown>
  const servers = result.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (!servers) return result
  for (const [, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const c = cfg as Record<string, unknown>
    for (const field of ['env', 'headers'] as const) {
      const dict = c[field] as Record<string, string> | undefined
      if (!dict) continue
      for (const [k, v] of Object.entries(dict)) {
        if (typeof v === 'string' && v.startsWith('{{VAULT:') && v.endsWith('}}')) {
          dict[k] = `vault:${v.slice(8, -2)}`
        }
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

// DB-backed counterpart to safeReadJson() above -- same {} on absent/invalid
// contract, reading the raw system_config blob instead of a file.
function readFederationConfigObjectRaw(): Record<string, unknown> {
  const raw = getFederationConfigRaw()
  if (raw === undefined) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function safeReadJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return {} }
}

function safeReadText(path: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

function safeReadBase64(path: string): string | null {
  try { return readFileSync(path).toString('base64') } catch { return null }
}

function extractSkillDescription(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return ''
  const line = fmMatch[1].match(/^description:\s*(.+)/im)
  if (!line) return ''
  return line[1].trim().replace(/^["']|["']$/g, '')
}

// Skills are stored in SQL and mirrored to disk as the generated cache the
// Claude Code loader reads. Export from SQL so a snapshot reflects the latest
// content even if the on-disk mirror hasn't been regenerated yet.
function listGlobalSkillsFromSQL(): SkillExport[] {
  const prefix = 'global/'
  return listAllSkills()
    .filter(r => r.tenant_id === 'fleet' && r.id.startsWith(prefix))
    .map(r => ({ name: r.id.slice(prefix.length), skillMd: r.content }))
}

function listAgentSkillsFromSQL(agentId: string): SkillExport[] {
  const prefix = `agent/${agentId}/`
  return listAllSkills()
    .filter(r => r.tenant_id === 'fleet' && r.id.startsWith(prefix))
    .map(r => ({ name: r.id.slice(prefix.length), skillMd: r.content }))
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportChannelsAccess(channelsDir: string): Record<string, unknown> {
  const channelsAccess: Record<string, unknown> = {}
  if (existsSync(channelsDir)) {
    for (const provider of readdirSync(channelsDir)) {
      const accessPath = join(channelsDir, provider, 'access.json')
      if (existsSync(accessPath)) {
        channelsAccess[provider] = safeReadJson(accessPath)
      }
    }
  }
  return channelsAccess
}

// Main agent lives at PROJECT_ROOT -- exported separately since it's not under agents/.
function exportMainAgent(
  bindingLookup: Map<string, Map<string, Map<string, string>>>,
  withSecrets: boolean,
): MainAgentExport {
  const claudeDir = join(PROJECT_ROOT, '.claude')
  const mcpPath = join(PROJECT_ROOT, '.mcp.json')
  const settingsPath = join(claudeDir, 'settings.json')

  const rawMcp = safeReadJson(mcpPath)
  // withSecrets: whole JSON will be encrypted -- skip placeholder/hard-fail
  const mcp = withSecrets ? rawMcp : placeholderMcp(rawMcp, mcpPath, bindingLookup)

  const settingsRaw = safeReadText(settingsPath)
  const settings = settingsRaw ? JSON.parse(settingsRaw) as Record<string, unknown> : {}

  // M4: in plaintext export, hard-fail if settings.env contains secrets
  if (!withSecrets && typeof settings.env === 'object' && settings.env !== null) {
    for (const [key, val] of Object.entries(settings.env as Record<string, unknown>)) {
      if (typeof val === 'string' && looksLikeSecret(val)) {
        throw new UserFacingError(
          `Titkosítatlan secret a settings.json env blokkjában: kulcs="${key}". ` +
          `Adj meg vault jelszót az exporthoz, vagy távolítsd el a titkot a settings.json-ból.`
        )
      }
    }
  }

  // Main agent channel access lives at ~/.claude/channels/<provider>/access.json
  const channelsAccess = exportChannelsAccess(join(homedir(), '.claude', 'channels'))

  return {
    agentId: MAIN_AGENT_ID,
    identity: {
      MAIN_AGENT_ID,
      BOT_NAME,
      BRAND_NAME,
      OWNER_NAME,
      CHANNEL_PROVIDER,
    },
    claudeMd: safeReadText(join(PROJECT_ROOT, 'CLAUDE.md')),
    soulMd: safeReadText(join(PROJECT_ROOT, 'SOUL.md')),
    config: safeReadJson(join(PROJECT_ROOT, 'agent-config.json')),
    mcp,
    settings,
    channelsAccess,
  }
}

function exportAgent(
  name: string,
  bindingLookup: Map<string, Map<string, Map<string, string>>>,
  withSecrets: boolean,
): AgentExport {
  const dir = join(AGENTS_BASE_DIR, name)
  const claudeDir = join(dir, '.claude')
  const mcpPath = join(dir, '.mcp.json')
  const settingsPath = join(claudeDir, 'settings.json')

  const rawMcp = safeReadJson(mcpPath)
  // withSecrets: whole JSON will be encrypted -- skip placeholder/hard-fail
  const mcp = withSecrets ? rawMcp : placeholderMcp(rawMcp, mcpPath, bindingLookup)

  const settingsRaw = safeReadText(settingsPath)
  const settings = settingsRaw ? JSON.parse(settingsRaw) as Record<string, unknown> : {}

  // M4: in plaintext export, hard-fail if settings.env contains secrets
  if (!withSecrets && typeof settings.env === 'object' && settings.env !== null) {
    for (const [key, val] of Object.entries(settings.env as Record<string, unknown>)) {
      if (typeof val === 'string' && looksLikeSecret(val)) {
        throw new UserFacingError(
          `Titkosítatlan secret az agent "${name}" settings.json env blokkjában: kulcs="${key}". ` +
          `Adj meg vault jelszót az exporthoz, vagy távolítsd el a titkot a settings.json-ból.`
        )
      }
    }
  }

  // channels/access.json per provider (not .env -- vault-gated)
  const channelsAccess = exportChannelsAccess(join(claudeDir, 'channels'))

  // avatar -- preserve actual extension
  let avatar: string | null = null
  let avatarExt = 'png'
  const pngPath = join(dir, 'avatar.png')
  const jpgPath = join(dir, 'avatar.jpg')
  if (existsSync(pngPath)) {
    avatar = safeReadBase64(pngPath)
    avatarExt = 'png'
  } else if (existsSync(jpgPath)) {
    avatar = safeReadBase64(jpgPath)
    avatarExt = 'jpg'
  }

  return {
    name,
    config: safeReadJson(join(dir, 'agent-config.json')),
    claudeMd: safeReadText(join(dir, 'CLAUDE.md')),
    soulMd: safeReadText(join(dir, 'SOUL.md')),
    mcp,
    settings,
    channelsAccess,
    avatar,
    avatarExt,
    agentSkills: listAgentSkillsFromSQL(name),
  }
}

function exportScheduledTasks(): ScheduledTaskExport[] {
  if (!existsSync(SCHEDULED_TASKS_DIR)) return []
  const result: ScheduledTaskExport[] = []
  for (const dirName of readdirSync(SCHEDULED_TASKS_DIR)) {
    const dir = join(SCHEDULED_TASKS_DIR, dirName)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    const skillMd = safeReadText(join(dir, 'SKILL.md'))
    const configRaw = safeReadJson(join(dir, 'task-config.json'))
    result.push({ dirName, skillMd, config: { ...configRaw, enabled: false } })
  }
  return result
}

async function exportDashboardSettings(): Promise<DashboardSettingsExport> {
  const read = (name: string) => safeReadJson(join(STORE_DIR, name))
  return {
    autonomy: await listAutonomyCategories(),
    modelProfileMap: listModelProfileMap(),
    autoRestart: listAgentSettingsByKey('auto_restart'),
    agentsDesired: [...getDesiredAgents()].sort(),
    norbertPersonal: read('norbert-personal.json'),
    modelFallback: readModelFallbackFieldsRaw(),
    federation: readFederationConfigObjectRaw(),
    costopsConfig: read('costops-config.json'),
    costBudgets: await listCostBudgets('default'),
    egressAllowlist: await listEgressAllowlistRows(null),
    terminalInputEnabled: readTerminalInputEnabledRaw(),
  }
}

async function exportVault(): Promise<VaultExport | null> {
  const vaultKeyPath = join(STORE_DIR, '.vault-key')
  const vaultKeyMigratedPath = join(STORE_DIR, '.vault-key.migrated')
  const vaultPath = join(STORE_DIR, 'vault.json')

  if (!existsSync(vaultKeyPath)) {
    // macOS Keychain migration -- vault-key.migrated means key is in Keychain
    if (existsSync(vaultKeyMigratedPath)) {
      throw new Error(
        'A vault kulcs macOS Keychain-be lett migrálva (.vault-key.migrated megtalálható). ' +
        'A vault szekció exportja ebben a konfigurációban nem támogatott -- adj meg vault jelszót.'
      )
    }
    return null
  }

  // Raw export: the entire FleetJson will be encrypted, so vault data is safe as plaintext here.
  const vaultKey = readFileSync(vaultKeyPath, 'utf-8').trim()
  const vaultStore = safeReadJson(vaultPath)
  const entries = (vaultStore.entries as Record<string, unknown>[]) ?? []
  // DB-backed (vault_bindings, migration 0062, #985 group 7/8), not the
  // retired store/vault-bindings.json.
  const bindings = (await listVaultBindings('default')) as unknown as Record<string, unknown>[]

  // Channel .env (bot tokens) are intentionally NOT exported -- see re-pair model comment in VaultExport.
  return { vaultKey, entries, bindings }
}

// Encrypted export wrapper: {"enc":1,"blob":"<base64-of-encrypted-fleet-json>"}
// The enc field signals the import side to decrypt before parsing.
export const ENCRYPTED_FLEET_VERSION = 1

export type ExportedFleet = { data: string; exportedAt: string }

export async function exportFleet(options: { vaultPassword?: string } = {}): Promise<ExportedFleet> {
  if (options.vaultPassword !== undefined && options.vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
    throw new Error(`A vault jelszó legalább ${MIN_VAULT_PASSWORD_LEN} karakter kell legyen.`)
  }

  const withSecrets = !!options.vaultPassword
  const bindingLookup = withSecrets ? new Map() : await buildBindingLookup()

  const mainAgent = exportMainAgent(bindingLookup, withSecrets)
  const agents = listAgentNames().map(name => exportAgent(name, bindingLookup, withSecrets))
  const skills = listGlobalSkillsFromSQL()
  const scheduledTasks = exportScheduledTasks()

  // Export ALL memories and daily_logs across every agent_id
  const memories = await exportMemoryRows<MemoryRow>()

  const dailyLogs = await exportDailyLogRows<DailyLogRow>()

  const kanban: KanbanExport = {
    cards: await exportTableRows('kanban_cards'),
    comments: await exportTableRows('kanban_comments'),
    cardEvents: await exportTableRows('kanban_card_events'),
    labels: await exportTableRows('labels'),
    cardLabels: await exportTableRows('kanban_card_labels'),
  }

  const ideaBox: IdeaBoxExport = {
    ideas: await exportTableRows('idea_box'),
    comments: await exportTableRows('idea_comments'),
    statusLog: await exportTableRows('idea_status_log'),
  }

  // DB-based schedules (dashboard-schedule-crud API), distinct from the file-based
  // scheduledTasks[] above. Force-disabled at export time, same as scheduledTasks,
  // so an imported fleet never starts firing a source fleet's cron jobs unreviewed.
  const schedules = (await exportTableRows('schedules'))
    .map(row => ({ ...row, enabled: 0 }))

  // Import-pipeline source configs (local/gdrive/sharepoint/confluence). Only the
  // config row is exported -- vault_token_ref is just the vault entry's id (the
  // secret itself travels via the vault section), and the crawled content
  // (import_memories) is deliberately NOT exported: the crawler re-fetches it.
  // Force-disabled + last_run_at cleared at export time: a target's local paths
  // and gdrive/sharepoint/confluence credentials are never portable as-is, AND
  // leaving last_run_at set would make the next crawl treat itself as incremental
  // and silently skip everything older than that cutoff -- content the target
  // never actually has, since import_memories didn't come along for the ride.
  const importSources = (await exportTableRows('import_sources'))
    .map(row => ({ ...row, enabled: 0, last_run_at: null }))

  // SSH key-pool metadata (P4). Neither table has a private-key column -- the
  // actual private key material lives as a generic vault secret keyed by
  // vault_key_id, and is included ONLY when the vault section below is (i.e.
  // only in an encrypted, password-protected export). This metadata alone is
  // safe in plaintext: public key, fingerprint, host/port/username, no secret.
  const vaultSshKeys = await exportTableRows('vault_ssh_keys')
  const vaultSshServers = await exportTableRows('vault_ssh_servers')

  // Vault section is only included in encrypted exports (whole-JSON encryption makes it safe)
  const vault = withSecrets ? await exportVault() : undefined

  const fleet: FleetJson = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceHost: hostname(),
    mainAgent,
    agents,
    skills,
    scheduledTasks,
    memories,
    dailyLogs,
    kanban,
    ideaBox,
    schedules,
    importSources,
    vaultSshKeys,
    vaultSshServers,
    dashboardSettings: await exportDashboardSettings(),
    ...(vault ? { vault } : {}),
  }

  // Normalize ALL absolute paths in the entire JSON in one pass
  const normalized = normalizePaths(JSON.stringify(fleet))

  if (withSecrets) {
    // Encrypt the entire JSON -- vault secrets, MCP tokens, settings.env all protected as a unit
    const blob = encryptWithPassword(normalized, options.vaultPassword!)
    const data = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })
    return { data, exportedAt: fleet.exportedAt }
  }

  return { data: normalized, exportedAt: fleet.exportedAt }
}

// ---------------------------------------------------------------------------
// Import -- validate, dry-run, and apply
// ---------------------------------------------------------------------------

function validateSchema(fleet: unknown): string[] {
  const errors: string[] = []
  if (!fleet || typeof fleet !== 'object') {
    errors.push('Érvénytelen JSON: a gyökér nem objektum.')
    return errors
  }
  const f = fleet as Record<string, unknown>
  if (f.schemaVersion === undefined || f.schemaVersion === null) {
    errors.push('schemaVersion hiányzik -- az export nem kompatibilis vagy pre-v1 build hozta létre.')
    return errors
  }
  if (f.schemaVersion !== FLEET_SCHEMA_VERSION) {
    const v = f.schemaVersion
    errors.push(
      `Az export schema v${v}, a telepített dashboard v${FLEET_SCHEMA_VERSION}-t támogat. ` +
      (Number(v) > FLEET_SCHEMA_VERSION
        ? 'Frissítsd a dashboardot az import előtt.'
        : 'Az export túl régi.')
    )
    return errors
  }
  if (!Array.isArray(f.agents)) errors.push('agents mező hiányzik vagy nem tömb.')
  return errors
}

// B1: validate all untrusted names before any file operation
function validateNames(fleet: FleetJson): string[] {
  const errors: string[] = []

  // mainAgent channel providers (written to ~/.claude/channels/<provider>/)
  for (const provider of Object.keys(fleet.mainAgent?.channelsAccess ?? {})) {
    if (!SAFE_NAME_RE.test(provider)) {
      errors.push(`Érvénytelen mainAgent channel provider: "${provider.slice(0, 60)}"`)
    }
  }

  for (const agent of fleet.agents ?? []) {
    if (!SAFE_NAME_RE.test(String(agent.name ?? ''))) {
      errors.push(`Érvénytelen agent.name: "${String(agent.name).slice(0, 60)}"`)
    }
    // B1: avatarExt defense-in-depth guard (primary enforcement in writeAgentFiles)
    if (agent.avatar && agent.avatarExt !== undefined &&
        !/^(png|jpe?g|webp)$/i.test(String(agent.avatarExt))) {
      errors.push(`Érvénytelen avatarExt (agent ${agent.name}): "${String(agent.avatarExt).slice(0, 20)}"`)
    }
    for (const skill of agent.agentSkills ?? []) {
      if (!SAFE_NAME_RE.test(String(skill.name ?? ''))) {
        errors.push(`Érvénytelen skill.name (agent ${agent.name}): "${String(skill.name).slice(0, 60)}"`)
      }
    }
    for (const provider of Object.keys(agent.channelsAccess ?? {})) {
      if (!SAFE_NAME_RE.test(provider)) {
        errors.push(`Érvénytelen channel provider (agent ${agent.name}): "${provider.slice(0, 60)}"`)
      }
    }
  }
  for (const skill of fleet.skills ?? []) {
    if (!SAFE_NAME_RE.test(String(skill.name ?? ''))) {
      errors.push(`Érvénytelen global skill.name: "${String(skill.name).slice(0, 60)}"`)
    }
  }
  for (const task of fleet.scheduledTasks ?? []) {
    if (!SAFE_NAME_RE.test(String(task.dirName ?? ''))) {
      errors.push(`Érvénytelen scheduledTask.dirName: "${String(task.dirName).slice(0, 60)}"`)
    }
  }
  return errors
}

// Tenant an imported schedule lands in. Tenants are local to a machine: an exported tenant_id
// that this machine does not have (or has disabled) cannot be honoured, and a task must belong
// to a tenant, so it is re-homed to the default tenant. It arrives disabled either way, so a
// person reviews it before it can fire.
/**
 * True when an imported row would break a NOT NULL or CHECK rule of its table.
 * The import used to rely on INSERT OR IGNORE swallowing such a row; ON
 * CONFLICT DO NOTHING only absorbs key conflicts, so the rule is checked here
 * and the row is skipped the same way. `enums` are the CHECK(col IN (...)) lists.
 */
export function breaksTableRules(row: Record<string, unknown>, notNull: string[], enums: Record<string, string[]> = {}): boolean {
  if (notNull.some((col) => row[col] == null)) return true
  return Object.entries(enums).some(([col, allowed]) => !allowed.includes(row[col] as string))
}

function importedScheduleTenant(localTenants: ReadonlySet<string>, raw: unknown): string {
  return typeof raw === 'string' && localTenants.has(raw) ? raw : 'default'
}

async function enabledLocalTenantIds(): Promise<Set<string>> {
  return new Set<string>(['default', ...await listEnabledTenantIds()])
}

async function buildDiffReport(fleet: FleetJson): Promise<DiffReport> {
  const warnings: string[] = []

  const existingAgents = new Set(listAgentNames())
  const newAgents = (fleet.agents ?? []).map(a => a.name).filter(n => !existingAgents.has(n))

  let newMemories = 0
  for (const mem of fleet.memories ?? []) {
    if (!await fleetRowExists('memories', mem)) {
      newMemories++
    }
  }

  let newCards = 0
  for (const card of fleet.kanban?.cards ?? []) {
    if (!await fleetRowIdExists('kanban_cards', (card as any).id)) newCards++
  }

  let newLabels = 0
  for (const label of fleet.kanban?.labels ?? []) {
    if (!await fleetRowIdExists('labels', (label as any).id)) newLabels++
  }

  let newDailyLogs = 0
  for (const log of fleet.dailyLogs ?? []) {
    if (!await fleetRowExists('daily_logs', log)) {
      newDailyLogs++
    }
  }

  let newComments = 0
  for (const c of fleet.kanban?.comments ?? []) {
    if (!await fleetRowExists('kanban_comments', c as any)) newComments++
  }

  let newSchedules = 0
  let rehomedSchedules = 0
  const localTenants = await enabledLocalTenantIds()
  for (const sch of fleet.schedules ?? []) {
    if (await fleetRowIdExists('schedules', (sch as any).id)) continue
    newSchedules++
    const exported = (sch as any).tenant_id
    if (exported != null && importedScheduleTenant(localTenants, exported) !== exported) rehomedSchedules++
  }
  if (newSchedules > 0) {
    warnings.push(`${newSchedules} ütemezés importálva -- letiltva érkezik, kézi átvizsgálás és engedélyezés szükséges célgépen.`)
  }
  if (rehomedSchedules > 0) {
    warnings.push(`${rehomedSchedules} ütemezés tenantja nem létezik (vagy le van tiltva) a célgépen, ezért a default tenantba kerül -- ellenőrizd, melyik tenantba és ágenshez tartozzon, mielőtt engeded.`)
  }

  let newImportSources = 0
  for (const src of fleet.importSources ?? []) {
    if (!await fleetRowIdExists('import_sources', (src as any).id)) newImportSources++
  }
  if (newImportSources > 0) {
    warnings.push(
      `${newImportSources} import-forrás importálva -- letiltva érkezik, a tartalom (import_memories) nem került át. ` +
      `A vault_token_ref-ek csak akkor engedélyezhetők újra, ha a hivatkozott vault-bejegyzés a célgépen is létezik.`
    )
  }

  let newVaultSshKeys = 0
  for (const key of fleet.vaultSshKeys ?? []) {
    if (!await fleetRowIdExists('vault_ssh_keys', (key as any).id)) newVaultSshKeys++
  }
  let newVaultSshServers = 0
  for (const srv of fleet.vaultSshServers ?? []) {
    if (!await fleetRowIdExists('vault_ssh_servers', (srv as any).id)) newVaultSshServers++
  }

  if (!fleet.vault) {
    warnings.push('vault szekció hiányzik -- az MCP szerverek token nélkül indulnak el, manuális re-auth szükséges.')
    if (newVaultSshKeys > 0) {
      warnings.push(
        `${newVaultSshKeys} SSH kulcs metaadata importálva, de a PRIVÁT kulcs anyaga NEM -- az csak ` +
        'titkosított (jelszavas) vault-exportban utazik. A kulcsok publikus adatai (fingerprint, ' +
        'nyilvános kulcs) láthatók lesznek, de használat előtt a privát kulcsot újra fel kell tölteni.'
      )
    }
  }

  // H3: track which existing agents and main agent would be overwritten
  const existingAgentsToOverwrite = (fleet.agents ?? []).map(a => a.name).filter(n => existingAgents.has(n))
  const mainAgentOverwrite = !!fleet.mainAgent && existsSync(join(PROJECT_ROOT, 'CLAUDE.md'))

  // Channels: always warn -- bot tokens are not exported (re-pair model)
  const hasChannels = Object.keys(fleet.mainAgent?.channelsAccess ?? {}).length > 0 ||
    (fleet.agents ?? []).some(a => Object.keys(a.channelsAccess ?? {}).length > 0)
  if (hasChannels) {
    warnings.push('Csatornák: újra-párosítás szükséges a célgépen (bot token újboli megadása).')
  }

  // Identity takeover preview
  const drySourceId = fleet.mainAgent?.identity?.MAIN_AGENT_ID ?? fleet.mainAgent?.agentId
  if (drySourceId && typeof drySourceId === 'string') {
    warnings.push(
      `Fő-agent identitás átvéve: ${drySourceId}. Apply után újraindítás szükséges hogy a dashboard ${drySourceId}-ként induljon.`
    )
  }

  return {
    dryRun: true,
    wouldCreate: {
      mainAgent: !!fleet.mainAgent,
      agents: newAgents,
      globalSkills: (fleet.skills ?? []).length,
      scheduledTasks: (fleet.scheduledTasks ?? []).length,
      memories: newMemories,
      kanbanCards: newCards,
      kanbanComments: newComments,
      labels: newLabels,
      dailyLogs: newDailyLogs,
      ideaBox: (fleet.ideaBox?.ideas ?? []).length,
      schedules: newSchedules,
      importSources: newImportSources,
      vaultSshKeys: newVaultSshKeys,
      vaultSshServers: newVaultSshServers,
    },
    wouldOverwrite: {
      agents: existingAgentsToOverwrite,
      mainAgent: mainAgentOverwrite,
    },
    warnings,
    errors: [],
  }
}

// ---------------------------------------------------------------------------
// Apply helpers -- staged writes, so a failing import leaves nothing half applied
// ---------------------------------------------------------------------------
//
// The import is applied in phases:
//   0. decode and validate everything that is pure (nothing is written),
//   1. STAGE the files: each one is written as `<path>.import-new`; a file that would be overwritten is first copied
//      to `<path>.import-bak`. No final path changes in this phase (only the directories that did not exist are
//      created, and tracked so a failure removes them again),
//   2. ONE database transaction holds every database write of the import (the settings, the skills and the rows),
//   3. only after the commit: rename the staged files into place, reload the process-local caches, then the vault
//      step and the `.env` mirror (the vault stays last, as before).
//
// Backup rule. A failure before the commit never touched a final path, so the staged files AND the backups (a
// redundant copy of files that are still in place) are removed. A failure after the commit restores the renamed
// files from their backups and KEEPS those backups (they are the only copy of the previous content if a restore
// itself fails); the backups of files that were never renamed are removed. A successful import removes every backup.

const STAGE_SUFFIX = '.import-new'
const BACKUP_SUFFIX = '.import-bak'

interface WriteEntry {
  /** The final path. */
  path: string
  /** `<path>.import-new`: where the new content waits for the commit. */
  staged: string
  /** `<path>.import-bak`: the previous content, set only when the final path existed at staging time. */
  backup: string | null
  /** True once the staged file was renamed onto the final path. */
  renamed: boolean
}

interface WriteTracker {
  files: WriteEntry[]
  dirs: string[]
}

function trackedMkdir(path: string, tracker: WriteTracker): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
    tracker.dirs.push(path)
  }
}

/** Phase 1: write the new content next to `path` and back up the file it will replace. Touches no final path. */
function stagedWrite(path: string, content: string | Buffer, tracker: WriteTracker, opts?: { mode?: number }): WriteEntry {
  let entry = tracker.files.find((e) => e.path === path)
  if (!entry) {
    // Tracked before the write, so a write that fails half way is still cleaned up.
    entry = { path, staged: `${path}${STAGE_SUFFIX}`, backup: null, renamed: false }
    tracker.files.push(entry)
  }
  atomicWriteFileSync(entry.staged, content as string, opts)
  if (entry.backup === null && existsSync(path)) {
    const backup = `${path}${BACKUP_SUFFIX}`
    copyFileSync(path, backup)
    entry.backup = backup
  }
  return entry
}

function removeQuietly(path: string): void {
  try { unlinkSync(path) } catch { /* best effort */ }
}

function removeCreatedDirs(tracker: WriteTracker): void {
  // Deepest first. Only directories this import created are listed, so nothing of the target's goes with them.
  for (const d of [...tracker.dirs].reverse()) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Failure before the commit: no final path was touched, so drop the staged files, the backups and the new dirs. */
function discardStaged(tracker: WriteTracker): void {
  for (const e of tracker.files) {
    removeQuietly(e.staged)
    if (e.backup) removeQuietly(e.backup)
  }
  removeCreatedDirs(tracker)
}

/** Phase 3: rename the staged files onto their final paths (same directory, so each rename is atomic). */
function finalizeStaged(entries: readonly WriteEntry[]): void {
  for (const e of entries) {
    renameSync(e.staged, e.path)
    e.renamed = true
  }
}

/**
 * Failure after the commit: put the final paths back as they were. A renamed file that replaced an existing one is
 * copied back from its backup (the backup stays, see the rule above); a renamed file that is new is removed; a file
 * that was never renamed loses its staged copy and its backup. Best effort and logged: returns the paths that could
 * not be restored.
 */
function restoreFinalized(tracker: WriteTracker): string[] {
  const failed: string[] = []
  for (const e of tracker.files) {
    if (!e.renamed) {
      removeQuietly(e.staged)
      if (e.backup) removeQuietly(e.backup)
      continue
    }
    try {
      if (e.backup) copyFileSync(e.backup, e.path)
      else unlinkSync(e.path)
    } catch (err: any) {
      failed.push(e.path)
      logger.error({ path: e.path, err: err?.message }, 'Fleet import: could not restore a file after a failed finish')
    }
  }
  removeCreatedDirs(tracker)
  return failed
}

/** Success: the previous content is no longer needed. */
function dropBackups(tracker: WriteTracker): void {
  for (const e of tracker.files) {
    if (e.backup) removeQuietly(e.backup)
  }
}

/**
 * Re-read the process-local caches that mirror the tables the import writes (a write-through cache shows the new
 * value as soon as the statement ran, inside the transaction, and keeps it after a rollback), and drop the federation
 * config cache for the same reason.
 */
function reloadImportCaches(): void {
  reloadModelProfileMapCache()
  reloadAgentSettingsCache()
  reloadSystemConfigCache()
  invalidateFederationConfigCache()
}

/** The failure-branch variant: the original error is the one to report, so a reload that fails is only logged. */
function reloadImportCachesQuietly(): void {
  try { reloadImportCaches() } catch (err: any) {
    logger.error({ err: err?.message }, 'Fleet import: could not reload the caches after a failed import')
  }
}

function writeMainAgentFiles(ma: MainAgentExport, tracker: WriteTracker): void {
  const claudeDir = join(PROJECT_ROOT, '.claude')
  trackedMkdir(claudeDir, tracker)

  if (ma.claudeMd) stagedWrite(join(PROJECT_ROOT, 'CLAUDE.md'), ma.claudeMd, tracker)
  if (ma.soulMd) stagedWrite(join(PROJECT_ROOT, 'SOUL.md'), ma.soulMd, tracker)
  if (ma.config && Object.keys(ma.config).length)
    stagedWrite(join(PROJECT_ROOT, 'agent-config.json'), JSON.stringify(ma.config, null, 2), tracker)
  stagedWrite(join(PROJECT_ROOT, '.mcp.json'), JSON.stringify(deplaceholderMcp(ma.mcp), null, 2), tracker)
  stagedWrite(join(claudeDir, 'settings.json'), JSON.stringify(ma.settings, null, 2), tracker)

  // Main agent channel access: ~/.claude/channels/<provider>/access.json
  // B1: provider names validated by validateNames() before this is called
  const channelsBase = join(homedir(), '.claude', 'channels')
  for (const [provider, access] of Object.entries(ma.channelsAccess ?? {})) {
    const provDir = safeJoin(channelsBase, provider)
    trackedMkdir(provDir, tracker)
    stagedWrite(join(provDir, 'access.json'), JSON.stringify(access, null, 2), tracker)
  }
}

function writeAgentFiles(agent: AgentExport, tracker: WriteTracker): void {
  // B1: names already validated by validateNames() before this is called
  const dir = safeJoin(AGENTS_BASE_DIR, agent.name)
  const claudeDir = safeJoin(dir, '.claude')
  trackedMkdir(claudeDir, tracker)

  stagedWrite(join(dir, 'agent-config.json'), JSON.stringify(agent.config, null, 2), tracker)
  if (agent.claudeMd) stagedWrite(join(dir, 'CLAUDE.md'), agent.claudeMd, tracker)
  if (agent.soulMd) stagedWrite(join(dir, 'SOUL.md'), agent.soulMd, tracker)

  // .mcp.json: de-placeholder vault refs (path denormalization happens at fleet level)
  stagedWrite(join(dir, '.mcp.json'), JSON.stringify(deplaceholderMcp(agent.mcp), null, 2), tracker)

  stagedWrite(join(claudeDir, 'settings.json'), JSON.stringify(agent.settings, null, 2), tracker)

  for (const [provider, access] of Object.entries(agent.channelsAccess ?? {})) {
    const provDir = safeJoin(claudeDir, 'channels', provider)
    trackedMkdir(provDir, tracker)
    stagedWrite(join(provDir, 'access.json'), JSON.stringify(access, null, 2), tracker)
  }

  if (agent.avatar) {
    // B1: whitelist extension to prevent path traversal via malicious avatarExt
    const ext = /^(png|jpe?g|webp)$/i.test(String(agent.avatarExt || '')) ? String(agent.avatarExt) : 'png'
    stagedWrite(safeJoin(dir, `avatar.${ext}`), Buffer.from(agent.avatar, 'base64'), tracker)
  }

  for (const skill of agent.agentSkills ?? []) {
    const skillDir = safeJoin(claudeDir, 'skills', skill.name)
    trackedMkdir(skillDir, tracker)
    stagedWrite(join(skillDir, 'SKILL.md'), skill.skillMd, tracker)
    // The matching SQL row is part of the import transaction (skillSqlSeeds()).
  }
}

type SkillSeed = Parameters<typeof seedSkillIfAbsent>[0]

/**
 * Dual-write into SQL (the source of truth) alongside the file the Claude Code loader needs -- mirrors the
 * existing zip-import precedent (routes/skills.ts). Unconditional, not gated by SKILL_SQL_REGEN: a fresh install
 * may still have the kill-switch off, and the loader needs the file regardless, so this can't rely on regen to
 * materialize it. Pure: the rows are decided here and written inside the import transaction, where a failure
 * fails the import instead of leaving a file without its row.
 */
function skillSqlSeeds(fleet: FleetJson): SkillSeed[] {
  const seeds: SkillSeed[] = []
  for (const agent of fleet.agents ?? []) {
    for (const skill of agent.agentSkills ?? []) {
      seeds.push({
        id: `agent/${agent.name}/${skill.name}`,
        name: skill.name,
        description: extractSkillDescription(skill.skillMd),
        content: skill.skillMd,
        tenant_id: 'fleet',
        is_global: false,
      })
    }
  }
  for (const skill of fleet.skills ?? []) {
    seeds.push({
      id: `global/${skill.name}`,
      name: skill.name,
      description: extractSkillDescription(skill.skillMd),
      content: skill.skillMd,
      tenant_id: 'fleet',
      is_global: true,
    })
  }
  return seeds
}

// Phase 1 of the vault: stage the two files (mode 0600 from the first byte). The caller renames them in the vault step.
function stageVaultFiles(vault: VaultExport, tracker: WriteTracker): WriteEntry[] {
  // vault.vaultKey is plaintext -- the caller already decrypted the whole JSON with the user password
  return [
    stagedWrite(join(STORE_DIR, '.vault-key'), vault.vaultKey, tracker, { mode: 0o600 }),
    stagedWrite(join(STORE_DIR, 'vault.json'), JSON.stringify({ entries: vault.entries }, null, 2), tracker, { mode: 0o600 }),
  ]
  // Channel .env (bot tokens) are intentionally NOT imported -- target must re-pair channels manually.
}

// vault.bindings -> vault_bindings (DB-backed, migration 0062, #985 group
// 7/8), not a file write. Same guard shape as costBudgets' fleet-transfer
// import (#524 lesson): an EMPTY or entirely-invalid source array must not
// wipe the target's own bindings (old-format export vs. genuinely zero
// bindings are indistinguishable, and neither justifies deleting what the
// target already has), and a duplicated (vaultSecretId, envVar) pair must be
// de-duped -- first occurrence wins -- instead of hitting
// vault_bindings' PRIMARY KEY mid-write and throwing. Pushes onto the
// caller's `warnings` array (the same applyWarnings list importFleet's other
// DB-backed fields report through) rather than returning its own.
//
// The two vault files were STAGED with everything else (stageVaultFiles, phase 1) and are renamed here, in the
// vault step after the commit; the bindings are written here too, so nothing of the vault changes if the
// transaction fails.
async function importVaultSection(vault: VaultExport, stagedFiles: readonly WriteEntry[], warnings: string[]): Promise<void> {
  finalizeStaged(stagedFiles)

  const rawBindings = Array.isArray(vault.bindings) ? vault.bindings : []
  if (rawBindings.length === 0) {
    if (Array.isArray(vault.bindings)) {
      warnings.push('vault bindings üres volt a forrás fájlban -- a célgép saját bindingjei megmaradtak (nem törlődtek).')
    }
    return
  }

  const validated: VaultBinding[] = []
  let invalidCount = 0
  for (const raw of rawBindings) {
    const b = raw as Record<string, unknown>
    if (typeof b?.vaultSecretId !== 'string' || !b.vaultSecretId) { invalidCount++; continue }
    if (typeof b?.envVar !== 'string' || !b.envVar) { invalidCount++; continue }
    const targets = Array.isArray(b.targets)
      ? (b.targets as unknown[]).filter(
          (t): t is { mcpFilePath: string; serverName: string } =>
            !!t && typeof (t as any).mcpFilePath === 'string' && typeof (t as any).serverName === 'string',
        )
      : []
    validated.push({ vaultSecretId: b.vaultSecretId, envVar: b.envVar, targets })
  }

  // De-dup by (vaultSecretId, envVar), first occurrence wins -- same
  // semantics as migrateVaultBindingsFromFile()'s INSERT OR IGNORE.
  const seen = new Set<string>()
  const deduped: VaultBinding[] = []
  let duplicateCount = 0
  for (const b of validated) {
    const key = `${b.vaultSecretId}\u0000${b.envVar}`
    if (seen.has(key)) { duplicateCount++; continue }
    seen.add(key)
    deduped.push(b)
  }

  // The rawBindings.length===0 check above only proves the SOURCE array was
  // non-empty -- if every entry was invalid or a duplicate, `deduped` can
  // still be empty here. Applying the "don't wipe" guard to the raw source
  // length would let replaceVaultBindings('default', []) through in exactly
  // that case, still wiping the target for reasons the source never asked for.
  if (deduped.length > 0) {
    await replaceVaultBindings('default', deduped)
  }
  if (invalidCount > 0) {
    warnings.push(`vault bindings: ${invalidCount} érvénytelen bejegyzés kimaradt az importból.`)
  }
  if (duplicateCount > 0) {
    warnings.push(`vault bindings: ${duplicateCount} duplikált (vaultSecretId, envVar) pár kimaradt (az első előfordulás nyert).`)
  }
  if (deduped.length === 0) {
    warnings.push('vault bindings: egyetlen érvényes bejegyzés sem maradt validálás után -- a célgép saját bindingjei megmaradtak (nem törlődtek).')
  }
}

const EMPTY_DIFF: DiffReport = {
  dryRun: true,
  wouldCreate: { mainAgent: false, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0, schedules: 0, importSources: 0, vaultSshKeys: 0, vaultSshServers: 0 },
  wouldOverwrite: { agents: [], mainAgent: false },
  warnings: [],
  errors: [],
}

// Applying imports one at a time. The staged files carry fixed names (`<path>.import-new`, `<path>.import-bak`), so two
// applies that overlap (a double click on the import button) would stage onto the same files and one of them would
// fail its rename after its transaction had committed; and the database and the files of two different bundles could
// end up mixed. The second apply waits for the first, then runs on the state the first left. A dry run writes
// nothing and does not wait.
let applyChain: Promise<unknown> = Promise.resolve()

export async function importFleet(
  rawBody: string,
  options: { vaultPassword?: string; apply: boolean },
): Promise<DiffReport | ImportResult> {
  if (!options.apply) return runImportFleet(rawBody, options)
  const run = applyChain.then(() => runImportFleet(rawBody, options))
  // The chain only orders the runs: a failed run must not stop the next one, and its error goes to its own caller.
  applyChain = run.catch(() => undefined)
  return run
}

async function runImportFleet(
  rawBody: string,
  options: { vaultPassword?: string; apply: boolean },
): Promise<DiffReport | ImportResult> {
  // Auto-detect encrypted export: {"enc":1,"blob":"..."}
  // H2/M2: decrypt FIRST, before any file writes or DB commits (fail-fast on wrong password)
  let jsonBody: string
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed && typeof parsed === 'object' && parsed.enc === ENCRYPTED_FLEET_VERSION && typeof parsed.blob === 'string') {
      // Encrypted fleet -- password required
      if (!options.vaultPassword) {
        return { ...EMPTY_DIFF, errors: ['A fájl titkosítva van -- add meg a vault jelszót az importhoz.'] }
      }
      if (options.vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
        return { ...EMPTY_DIFF, errors: [`A vault jelszó legalább ${MIN_VAULT_PASSWORD_LEN} karakter kell legyen.`] }
      }
      try {
        jsonBody = decryptWithPassword(parsed.blob, options.vaultPassword)
      } catch {
        return { ...EMPTY_DIFF, errors: ['Helytelen vault jelszó -- a titkosított fájl nem dekódolható.'] }
      }
    } else {
      // Plaintext fleet JSON
      jsonBody = rawBody
    }
  } catch (err: any) {
    return { ...EMPTY_DIFF, errors: [`Érvénytelen JSON: ${err.message}`] }
  }

  // Denormalize paths in the entire JSON before any processing
  const fleet = JSON.parse(denormalizePaths(jsonBody)) as FleetJson

  const schemaErrors = validateSchema(fleet)
  if (schemaErrors.length > 0) {
    return { ...EMPTY_DIFF, errors: schemaErrors }
  }

  // B1: validate all names before dry-run or apply
  const nameErrors = validateNames(fleet)
  if (nameErrors.length > 0) {
    return { ...EMPTY_DIFF, errors: nameErrors }
  }

  if (!options.apply) {
    const report = await buildDiffReport(fleet)
    // M1: vault present in export but no password at import -> warning (apply would skip vault)
    if (fleet.vault && !options.vaultPassword) {
      report.warnings.push('vault szekció jelen van, de nem adtál meg jelszót -- a vault-titkok kihagyásra kerülnek.')
    }
    return report
  }

  // -------------------------------------------------------------------------
  // Apply phase -- two phases, so a failing import leaves nothing half applied
  // (the phases are described above stagedWrite())
  // -------------------------------------------------------------------------

  // Phase 0: decode and validate everything that is pure, before anything is written.
  const s = fleet.dashboardSettings ?? {}
  // One warnings list for the whole apply (the vault step and the identity takeover push onto it too).
  const applyWarnings: string[] = []

  // federation (system_config 'federation_config_json') -- whole-value replace via the raw setter, not a file write,
  // then an explicit cache invalidation (see invalidateFederationConfigCache()'s doc comment for why this bypass
  // needs one -- there is no cross-module file watch anymore to pick the change up on its own). Validated BEFORE
  // the write (same precedent as costBudgets/vault bindings below): an invalid source document must not silently
  // overwrite the target's own working federation config with something the fail-closed reader would then disable
  // on its very next read -- a booby-trapped import that "succeeds" but quietly kills the target's federation.
  // Skip the write, report a warning, leave the target's existing config untouched.
  let federationJson: string | null = null
  if (s.federation && Object.keys(s.federation).length) {
    const result = validateFederationConfig(s.federation)
    if (typeof result === 'string') {
      applyWarnings.push(`federáció: a forrás konfig érvénytelen (${result}) -- kihagyva, a célgép saját federációs beállításai megmaradtak.`)
    } else {
      federationJson = JSON.stringify(s.federation, null, 2)
    }
  }

  // costBudgets (cost_budgets) -- whole-value replace, not a file write. A possible `budgets` key inside
  // s.costopsConfig (an export taken before the budgets moved to the database, i.e. the old file-based format) is not read here --
  // that data is not lost, though: migrateCostBudgetsFromFile() (src/db/cost-budgets.ts, wired into
  // initDatabase()) picks it up ADDITIVELY (INSERT OR IGNORE) from costopsConfig's own file on the target's *next*
  // boot, same as any other install from before that move.
  //
  // An EMPTY array is deliberately NOT the same as "replace with nothing": it means either an old-format export
  // (this field genuinely absent) or a source fleet with zero configured budgets -- neither justifies wiping a
  // target's own already-configured budgets. Same Object.keys(...).length guard idiom as costopsConfig, just
  // array-shaped. A non-empty array IS still a full replace (P3 semantics, matching the old whole-file overwrite
  // this field replaced) -- but only after validateConfig() drops any malformed entry (missing id, non-number
  // amount), so one bad row in the source snapshot can't crash the write against cost_budgets' NOT NULL columns.
  let budgetsToReplace: BudgetEntry[] | null = null
  if (Array.isArray(s.costBudgets) && s.costBudgets.length > 0) {
    const { config: validatedConfig, errors: budgetErrors } = validateConfig({ budgets: s.costBudgets })
    // De-dup by id, first occurrence wins -- same "first wins" semantics as migrateCostBudgetsFromFile()'s
    // INSERT OR IGNORE. Without this, a duplicated id in the source snapshot hits cost_budgets'
    // PRIMARY KEY(id, tenant_id) and throws mid-write instead of the later duplicate being silently skipped.
    const seenIds = new Set<string>()
    const deduped: BudgetEntry[] = []
    let duplicateCount = 0
    for (const b of validatedConfig.budgets) {
      if (seenIds.has(b.id)) { duplicateCount++; continue }
      seenIds.add(b.id)
      deduped.push(b)
    }
    // The `s.costBudgets.length > 0` guard above only proves the SOURCE array was non-empty -- if every entry was
    // invalid (or every valid entry was a duplicate id), `deduped` can still be empty here. Applying the "don't
    // wipe on empty" guard to the raw source length would let a replaceCostBudgets('default', []) call through
    // in exactly that case, still wiping the target for reasons the source never actually asked for (nothing it
    // sent survived validation).
    if (deduped.length > 0) budgetsToReplace = deduped
    if (budgetErrors.length > 0) {
      applyWarnings.push(
        `costBudgets: ${budgetErrors.length} érvénytelen bejegyzés kimaradt az importból (${budgetErrors.join('; ')}).`
      )
    }
    if (duplicateCount > 0) {
      applyWarnings.push(
        `costBudgets: ${duplicateCount} duplikált id kimaradt (az első előfordulás nyert).`
      )
    }
    if (deduped.length === 0) {
      applyWarnings.push('costBudgets: egyetlen érvényes bejegyzés sem maradt validálás után -- a célgép saját budgetjei megmaradtak (nem törlődtek).')
    }
  } else if (Array.isArray(s.costBudgets)) {
    applyWarnings.push('costBudgets üres volt a forrás fájlban -- a célgép saját budgetjei megmaradtak (nem törlődtek).')
  }

  // Identity takeover: mirror the source identity set (name, brand, owner) into .env so the target install adopts
  // the source persona on next restart. Preference: use identity object (full set) if present; fall back to
  // agentId-only for exports produced before the identity field was added. Decided here, written in the last step.
  //
  // .env (via updateEnvFile below) is the ONLY identity-persistence path here since it was retired
  // config-overrides.json -- this used to also write a config-overrides.json, but cfg()'s boot-time identity
  // consumers (OWNER_NAME, BOT_NAME, BRAND_NAME, MAIN_AGENT_ID) read env['KEY'] directly, never cfg(), so that
  // write was already redundant with this .env mirror for every field that matters at boot. Shell-side launchers
  // -- above all scripts/channels.sh -- also read MAIN_AGENT_ID / CHANNEL_PROVIDER DIRECTLY from .env. Without
  // this mirror the main agent would launch under the pre-import identity (`${old-id}-channels`) while the
  // dashboard looks for `${new-id}-channels` and reports the main agent as down.
  const sourceIdentity = fleet.mainAgent?.identity
  const sourceAgentId = sourceIdentity?.MAIN_AGENT_ID ?? fleet.mainAgent?.agentId
  let envIdentity: Record<string, string> | null = null
  if (sourceAgentId && typeof sourceAgentId === 'string') {
    envIdentity = {}
    if (sourceIdentity && typeof sourceIdentity === 'object') {
      // Only the identity keys an export writes (FleetIdentity). The bundle is untrusted input and .env holds
      // credentials and endpoints (tokens, OTEL_* ...): any other key in `identity` is not copied.
      for (const key of FLEET_IDENTITY_ENV_KEYS) {
        const val = (sourceIdentity as unknown as Record<string, unknown>)[key]
        if (typeof val === 'string' && val.length > 0 && !/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(val)) envIdentity[key] = val
      }
    } else {
      envIdentity['MAIN_AGENT_ID'] = sourceAgentId
    }
  }

  const skillSeeds = skillSqlSeeds(fleet)

  const tracker: WriteTracker = { files: [], dirs: [] }
  const globalSkillsDir = join(homedir(), '.claude', 'skills')
  let vaultFiles: WriteEntry[] = []

  try {
    // Phase 1: stage the files. No final path changes here.
    // 0. Main agent files (PROJECT_ROOT level -- main agent persona, settings, channel pairing)
    if (fleet.mainAgent) {
      writeMainAgentFiles(fleet.mainAgent, tracker)
    }

    // 1. Sub-agent files
    for (const agent of fleet.agents ?? []) {
      writeAgentFiles(agent, tracker)
    }

    // 2. Global skills (their SQL rows are in the transaction below)
    trackedMkdir(globalSkillsDir, tracker)
    for (const skill of fleet.skills ?? []) {
      const skillDir = safeJoin(globalSkillsDir, skill.name)
      trackedMkdir(skillDir, tracker)
      stagedWrite(join(skillDir, 'SKILL.md'), skill.skillMd, tracker)
    }

    // 3. Scheduled tasks (all paused: enabled=false already set at export time)
    if (existsSync(SCHEDULED_TASKS_DIR) || fleet.scheduledTasks?.length) {
      trackedMkdir(SCHEDULED_TASKS_DIR, tracker)
    }
    for (const task of fleet.scheduledTasks ?? []) {
      const dir = safeJoin(SCHEDULED_TASKS_DIR, task.dirName)
      trackedMkdir(dir, tracker)
      if (task.skillMd) stagedWrite(join(dir, 'SKILL.md'), task.skillMd, tracker)
      stagedWrite(
        join(dir, 'task-config.json'),
        JSON.stringify({ ...task.config, enabled: false }, null, 2),
        tracker,
      )
    }

    // 4. Dashboard settings that are still files
    if (s.norbertPersonal && Object.keys(s.norbertPersonal).length)
      stagedWrite(join(STORE_DIR, 'norbert-personal.json'), JSON.stringify(s.norbertPersonal, null, 2), tracker)
    if (s.costopsConfig && Object.keys(s.costopsConfig).length)
      stagedWrite(join(STORE_DIR, 'costops-config.json'), JSON.stringify(s.costopsConfig, null, 2), tracker)

    // 5. Vault files (staged like the rest; renamed in the vault step after the commit)
    if (fleet.vault) {
      vaultFiles = stageVaultFiles(fleet.vault, tracker)
    }

    // Phase 2: ONE transaction holds every database write of the import -- the settings, the skill rows and the
    // per-row imports -- so a failure anywhere rolls all of it back. The body holds only `dbx` calls (the modules
    // below are on the facade, so each joins the ambient transaction and a nested one becomes a savepoint) and pure
    // row policy: no file I/O, no network, no timer, no LLM, no vault. The one exception to "only dbx" is
    // seedSkillIfAbsent(), which still writes on the raw connection: on the single SQLite connection that
    // statement runs inside the open transaction and is rolled back with it (docs/db-facade.md), which a test pins.
    // Rows are written in the same order the pre-transaction block used.
    const importTx = () => inFleetImportTransaction(async () => {
      // DB-backed -- upsert each imported row into autonomy_categories (not a file write). Upsert rather than
      // replace-all: a category that only exists on the target fleet (not in the imported snapshot) is left
      // untouched, consistent with the identity-takeover model not being destructive beyond what the source
      // snapshot actually describes.
      if (Array.isArray(s.autonomy)) {
        for (const row of s.autonomy) await upsertAutonomyCategory(row)
      }
      // Same upsert-not-replace rationale as autonomy above. upsertModelProfileMapEntry is write-through
      // (db/model-profile-map-cache.ts), so the cache is re-read after a rollback (reloadImportCaches()).
      if (Array.isArray(s.modelProfileMap)) {
        for (const row of s.modelProfileMap) await upsertModelProfileMapEntry(row)
      }
      // DB-backed (agent_settings) -- upsert per agent, same rationale as autonomy/modelProfileMap above.
      if (s.autoRestart) {
        for (const [agentId, cfg] of Object.entries(s.autoRestart)) await setAgentSetting(agentId, 'auto_restart', cfg)
      }
      // DB-backed (system_config 'agents_desired') -- whole-value replace. Array.isArray guards a pre-migration
      // snapshot that still has the old `{}` empty-object shape (nothing to import from that).
      if (Array.isArray(s.agentsDesired)) await setDesiredAgents(s.agentsDesired as string[])
      // DB-backed (system_config 'model_fallback_*') -- see the field-level doc comment on
      // writeModelFallbackFieldsRaw() for why this only sets the fields the source snapshot actually carries.
      if (s.modelFallback && Object.keys(s.modelFallback).length)
        await writeModelFallbackFieldsRaw(s.modelFallback as Partial<ModelFallbackConfig>)
      // DB-backed (system_config 'terminal_input_enabled') -- see readTerminalInputEnabledRaw()'s doc comment for
      // why an absent field must leave the target's current value untouched rather than defaulting it.
      if (typeof s.terminalInputEnabled === 'boolean') await writeTerminalInputEnabled(s.terminalInputEnabled)
      // federation: validated in phase 0; the cache is dropped after the commit (reloadImportCaches()).
      if (federationJson !== null) await setFederationConfigRaw(federationJson)
      // cost_budgets: validated and de-duplicated in phase 0.
      if (budgetsToReplace !== null) await replaceCostBudgets('default', budgetsToReplace)
      // egress_allowlist -- DB-backed (migration 0056), MERGE not overwrite (see DashboardSettingsExport doc):
      // INSERT OR IGNORE per row is the union semantics, same upsert-not-replace rationale as autonomy above.
      if (Array.isArray(s.egressAllowlist)) {
        await mergeEgressAllowlistEntries(s.egressAllowlist as EgressAllowlistRow[])
      }

      // The SQL side of the skill files staged above. A failure is the import's failure (it used to be logged and
      // swallowed, which let a file and its row drift apart).
      for (const seed of skillSeeds) seedSkillIfAbsent(seed)

      // The row-level policy (required fields, enums, forced values) lives here; the SQL itself is in
      // db/fleet-transfer.ts.
      // labels first (FK dep for kanban_card_labels)
      // M3: skip rows with missing required fields to avoid SQLite constraint errors -> 500
      await importFleetRows('labels', (fleet.kanban?.labels ?? []).filter((label) => {
        const l = label as any
        if (!l.id || !l.name || breaksTableRules(l, ['color', 'created_at'])) { logger.warn({ id: l.id }, 'Fleet import: skipping label with missing required fields'); return false }
        return true
      }))

      await importFleetRows('kanban_cards', (fleet.kanban?.cards ?? []).filter((card) => {
        const c = card as any
        if (!c.id || !c.title || !c.status || !c.priority || c.sort_order == null
          || breaksTableRules(c, ['created_at', 'updated_at'], {
            status: ['planned', 'in_progress', 'testing', 'waiting', 'done'],
            priority: ['low', 'normal', 'high', 'urgent'],
          })) {
          logger.warn({ id: c.id }, 'Fleet import: skipping kanban card with missing required fields'); return false
        }
        return true
      }))

      // kanban comments (idempotent: card_id + content)
      await importFleetRows('kanban_comments', (fleet.kanban?.comments ?? []).filter((comment) => {
        const c = comment as any
        return !!c.card_id && !!c.content
      }))

      // kanban card events -- idempotent on (card_id, created_at, to_status)
      await importFleetRows('kanban_card_events', (fleet.kanban?.cardEvents ?? []).filter((ev) => {
        const e = ev as any
        return !!e.card_id && !!e.to_status
      }))

      await importFleetRows('kanban_card_labels', (fleet.kanban?.cardLabels ?? []).filter((cl) => {
        const c = cl as any
        return !!c.card_id && !!c.label_id && c.created_at != null
      }))

      // schedules -- idempotent on id. Always imported disabled regardless of the
      // exported value (defense in depth -- mirrors the file-based scheduledTasks
      // pause-on-import above): a migrated fleet must never start firing a source
      // fleet's cron jobs unreviewed, e.g. under a different/missing agent name.
      const scheduleTenants = await enabledLocalTenantIds()
      const scheduleRows: Record<string, unknown>[] = []
      for (const sch of fleet.schedules ?? []) {
        const s = sch as any
        if (!s.id || !s.schedule || !s.agent || !s.type
          || breaksTableRules(s, [], { type: ['task', 'heartbeat', 'command'] })) {
          logger.warn({ id: s.id }, 'Fleet import: skipping schedule with missing required fields'); continue
        }
        scheduleRows.push({
          ...s,
          prompt: s.prompt ?? '', description: s.description ?? '', enabled: 0,
          tenant_id: importedScheduleTenant(scheduleTenants, s.tenant_id),
          skip_if_busy: s.skip_if_busy ?? 0, force_send: s.force_send ?? 0,
        })
      }
      await importFleetRows('schedules', scheduleRows)

      // import_sources -- idempotent on id. Always imported disabled with
      // last_run_at cleared, regardless of the exported values (defense in
      // depth, mirrors schedules above): the crawled content itself was never
      // exported, so a preserved last_run_at would make the next run treat
      // itself as incremental and silently skip everything the target doesn't
      // actually have. vault_token_ref is carried over as-is (just the vault
      // entry id); re-enabling still requires that entry to exist on this
      // machine (enforced by the route layer, not by this raw insert).
      const importSourceRows: Record<string, unknown>[] = []
      for (const src of fleet.importSources ?? []) {
        const s = src as any
        if (!s.id || !s.type || !s.path
          || breaksTableRules(s, ['created_at', 'updated_at'], { type: ['local', 'gdrive', 'sharepoint', 'confluence'] })) {
          logger.warn({ id: s.id }, 'Fleet import: skipping import source with missing required fields'); continue
        }
        importSourceRows.push({
          ...s,
          interval_hours: s.interval_hours ?? 4, enabled: 0, last_run_at: null,
          tenant_id: s.tenant_id ?? 'default',
        })
      }
      await importFleetRows('import_sources', importSourceRows)

      // vault_ssh_keys -- idempotent on id. Metadata only (no private key column);
      // inserted before vault_ssh_servers below since a server's ssh_key_id refers
      // to it (foreign_keys is on for this connection, so the insert order matters:
      // keys before servers).
      await importFleetRows('vault_ssh_keys', (fleet.vaultSshKeys ?? []).filter((key) => {
        const k = key as any
        if (!k.id || !k.label || !k.username || !k.vault_key_id || !k.public_key || !k.fingerprint || !k.key_type
          || breaksTableRules(k, ['created_at'])) {
          logger.warn({ id: k.id }, 'Fleet import: skipping SSH key with missing required fields'); return false
        }
        return true
      }).map((key) => ({ ...(key as any), tenant_id: (key as any).tenant_id ?? 'default' })))

      // vault_ssh_servers -- idempotent on id.
      await importFleetRows('vault_ssh_servers', (fleet.vaultSshServers ?? []).filter((srv) => {
        const s2 = srv as any
        if (!s2.id || !s2.name || !s2.host || !s2.username || breaksTableRules(s2, ['created_at', 'updated_at'])) {
          logger.warn({ id: s2.id }, 'Fleet import: skipping SSH server with missing required fields'); return false
        }
        return true
      }).map((srv) => ({ ...(srv as any), port: (srv as any).port ?? 22, tenant_id: (srv as any).tenant_id ?? 'default' })))

      // memories -- idempotent on (agent_id, content); covers ALL agent_ids
      // agent_id-k pontosan a forrásból kerülnek át (a cél átveszi a forrás főagent identitását)
      const now = Math.floor(Date.now() / 1000)
      await importFleetRows('memories', (fleet.memories ?? []).map((mem) => ({
        ...mem, chat_id: '', accessed_at: mem.accessed_at ?? now, auto_generated: mem.auto_generated ?? 0,
      })))

      // daily logs -- idempotent on (agent_id, date, content); multiple rows per date are preserved
      await importFleetRows('daily_logs', fleet.dailyLogs ?? [])

      // idea_box -- idempotent on id
      await importFleetRows('idea_box', (fleet.ideaBox?.ideas ?? []).filter((idea) => {
        const i = idea as any
        if (!i.id || breaksTableRules(i, ['title', 'category', 'created_at', 'updated_at'], { status: ['new', 'reviewed', 'kanban', 'rejected'] })) {
          logger.warn({ id: i.id }, 'Fleet import: skipping idea with missing required fields'); return false
        }
        return true
      }).map((idea) => ({ ...(idea as any), source: (idea as any).source ?? '' })))

      // idea_comments -- M5: idempotent on (idea_id, created_at, content)
      await importFleetRows('idea_comments', fleet.ideaBox?.comments ?? [])

      // idea_status_log -- M5: idempotent on (idea_id, created_at, to_status)
      await importFleetRows('idea_status_log', fleet.ideaBox?.statusLog ?? [])

      // FTS rebuild after all memory inserts
      await rebuildMemoriesFts()
    })

    await importTx()
  } catch (err: any) {
    // Failure in phase 1 or 2: no final path was touched and the transaction (if it ran) rolled back, so the staged
    // files go and the caches are re-read. The write-through caches may have shown the new values inside the
    // transaction and keep them after the rollback.
    discardStaged(tracker)
    reloadImportCachesQuietly()
    logger.error({ err: err.message }, 'Fleet import failed, nothing applied, staged files removed')
    throw err
  }

  // Phase 3: the database is committed. Put the files in place, then the caches, then the vault, then .env (the
  // vault and .env stay last, as before). A failure here cannot roll the database back: the files are restored
  // from their backups instead, and the error says that the database changes remain.
  try {
    finalizeStaged(tracker.files.filter((e) => !vaultFiles.includes(e)))
    reloadImportCaches()

    // 6. Vault -- LAST: vault data is plaintext (decrypted at the top of importFleet)
    if (fleet.vault) {
      await importVaultSection(fleet.vault, vaultFiles, applyWarnings)
    }

    // Identity takeover (decided in phase 0): the .env mirror is the very last step.
    if (envIdentity !== null) {
      updateEnvFile(envIdentity)

      applyWarnings.push(
        `Fő-agent identitás átvéve: ${sourceAgentId}. Újraindítás kell hogy a dashboard ${sourceAgentId}-ként induljon.`
      )
    }
  } catch (err: any) {
    const notRestored = restoreFinalized(tracker)
    logger.error({ err: err.message, notRestored }, 'Fleet import: the database was committed but finishing the files failed')
    throw new Error(
      `Fleet import: the database changes were committed and stay in place, but applying the files failed (${err.message}). ` +
      (notRestored.length === 0
        ? 'The files were restored from their .import-bak backups.'
        : `These files could not be restored, take them from their .import-bak backups: ${notRestored.join(', ')}.`),
      { cause: err },
    )
  }

  dropBackups(tracker)

  // M3: fire-and-forget re-embed imported memories (embedding was stripped at export)
  backfillEmbeddings().catch(err => logger.warn({ err: err?.message }, 'Fleet import: embedding backfill failed'))

  logger.info({ agents: (fleet.agents ?? []).map(a => a.name) }, 'Fleet import completed')

  return {
    ok: true,
    imported: {
      mainAgent: !!fleet.mainAgent,
      agents: (fleet.agents ?? []).map(a => a.name),
      globalSkills: (fleet.skills ?? []).length,
      scheduledTasks: (fleet.scheduledTasks ?? []).length,
      memories: (fleet.memories ?? []).length,
      kanbanCards: (fleet.kanban?.cards ?? []).length,
      labels: (fleet.kanban?.labels ?? []).length,
      dailyLogs: (fleet.dailyLogs ?? []).length,
      ideaBox: (fleet.ideaBox?.ideas ?? []).length,
      schedules: (fleet.schedules ?? []).length,
      importSources: (fleet.importSources ?? []).length,
      vaultSshKeys: (fleet.vaultSshKeys ?? []).length,
      vaultSshServers: (fleet.vaultSshServers ?? []).length,
    },
    ...(applyWarnings.length > 0 ? { warnings: applyWarnings } : {}),
  }
}
