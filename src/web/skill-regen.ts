/**
 * SQL -> file skill regeneration (716-D).
 *
 * At startup, AFTER materializeSkillsFromFiles() has seeded the DB, this
 * module writes fleet skills from SQL back to their canonical file locations.
 * SQL is the source of truth; files are the loader cache Claude Code reads.
 *
 * Guardrails (all mandatory):
 *   1. NON-DESTRUCTIVE: we never delete or overwrite a file that has no
 *      corresponding SQL row. Unknown-to-SQL files are left untouched.
 *   2. Runs only AFTER materialization (caller responsibility).
 *   3. IDEMPOTENT + ATOMIC: content-equal files are skipped; writes go to a
 *      sibling .tmp then rename() over the target.
 *   4. KILL-SWITCH: regen is ON by default; SKILL_SQL_REGEN=0 (also
 *      false/off/no) switches it off (see parseSkillSqlRegen in config.ts).
 *   5. Path safety: IDs with '..' or absolute-path components are rejected.
 *
 * Companion files (skill_files: scripts/, references/, ...) are generated next
 * to the SKILL.md with the same rules; they are only ever ADDED or UPDATED by
 * regen, removed only by an explicit delete of the file or skill (and then only
 * while still byte-equal to the deleted row).
 *
 * Tenant skills (tenant_id != 'fleet') are generated only under the agents of
 * the owning tenant and of the tenants they are granted to (see the "tenant
 * skills" section below); a tenant with no agent keeps its skills DB-only.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { PROJECT_ROOT, MAIN_AGENT_ID, SKILL_SQL_REGEN, TENANT_SKILL_FILES } from '../config.js'
import { listAllSkills, getSkill, listSkillAccess, getEnabledAgentsForTenant, getTenantsForAgent, listSkillFiles, seedSkillFileIfAbsent, type SkillRow, type SkillFileRow } from '../db.js'
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES_PER_SKILL, normalizeSkillRelPath, sanitizeSkillFileMode } from '../skill-files.js'
import { addGeneratedHeader, stripGeneratedHeader, readGeneratedHeader } from '../skill-header.js'

export interface RegenResult {
  enabled: boolean
  written: number
  skipped: number
  errors: number
}

/**
 * Derive the on-disk SKILL.md path from a SQL skill id.
 * Returns null for malformed or path-unsafe IDs.
 *
 * ID conventions (set by materialize-skills.ts):
 *   global/<name>              -> ~/.claude/skills/<name>/SKILL.md
 *   agent/<agentId>/<name>     -> <project>/agents/<agentId>/.claude/skills/<name>/SKILL.md
 *   agent/<MAIN_AGENT_ID>/<name> -> <project>/.claude/skills/<name>/SKILL.md
 */
export function resolveSkillPath(id: string): string | null {
  // Reject any component that could escape the expected base directories.
  if (id.includes('..') || id.startsWith('/')) return null

  const parts = id.split('/')
  if (parts.some(p => p === '' || p === '.')) return null

  if (parts[0] === 'global' && parts.length === 2) {
    const name = parts[1]
    const base = join(homedir(), '.claude', 'skills', name)
    const resolved = normalize(base)
    if (!resolved.startsWith(normalize(join(homedir(), '.claude', 'skills')))) return null
    return join(base, 'SKILL.md')
  }

  if (parts[0] === 'agent' && parts.length === 3) {
    const agentId = parts[1]
    const name = parts[2]
    let base: string
    if (agentId === MAIN_AGENT_ID) {
      base = join(PROJECT_ROOT, '.claude', 'skills', name)
      const expected = normalize(join(PROJECT_ROOT, '.claude', 'skills'))
      if (!normalize(base).startsWith(expected)) return null
    } else {
      base = join(AGENTS_BASE_DIR, agentId, '.claude', 'skills', name)
      const expected = normalize(join(AGENTS_BASE_DIR, agentId, '.claude', 'skills'))
      if (!normalize(base).startsWith(expected)) return null
    }
    return join(base, 'SKILL.md')
  }

  return null  // unknown ID pattern
}

/**
 * Regenerate fleet skill files from SQL.
 *
 * Safe to call unconditionally at startup: returns immediately with
 * enabled=false if the SKILL_SQL_REGEN kill-switch is off (and forceEnabled
 * is not set). The startup hook always calls with default opts; the CLI
 * script passes forceEnabled=true to allow manual proof runs.
 *
 * @param dryRun       If true, log what would be written but don't touch disk.
 * @param forceEnabled Bypass the SKILL_SQL_REGEN kill-switch (CLI use only).
 */
