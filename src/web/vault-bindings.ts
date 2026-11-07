import { existsSync, readdirSync, statSync, realpathSync, lstatSync } from 'node:fs'
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
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
import { listSecretAcl, replaceSecretAcl, deleteSecretAcl, listAllSecretAcls } from '../db/vault-secret-acl.js'
import { AGENT_ID_PATTERN, agentGrantee } from './vault-grantees.js'
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
export async function getBindings(): Promise<VaultBinding[]> {
  return listVaultBindings('default')
}

export async function addBinding(binding: VaultBinding): Promise<void> {
  await upsertVaultBinding('default', binding)
}

// Per-secret grantee list (vault_secret_acl, migration 0090). Same 'default'-tenant
// scope as the bindings above. An empty list means "open" (any target file), so this
// layer only stores and reads the set; enforcement is in syncSecret and the routes.
export async function getSecretAcl(vaultSecretId: string): Promise<string[]> {
  return listSecretAcl('default', vaultSecretId)
}

export async function setSecretAcl(vaultSecretId: string, grantees: readonly string[]): Promise<void> {
  await replaceSecretAcl('default', vaultSecretId, grantees)
}

export async function removeSecretAcl(vaultSecretId: string): Promise<void> {
  await deleteSecretAcl('default', vaultSecretId)
}

export async function getAllSecretAcls(): Promise<Record<string, string[]>> {
  return listAllSecretAcls('default')
}

export async function removeBinding(vaultSecretId: string, envVar: string): Promise<boolean> {
  return deleteVaultBinding('default', vaultSecretId, envVar)
}

