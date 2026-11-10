import {
  agentHasEnabledAvailability, countSkillFiles, getSkill, getSkillFile, insertFleetSkillFromFile, listSkillAccess,
  putSkillFile, setSkillContent,
} from './db/tasks.js'
import type { SkillActor } from './db/skill-revisions.js'
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
  /** True when the write-back was queued for review instead of landing live (a distinct outcome from `ignored`: the
   *  hook surfaces this one to the agent as additionalContext, the way it already does for a failed write-back). */
  pending?: boolean
  message: string
}

const done = (message: string): SkillSyncResult => ({ ok: true, message })
const ignored = (message: string): SkillSyncResult => ({ ok: true, ignored: true, message })
const pending = (message: string): SkillSyncResult => ({ ok: true, pending: true, message })

/** True when the agent has an enabled availability row for the skill's owning
 *  tenant or for a tenant it is granted to (the recipients regen writes to). */
async function agentQualifies(skillId: string, ownerTenant: string, agentId: string): Promise<boolean> {
  const tenants = [...new Set([ownerTenant, ...(await listSkillAccess(skillId)).map(g => g.tenant_id)])].sort()
  return agentHasEnabledAvailability(agentId, tenants)
}

/** Every write-back is traced as the calling agent, from the hook endpoint. */
const SYNC_SOURCE = { sourceRef: 'skill-sync' } as const

/** Returns a pending-review SkillSyncResult when the write-back was gated, null when it landed live (or the row was gone). */
async function touchContent(skillId: string, content: string, actor: SkillActor): Promise<SkillSyncResult | null> {
  const result = await setSkillContent(skillId, stripGeneratedHeader(content), Math.floor(Date.now() / 1000), actor, SYNC_SOURCE, { gatePrivilege: true })
  if (result.outcome === 'pending') return pending(`SKILL.md change for ${skillId} queued for review (touches privilege), not yet live in the DB`)
  return null
}

/** A plain SKILL.md (global/<dir> or agent/<id>/<dir>): update the row, or create it as a fleet skill. */
export async function syncSkillContent(skillId: string, content: string, actor: SkillActor): Promise<SkillSyncResult> {
  if (!SKILL_ID.test(skillId)) return { ok: false, message: 'skill_id is not a file-backed skill id' }
  if (await getSkill(skillId)) {
    const gated = await touchContent(skillId, content, actor)
    if (gated) return gated
  } else {
    const now = Math.floor(Date.now() / 1000)
    const name = skillId.slice(skillId.lastIndexOf('/') + 1)
    const created = await insertFleetSkillFromFile(skillId, name, stripGeneratedHeader(content), skillId.startsWith('global/'), now, actor, SYNC_SOURCE, { gatePrivilege: true })
    if (created.outcome === 'pending') return pending(`new skill ${skillId} queued for review (touches privilege), not yet live in the DB`)
  }
  return done(`upserted ${skillId}`)
}

/** A generated tenant copy was edited: update THAT tenant row, never create rows.
 *  The header is only a claim an agent could forge, so the edit is applied only
 *  when the copy sits where regen would put it (exact directory name) and the
 *  agent qualifies for the row's tenant (owner or granted). */
export async function syncTenantSkill(headerId: string, agentId: string, dirName: string, content: string, actor: SkillActor): Promise<SkillSyncResult> {
  if (!SEGMENT.test(agentId)) return { ok: false, message: 'agent_id must be a plain agent name' }
  if (dirName !== tenantSkillDirName(headerId)) return ignored(`tenant header id ${headerId} does not match directory ${dirName}, ignored`)
  const row = await getSkill(headerId)
  if (!row || row.tenant_id === 'fleet') return ignored(`no tenant skill ${headerId} in the DB, ignored`)
  if (!await agentQualifies(headerId, row.tenant_id, agentId)) return ignored(`agent ${agentId} does not qualify for tenant skill ${headerId}, ignored`)
  const gated = await touchContent(headerId, content, actor)
  if (gated) return gated
  return done(`updated tenant skill ${headerId}`)
}

/** A companion file (scripts/, references/, ...) of a skill was edited. Only for
 *  a skill that already has a row (SKILL.md creates rows); for a generated
 *  tenant copy `tenantAgent` is the agent whose directory it sits in. */
export async function syncCompanionFile(
  skillId: string, relPath: string, content: Buffer, mode: number | undefined, tenantAgent: string | null, actor: SkillActor,
): Promise<SkillSyncResult> {
  const rel = normalizeSkillRelPath(relPath)
  if (!rel) return ignored(`companion path ${relPath} not accepted, ignored`)
  if (content.length > MAX_SKILL_FILE_BYTES) return ignored(`companion ${rel} over the size limit, ignored`)
  const row = await getSkill(skillId)
  if (!row) return ignored(`no skill ${skillId} in the DB yet, companion ignored`)
  if (tenantAgent !== null) {
    if (!SEGMENT.test(tenantAgent)) return { ok: false, message: 'tenant_agent must be a plain agent name' }
    if (row.tenant_id === 'fleet' || !await agentQualifies(skillId, row.tenant_id, tenantAgent)) {
      return ignored(`agent ${tenantAgent} does not qualify for tenant skill ${skillId}, ignored`)
    }
  }
  if (!await getSkillFile(skillId, rel)) {
    const n = await countSkillFiles(skillId)
    if (n >= MAX_SKILL_FILES_PER_SKILL) return ignored(`skill ${skillId} already has ${n} companion files, ignored`)
  }
  const result = await putSkillFile(skillId, rel, content, mode, actor, SYNC_SOURCE, { gatePrivilege: true })
  if (result.outcome === 'pending') return pending(`companion ${rel} of ${skillId} queued for review (touches privilege), not yet live in the DB`)
  return done(`stored companion ${rel} of ${skillId}`)
}