export function regenSkillFilesFromSQL(dryRun = false, forceEnabled = false): RegenResult {
  // Kill-switch: must be explicitly enabled for live writes. Dry-run bypasses
  // the check (read-only; safe to run for inspection regardless of the flag).
  if (!dryRun && !SKILL_SQL_REGEN && !forceEnabled) {
    return { enabled: false, written: 0, skipped: 0, errors: 0 }
  }

  let written = 0
  let skipped = 0
  let errors = 0

  let allRows: SkillRow[]
  try {
    allRows = listAllSkills()
  } catch (err) {
    logger.error({ err }, 'skill-regen: failed to query skills table')
    return { enabled: true, written: 0, skipped: 0, errors: 1 }
  }
  const rows = allRows.filter(r => r.tenant_id === 'fleet')
  const tenantRows = allRows.filter(r => r.tenant_id !== 'fleet')

  for (const row of rows) {
    const targetPath = resolveSkillPath(row.id)
    if (!targetPath) {
      logger.warn({ id: row.id }, 'skill-regen: unrecognized ID pattern, skipping')
      errors++
      continue
    }

    const outcome = writeSkillFileToDisk(row.id, targetPath, row.content, dryRun)
    if (outcome === 'written') written++
    else if (outcome === 'skipped') skipped++
    else errors++
    if (outcome !== 'error') {
      const c = writeCompanionFiles(dirOfSkillMd(targetPath), safeListSkillFiles(row.id), dryRun)
      written += c.written
      skipped += c.skipped
      errors += c.errors
    }
  }

  for (const row of tenantRows) {
    try {
      const t = reconcileTenantSkill(row, dryRun)
      written += t.written
      skipped += t.skipped
      errors += t.errors
    } catch (err) {
      logger.error({ err, id: row.id }, 'skill-regen: tenant skill reconcile failed')
      errors++
    }
  }
  try {
    sweepOrphanTenantFiles(new Set(tenantRows.map(r => r.id)), dryRun)
  } catch (err) {
    logger.error({ err }, 'skill-regen: orphan tenant file sweep failed')
    errors++
  }

  return { enabled: true, written, skipped, errors }
}

/**
 * Shared write for one (id, path, content) triple: skip if the on-disk
 * content already matches (idempotent), otherwise atomic-write it. Used by
 * both the bulk startup regen and regenSingleSkillFile() below so the two
 * never drift apart.
 */
function writeSkillFileToDisk(id: string, targetPath: string, content: string, dryRun: boolean, opts: { tenant?: boolean } = {}): 'written' | 'skipped' | 'error' {
  // The file is a generated cache: SKILL.md content + a marker line after the frontmatter.
  const generated = addGeneratedHeader(content, id, opts)
  if (existsSync(targetPath)) {
    let onDisk = ''
    try { onDisk = readFileSync(targetPath, 'utf-8') } catch { /* treat as missing */ }
    if (onDisk === generated) return 'skipped'
    // Beyond a missing/outdated marker line, a difference means the cache file
    // was changed behind the DB's back (an editor, sed, a restored older file)
    // and the file->DB hook never saw it: say so, then restore it from the DB
    // rather than letting the two diverge unnoticed.
    if (onDisk !== '' && stripGeneratedHeader(onDisk) !== content) {
      logger.warn({ id, path: targetPath }, 'skill-regen: cache file drifted from the DB, restoring it from the DB')
    }
  }

  if (dryRun) {
    logger.info({ id, path: targetPath }, 'skill-regen [dry-run]: would write')
    return 'written'
  }

  try {
    const dir = targetPath.replace(/\/SKILL\.md$/, '')
    mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(targetPath, generated)
    logger.info({ id, path: targetPath }, 'skill-regen: wrote')
    return 'written'
  } catch (err) {
    logger.error({ err, id, path: targetPath }, 'skill-regen: write failed')
    return 'error'
  }
}

export interface SingleRegenResult {
  written: boolean
  skipped: boolean
  reason: 'disabled' | 'not_found' | 'not_file_backed' | 'unrecognized_id' | 'content_equal' | 'write_error' | null
}

/**
 * Regenerate a single skill's on-disk SKILL.md from its current SQL row,
 * immediately after a dashboard write -- Phase 1 of the file->SQL-only
 * migration. Callers should invoke this right after every
 * createSkill()/updateSkill() so an edit reaches disk (and therefore the
 * Claude Code loader) without waiting for the next startup regen.
 *
 * Tenant-scoped skills (tenant_id !== 'fleet') are reconciled across the agents
 * of their tenants; with no such agent the call is a no-op ('not_file_backed').
 *
 * @param forceEnabled Bypass the SKILL_SQL_REGEN kill-switch (CLI/test use only).
 */
