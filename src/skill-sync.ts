import { db } from './db/connection.js'
import { getSkill, getSkillFile, countSkillFiles, listSkillAccess, putSkillFile } from './db/tasks.js'
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES_PER_SKILL, normalizeSkillRelPath } from './skill-files.js'
import { stripGeneratedHeader } from './skill-header.js'
import { tenantSkillDirName } from './web/skill-regen.js'

// DB side of scripts/hooks/skill-sql-sync.py: a skill file an agent edited on
// disk is written back to the skills table. The hook keeps the file-system
// half (path -> skill id, generated-header parsing, reading the file) and sends
// the result here, so it never opens the database itself. Unlike PUT
// /api/skills/sql/:id this does NOT regenerate the file on disk: the agent just
// wrote it, and rewriting it under them (adding the generated header) is not
// what a write-back should do. Outcomes that are not an error (a forged tenant
// header, an unknown skill) come back as ok with ignored:true and a message the
// hook logs, exactly like the old direct writes did.

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SKILL_ID = /^(?:global\/[A-Za-z0-9][A-Za-z0-9._-]*|agent\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)$/

export interface SkillSyncResult {
  ok: boolean
  ignored?: boolean
  message: string
}

const done = (message: string): SkillSyncResult => ({ ok: true, message })
const ignored = (message: string): SkillSyncResult => ({ ok: true, ignored: true, message })

/** True when the agent has an enabled availability row for the skill's owning
 *  tenant or for a tenant it is granted to (the recipients regen writes to). */
function agentQualifies(skillId: string, ownerTenant: string, agentId: string): boolean {
  const tenants = [...new Set([ownerTenant, ...listSkillAccess(skillId).map(g => g.tenant_id)])].sort()
  const placeholders = tenants.map(() => '?').join(',')
  return db
    .prepare(`SELECT 1 FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1 AND tenant_id IN (${placeholders})`)
    .get(agentId, ...tenants) !== undefined
}

function touchContent(skillId: string, content: string): void {
  db.prepare('UPDATE skills SET content = ?, updated_at = ? WHERE id = ?')
    .run(stripGeneratedHeader(content), Math.floor(Date.now() / 1000), skillId)
}

/** A plain SKILL.md (global/<dir> or agent/<id>/<dir>): update the row, or create it as a fleet skill. */
export function syncSkillContent(skillId: string, content: string): SkillSyncResult {
  if (!SKILL_ID.test(skillId)) return { ok: false, message: 'skill_id is not a file-backed skill id' }
  if (getSkill(skillId)) {
    touchContent(skillId, content)
  } else {
    const now = Math.floor(Date.now() / 1000)
    const name = skillId.slice(skillId.lastIndexOf('/') + 1)
    db.prepare(`
      INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
      VALUES (?, ?, '', ?, 'fleet', ?, NULL, ?, ?)
    `).run(skillId, name, stripGeneratedHeader(content), skillId.startsWith('global/') ? 1 : 0, now, now)
  }
  return done(`upserted ${skillId}`)
}

/** A generated tenant copy was edited: update THAT tenant row, never create rows.
 *  The header is only a claim an agent could forge, so the edit is applied only
 *  when the copy sits where regen would put it (exact directory name) and the
 *  agent qualifies for the row's tenant (owner or granted). */
export function syncTenantSkill(headerId: string, agentId: string, dirName: string, content: string): SkillSyncResult {
  if (!SEGMENT.test(agentId)) return { ok: false, message: 'agent_id must be a plain agent name' }
  if (dirName !== tenantSkillDirName(headerId)) return ignored(`tenant header id ${headerId} does not match directory ${dirName}, ignored`)
  const row = getSkill(headerId)
  if (!row || row.tenant_id === 'fleet') return ignored(`no tenant skill ${headerId} in the DB, ignored`)
  if (!agentQualifies(headerId, row.tenant_id, agentId)) return ignored(`agent ${agentId} does not qualify for tenant skill ${headerId}, ignored`)
  touchContent(headerId, content)
  return done(`updated tenant skill ${headerId}`)
}

/** A companion file (scripts/, references/, ...) of a skill was edited. Only for
 *  a skill that already has a row (SKILL.md creates rows); for a generated
 *  tenant copy `tenantAgent` is the agent whose directory it sits in. */
export function syncCompanionFile(
  skillId: string, relPath: string, content: Buffer, mode: number | undefined, tenantAgent: string | null,
): SkillSyncResult {
  const rel = normalizeSkillRelPath(relPath)
  if (!rel) return ignored(`companion path ${relPath} not accepted, ignored`)
  if (content.length > MAX_SKILL_FILE_BYTES) return ignored(`companion ${rel} over the size limit, ignored`)
  const row = getSkill(skillId)
  if (!row) return ignored(`no skill ${skillId} in the DB yet, companion ignored`)
  if (tenantAgent !== null) {
    if (!SEGMENT.test(tenantAgent)) return { ok: false, message: 'tenant_agent must be a plain agent name' }
    if (row.tenant_id === 'fleet' || !agentQualifies(skillId, row.tenant_id, tenantAgent)) {
      return ignored(`agent ${tenantAgent} does not qualify for tenant skill ${skillId}, ignored`)
    }
  }
  if (!getSkillFile(skillId, rel)) {
    const n = countSkillFiles(skillId)
    if (n >= MAX_SKILL_FILES_PER_SKILL) return ignored(`skill ${skillId} already has ${n} companion files, ignored`)
  }
  putSkillFile(skillId, rel, content, mode)
  return done(`stored companion ${rel} of ${skillId}`)
}
