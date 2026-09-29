// Fleet export / import.
//
// Builds a single portable JSON snapshot of fleet content (agents, skills,
// scheduled tasks, DB tables, dashboard settings, optional vault) so it can
// be loaded into a freshly-installed, clean-git dashboard on another machine.
//
// Source code, build artefacts, OAuth tokens, and machine-specific paths are
// NOT included -- those come from a normal `npm ci && npm run build` install.

import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync,
} from 'node:fs'
import { join, extname } from 'node:path'
import { homedir, hostname } from 'node:os'
import {
  randomBytes, createCipheriv, createDecipheriv, scryptSync,
} from 'node:crypto'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID, BOT_NAME, BRAND_NAME, OWNER_NAME, CHANNEL_PROVIDER } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { updateEnvFile } from '../env.js'
import { AGENTS_BASE_DIR, listAgentNames, invalidateModelProfileMapCache } from './agent-config.js'
import { safeJoin } from './sanitize.js'
import { SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { getBindings } from './vault-bindings.js'
import { getDb, backfillEmbeddings, listAllSkills, seedSkillIfAbsent, listAutonomyCategories, upsertAutonomyCategory, type AutonomyCategoryRow, listModelProfileMap, upsertModelProfileMapEntry, type ModelProfileMapRow, listEgressAllowlistRows, mergeEgressAllowlistEntries, type EgressAllowlistRow, listAgentSettingsByKey, setAgentSetting } from '../db.js'
import { getDesiredAgents, setDesiredAgents } from './agent-desired-state.js'
import { readModelFallbackFieldsRaw, writeModelFallbackFieldsRaw } from './model-fallback-store.js'
import type { ModelFallbackConfig } from '../model-fallback.js'
import { readTerminalInputEnabledRaw, writeTerminalInputEnabled } from './terminal-input-store.js'
import { listCostBudgets, replaceCostBudgets } from '../db/cost-budgets.js'
import { validateConfig, type BudgetEntry } from '../costops/config.js'
import { listVaultBindings, replaceVaultBindings, type VaultBinding } from '../db/vault-bindings.js'
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
function buildBindingLookup(): Map<string, Map<string, Map<string, string>>> {
  const lookup = new Map<string, Map<string, Map<string, string>>>()
  for (const binding of getBindings()) {
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

function exportDashboardSettings(): DashboardSettingsExport {
  const read = (name: string) => safeReadJson(join(STORE_DIR, name))
  return {
    autonomy: listAutonomyCategories(),
    modelProfileMap: listModelProfileMap(),
    autoRestart: listAgentSettingsByKey('auto_restart'),
    agentsDesired: [...getDesiredAgents()].sort(),
    norbertPersonal: read('norbert-personal.json'),
    modelFallback: readModelFallbackFieldsRaw(),
    federation: readFederationConfigObjectRaw(),
    costopsConfig: read('costops-config.json'),
    costBudgets: listCostBudgets('default'),
    egressAllowlist: listEgressAllowlistRows(null),
    terminalInputEnabled: readTerminalInputEnabledRaw(),
  }
}

function exportVault(): VaultExport | null {
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
  const bindings = listVaultBindings('default') as unknown as Record<string, unknown>[]

  // Channel .env (bot tokens) are intentionally NOT exported -- see re-pair model comment in VaultExport.
  return { vaultKey, entries, bindings }
}

// Encrypted export wrapper: {"enc":1,"blob":"<base64-of-encrypted-fleet-json>"}
// The enc field signals the import side to decrypt before parsing.
export const ENCRYPTED_FLEET_VERSION = 1

export type ExportedFleet = { data: string; exportedAt: string }

export function exportFleet(options: { vaultPassword?: string } = {}): ExportedFleet {
  if (options.vaultPassword !== undefined && options.vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
    throw new Error(`A vault jelszó legalább ${MIN_VAULT_PASSWORD_LEN} karakter kell legyen.`)
  }

  const withSecrets = !!options.vaultPassword
  const db = getDb()
  const bindingLookup = withSecrets ? new Map() : buildBindingLookup()

  const mainAgent = exportMainAgent(bindingLookup, withSecrets)
  const agents = listAgentNames().map(name => exportAgent(name, bindingLookup, withSecrets))
  const skills = listGlobalSkillsFromSQL()
  const scheduledTasks = exportScheduledTasks()

  // Export ALL memories and daily_logs across every agent_id
  const memories = db.prepare(
    `SELECT agent_id, content, sector, salience, created_at, accessed_at,
            category, auto_generated, keywords
     FROM memories ORDER BY agent_id ASC, created_at ASC`
  ).all() as MemoryRow[]

  const dailyLogs = db.prepare(
    'SELECT agent_id, date, content, created_at FROM daily_logs ORDER BY agent_id ASC, date ASC'
  ).all() as DailyLogRow[]

  const kanban: KanbanExport = {
    cards: db.prepare('SELECT * FROM kanban_cards').all() as Record<string, unknown>[],
    comments: db.prepare('SELECT * FROM kanban_comments').all() as Record<string, unknown>[],
    cardEvents: db.prepare('SELECT * FROM kanban_card_events').all() as Record<string, unknown>[],
    labels: db.prepare('SELECT * FROM labels').all() as Record<string, unknown>[],
    cardLabels: db.prepare('SELECT * FROM kanban_card_labels').all() as Record<string, unknown>[],
  }

  const ideaBox: IdeaBoxExport = {
    ideas: db.prepare('SELECT * FROM idea_box').all() as Record<string, unknown>[],
    comments: db.prepare('SELECT * FROM idea_comments').all() as Record<string, unknown>[],
    statusLog: db.prepare('SELECT * FROM idea_status_log').all() as Record<string, unknown>[],
  }

  // DB-based schedules (dashboard-schedule-crud API), distinct from the file-based
  // scheduledTasks[] above. Force-disabled at export time, same as scheduledTasks,
  // so an imported fleet never starts firing a source fleet's cron jobs unreviewed.
  const schedules = (db.prepare('SELECT * FROM schedules').all() as Record<string, unknown>[])
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
  const importSources = (db.prepare('SELECT * FROM import_sources').all() as Record<string, unknown>[])
    .map(row => ({ ...row, enabled: 0, last_run_at: null }))

  // SSH key-pool metadata (P4). Neither table has a private-key column -- the
  // actual private key material lives as a generic vault secret keyed by
  // vault_key_id, and is included ONLY when the vault section below is (i.e.
  // only in an encrypted, password-protected export). This metadata alone is
  // safe in plaintext: public key, fingerprint, host/port/username, no secret.
  const vaultSshKeys = db.prepare('SELECT * FROM vault_ssh_keys').all() as Record<string, unknown>[]
  const vaultSshServers = db.prepare('SELECT * FROM vault_ssh_servers').all() as Record<string, unknown>[]

  // Vault section is only included in encrypted exports (whole-JSON encryption makes it safe)
  const vault = withSecrets ? exportVault() : undefined

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
    dashboardSettings: exportDashboardSettings(),
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

function buildDiffReport(fleet: FleetJson): DiffReport {
  const db = getDb()
  const warnings: string[] = []

  const existingAgents = new Set(listAgentNames())
  const newAgents = (fleet.agents ?? []).map(a => a.name).filter(n => !existingAgents.has(n))

  let newMemories = 0
  for (const mem of fleet.memories ?? []) {
    if (!db.prepare('SELECT 1 FROM memories WHERE agent_id = ? AND content = ?').get(mem.agent_id, mem.content)) {
      newMemories++
    }
  }

  let newCards = 0
  for (const card of fleet.kanban?.cards ?? []) {
    if (!db.prepare('SELECT 1 FROM kanban_cards WHERE id = ?').get((card as any).id)) newCards++
  }

  let newLabels = 0
  for (const label of fleet.kanban?.labels ?? []) {
    if (!db.prepare('SELECT 1 FROM labels WHERE id = ?').get((label as any).id)) newLabels++
  }

  let newDailyLogs = 0
  for (const log of fleet.dailyLogs ?? []) {
    if (!db.prepare('SELECT 1 FROM daily_logs WHERE agent_id = ? AND date = ? AND content = ?').get(log.agent_id, log.date, log.content)) {
      newDailyLogs++
    }
  }

  let newComments = 0
  for (const c of fleet.kanban?.comments ?? []) {
    if (!db.prepare('SELECT 1 FROM kanban_comments WHERE card_id = ? AND content = ?')
      .get((c as any).card_id, (c as any).content)) newComments++
  }

  let newSchedules = 0
  for (const sch of fleet.schedules ?? []) {
    if (!db.prepare('SELECT 1 FROM schedules WHERE id = ?').get((sch as any).id)) newSchedules++
  }
  if (newSchedules > 0) {
    warnings.push(`${newSchedules} ütemezés importálva -- letiltva érkezik, kézi átvizsgálás és engedélyezés szükséges célgépen.`)
  }

  let newImportSources = 0
  for (const src of fleet.importSources ?? []) {
    if (!db.prepare('SELECT 1 FROM import_sources WHERE id = ?').get((src as any).id)) newImportSources++
  }
  if (newImportSources > 0) {
    warnings.push(
      `${newImportSources} import-forrás importálva -- letiltva érkezik, a tartalom (import_memories) nem került át. ` +
      `A vault_token_ref-ek csak akkor engedélyezhetők újra, ha a hivatkozott vault-bejegyzés a célgépen is létezik.`
    )
  }

  let newVaultSshKeys = 0
  for (const key of fleet.vaultSshKeys ?? []) {
    if (!db.prepare('SELECT 1 FROM vault_ssh_keys WHERE id = ?').get((key as any).id)) newVaultSshKeys++
  }
  let newVaultSshServers = 0
  for (const srv of fleet.vaultSshServers ?? []) {
    if (!db.prepare('SELECT 1 FROM vault_ssh_servers WHERE id = ?').get((srv as any).id)) newVaultSshServers++
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
// Apply helpers -- tracked writes for partial cleanup (H3)
// ---------------------------------------------------------------------------

interface WriteEntry {
  path: string
  preexisted: boolean
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

function trackedWrite(path: string, content: string | Buffer, tracker: WriteTracker, opts?: { mode?: number }): void {
  const preexisted = existsSync(path)
  atomicWriteFileSync(path, content as string, opts)
  tracker.files.push({ path, preexisted })
}

function cleanupTracked(tracker: WriteTracker): void {
  // Only delete files that did not exist before the import started; pre-existing overwritten files
  // cannot be restored (no backup), so we leave them rather than delete them (H3).
  for (const { path, preexisted } of tracker.files) {
    if (!preexisted) {
      try { unlinkSync(path) } catch { /* best effort */ }
    }
  }
  // Remove dirs in reverse order (deepest first), only if empty
  for (const d of [...tracker.dirs].reverse()) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function writeMainAgentFiles(ma: MainAgentExport, tracker: WriteTracker): void {
  const claudeDir = join(PROJECT_ROOT, '.claude')
  trackedMkdir(claudeDir, tracker)

  if (ma.claudeMd) trackedWrite(join(PROJECT_ROOT, 'CLAUDE.md'), ma.claudeMd, tracker)
  if (ma.soulMd) trackedWrite(join(PROJECT_ROOT, 'SOUL.md'), ma.soulMd, tracker)
  if (ma.config && Object.keys(ma.config).length)
    trackedWrite(join(PROJECT_ROOT, 'agent-config.json'), JSON.stringify(ma.config, null, 2), tracker)
  trackedWrite(join(PROJECT_ROOT, '.mcp.json'), JSON.stringify(deplaceholderMcp(ma.mcp), null, 2), tracker)
  trackedWrite(join(claudeDir, 'settings.json'), JSON.stringify(ma.settings, null, 2), tracker)

  // Main agent channel access: ~/.claude/channels/<provider>/access.json
  // B1: provider names validated by validateNames() before this is called
  const channelsBase = join(homedir(), '.claude', 'channels')
  for (const [provider, access] of Object.entries(ma.channelsAccess ?? {})) {
    const provDir = safeJoin(channelsBase, provider)
    trackedMkdir(provDir, tracker)
    trackedWrite(join(provDir, 'access.json'), JSON.stringify(access, null, 2), tracker)
  }
}

function writeAgentFiles(agent: AgentExport, tracker: WriteTracker): void {
  // B1: names already validated by validateNames() before this is called
  const dir = safeJoin(AGENTS_BASE_DIR, agent.name)
  const claudeDir = safeJoin(dir, '.claude')
  trackedMkdir(claudeDir, tracker)

  trackedWrite(join(dir, 'agent-config.json'), JSON.stringify(agent.config, null, 2), tracker)
  if (agent.claudeMd) trackedWrite(join(dir, 'CLAUDE.md'), agent.claudeMd, tracker)
  if (agent.soulMd) trackedWrite(join(dir, 'SOUL.md'), agent.soulMd, tracker)

  // .mcp.json: de-placeholder vault refs (path denormalization happens at fleet level)
  trackedWrite(join(dir, '.mcp.json'), JSON.stringify(deplaceholderMcp(agent.mcp), null, 2), tracker)

  trackedWrite(join(claudeDir, 'settings.json'), JSON.stringify(agent.settings, null, 2), tracker)

  for (const [provider, access] of Object.entries(agent.channelsAccess ?? {})) {
    const provDir = safeJoin(claudeDir, 'channels', provider)
    trackedMkdir(provDir, tracker)
    trackedWrite(join(provDir, 'access.json'), JSON.stringify(access, null, 2), tracker)
  }

  if (agent.avatar) {
    // B1: whitelist extension to prevent path traversal via malicious avatarExt
    const ext = /^(png|jpe?g|webp)$/i.test(String(agent.avatarExt || '')) ? String(agent.avatarExt) : 'png'
    trackedWrite(safeJoin(dir, `avatar.${ext}`), Buffer.from(agent.avatar, 'base64'), tracker)
  }

  for (const skill of agent.agentSkills ?? []) {
    const skillDir = safeJoin(claudeDir, 'skills', skill.name)
    trackedMkdir(skillDir, tracker)
    trackedWrite(join(skillDir, 'SKILL.md'), skill.skillMd, tracker)
    // Dual-write into SQL (the source of truth) alongside the file the Claude
    // Code loader needs -- mirrors the existing zip-import precedent
    // (routes/skills.ts). Unconditional, not gated by SKILL_SQL_REGEN: a fresh
    // install may still have the kill-switch off, and the loader needs the
    // file regardless, so this can't rely on regen to materialize it.
    try {
      seedSkillIfAbsent({
        id: `agent/${agent.name}/${skill.name}`,
        name: skill.name,
        description: extractSkillDescription(skill.skillMd),
        content: skill.skillMd,
        tenant_id: 'fleet',
        is_global: false,
      })
    } catch (sqlErr) {
      logger.warn({ agent: agent.name, skill: skill.name, err: sqlErr }, 'Fleet import: failed to upsert agent skill into SQL')
    }
  }
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
function importVaultSection(vault: VaultExport, tracker: WriteTracker, warnings: string[]): void {
  // vault.vaultKey is plaintext -- the caller already decrypted the whole JSON with the user password
  trackedWrite(join(STORE_DIR, '.vault-key'), vault.vaultKey, tracker, { mode: 0o600 })
  trackedWrite(join(STORE_DIR, 'vault.json'), JSON.stringify({ entries: vault.entries }, null, 2), tracker, { mode: 0o600 })
  // Channel .env (bot tokens) are intentionally NOT imported -- target must re-pair channels manually.

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
    replaceVaultBindings('default', deduped)
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

export function importFleet(
  rawBody: string,
  options: { vaultPassword?: string; apply: boolean },
): DiffReport | ImportResult {
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
    const report = buildDiffReport(fleet)
    // M1: vault present in export but no password at import -> warning (apply would skip vault)
    if (fleet.vault && !options.vaultPassword) {
      report.warnings.push('vault szekció jelen van, de nem adtál meg jelszót -- a vault-titkok kihagyásra kerülnek.')
    }
    return report
  }

  // -------------------------------------------------------------------------
  // Apply phase -- H3: track ALL writes, cleanup on any failure
  // -------------------------------------------------------------------------
  const db = getDb()
  const tracker: WriteTracker = { files: [], dirs: [] }
  const globalSkillsDir = join(homedir(), '.claude', 'skills')

  try {
    // 0. Main agent files (PROJECT_ROOT level -- main agent persona, settings, channel pairing)
    if (fleet.mainAgent) {
      writeMainAgentFiles(fleet.mainAgent, tracker)
    }

    // 1. Sub-agent files
    for (const agent of fleet.agents ?? []) {
      writeAgentFiles(agent, tracker)
    }

    // 2. Global skills
    trackedMkdir(globalSkillsDir, tracker)
    for (const skill of fleet.skills ?? []) {
      const skillDir = safeJoin(globalSkillsDir, skill.name)
      trackedMkdir(skillDir, tracker)
      trackedWrite(join(skillDir, 'SKILL.md'), skill.skillMd, tracker)
      // Dual-write into SQL -- see the matching comment in writeAgentFiles().
      try {
        seedSkillIfAbsent({
          id: `global/${skill.name}`,
          name: skill.name,
          description: extractSkillDescription(skill.skillMd),
          content: skill.skillMd,
          tenant_id: 'fleet',
          is_global: true,
        })
      } catch (sqlErr) {
        logger.warn({ skill: skill.name, err: sqlErr }, 'Fleet import: failed to upsert global skill into SQL')
      }
    }

    // 3. Scheduled tasks (all paused: enabled=false already set at export time)
    if (existsSync(SCHEDULED_TASKS_DIR) || fleet.scheduledTasks?.length) {
      trackedMkdir(SCHEDULED_TASKS_DIR, tracker)
    }
    for (const task of fleet.scheduledTasks ?? []) {
      const dir = safeJoin(SCHEDULED_TASKS_DIR, task.dirName)
      trackedMkdir(dir, tracker)
      if (task.skillMd) trackedWrite(join(dir, 'SKILL.md'), task.skillMd, tracker)
      trackedWrite(
        join(dir, 'task-config.json'),
        JSON.stringify({ ...task.config, enabled: false }, null, 2),
        tracker,
      )
    }

    // 4. Dashboard settings
    const s = fleet.dashboardSettings ?? {}
    // Declared here (not down by the main-agent-identity block below) so the
    // costBudgets validation warning further down can also push onto it --
    // same array, one warnings list for the whole apply.
    const applyWarnings: string[] = []
    // DB-backed -- upsert each imported row into autonomy_categories
    // (not a file write). Upsert rather than replace-all: a category that
    // only exists on the target fleet (not in the imported snapshot) is left
    // untouched, consistent with the identity-takeover model not being
    // destructive beyond what the source snapshot actually describes.
    if (Array.isArray(s.autonomy)) {
      for (const row of s.autonomy) upsertAutonomyCategory(row)
    }
    // Same upsert-not-replace rationale as autonomy above.
    if (Array.isArray(s.modelProfileMap)) {
      for (const row of s.modelProfileMap) upsertModelProfileMapEntry(row)
      invalidateModelProfileMapCache()
    }
    // DB-backed (agent_settings) -- upsert per agent, same
    // rationale as autonomy/modelProfileMap above, not a file write.
    if (s.autoRestart) {
      for (const [agentId, cfg] of Object.entries(s.autoRestart)) setAgentSetting(agentId, 'auto_restart', cfg)
    }
    // DB-backed (system_config 'agents_desired') -- whole-value replace, not a
    // file write. Array.isArray guards a pre-migration snapshot that still has
    // the old `{}` empty-object shape (nothing to import from that).
    if (Array.isArray(s.agentsDesired)) setDesiredAgents(s.agentsDesired as string[])
    if (s.norbertPersonal && Object.keys(s.norbertPersonal).length)
      trackedWrite(join(STORE_DIR, 'norbert-personal.json'), JSON.stringify(s.norbertPersonal, null, 2), tracker)
    // DB-backed (system_config 'model_fallback_*') -- see the field-level doc
    // comment on writeModelFallbackFieldsRaw() for why this only sets the
    // fields the source snapshot actually carries, not a file write.
    if (s.modelFallback && Object.keys(s.modelFallback).length)
      writeModelFallbackFieldsRaw(s.modelFallback as Partial<ModelFallbackConfig>)
    // DB-backed (system_config 'terminal_input_enabled') -- see
    // readTerminalInputEnabledRaw()'s doc comment for why an absent field must
    // leave the target's current value untouched rather than defaulting it.
    if (typeof s.terminalInputEnabled === 'boolean') writeTerminalInputEnabled(s.terminalInputEnabled)
    // DB-backed (system_config 'federation_config_json') -- whole-value
    // replace via the raw setter, not a file write, then an explicit cache
    // invalidation (see invalidateFederationConfigCache()'s doc comment for
    // why this bypass needs one -- there is no cross-module file watch
    // anymore to pick the change up on its own). Validated BEFORE the write
    // (same #524/#526 precedent as costBudgets/vault bindings below): an
    // invalid source document must not silently overwrite the target's own
    // working federation config with something the fail-closed reader would
    // then disable on its very next read -- a booby-trapped import that
    // "succeeds" but quietly kills the target's federation. Skip the write,
    // report a warning, leave the target's existing config untouched.
    if (s.federation && Object.keys(s.federation).length) {
      const result = validateFederationConfig(s.federation)
      if (typeof result === 'string') {
        applyWarnings.push(`federáció: a forrás konfig érvénytelen (${result}) -- kihagyva, a célgép saját federációs beállításai megmaradtak.`)
      } else {
        setFederationConfigRaw(JSON.stringify(s.federation, null, 2))
        invalidateFederationConfigCache()
      }
    }
    if (s.costopsConfig && Object.keys(s.costopsConfig).length)
      trackedWrite(join(STORE_DIR, 'costops-config.json'), JSON.stringify(s.costopsConfig, null, 2), tracker)
    // DB-backed (cost_budgets) -- whole-value replace, not a file write. A
    // possible `budgets` key inside s.costopsConfig (an export taken before
    // #985 group 6/8, i.e. the old file-based format) is not read here --
    // that data is not lost, though: migrateCostBudgetsFromFile()
    // (src/db/cost-budgets.ts, wired into initDatabase()) picks it up
    // ADDITIVELY (INSERT OR IGNORE) from costopsConfig's own file write just
    // above on the target's *next* boot, same as any other pre-#985 install.
    //
    // An EMPTY array is deliberately NOT the same as "replace with nothing":
    // it means either an old-format export (this field genuinely absent) or
    // a source fleet with zero configured budgets -- neither justifies
    // wiping a target's own already-configured budgets. Same
    // Object.keys(...).length guard idiom as costopsConfig above, just
    // array-shaped. A non-empty array IS still a full replace (P3 semantics,
    // matching the old whole-file overwrite this field replaced) -- but only
    // after validateConfig() drops any malformed entry (missing id,
    // non-number amount), so one bad row in the source snapshot can't crash
    // the write against cost_budgets' NOT NULL columns.
    if (Array.isArray(s.costBudgets) && s.costBudgets.length > 0) {
      const { config: validatedConfig, errors: budgetErrors } = validateConfig({ budgets: s.costBudgets })
      // De-dup by id, first occurrence wins -- same "first wins" semantics
      // as migrateCostBudgetsFromFile()'s INSERT OR IGNORE. Without this, a
      // duplicated id in the source snapshot hits cost_budgets'
      // PRIMARY KEY(id, tenant_id) and throws mid-write instead of the later
      // duplicate being silently skipped.
      const seenIds = new Set<string>()
      const deduped: BudgetEntry[] = []
      let duplicateCount = 0
      for (const b of validatedConfig.budgets) {
        if (seenIds.has(b.id)) { duplicateCount++; continue }
        seenIds.add(b.id)
        deduped.push(b)
      }
      // The `s.costBudgets.length > 0` guard above only proves the SOURCE
      // array was non-empty -- if every entry was invalid (or every valid
      // entry was a duplicate id), `deduped` can still be empty here.
      // Applying the "don't wipe on empty" guard to the raw source length
      // would let a replaceCostBudgets('default', []) call through in
      // exactly that case, still wiping the target for reasons the source
      // never actually asked for (nothing it sent survived validation).
      if (deduped.length > 0) {
        replaceCostBudgets('default', deduped)
      }
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
    // egress_allowlist -- DB-backed (migration 0056), MERGE not overwrite (see
    // DashboardSettingsExport doc): INSERT OR IGNORE per row is the union
    // semantics, same upsert-not-replace rationale as autonomy above.
    if (Array.isArray(s.egressAllowlist)) {
      mergeEgressAllowlistEntries(s.egressAllowlist as EgressAllowlistRow[])
    }

    // 5. DB -- single transaction (H3: before vault so vault is last and cleanup is cleaner)
    const importTx = db.transaction(() => {
      // labels first (FK dep for kanban_card_labels)
      // M3: skip rows with missing required fields to avoid SQLite constraint errors -> 500
      for (const label of fleet.kanban?.labels ?? []) {
        const l = label as any
        if (!l.id || !l.name) { logger.warn({ id: l.id }, 'Fleet import: skipping label with missing required fields'); continue }
        db.prepare('INSERT OR IGNORE INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)')
          .run(l.id, l.name, l.color, l.created_at)
      }

      for (const card of fleet.kanban?.cards ?? []) {
        const c = card as any
        if (!c.id || !c.title || !c.status || !c.priority || c.sort_order == null) {
          logger.warn({ id: c.id }, 'Fleet import: skipping kanban card with missing required fields'); continue
        }
        db.prepare(
          `INSERT OR IGNORE INTO kanban_cards
           (id, title, description, status, assignee, priority, project,
            due_date, sort_order, created_at, updated_at, archived_at, parent_id, dispatched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(c.id, c.title, c.description ?? null, c.status, c.assignee ?? null,
          c.priority, c.project ?? null, c.due_date ?? null, c.sort_order,
          c.created_at, c.updated_at, c.archived_at ?? null, c.parent_id ?? null, c.dispatched_at ?? null)
      }

      // kanban comments (idempotent: card_id + content)
      for (const comment of fleet.kanban?.comments ?? []) {
        const c = comment as any
        if (!c.card_id || !c.content) continue
        if (!db.prepare('SELECT 1 FROM kanban_comments WHERE card_id = ? AND content = ?').get(c.card_id, c.content)) {
          db.prepare('INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)')
            .run(c.card_id, c.author, c.content, c.created_at)
        }
      }

      // kanban card events -- idempotent on (card_id, created_at, to_status)
      for (const ev of fleet.kanban?.cardEvents ?? []) {
        const e = ev as any
        if (!e.card_id || !e.to_status) continue
        if (!db.prepare('SELECT 1 FROM kanban_card_events WHERE card_id = ? AND created_at = ? AND to_status = ?')
          .get(e.card_id, e.created_at, e.to_status)) {
          db.prepare('INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(e.card_id, e.from_status ?? null, e.to_status, e.actor, e.created_at)
        }
      }

      for (const cl of fleet.kanban?.cardLabels ?? []) {
        const c = cl as any
        if (!c.card_id || !c.label_id) continue
        db.prepare('INSERT OR IGNORE INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?)')
          .run(c.card_id, c.label_id, c.created_at)
      }

      // schedules -- idempotent on id. Always imported disabled regardless of the
      // exported value (defense in depth -- mirrors the file-based scheduledTasks
      // pause-on-import above): a migrated fleet must never start firing a source
      // fleet's cron jobs unreviewed, e.g. under a different/missing agent name.
      for (const sch of fleet.schedules ?? []) {
        const s = sch as any
        if (!s.id || !s.schedule || !s.agent || !s.type) {
          logger.warn({ id: s.id }, 'Fleet import: skipping schedule with missing required fields'); continue
        }
        db.prepare(
          `INSERT OR IGNORE INTO schedules
           (id, prompt, description, schedule, agent, type, enabled, tenant_id, skip_if_busy,
            force_send, target_session, command, timeout_ms, fail_threshold, pre_check,
            catch_up_max_age_minutes, stuck_after_minutes, requires, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          s.id, s.prompt ?? '', s.description ?? '', s.schedule, s.agent, s.type,
          s.tenant_id ?? null, s.skip_if_busy ?? 0, s.force_send ?? 0, s.target_session ?? null,
          s.command ?? null, s.timeout_ms ?? null, s.fail_threshold ?? null, s.pre_check ?? null,
          s.catch_up_max_age_minutes ?? null, s.stuck_after_minutes ?? null, s.requires ?? null,
          s.created_at, s.updated_at,
        )
      }

      // import_sources -- idempotent on id. Always imported disabled with
      // last_run_at cleared, regardless of the exported values (defense in
      // depth, mirrors schedules above): the crawled content itself was never
      // exported, so a preserved last_run_at would make the next run treat
      // itself as incremental and silently skip everything the target doesn't
      // actually have. vault_token_ref is carried over as-is (just the vault
      // entry id); re-enabling still requires that entry to exist on this
      // machine (enforced by the route layer, not by this raw insert).
      for (const src of fleet.importSources ?? []) {
        const s = src as any
        if (!s.id || !s.type || !s.path) {
          logger.warn({ id: s.id }, 'Fleet import: skipping import source with missing required fields'); continue
        }
        db.prepare(
          `INSERT OR IGNORE INTO import_sources
           (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at,
            tenant_id, vault_token_ref, confluence_email, base_url)
           VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?)`
        ).run(
          s.id, s.type, s.path, s.label ?? null, s.interval_hours ?? 4,
          s.created_at, s.updated_at, s.tenant_id ?? 'default',
          s.vault_token_ref ?? null, s.confluence_email ?? null, s.base_url ?? null,
        )
      }

      // vault_ssh_keys -- idempotent on id. Metadata only (no private key column);
      // inserted before vault_ssh_servers below since a server's ssh_key_id refers
      // to it (foreign_keys enforcement is off for this connection, as elsewhere in
      // this schema, but the insert order still matches the logical dependency).
      for (const key of fleet.vaultSshKeys ?? []) {
        const k = key as any
        if (!k.id || !k.label || !k.username || !k.vault_key_id || !k.public_key || !k.fingerprint || !k.key_type) {
          logger.warn({ id: k.id }, 'Fleet import: skipping SSH key with missing required fields'); continue
        }
        db.prepare(
          `INSERT OR IGNORE INTO vault_ssh_keys
           (id, label, username, vault_key_id, public_key, fingerprint, key_type, created_at, tenant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(k.id, k.label, k.username, k.vault_key_id, k.public_key, k.fingerprint, k.key_type, k.created_at, k.tenant_id ?? 'default')
      }

      // vault_ssh_servers -- idempotent on id.
      for (const srv of fleet.vaultSshServers ?? []) {
        const s2 = srv as any
        if (!s2.id || !s2.name || !s2.host || !s2.username) {
          logger.warn({ id: s2.id }, 'Fleet import: skipping SSH server with missing required fields'); continue
        }
        db.prepare(
          `INSERT OR IGNORE INTO vault_ssh_servers
           (id, name, host, port, username, ssh_key_id, description, tenant_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          s2.id, s2.name, s2.host, s2.port ?? 22, s2.username, s2.ssh_key_id ?? null,
          s2.description ?? null, s2.tenant_id ?? 'default', s2.created_at, s2.updated_at,
        )
      }

      // memories -- idempotent on (agent_id, content); covers ALL agent_ids
      // agent_id-k pontosan a forrásból kerülnek át (a cél átveszi a forrás főagent identitását)
      const now = Math.floor(Date.now() / 1000)
      for (const mem of fleet.memories ?? []) {
        if (!db.prepare('SELECT 1 FROM memories WHERE agent_id = ? AND content = ?').get(mem.agent_id, mem.content)) {
          db.prepare(
            `INSERT INTO memories
             (chat_id, topic_key, content, sector, salience, created_at, accessed_at,
              agent_id, category, auto_generated, keywords)
             VALUES ('', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(mem.content, mem.sector, mem.salience, mem.created_at, mem.accessed_at ?? now,
            mem.agent_id, mem.category, mem.auto_generated ?? 0, mem.keywords ?? null)
        }
      }

      // daily logs -- idempotent on (agent_id, date, content); multiple rows per date are preserved
      for (const log of fleet.dailyLogs ?? []) {
        if (!db.prepare('SELECT 1 FROM daily_logs WHERE agent_id = ? AND date = ? AND content = ?').get(log.agent_id, log.date, log.content)) {
          db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)')
            .run(log.agent_id, log.date, log.content, log.created_at)
        }
      }

      // idea_box -- idempotent on id
      for (const idea of fleet.ideaBox?.ideas ?? []) {
        const i = idea as any
        db.prepare(
          `INSERT OR IGNORE INTO idea_box
           (id, title, description, category, status, source, kanban_id, impact, effort, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(i.id, i.title, i.description ?? null, i.category, i.status, i.source ?? '',
          i.kanban_id ?? null, i.impact ?? null, i.effort ?? null, i.created_at, i.updated_at)
      }

      // idea_comments -- M5: idempotent on (idea_id, created_at, content)
      for (const comment of fleet.ideaBox?.comments ?? []) {
        const c = comment as any
        if (!db.prepare('SELECT 1 FROM idea_comments WHERE idea_id = ? AND created_at = ? AND content = ?')
          .get(c.idea_id, c.created_at, c.content)) {
          db.prepare('INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)')
            .run(c.idea_id, c.author, c.content, c.created_at)
        }
      }

      // idea_status_log -- M5: idempotent on (idea_id, created_at, to_status)
      for (const log of fleet.ideaBox?.statusLog ?? []) {
        const l = log as any
        if (!db.prepare('SELECT 1 FROM idea_status_log WHERE idea_id = ? AND created_at = ? AND to_status = ?')
          .get(l.idea_id, l.created_at, l.to_status)) {
          db.prepare(
            'INSERT INTO idea_status_log (idea_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(l.idea_id, l.from_status ?? null, l.to_status, l.actor, l.note ?? null, l.created_at)
        }
      }

      // FTS rebuild after all memory inserts
      db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run()
    })

    importTx()

    // 6. Vault -- LAST: vault data is plaintext (decrypted at the top of importFleet)
    if (fleet.vault) {
      importVaultSection(fleet.vault, tracker, applyWarnings)
    }

    // M3: fire-and-forget re-embed imported memories (embedding was stripped at export)
    backfillEmbeddings().catch(err => logger.warn({ err: err?.message }, 'Fleet import: embedding backfill failed'))

    // Identity takeover: mirror the source identity set (name, brand, owner)
    // into .env so the target install adopts the source persona on next
    // restart. Preference: use identity object (full set) if present; fall
    // back to agentId-only for exports produced before the identity field
    // was added.
    //
    // .env (via updateEnvFile below) is the ONLY identity-persistence path
    // here since S8B retired config-overrides.json -- this used to also
    // write a config-overrides.json, but cfg()'s boot-time identity consumers
    // (OWNER_NAME, BOT_NAME, BRAND_NAME, MAIN_AGENT_ID) read env['KEY']
    // directly, never cfg(), so that write was already redundant with this
    // .env mirror for every field that matters at boot. Shell-side launchers
    // -- above all scripts/channels.sh -- also read MAIN_AGENT_ID /
    // CHANNEL_PROVIDER DIRECTLY from .env. Without this mirror the main
    // agent would launch under the pre-import identity (`${old-id}-channels`)
    // while the dashboard looks for `${new-id}-channels` and reports the
    // main agent as down.
    const sourceIdentity = fleet.mainAgent?.identity
    const sourceAgentId = sourceIdentity?.MAIN_AGENT_ID ?? fleet.mainAgent?.agentId
    if (sourceAgentId && typeof sourceAgentId === 'string') {
      const envIdentity: Record<string, string> = {}
      if (sourceIdentity && typeof sourceIdentity === 'object') {
        for (const [key, val] of Object.entries(sourceIdentity)) {
          if (typeof val === 'string' && val.length > 0) envIdentity[key] = val
        }
      } else {
        envIdentity['MAIN_AGENT_ID'] = sourceAgentId
      }
      updateEnvFile(envIdentity)

      applyWarnings.push(
        `Fő-agent identitás átvéve: ${sourceAgentId}. Újraindítás kell hogy a dashboard ${sourceAgentId}-ként induljon.`
      )
    }

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
  } catch (err: any) {
    cleanupTracked(tracker)
    logger.error({ err: err.message }, 'Fleet import failed, tracked writes cleaned up')
    throw err
  }
}