export function regenSingleSkillFile(id: string, forceEnabled = false): SingleRegenResult {
  if (!SKILL_SQL_REGEN && !forceEnabled) {
    return { written: false, skipped: true, reason: 'disabled' }
  }

  const row = getSkill(id)
  if (!row) return { written: false, skipped: false, reason: 'not_found' }
  if (row.tenant_id !== 'fleet') {
    const t = reconcileTenantSkill(row, false)
    if (t.errors > 0) return { written: false, skipped: false, reason: 'write_error' }
    if (t.written > 0) return { written: true, skipped: false, reason: null }
    if (t.removed > 0) return { written: false, skipped: false, reason: null }
    // No agent of the owning/granted tenants: the skill lives in the DB only.
    if (t.recipients === 0) return { written: false, skipped: true, reason: 'not_file_backed' }
    return { written: false, skipped: true, reason: 'content_equal' }
  }

  const targetPath = resolveSkillPath(id)
  if (!targetPath) return { written: false, skipped: false, reason: 'unrecognized_id' }

  const outcome = writeSkillFileToDisk(id, targetPath, row.content, false)
  if (outcome === 'error') return { written: false, skipped: false, reason: 'write_error' }
  const c = writeCompanionFiles(dirOfSkillMd(targetPath), safeListSkillFiles(id), false)
  if (c.errors > 0) return { written: false, skipped: false, reason: 'write_error' }
  if (outcome === 'written' || c.written > 0) return { written: true, skipped: false, reason: null }
  return { written: false, skipped: true, reason: 'content_equal' }
}

export interface RemoveGeneratedResult {
  removed: boolean
  reason: 'disabled' | 'not_file_backed' | 'unrecognized_id' | 'absent' | 'modified_on_disk' | 'unlink_error' | null
}

/**
 * Remove the generated SKILL.md of a skill that was just deleted from SQL, so
 * the loader cache does not resurrect a skill the DB no longer has.
 *
 * The file is only a cache of the DB row, so it is only deleted while it is
 * still byte-equal to the row's content: a file someone edited by hand (and
 * that the file->DB hook has not synced) is left in place and reported as
 * 'modified_on_disk' instead of destroying that edit. The skill directory is
 * removed only when it ends up empty (companion files keep it alive).
 *
 * @param id       The deleted skill's SQL id.
 * @param content  The deleted row's content (read BEFORE the DB delete).
 * @param tenantId The deleted row's tenant_id; non-fleet skills are removed from every agent that holds a generated copy.
 * @param files    The deleted skill's companion file rows (read BEFORE the DB delete); the ones still byte-equal on disk are removed too.
 */
export function removeGeneratedSkillFile(id: string, content: string, tenantId: string, files: SkillFileRow[] = []): RemoveGeneratedResult {
  if (!SKILL_SQL_REGEN) return { removed: false, reason: 'disabled' }
  if (tenantId !== 'fleet') return removeTenantSkillFiles(id, content, files)
  const targetPath = resolveSkillPath(id)
  if (!targetPath) return { removed: false, reason: 'unrecognized_id' }
  if (!existsSync(targetPath)) return { removed: false, reason: 'absent' }

  let onDisk = ''
  try { onDisk = readFileSync(targetPath, 'utf-8') } catch { return { removed: false, reason: 'unlink_error' } }
  if (stripGeneratedHeader(onDisk) !== content) {
    logger.warn({ id, path: targetPath }, 'skill-regen: deleted skill has a hand-edited file on disk, leaving it')
    return { removed: false, reason: 'modified_on_disk' }
  }
  try {
    unlinkSync(targetPath)
    removeCompanionFiles(dirOfSkillMd(targetPath), files)
    try { rmdirSync(dirOfSkillMd(targetPath)) } catch { /* not empty (untracked files) or gone */ }
    logger.info({ id, path: targetPath }, 'skill-regen: removed generated file of deleted skill')
    return { removed: true, reason: null }
  } catch (err) {
    logger.error({ err, id, path: targetPath }, 'skill-regen: failed to remove generated file')
    return { removed: false, reason: 'unlink_error' }
  }
}

// --- companion files (skill_files) ---------------------------------------------

function dirOfSkillMd(skillMdPath: string): string {
  return skillMdPath.replace(/\/SKILL\.md$/, '')
}

function safeListSkillFiles(id: string): SkillFileRow[] {
  try { return listSkillFiles(id) } catch (err) {
    logger.error({ err, id }, 'skill-regen: failed to read skill companion files')
    return []
  }
}

