import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmSync, statSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { agentDir } from '../agent-config.js'
import { generateSkillMd } from '../agent-scaffold.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json } from '../http-helpers.js'
import { sanitizeAgentName, sanitizeSkillName, safeJoin } from '../sanitize.js'
import { regenSingleSkillFile } from '../skill-regen.js'
import { extractSkillArchive, quarantineStagedSkills, removeStage, type ExtractResult } from '../skill-import-quarantine.js'
import { skillActorFromRoute } from '../skill-actor.js'
import type { RouteContext } from './types.js'
import { createSkill, deleteSkill, seedSkillIfAbsent, listAgentOwnedSkills, listGlobalFleetSkills, type SkillRow, type CreateSkillResult } from '../../db.js'

// Marveen's skills live at the global ~/.claude/skills/ path (shared with
// the operator's Claude Code install); sub-agents under their own
// agents/<name>/.claude/skills/. agentDir(MAIN_AGENT_ID) points at the
// non-existent agents/marveen/ folder so we must branch here.
function skillsRootFor(name: string): string {
  return name === MAIN_AGENT_ID
    ? join(homedir(), '.claude', 'skills')
    : join(agentDir(name), '.claude', 'skills')
}
function agentExistsFor(name: string): boolean {
  return name === MAIN_AGENT_ID || existsSync(agentDir(name))
}

// Pull the `description:` field out of a skill's SKILL.md YAML frontmatter so
// the dashboard can show what each skill does. Best-effort: single-line value,
// quotes trimmed, capped so a malformed file can't bloat the response.
function readSkillDescription(skillDir: string): string {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const block = fm ? fm[1] : md.slice(0, 600)
    const m = block.match(/^description:\s*(.+)$/m)
    if (!m) return ''
    return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 300)
  } catch {
    return ''
  }
}

type AgentSkill = {
  name: string
  hasSkillMd: boolean
  description: string
  source: 'agent' | 'global'
  deletable: boolean
}

// Map a skills-table row to the dashboard's AgentSkill shape. Every row
// reachable here has tenant_id 'fleet' (materialize-skills.ts / createSkill
// only ever seed fleet rows for file-backed skills), and regen guarantees a
// fleet row has a matching on-disk SKILL.md, so hasSkillMd is always true.
function skillRowToAgentSkill(row: SkillRow, source: 'agent' | 'global', deletable: boolean): AgentSkill {
  return {
    name: row.name,
    hasSkillMd: row.tenant_id === 'fleet',
    description: row.description,
    source,
    deletable,
  }
}