export async function removeBindingsForSecret(vaultSecretId: string): Promise<void> {
  // Fetch-then-delete (not delete-then-use-return-value): the DB layer
  // already returns the deleted rows, so their targets are still available
  // here for the per-target MCP-file cleanup below.
  const toRemove = await deleteVaultBindingsForSecret('default', vaultSecretId)
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

interface GranteeBases { project: string, home: string, agents: string, externals: string[] }

function lexicalBases(): GranteeBases {
  return {
    project: resolve(PROJECT_ROOT), home: resolve(homedir()), agents: resolve(AGENTS_BASE_DIR),
    externals: getExternalProjectPaths().map(e => resolve(e)),
  }
}

// A base directory with its symbolic links followed (macOS keeps /tmp and /var behind a link, an install
// can sit behind one too). A base that does not exist stays as it is.
function realpathOr(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

function realBases(): GranteeBases {
  const b = lexicalBases()
  return { project: realpathOr(b.project), home: realpathOr(b.home), agents: realpathOr(b.agents), externals: b.externals.map(realpathOr) }
}

// The one place that maps an already-resolved file path onto a grantee, against the given base directories.
function granteeIn(resolved: string, bases: GranteeBases): string | null {
  if (resolved === join(bases.project, '.mcp.json')) return 'scope:project'
  if (resolved === join(bases.home, '.claude.json')) return 'scope:user'

  const rel = relative(bases.agents, resolved)
  if (rel !== '' && !isAbsolute(rel)) {
    const segs = rel.split(sep)
    const name = segs[0]
    if (name !== '..' && AGENT_ID_PATTERN.test(name)) {
      if (segs.length === 2 && segs[1] === '.mcp.json') return agentGrantee(name)
      if (segs.length === 4 && segs[1] === 'projects' && segs[3] === '.mcp.json') return agentGrantee(name)
    }
  }

  for (const ext of bases.externals) {
    if (resolved === join(ext, '.mcp.json')) return 'scope:external'
  }
  return null
}

/**
 * Which grantee an MCP file belongs to, or null when it belongs to none we know.
 *
 * The same four places `collectAllMcpFilePaths` lists, in the same order (the first match wins):
 *   PROJECT_ROOT/.mcp.json                                    -> scope:project
 *   ~/.claude.json                                            -> scope:user
 *   AGENTS_BASE_DIR/<name>/.mcp.json
 *   AGENTS_BASE_DIR/<name>/projects/<project>/.mcp.json       -> agent:<name>
 *   <external project path>/.mcp.json                         -> scope:external
 * Anything else (an unknown directory, a name that is not an agent id, a non-string) is null, and a
 * non-empty allowlist refuses null (fail-closed).
 *
 * The path is `path.resolve`d BEFORE it is judged, so `agents/a/../b/.mcp.json` is b's file, not a's.
 * The agent segment is compared as a whole path segment, never with startsWith: `agents/a-evil/...`
 * is `agent:a-evil`, not `agent:a`. This function is PURE (no file-system call) and judges the path as
 * written; a symbolic link in a directory on the way is not followed here. Where the write really
 * lands is `verifiedGranteeOfMcpFile`, which the allowlist checks use.
 */
export function granteeOfMcpFile(mcpFilePath: unknown): string | null {
  if (typeof mcpFilePath !== 'string' || mcpFilePath === '' || mcpFilePath.includes('\0')) return null
  return granteeIn(resolve(mcpFilePath), lexicalBases())
}

/**
 * True when the path is a string that `path.resolve` leaves exactly as written: absolute, no `.` or
 * `..` segment, no doubled or trailing separator. The paths the discovery lists are built with `join`
 * from absolute bases, so they are canonical; a hand-written target may not be. Pure (no file system).
 */
export function isCanonicalMcpPath(mcpFilePath: unknown): boolean {
  return typeof mcpFilePath === 'string' && mcpFilePath !== '' && !mcpFilePath.includes('\0') && resolve(mcpFilePath) === mcpFilePath
}

/**
 * `granteeOfMcpFile` plus the file-system step: where the write REALLY lands.
 *
 * The lexical answer is wrong when a directory on the way is a symbolic link: `agents/a/projects/x -> ../b`
 * is listed (and written) as a file of `a` by the discovery, which follows the link, while the write
 * lands in b's file. So the parent directory of the file is `realpath`ed (every link on the way followed),
 * the grantee is computed AGAIN from that real location against the real base directories, and the two
 * answers must be the same grantee; any difference is `null`, which a non-empty allowlist refuses
 * (fail-closed). The same holds for `scope:external`. The file itself must be a regular file with a single
 * name (`lstat`: not a symbolic link, not a hard link with a link count above one, not a pipe, device or
 * directory): the sync reads through the path before it writes, so an alias of another file would carry
 * that file's content into this one; it is `null` too, whatever the alias points at.
 *
 * The path must be canonical as written (`resolve(p) === p`): the sync reads and writes the given string, the OS
 * follows a link before it applies a `..`, and `resolve` does not, so a path with a `..` in it is `null`.
 *
 * A parent directory or a file that does not exist yet has nothing to resolve (the lexical answer
 * stands); any other failure to resolve or look at them (no permission, a link loop) is `null`. Called
 * only when a list is set, so an open secret costs no file-system call.
 *
 * Known limit: the check and the write are two steps, so a link put in place between them is not seen
 * (it takes write access to the agent's own directory and a precise timing; the full fix is separate).
 */
export function verifiedGranteeOfMcpFile(mcpFilePath: unknown): string | null {
  const lexical = granteeOfMcpFile(mcpFilePath)
  if (lexical === null) return null
  const resolved = resolve(mcpFilePath as string)
  // The sync reads and writes the string it was given, and the OS follows a link BEFORE it applies a `..`
  // (`agents/a/x/../.mcp.json` with x -> elsewhere opens elsewhere/.mcp.json), while `resolve` collapses the
  // `..` lexically. The two only agree on a path that is already canonical, so anything else is refused.
  if (!isCanonicalMcpPath(mcpFilePath)) return null
  let realParent: string // the parent directory with every link followed
  try {
    realParent = realpathSync(dirname(resolved))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? lexical : null
  }
  const real = granteeIn(join(realParent, basename(resolved)), realBases())
  if (real !== lexical) return null

  // The file itself must be a regular file with a single name. The sync READS the file through the path
  // (a symbolic link makes it read the target, a second name of the same file (hard link, link count above
  // one) is the same content under another grantee's directory, and a pipe or device may even block the
  // read), and a value from there then lands in this file: information flows across the grantee boundary,
  // so the directory check above is not enough. `lstat` does not follow a link, so a symbolic link is not a
  // regular file here. A file that does not exist yet is fine (nothing to alias); any other failure to look
  // at it is refused (fail-closed).
  try {
    const st = lstatSync(resolved)
    if (!st.isFile() || st.nlink > 1) return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  return lexical
}

/**
 * The parent directory of an MCP file with every link followed, or null when it cannot be resolved. It is
 * only the realpath step of verifiedGranteeOfMcpFile (no second grantee lookup): syncSecret notes it when it
 * judges a target and compares it again right before the rename.
 */
export function realParentOfMcpFile(mcpFilePath: string): string | null {
  try {
    return realpathSync(dirname(resolve(mcpFilePath)))
  } catch {
    return null
  }
}

/** Test seam: runs first in the pre-rename re-check of syncSecret, so a test can change the file system
 *  between the check and the rename. Null in production. */
let syncBeforeRenameTestHook: ((tmpPath: string) => void) | null = null
export function setSyncBeforeRenameTestHook(hook: ((tmpPath: string) => void) | null): void {
  syncBeforeRenameTestHook = hook
}

export interface RefusedTarget {
  target: VaultBindingTarget
  grantee: string | null
}

/**
 * Splits targets by a secret's allowlist. An EMPTY list allows everything (today's behaviour, and the
 * grantee is not even computed); a non-empty list allows exactly the targets whose file belongs to a
 * listed grantee, and refuses the rest, a file of no known grantee (null) included.
 */
export function partitionTargetsByAcl(
  acl: readonly string[],
  targets: readonly VaultBindingTarget[],
): { allowed: VaultBindingTarget[], refused: RefusedTarget[] } {
  if (acl.length === 0) return { allowed: [...targets], refused: [] }
  // A body that is not an array of targets cannot be judged entry by entry: refuse it whole (fail-closed)
  // rather than iterate something that is not iterable.
  if (!Array.isArray(targets)) return { allowed: [], refused: [{ target: targets as unknown as VaultBindingTarget, grantee: null }] }
  const allowed: VaultBindingTarget[] = []
  const refused: RefusedTarget[] = []
  for (const target of targets) {
    const grantee = verifiedGranteeOfMcpFile(target?.mcpFilePath)
    if (grantee !== null && acl.includes(grantee)) allowed.push(target)
    else refused.push({ target, grantee })
  }
  return { allowed, refused }
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

export async function syncSecret(vaultSecretId: string): Promise<SyncResult> {
  const bindings = (await getBindings()).filter(b => b.vaultSecretId === vaultSecretId)
  if (bindings.length === 0) return { updated: 0, errors: [] }

  const secret = getSecret(vaultSecretId)
  if (secret === null) return { updated: 0, errors: [`Vault secret "${vaultSecretId}" not found`] }

  // The grantee list: empty = every target as before; non-empty = only the listed grantees' files. A
  // refused target is skipped and reported, never written, and a reference an earlier sync already
  // wrote there is NOT removed (no destructive file edit here); the error shows up on every sync.
  const acl = await getSecretAcl(vaultSecretId)

  let updated = 0
  const errors: string[] = []

  for (const binding of bindings) {
    const { allowed, refused } = partitionTargetsByAcl(acl, binding.targets)
    for (const { target, grantee } of refused) {
      // A refusal with no grantee has more than one cause, and a path that is not canonical is the one
      // the caller can fix by spelling it differently, so it gets its own words.
      errors.push(grantee !== null
        ? `Target not allowed for secret "${vaultSecretId}": ${grantee}`
        : isCanonicalMcpPath(target?.mcpFilePath)
          ? `Target not allowed for secret "${vaultSecretId}": ${target.mcpFilePath} (it must be a regular file with a single name in a known place: no link, no second name, no special file)`
          : `Target not allowed for secret "${vaultSecretId}": ${String(target?.mcpFilePath)} (the path must be canonical: absolute, with no "." or ".." segment and no doubled or trailing separator)`)
    }
    for (const target of allowed) {
      try {
        // Only a non-empty list made an access decision, so only then is it judged again right before the
        // rename (an open secret costs no file-system call). The parent directory as it was when the target
        // was judged is noted here; the re-check compares it with the real one at the last moment.
        const checkedParent = acl.length > 0 ? realParentOfMcpFile(target.mcpFilePath) : null
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const serverCfg = content.mcpServers?.[target.serverName]
        if (!serverCfg) {
          errors.push(`Server "${target.serverName}" not found in ${target.mcpFilePath}`)
          continue
        }
        if (!serverCfg.env) serverCfg.env = {}
        serverCfg.env[binding.envVar] = `vault:${vaultSecretId}`
        if (serverCfg.command && !serverCfg.url) wrapCommand(serverCfg)
        const beforeRename = acl.length > 0
          ? (tmpPath: string): void => {
              syncBeforeRenameTestHook?.(tmpPath)
              const grantee = verifiedGranteeOfMcpFile(target.mcpFilePath)
              const sameParent = checkedParent !== null && realParentOfMcpFile(tmpPath) === checkedParent
              if (grantee === null || !acl.includes(grantee) || !sameParent) {
                logger.warn({ vaultSecretId, mcpFilePath: target.mcpFilePath }, 'vault-sync-target-changed')
                throw new Error('target changed during sync')
              }
            }
          : undefined
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2), { mode: 0o600, beforeRename })
        updated++
      } catch (err: any) {
        errors.push(`Failed to update ${target.mcpFilePath}: ${err.message}`)
      }
    }
  }

  if (updated > 0) logger.info({ vaultSecretId, updated }, 'Vault secret synced to .mcp.json files')
  return { updated, errors }
}

export async function unsyncBinding(vaultSecretId: string, envVar: string): Promise<void> {
  const bindings = (await getBindings()).filter(
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

export async function syncAllBindings(): Promise<SyncResult> {
  const allBindings = await getBindings()
  const secretIds = new Set(allBindings.map(b => b.vaultSecretId))
  let totalUpdated = 0
  const allErrors: string[] = []

  for (const id of secretIds) {
    const result = await syncSecret(id)
    totalUpdated += result.updated
    allErrors.push(...result.errors)
  }
  return { updated: totalUpdated, errors: allErrors }
}