/** Absolute target of a companion file, or null if the path escapes the skill dir or crosses a symlink. */
function companionTarget(skillDir: string, relPath: string): string | null {
  const rel = normalizeSkillRelPath(relPath)
  if (!rel) return null
  const target = join(skillDir, ...rel.split('/'))
  if (!normalize(target).startsWith(normalize(skillDir) + sep)) return null
  // A symlink anywhere on the way (an agent-made scripts -> /elsewhere) would redirect the write.
  let cur = skillDir
  for (const part of rel.split('/')) {
    cur = join(cur, part)
    try { if (lstatSync(cur).isSymbolicLink()) return null } catch { break }   // ENOENT: the rest does not exist yet
  }
  return target
}

interface CompanionWrite { written: number; skipped: number; errors: number }

/** Write the DB's companion files under one skill dir: content-equal files are left, others are replaced atomically. */
function writeCompanionFiles(skillDir: string, files: SkillFileRow[], dryRun: boolean): CompanionWrite {
  const out: CompanionWrite = { written: 0, skipped: 0, errors: 0 }
  for (const f of files) {
    const target = companionTarget(skillDir, f.rel_path)
    if (!target) {
      logger.warn({ skillDir, rel: f.rel_path }, 'skill-regen: unsafe companion file path, skipping')
      out.errors++
      continue
    }
    const mode = sanitizeSkillFileMode(f.mode)
    if (existsSync(target)) {
      let onDisk: Buffer | null = null
      try { onDisk = readFileSync(target) } catch { /* treated as differing */ }
      if (onDisk && onDisk.equals(f.content)) {
        try { if ((statSync(target).mode & 0o777) !== mode && !dryRun) chmodSync(target, mode) } catch { /* best effort */ }
        out.skipped++
        continue
      }
      logger.warn({ skillDir, rel: f.rel_path }, 'skill-regen: companion file drifted from the DB, restoring it from the DB')
    }
    if (dryRun) { out.written++; continue }
    try {
      mkdirSync(dirname(target), { recursive: true })
      atomicWriteFileSync(target, f.content, { mode })
      out.written++
    } catch (err) {
      logger.error({ err, skillDir, rel: f.rel_path }, 'skill-regen: companion file write failed')
      out.errors++
    }
  }
  return out
}

/** Remove one generated companion file (only while byte-equal to `expected`) and prune the empty dirs above it, up to the skill dir. */
function removeCompanionFile(skillDir: string, relPath: string, expected: Buffer): 'removed' | 'absent' | 'modified' | 'error' {
  const target = companionTarget(skillDir, relPath)
  if (!target || !existsSync(target)) return 'absent'
  let onDisk: Buffer
  try { onDisk = readFileSync(target) } catch { return 'error' }
  if (!onDisk.equals(expected)) {
    logger.warn({ skillDir, rel: relPath }, 'skill-regen: companion file was edited by hand, leaving it')
    return 'modified'
  }
  try {
    unlinkSync(target)
    for (let d = dirname(target); normalize(d) !== normalize(skillDir) && normalize(d).startsWith(normalize(skillDir) + sep); d = dirname(d)) {
      try { rmdirSync(d) } catch { break }   // not empty
    }
    return 'removed'
  } catch (err) {
    logger.error({ err, skillDir, rel: relPath }, 'skill-regen: failed to remove companion file')
    return 'error'
  }
}

function removeCompanionFiles(skillDir: string, files: SkillFileRow[]): void {
  for (const f of files) removeCompanionFile(skillDir, f.rel_path, f.content)
}

/**
 * Remove the generated copy of ONE deleted companion file from the skill's
 * on-disk locations (the fleet dir, or every tenant copy). Only byte-equal
 * files go; returns how many were removed.
 */