export async function tryHandleAgentsSkills(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  // Who is writing, for the skill_revisions trail: what the credential proves, never a claimed name.
  const actor = skillActorFromRoute(ctx)

  const skillImportMatch = path.match(/^\/api\/agents\/([^/]+)\/skills\/import$/)
  if (skillImportMatch && method === 'POST') {
    const name = sanitizeAgentName(decodeURIComponent(skillImportMatch[1]))
    if (!name) { json(res, { error: 'invalid_value', field: 'name', hint: 'Invalid agent name' }, 400); return true }
    if (!agentExistsFor(name)) { json(res, { error: 'not_found', hint: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''
    const { file } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'required', field: 'file', hint: 'No file uploaded' }, 400); return true }

    let staged: ExtractResult | null = null
    try {
      // Unzipped OUTSIDE every skills directory and recorded as a pending revision (quarantine): nothing of the archive
      // is written where an agent loads skills from until a person activates it.
      staged = extractSkillArchive(file.data)
      if (staged.kind === 'invalid') { json(res, { error: 'invalid_value', field: 'file', hint: staged.hint }, 400); return true }
      const importIsGlobal = name === MAIN_AGENT_ID
      // A directory that is already on disk holds the name too (a skill the database does not know yet): 409, nothing recorded.
      for (const td of staged.skills) {
        if (existsSync(join(skillsRootFor(name), td))) {
          json(res, { error: 'conflict', hint: `Skill already exists: ${td}. Delete it first if you want to overwrite.` }, 409)
          return true
        }
      }
      const outcome = await quarantineStagedSkills(staged, {
        idFor: (dir) => importIsGlobal ? `global/${dir}` : `agent/${name}/${dir}`, isGlobal: importIsGlobal,
        describe: (dir) => readSkillDescription(dir),
        // An archive import is traced as an import (source: the skill directory name in the archive), by whoever sent it.
        actor: { kind: 'import', id: actor.id },
      })
      if (outcome.conflict) {
        json(res, { error: 'conflict', hint: `Skill already exists: ${outcome.conflict}. Delete it first if you want to overwrite.` }, 409)
        return true
      }
      if (outcome.quarantined.length === 0 && outcome.refused.length > 0) {
        json(res, { error: 'invalid_value', field: 'file', hint: outcome.refused[0].hint }, 400)
        return true
      }
      const names = outcome.quarantined.map((q) => q.name)
      logger.info({ name, skills: names }, 'Skill(s) imported into quarantine')
      // 202, not 200: the skill is NOT saved as a usable skill, it waits for a review.
      json(res, { ok: true, status: 'pending_review', imported: names, skills: outcome.quarantined, refused: outcome.refused }, 202)
      return true
    } catch (err) {
      logger.error({ err }, 'Failed to import skill')
      json(res, { error: 'internal_error', hint: 'Failed to extract .skill file' }, 500)
      return true
    } finally {
      if (staged && staged.kind === 'ok') removeStage(staged.stage)
    }
  }

  const skillActionMatch = path.match(/^\/api\/agents\/([^/]+)\/skills\/([^/]+)$/)
  if (skillActionMatch && method === 'DELETE') {
    const name = sanitizeAgentName(decodeURIComponent(skillActionMatch[1]))
    const skillName = sanitizeSkillName(decodeURIComponent(skillActionMatch[2]))
    if (!name || !skillName) { json(res, { error: 'invalid_value', hint: 'Invalid agent or skill name' }, 400); return true }
    if (!agentExistsFor(name)) { json(res, { error: 'not_found', hint: 'Agent not found' }, 404); return true }
    let skillDir: string
    try {
      skillDir = safeJoin(skillsRootFor(name), skillName)
    } catch {
      json(res, { error: 'invalid_value', field: 'skillName', hint: 'Invalid skill path' }, 400)
      return true
    }
    if (!existsSync(skillDir)) { json(res, { error: 'not_found', hint: 'Skill not found' }, 404); return true }
    const deleteSqlId = name === MAIN_AGENT_ID ? `global/${skillName}` : `agent/${name}/${skillName}`
    await deleteSkill(deleteSqlId, actor)
    rmSync(skillDir, { recursive: true, force: true })
    json(res, { ok: true })
    return true
  }

  const skillsMatch = path.match(/^\/api\/agents\/([^/]+)\/skills$/)
  if (skillsMatch && method === 'GET') {
    const name = decodeURIComponent(skillsMatch[1])
    if (!agentExistsFor(name)) { json(res, { error: 'not_found', hint: 'Agent not found' }, 404); return true }
    let skills: AgentSkill[]
    if (name === MAIN_AGENT_ID) {
      // The main agent's skill root IS the global ~/.claude/skills dir; these
      // skills are deletable from this view.
      skills = (await listGlobalFleetSkills()).map((row) => skillRowToAgentSkill(row, 'global', true))
    } else {
      // Sub-agents own a small agents/<name>/.claude/skills set (deletable) but
      // at runtime ALSO inherit every global ~/.claude/skills entry. List both;
      // the inherited ones are not deletable from a single agent's view (they
      // are shared) and a local skill shadows a global one of the same name.
      const local = (await listAgentOwnedSkills(name)).map((row) => skillRowToAgentSkill(row, 'agent', true))
      const localNames = new Set(local.map((s) => s.name))
      const inherited = (await listGlobalFleetSkills())
        .map((row) => skillRowToAgentSkill(row, 'global', false))
        .filter((s) => !localNames.has(s.name))
      skills = [...local, ...inherited]
    }
    json(res, skills)
    return true
  }

  if (skillsMatch && method === 'POST') {
    const agentName = decodeURIComponent(skillsMatch[1])
    if (!agentExistsFor(agentName)) { json(res, { error: 'not_found', hint: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const { name: rawSkillName, description } = JSON.parse(body.toString()) as { name: string; description: string }
    const skillName = sanitizeSkillName(rawSkillName || '')
    if (!skillName) { json(res, { error: 'required', field: 'name', hint: 'Skill name is required' }, 400); return true }
    if (!description) { json(res, { error: 'required', field: 'description', hint: 'Skill description is required' }, 400); return true }

    const skillDir = join(skillsRootFor(agentName), skillName)
    if (existsSync(skillDir)) { json(res, { error: 'conflict', hint: 'Skill already exists' }, 409); return true }

    let skillMd: string
    try {
      skillMd = await generateSkillMd(skillName, description)
    } catch {
      json(res, { error: 'internal_error', hint: 'Failed to generate skill' }, 500)
      return true
    }

    const agentSqlId = agentName === MAIN_AGENT_ID ? `global/${skillName}` : `agent/${agentName}/${skillName}`
    const agentIsGlobal = agentName === MAIN_AGENT_ID
    let createResult: CreateSkillResult
    try {
      createResult = await createSkill({ id: agentSqlId, name: skillName, description, content: skillMd, tenant_id: 'fleet', is_global: agentIsGlobal }, actor, {}, { gatePrivilege: true })
    } catch {
      json(res, { error: 'conflict', hint: 'Skill already exists' }, 409)
      return true
    }
    if (createResult.outcome === 'pending') {
      json(res, { ok: true, status: 'pending_review', revision: createResult.revision.seq, touches_privilege: createResult.revision.touches_privilege === 1 }, 202)
      return true
    }

    // SQL is the source of truth (Phase 4 of the file->SQL-only migration);
    // no direct file write here. regenSingleSkillFile pushes the SQL row to disk immediately
    // (a no-op, logged, while SKILL_SQL_REGEN=0) rather than the route
    // writing the file itself -- matches the /api/skills/sql POST precedent.
    await regenSingleSkillFile(agentSqlId)

    json(res, { ok: true, name: skillName })
    return true
  }

  return false
}
