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
 *   4. KILL-SWITCH: SKILL_SQL_REGEN=1 must be set explicitly. Any other
 *      value (including absent) leaves regen disabled -- fail-safe.
 *   5. Path safety: IDs with '..' or absolute-path components are rejected.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { PROJECT_ROOT, MAIN_AGENT_ID, SKILL_SQL_REGEN } from '../config.js'
import { listAllSkills, getSkill } from '../db.js'

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
function resolveSkillPath(id: string): string | null {
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

  let rows
  try {
    rows = listAllSkills().filter(r => r.tenant_id === 'fleet')
  } catch (err) {
    logger.error({ err }, 'skill-regen: failed to query skills table')
    return { enabled: true, written: 0, skipped: 0, errors: 1 }
  }

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
  }

  return { enabled: true, written, skipped, errors }
}

/**
 * Shared write for one (id, path, content) triple: skip if the on-disk
 * content already matches (idempotent), otherwise atomic-write it. Used by
 * both the bulk startup regen and regenSingleSkillFile() below so the two
 * never drift apart.
 */
function writeSkillFileToDisk(id: string, targetPath: string, content: string, dryRun: boolean): 'written' | 'skipped' | 'error' {
  if (existsSync(targetPath)) {
    let onDisk = ''
    try { onDisk = readFileSync(targetPath, 'utf-8') } catch { /* treat as missing */ }
    if (onDisk === content) return 'skipped'
  }

  if (dryRun) {
    logger.info({ id, path: targetPath }, 'skill-regen [dry-run]: would write')
    return 'written'
  }

  try {
    const dir = targetPath.replace(/\/SKILL\.md$/, '')
    mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(targetPath, content)
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
 * migration (kanban 3f52d485). Callers should invoke this right after every
 * createSkill()/updateSkill() so an edit reaches disk (and therefore the
 * Claude Code loader) without waiting for the next startup regen.
 *
 * A no-op (skipped, no warning logged) for skills that were never file-backed
 * to begin with -- tenant-scoped B2B skills (tenant_id !== 'fleet') have no
 * canonical on-disk location, so every dashboard write reaching this
 * function for one of those is expected, not an error.
 *
 * @param forceEnabled Bypass the SKILL_SQL_REGEN kill-switch (CLI/test use only).
 */
export function regenSingleSkillFile(id: string, forceEnabled = false): SingleRegenResult {
  if (!SKILL_SQL_REGEN && !forceEnabled) {
    return { written: false, skipped: true, reason: 'disabled' }
  }

  const row = getSkill(id)
  if (!row) return { written: false, skipped: false, reason: 'not_found' }
  if (row.tenant_id !== 'fleet') return { written: false, skipped: true, reason: 'not_file_backed' }

  const targetPath = resolveSkillPath(id)
  if (!targetPath) return { written: false, skipped: false, reason: 'unrecognized_id' }

  const outcome = writeSkillFileToDisk(id, targetPath, row.content, false)
  if (outcome === 'written') return { written: true, skipped: false, reason: null }
  if (outcome === 'skipped') return { written: false, skipped: true, reason: 'content_equal' }
  return { written: false, skipped: false, reason: 'write_error' }
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

/**
 * Return the set of agent IDs whose local skills directory exists on disk,
 * so callers can verify the loader would find them.
 */
export function listKnownSkillAgents(): string[] {
  return [MAIN_AGENT_ID, ...listAgentNames()]
}