export function removeGeneratedCompanionFile(id: string, relPath: string, content: Buffer, tenantId: string): number {
  if (!SKILL_SQL_REGEN) return 0
  let removed = 0
  if (tenantId === 'fleet') {
    const skillMd = resolveSkillPath(id)
    if (skillMd && removeCompanionFile(dirOfSkillMd(skillMd), relPath, content) === 'removed') removed++
    return removed
  }
  for (const agentId of agentDirsOnDisk()) {
    const path = tenantSkillPath(agentId, id)
    if (!path || !existsSync(path)) continue
    const text = readTextOrNull(path)
    const hdr = text === null ? null : readGeneratedHeader(text)
    if (!hdr || !hdr.tenant || hdr.id !== id) continue
    if (removeCompanionFile(dirOfSkillMd(path), relPath, content) === 'removed') removed++
  }
  return removed
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git'])
const SKIP_FILES = new Set(['.DS_Store'])

function walkCompanionFiles(root: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = []
  const walk = (dir: string, prefix: string) => {
    let entries: string[] = []
    try { entries = readdirSync(dir).sort() } catch { return }
    for (const name of entries) {
      const abs = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let st
      try { st = lstatSync(abs) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(abs, rel); continue }
      if (!st.isFile() || SKIP_FILES.has(name) || rel === 'SKILL.md') continue
      out.push({ rel, abs })
    }
  }
  walk(root, '')
  return out
}

export interface CompanionImportResult { seeded: number; skipped: number; errors: number }

/**
 * Seed skill_files for ONE skill from the files that sit next to its SKILL.md
 * in `skillDir`. Insert-if-absent: a file the DB already has is never
 * overwritten. Symlinks, tool caches and over-limit files are not imported.
 */
export function importCompanionFilesOfDir(skillId: string, skillDir: string, dryRun = false): CompanionImportResult {
  const out: CompanionImportResult = { seeded: 0, skipped: 0, errors: 0 }
  const found = walkCompanionFiles(skillDir)
  if (found.length > MAX_SKILL_FILES_PER_SKILL) {
    logger.warn({ id: skillId, files: found.length }, 'skill-regen: too many companion files, not importing this skill\'s files')
    out.errors++
    return out
  }
  for (const f of found) {
    const rel = normalizeSkillRelPath(f.rel)
    if (!rel) { out.skipped++; continue }
    try {
      const st = statSync(f.abs)
      if (st.size > MAX_SKILL_FILE_BYTES) {
        logger.warn({ id: skillId, rel }, 'skill-regen: companion file over the size limit, not importing it')
        out.errors++
        continue
      }
      if (dryRun) { out.seeded++; continue }
      if (seedSkillFileIfAbsent(skillId, rel, readFileSync(f.abs), st.mode)) out.seeded++
      else out.skipped++
    } catch (err) {
      logger.error({ err, id: skillId, rel }, 'skill-regen: companion file import failed')
      out.errors++
    }
  }
  return out
}

/**
 * Seed skill_files from the companion files that already sit next to fleet
 * skills on disk (scripts/, references/, ...). Safe on every startup (see
 * importCompanionFilesOfDir) and only matters until the DB holds them all. Runs
 * BEFORE the regen, which would otherwise never know about these files.
 */
export function importSkillCompanionFilesFromDisk(dryRun = false): CompanionImportResult {
  const total: CompanionImportResult = { seeded: 0, skipped: 0, errors: 0 }
  let rows: SkillRow[]
  try { rows = listAllSkills().filter(r => r.tenant_id === 'fleet') } catch (err) {
    logger.error({ err }, 'skill-regen: failed to query skills table for companion import')
    return { ...total, errors: 1 }
  }
  for (const row of rows) {
    const skillMd = resolveSkillPath(row.id)
    if (!skillMd || !existsSync(skillMd)) continue
    const r = importCompanionFilesOfDir(row.id, dirOfSkillMd(skillMd), dryRun)
    total.seeded += r.seeded
    total.skipped += r.skipped
    total.errors += r.errors
  }
  return total
}

// --- tenant skills ---------------------------------------------------------
//
// A skill with tenant_id != 'fleet' is generated under the agents of the tenant
// that owns it and of every tenant it is granted to (skill_tenant_access), as
// <agents>/<agentId>/.claude/skills/<dir>/SKILL.md with a "tenant skill <id>"
// header. Recipients are the agents with an enabled row in
// tenant_agent_availability that exist on disk; a fleet/global skill granted to
// a tenant needs nothing (it is already in ~/.claude/skills for every agent).
// An agent enabled for several tenants receives all of their skills.

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface TenantReconcile { written: number; skipped: number; errors: number; removed: number; recipients: number }

/** Directory name for a tenant skill id: [A-Za-z0-9._-] only, no leading dot/dash. */
export function tenantSkillDirName(id: string): string | null {
  const dir = id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return SAFE_SEGMENT.test(dir) ? dir : null
}

function tenantSkillPath(agentId: string, id: string): string | null {
  if (!SAFE_SEGMENT.test(agentId)) return null
  const dirName = tenantSkillDirName(id)
  if (!dirName) return null
  return join(AGENTS_BASE_DIR, agentId, '.claude', 'skills', dirName, 'SKILL.md')
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** Agent directories present on disk (candidates for stale-copy cleanup). */
function agentDirsOnDisk(): string[] {
  try {
    return readdirSync(AGENTS_BASE_DIR).filter(a => SAFE_SEGMENT.test(a) && isDir(join(AGENTS_BASE_DIR, a)))
  } catch {
    return []
  }
}

// Tenant skill files exist only while their agent runs (generated at agent start, removed at stop).
// The probe says whether an agent is running; the default (everything runs) keeps callers and tests
// that never wire it unchanged, the dashboard sets it from the tmux run state at startup.
let agentRunningProbe: (agentId: string) => boolean = () => true
export function setTenantSkillAgentProbe(probe: (agentId: string) => boolean): void { agentRunningProbe = probe }
function agentIsRunning(agentId: string): boolean {
  try { return agentRunningProbe(agentId) } catch { return true }   // unsure: keep the files, the use-time gate still applies
}

/** Agents that MAY hold a generated copy of a tenant skill (mode, tenant availability, directory on disk), running or not. */
function tenantSkillQualifiers(row: SkillRow): string[] {
  const mode = TENANT_SKILL_FILES   // read once: a getter in tests, a constant in production
  if (mode === 'off') return []
  const tenants = new Set<string>([row.tenant_id])
  for (const g of listSkillAccess(row.id)) tenants.add(g.tenant_id)
  const agents = new Set<string>()
  for (const t of tenants) for (const a of getEnabledAgentsForTenant(t)) agents.add(a)
  // The main agent's skills dir is the project-wide one, not a tenant's own.
  return [...agents].filter(a =>
    a !== MAIN_AGENT_ID && SAFE_SEGMENT.test(a) && isDir(join(AGENTS_BASE_DIR, a)) &&
    // An agent shared by several tenants would expose this tenant's skill (and its companion
    // scripts) to requests of the other tenants: shared agents are DB-only, always.
    getTenantsForAgent(a).length === 1)
}

/** Agents that hold a generated copy right now: the qualifiers that are running. */
function tenantSkillRecipients(row: SkillRow): string[] {
  return tenantSkillQualifiers(row).filter(agentIsRunning)
}

function readTextOrNull(p: string): string | null {
  try { return readFileSync(p, 'utf-8') } catch { return null }
}

function unlinkSkillFile(path: string): boolean {
  try {
    unlinkSync(path)
    try { rmdirSync(path.replace(/\/SKILL\.md$/, '')) } catch { /* not empty (companion files) or gone */ }
    return true
  } catch (err) {
    logger.error({ err, path }, 'skill-regen: failed to remove generated tenant file')
    return false
  }
}

/** Write one agent's generated copy (SKILL.md + companion files) of a tenant skill; a hand-made skill of the same name is never overwritten. */
function writeTenantCopy(row: SkillRow, agentId: string, files: SkillFileRow[], dryRun: boolean, out: TenantReconcile): void {
  const path = tenantSkillPath(agentId, row.id)
  if (!path) { out.errors++; return }
  if (existsSync(path)) {
    const existing = readTextOrNull(path)
    const hdr = existing === null ? null : readGeneratedHeader(existing)
    if (!hdr || !hdr.tenant || hdr.id !== row.id) {
      // A hand-made skill (or another generated one) already owns this name.
      logger.warn({ id: row.id, agentId, path }, 'skill-regen: tenant skill name collides with an existing file, skipping')
      out.skipped++
      return
    }
  }
  const outcome = writeSkillFileToDisk(row.id, path, row.content, dryRun, { tenant: true })
  if (outcome === 'written') out.written++
  else if (outcome === 'skipped') out.skipped++
  else out.errors++
  if (outcome !== 'error') {
    const c = writeCompanionFiles(dirOfSkillMd(path), files, dryRun)
    out.written += c.written
    out.skipped += c.skipped
    out.errors += c.errors
  }
}

function reconcileTenantSkill(row: SkillRow, dryRun: boolean): TenantReconcile {
  const out: TenantReconcile = { written: 0, skipped: 0, errors: 0, removed: 0, recipients: 0 }
  const expected = new Set(tenantSkillRecipients(row))
  out.recipients = expected.size
  const files = safeListSkillFiles(row.id)

  for (const agentId of expected) writeTenantCopy(row, agentId, files, dryRun, out)

  for (const agentId of agentDirsOnDisk()) {
    if (expected.has(agentId)) continue
    const path = tenantSkillPath(agentId, row.id)
    if (!path || !existsSync(path)) continue
    const onDisk = readTextOrNull(path)
    const hdr = onDisk === null ? null : readGeneratedHeader(onDisk)
    if (onDisk === null || !hdr || !hdr.tenant || hdr.id !== row.id) continue   // not our generated copy
    const handEdited = stripGeneratedHeader(onDisk) !== row.content
    if (dryRun) {
      logger.info({ id: row.id, agentId, path, handEdited }, 'skill-regen [dry-run]: would remove stale tenant copy')
      continue
    }
    // Generated companion files (byte-equal to the DB row) go either way; a
    // hand-edited SKILL.md is kept, but its scripts must not stay on an agent
    // that no longer qualifies.
    removeCompanionFiles(dirOfSkillMd(path), files)
    if (handEdited) {
      logger.warn({ id: row.id, agentId, path }, 'skill-regen: stale tenant copy was edited by hand, leaving SKILL.md (generated companion files removed)')
      continue
    }
    if (unlinkSkillFile(path)) {
      logger.info({ id: row.id, agentId, path }, 'skill-regen: removed tenant skill from an agent that no longer qualifies')
      out.removed++
    } else {
      out.errors++
    }
  }
  return out
}

/**
 * Remove generated tenant copies whose skill row no longer exists (tenant or
 * skill deleted). A header saying "rewritten from the DB" with no row behind it
 * is a stale cache; a hand edit would have been synced to a row by the hook.
 */
function sweepOrphanTenantFiles(tenantSkillIds: Set<string>, dryRun: boolean): void {
  for (const agentId of agentDirsOnDisk()) {
    const skillsDir = join(AGENTS_BASE_DIR, agentId, '.claude', 'skills')
    let entries: string[] = []
    try { entries = readdirSync(skillsDir) } catch { continue }
    for (const entry of entries) {
      const path = join(skillsDir, entry, 'SKILL.md')
      const content = readTextOrNull(path)
      if (content === null) continue
      const hdr = readGeneratedHeader(content)
      if (!hdr || !hdr.tenant || !hdr.id || tenantSkillIds.has(hdr.id)) continue
      if (dryRun) { logger.info({ id: hdr.id, agentId, path }, 'skill-regen [dry-run]: would remove orphan tenant copy'); continue }
      if (unlinkSkillFile(path)) logger.info({ id: hdr.id, agentId, path }, 'skill-regen: removed orphan tenant skill copy')
    }
  }
}

function removeTenantSkillFiles(id: string, content: string, files: SkillFileRow[]): RemoveGeneratedResult {
  if (!tenantSkillDirName(id)) return { removed: false, reason: 'unrecognized_id' }
  let removed = false
  let modified = false
  for (const agentId of agentDirsOnDisk()) {
    const path = tenantSkillPath(agentId, id)
    if (!path || !existsSync(path)) continue
    const onDisk = readTextOrNull(path)
    const hdr = onDisk === null ? null : readGeneratedHeader(onDisk)
    if (onDisk === null || !hdr || !hdr.tenant || hdr.id !== id) continue
    if (stripGeneratedHeader(onDisk) !== content) {
      logger.warn({ id, agentId, path }, 'skill-regen: deleted tenant skill has a hand-edited copy on disk, leaving it')
      modified = true
      continue
    }
    removeCompanionFiles(dirOfSkillMd(path), files)
    if (unlinkSkillFile(path)) removed = true
    else return { removed, reason: 'unlink_error' }
  }
  if (removed) return { removed: true, reason: null }
  return { removed: false, reason: modified ? 'modified_on_disk' : 'absent' }
}

/**
 * Agent START: write the generated copies of every tenant skill this agent qualifies for
 * (before its session launches, so the loader sees them). Same rules as the bulk regen; the
 * agent does not have to be running yet.
 */
export function generateTenantSkillFilesForAgent(agentId: string, forceEnabled = false): { written: number; skipped: number; errors: number } {
  const total = { written: 0, skipped: 0, errors: 0 }
  if (!SKILL_SQL_REGEN && !forceEnabled) return total
  for (const row of listAllSkills()) {
    if (row.tenant_id === 'fleet' || !tenantSkillQualifiers(row).includes(agentId)) continue
    const out: TenantReconcile = { written: 0, skipped: 0, errors: 0, removed: 0, recipients: 0 }
    writeTenantCopy(row, agentId, safeListSkillFiles(row.id), false, out)
    total.written += out.written; total.skipped += out.skipped; total.errors += out.errors
  }
  return total
}

/**
 * Agent STOP: delete every GENERATED tenant skill copy in this agent's skills directory
 * (SKILL.md and companion files). A hand-edited SKILL.md or companion file is kept (it holds
 * work the DB does not have); a generated copy whose skill row is gone is removed.
 */
export function removeGeneratedTenantSkillFilesForAgent(agentId: string, forceEnabled = false): { removed: number; kept: number; errors: number } {
  const total = { removed: 0, kept: 0, errors: 0 }
  if (!SKILL_SQL_REGEN && !forceEnabled) return total
  if (!SAFE_SEGMENT.test(agentId)) return total
  const skillsDir = join(AGENTS_BASE_DIR, agentId, '.claude', 'skills')
  let entries: string[] = []
  try { entries = readdirSync(skillsDir) } catch { return total }
  const rows = new Map(listAllSkills().map(r => [r.id, r]))
  for (const entry of entries) {
    const path = join(skillsDir, entry, 'SKILL.md')
    const text = readTextOrNull(path)
    const hdr = text === null ? null : readGeneratedHeader(text)
    if (text === null || !hdr || !hdr.tenant || !hdr.id) continue   // not a generated tenant copy
    const row = rows.get(hdr.id)
    if (row) removeCompanionFiles(dirOfSkillMd(path), safeListSkillFiles(row.id))
    if (row && stripGeneratedHeader(text) !== row.content) {
      logger.warn({ id: hdr.id, agentId, path }, 'skill-regen: tenant skill copy was edited by hand, keeping it at agent stop')
      total.kept++
      continue
    }
    if (unlinkSkillFile(path)) total.removed++
    else total.errors++
  }
  return total
}

/**
 * Re-reconcile every tenant skill that a change in tenant_agent_availability
 * can affect (skills owned by, or granted to, the tenant). Called when an agent
 * is enabled/disabled for a tenant.
 */
export function regenTenantSkillFiles(tenantId: string, forceEnabled = false): { written: number; removed: number; errors: number } {
  const total = { written: 0, removed: 0, errors: 0 }
  if (!SKILL_SQL_REGEN && !forceEnabled) return total
  for (const row of listAllSkills()) {
    if (row.tenant_id === 'fleet') continue
    if (row.tenant_id !== tenantId && !listSkillAccess(row.id).some(g => g.tenant_id === tenantId)) continue
    const t = reconcileTenantSkill(row, false)
    total.written += t.written
    total.removed += t.removed
    total.errors += t.errors
  }
  return total
}

/**
 * An availability change moves ONE agent between tenants, which changes whether it is single-tenant
 * for EVERY tenant it serves: enabling a second tenant turns the agent into a shared one (the other
 * tenants' copies on it must go), disabling one can turn it back into a single-tenant agent (its
 * remaining tenant's copies are due). So reconcile the changed tenant AND every tenant the agent
 * serves now, not just the changed one.
 */
export function regenTenantSkillFilesForAgentChange(agentId: string, tenantId: string, forceEnabled = false): { written: number; removed: number; errors: number } {
  const total = { written: 0, removed: 0, errors: 0 }
  const tenants = new Set<string>([tenantId, ...getTenantsForAgent(agentId)])
  for (const t of tenants) {
    const r = regenTenantSkillFiles(t, forceEnabled)
    total.written += r.written; total.removed += r.removed; total.errors += r.errors
  }
  return total
}

/**
 * Verify that every fleet skill in SQL has a readable SKILL.md on disk.
 * Used for the proof step (guardrail 5) before enabling the kill-switch.
 * Returns a list of IDs that are missing from disk.
 */
export function findMissingSkillFiles(): string[] {
  const missing: string[] = []
  let rows
  try {
    rows = listAllSkills().filter(r => r.tenant_id === 'fleet')
  } catch {
    return []
  }
  for (const row of rows) {
    const p = resolveSkillPath(row.id)
    if (!p || !existsSync(p)) missing.push(row.id)
  }
  return missing
}

export interface SkillFileGaps {
  /** Fleet skill ids whose SKILL.md is missing. */
  skillFiles: string[]
  /** "<skill id>:<rel path>" of DB companion files missing (or with an unsafe path) on disk. */
  companionFiles: string[]
  /** "<tenant skill id>@<agent>" of expected tenant copies that are missing. */
  tenantCopies: string[]
}

/**
 * Read-only, quiet gap check between the DB and the generated cache: skills,
 * companion files and tenant copies that exist in the DB but not on disk (the
 * state right after a restore, or with SKILL_SQL_REGEN off). Content drift is
 * not reported here; the regen restores it with a warning.
 */
export function findSkillFileGaps(): SkillFileGaps {
  const gaps: SkillFileGaps = { skillFiles: [], companionFiles: [], tenantCopies: [] }
  let rows: SkillRow[]
  try { rows = listAllSkills() } catch { return gaps }
  const missingCompanions = (id: string, skillDir: string) => {
    for (const f of safeListSkillFiles(id)) {
      const t = companionTarget(skillDir, f.rel_path)
      if (!t || !existsSync(t)) gaps.companionFiles.push(`${id}:${f.rel_path}`)
    }
  }
  for (const row of rows) {
    if (row.tenant_id === 'fleet') {
      const p = resolveSkillPath(row.id)
      if (!p) continue
      if (!existsSync(p)) gaps.skillFiles.push(row.id)
      missingCompanions(row.id, dirOfSkillMd(p))
      continue
    }
    for (const agentId of tenantSkillRecipients(row)) {
      const p = tenantSkillPath(agentId, row.id)
      if (!p) continue
      if (!existsSync(p)) gaps.tenantCopies.push(`${row.id}@${agentId}`)
      missingCompanions(row.id, dirOfSkillMd(p))
    }
  }
  return gaps
}

/**
 * Return the set of agent IDs whose local skills directory exists on disk,
 * so callers can verify the loader would find them.
 */
export function listKnownSkillAgents(): string[] {
  return [MAIN_AGENT_ID, ...listAgentNames()]
}
