import { createReadStream, existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmSync, statSync, lstatSync } from 'node:fs'
import { join, sep, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { AGENTS_BASE_DIR, listAgentNames, readFileOr, agentDir } from '../agent-config.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../../config.js'
import { generateSkillMd } from '../agent-scaffold.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, RequestBodyTooLargeError } from '../http-helpers.js'
import { sanitizeSkillName, shellEscape } from '../sanitize.js'
import { regenSingleSkillFile, removeGeneratedSkillFile, removeGeneratedCompanionFile, importCompanionFilesOfDir } from '../skill-regen.js'
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES_PER_SKILL, normalizeSkillRelPath } from '../../skill-files.js'
import type { RouteContext } from './types.js'
import {
  createSkill, getSkill, updateSkill, deleteSkill, seedSkillIfAbsent,
  listSkillsForTenant, listAllSkills,
  grantSkillAccess, revokeSkillAccess, listSkillAccess,
  listSkillFiles, getSkillFile, putSkillFile, deleteSkillFile, countSkillFiles,
} from '../../db.js'

function parseFrontmatterField(content: string, field: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return ''
  const fm = fmMatch[1]
  const line = fm.match(new RegExp(`^${field}:\\s*(.+)`, 'im'))
  if (!line) return ''
  let val = line[1].trim()
  if (val.startsWith('"')) {
    const q = val.match(/^"(.*)"/)
    return q ? q[1].trim() : val.replace(/^"|"$/g, '').trim()
  }
  if (val.startsWith("'")) {
    const q = val.match(/^'(.*)'/)
    return q ? q[1].trim() : val.replace(/^'|'$/g, '').trim()
  }
  return val
}

/** Directory name, agent and scope of a file-backed skill id, or null when the id is not one (or is path-unsafe). */
function fileBackedSkillSpec(id: string): { name: string; isGlobal: boolean } | null {
  const parts = id.split('/')
  const okName = (n: string) => n !== '' && sanitizeSkillName(n) === n
  if (parts.length === 2 && parts[0] === 'global' && okName(parts[1])) return { name: parts[1], isGlobal: true }
  if (parts.length === 3 && parts[0] === 'agent' && okName(parts[2]) && (parts[1] === MAIN_AGENT_ID || listAgentNames().includes(parts[1]))) {
    return { name: parts[2], isGlobal: false }
  }
  return null
}

function parseSkillDescription(content: string): string {
  return parseFrontmatterField(content, 'description')
}

function parseSkillKeywords(content: string): string[] {
  const raw = parseFrontmatterField(content, 'keywords')
  if (!raw) return []
  return raw.split(',').map(k => k.trim()).filter(Boolean)
}

// Skills are stored in SQL and mirrored to disk for the Claude Code loader --
// derive per-agent coverage for a skill name from the `agent/<agentId>/<name>`
// id scheme instead of statting each agent's on-disk skills directory.
function getSkillAgents(skillDirName: string): string[] {
  const agents: string[] = []
  for (const row of listAllSkills()) {
    const parts = row.id.split('/')
    if (parts.length === 3 && parts[0] === 'agent' && parts[2] === skillDirName) {
      agents.push(parts[1])
    }
  }
  return agents
}

export async function tryHandleSkills(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/skills' && method === 'GET') {
    type SkillEntry = {
      name: string
      label: string
      description: string
      agents: string[]
      keywords: string[]
      path: string
      mtime: number
      source: 'user' | 'plugin'
      pluginPackage?: string
    }
    const skills: SkillEntry[] = []

    const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    if (existsSync(USER_SKILLS_DIR)) {
      const SKIP_DIRS = new Set(['skills', 'temp_skills', 'tmp_skills', '.skill-index.md'])
      const dirs = readdirSync(USER_SKILLS_DIR).filter(f => {
        if (SKIP_DIRS.has(f)) return false
        if (f.startsWith('.')) return false
        try { return statSync(join(USER_SKILLS_DIR, f)).isDirectory() } catch { return false }
      })
      // Global user skills are available to every agent via shared HOME --
      // no per-agent copy exists. Show all fleet agent names as coverage.
      const allAgents = listAgentNames()
      for (const dir of dirs) {
        const skillMdPath = join(USER_SKILLS_DIR, dir, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue
        const content = readFileOr(skillMdPath, '')
        let mtime = 0
        try { mtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
        skills.push({
          name: dir,
          label: dir,
          description: parseSkillDescription(content),
          keywords: parseSkillKeywords(content),
          agents: allAgents,
          path: join(USER_SKILLS_DIR, dir),
          mtime,
          source: 'user',
        })
      }
    }

    const PLUGINS_CACHE_DIR = join(homedir(), '.claude', 'plugins', 'cache')
    if (existsSync(PLUGINS_CACHE_DIR)) {
      const walkForSkills = (dir: string, depth: number, packagePath: string[]): void => {
        if (depth > 4) return
        let entries: string[] = []
        try { entries = readdirSync(dir) } catch { return }
        if (entries.includes('skills')) {
          const skillsDir = join(dir, 'skills')
          let skillDirs: string[] = []
          try { skillDirs = readdirSync(skillsDir) } catch { /* no-op */ }
          for (const sd of skillDirs) {
            if (sd.startsWith('.')) continue
            const skillDirPath = join(skillsDir, sd)
            try { if (!statSync(skillDirPath).isDirectory()) continue } catch { continue }
            const skillMdPath = join(skillDirPath, 'SKILL.md')
            if (!existsSync(skillMdPath)) continue
            const pluginPackage = packagePath.join('/')
            // Treat segments that look like a version (semver, v-prefix, rc/beta/etc.)
            // as the version, and the segment before them as the plugin id.
            const VERSION_LIKE = /^(?:\d|v\d|(?:rc|beta|alpha|pre|snapshot)(?:[.\-_]|\d|$))/i
            const lastIdx = packagePath.length - 1
            let shortPluginIdx = lastIdx
            if (lastIdx >= 1 && VERSION_LIKE.test(packagePath[lastIdx] || '')) {
              shortPluginIdx = lastIdx - 1
            }
            const shortPlugin = packagePath[shortPluginIdx] || 'plugin'
            const pluginContent = readFileOr(skillMdPath, '')
            let pluginMtime = 0
            try { pluginMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
            skills.push({
              name: pluginPackage ? `${pluginPackage}:${sd}` : sd,
              label: `${shortPlugin}:${sd}`,
              description: parseSkillDescription(pluginContent),
              keywords: parseSkillKeywords(pluginContent),
              agents: [],
              path: skillDirPath,
              mtime: pluginMtime,
              source: 'plugin',
              pluginPackage,
            })
          }
          return
        }
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'skills') continue
          const next = join(dir, entry)
          try {
            if (!statSync(next).isDirectory()) continue
          } catch { continue }
          walkForSkills(next, depth + 1, packagePath.concat(entry))
        }
      }
      walkForSkills(PLUGINS_CACHE_DIR, 0, [])
    }

    skills.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'user' ? -1 : 1
      return (a.label || a.name).localeCompare(b.label || b.name)
    })
    json(res, skills)
    return true
  }

  // Return all local (agent-specific) skills across the whole fleet.
  // Must be matched before /:name so "local" is not treated as a skill name.
  if (path === '/api/skills/local' && method === 'GET') {
    type LocalSkillEntry = {
      name: string
      label: string
      agentId: string
      description: string
      keywords: string[]
      mtime: number
      source: 'agent'
    }
    const result: LocalSkillEntry[] = []
    // Prepend MAIN_AGENT_ID explicitly: listAgentNames() scans AGENTS_BASE_DIR
    // subdirectories, so the main agent (which lives in PROJECT_ROOT, not under
    // agents/<id>/) is never returned by that call.
    const subAgentNames = listAgentNames()
    const allAgentNames = subAgentNames.includes(MAIN_AGENT_ID)
      ? subAgentNames
      : [MAIN_AGENT_ID, ...subAgentNames]
    for (const agentName of allAgentNames) {
      // The main agent's local skills live at PROJECT_ROOT/.claude/skills (not
      // under agents/<id>/, which does not exist). Same pattern as CLAUDE.md path
      // resolution in ensureAutonomySection.
      const skillsDir = agentName === MAIN_AGENT_ID
        ? join(PROJECT_ROOT, '.claude', 'skills')
        : join(agentDir(agentName), '.claude', 'skills')
      if (!existsSync(skillsDir)) continue
      let entries: string[] = []
      try { entries = readdirSync(skillsDir) } catch { continue }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue
        const skillDirPath = join(skillsDir, entry)
        try { if (!statSync(skillDirPath).isDirectory()) continue } catch { continue }
        const skillMdPath = join(skillDirPath, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue
        const content = readFileOr(skillMdPath, '')
        let mtime = 0
        try { mtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
        result.push({
          name: entry,
          label: entry,
          agentId: agentName,
          description: parseSkillDescription(content),
          keywords: parseSkillKeywords(content),
          mtime,
          source: 'agent',
        })
      }
    }
    result.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name))
    json(res, result)
    return true
  }

  // Export must be matched before the generic /:name detail route, otherwise
  // the detail handler intercepts GET /api/skills/export as skillName="export".
  if (path === '/api/skills/export' && method === 'GET') {
    const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    if (!existsSync(USER_SKILLS_DIR)) {
      json(res, { error: 'not_found', hint: 'No user skills directory' }, 404)
      return true
    }
    const tmpZip = join(tmpdir(), `skills-export-${randomUUID()}.zip`)
    try {
      execSync(
        `cd ${shellEscape(USER_SKILLS_DIR)} && zip -r ${shellEscape(tmpZip)} . --include "*/SKILL.md" --include "*/references/*"`,
        { timeout: 15000 }
      )
      const stat = statSync(tmpZip)
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', 'attachment; filename="skills-export.zip"')
      res.setHeader('Content-Length', stat.size)
      const stream = createReadStream(tmpZip)
      stream.on('end', () => { try { unlinkSync(tmpZip) } catch { /* no-op */ } })
      stream.on('error', () => { try { unlinkSync(tmpZip) } catch { /* no-op */ } })
      stream.pipe(res)
    } catch (err) {
      try { unlinkSync(tmpZip) } catch { /* no-op */ }
      logger.error({ err }, 'Skills export failed')
      json(res, { error: 'internal_error', hint: 'Export failed' }, 500)
    }
    return true
  }

  // 'sql' is a reserved segment handled by the SQL-skills block below; exclude it
  // here so GET /api/skills/sql reaches the correct handler instead of 404ing.
  const globalSkillDetailMatch = path.match(/^\/api\/skills\/(?!sql(?:\/|$))([^/]+)$/)
  if (globalSkillDetailMatch && method === 'GET') {
    const skillName = decodeURIComponent(globalSkillDetailMatch[1])

    // When ?agent=<id> is supplied, resolve from that agent's local skills dir.
    const agentParam = ctx.url.searchParams.get('agent')
    if (agentParam) {
      const validAgentIds = new Set([MAIN_AGENT_ID, ...listAgentNames()])
      if (!validAgentIds.has(agentParam)) {
        json(res, { error: 'not_found', hint: 'Skill not found' }, 404)
        return true
      }
      const agentSkillsRoot = agentParam === MAIN_AGENT_ID
        ? join(PROJECT_ROOT, '.claude', 'skills')
        : join(agentDir(agentParam), '.claude', 'skills')
      const skillDir = join(agentSkillsRoot, skillName)
      if (!skillDir.startsWith(agentSkillsRoot + sep)) {
        json(res, { error: 'not_found', hint: 'Skill not found' }, 404)
        return true
      }
      const skillMdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) { json(res, { error: 'not_found', hint: 'Skill not found' }, 404); return true }
      const content = readFileOr(skillMdPath, '')
      const files: string[] = []
      try { for (const entry of readdirSync(skillDir)) files.push(entry) } catch { /* no-op */ }
      let agentDetailMtime = 0
      try { agentDetailMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
      json(res, {
        name: skillName,
        description: parseSkillDescription(content),
        keywords: parseSkillKeywords(content),
        content,
        agents: [],
        agentId: agentParam,
        path: skillDir,
        mtime: agentDetailMtime,
        files,
        source: 'agent',
      })
      return true
    }

    if (skillName.includes(':')) {
      const lastColon = skillName.lastIndexOf(':')
      const pluginPath = skillName.slice(0, lastColon)
      const skillBasename = skillName.slice(lastColon + 1)
      const PLUGINS_CACHE_DIR = join(homedir(), '.claude', 'plugins', 'cache')
      const skillDir = join(PLUGINS_CACHE_DIR, ...pluginPath.split('/'), 'skills', skillBasename)
      if (!skillDir.startsWith(PLUGINS_CACHE_DIR + sep)) {
        json(res, { error: 'not_found', hint: 'Skill not found' }, 404)
        return true
      }
      const skillMdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) { json(res, { error: 'not_found', hint: 'Skill not found' }, 404); return true }
      const content = readFileOr(skillMdPath, '')
      const files: string[] = []
      try { for (const entry of readdirSync(skillDir)) files.push(entry) } catch { /* no-op */ }
      let pluginDetailMtime = 0
      try { pluginDetailMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }
      json(res, {
        name: skillName,
        description: parseSkillDescription(content),
        keywords: parseSkillKeywords(content),
        content,
        agents: [],
        path: skillDir,
        mtime: pluginDetailMtime,
        files,
        source: 'plugin',
        pluginPackage: pluginPath,
      })
      return true
    }

    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const skillDir = join(GLOBAL_SKILLS_DIR, skillName)
    if (!skillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'not_found', hint: 'Skill not found' }, 404)
      return true
    }
    if (!existsSync(skillDir)) { json(res, { error: 'not_found', hint: 'Skill not found' }, 404); return true }

    const skillMdPath = join(skillDir, 'SKILL.md')
    const content = readFileOr(skillMdPath, '')
    const description = parseSkillDescription(content)
    const keywords = parseSkillKeywords(content)
    let userDetailMtime = 0
    try { userDetailMtime = statSync(skillMdPath).mtimeMs } catch { /* no-op */ }

    const files: string[] = []
    try {
      for (const entry of readdirSync(skillDir)) files.push(entry)
    } catch { /* empty */ }

    json(res, {
      name: skillName,
      description,
      keywords,
      content,
      agents: getSkillAgents(skillName),
      path: skillDir,
      mtime: userDetailMtime,
      files,
      source: 'user',
    })
    return true
  }

  if (path === '/api/skills' && method === 'POST') {
    const body = await readBody(req)
    const { name: rawSkillName, description } = JSON.parse(body.toString()) as { name: string; description: string }
    const skillName = sanitizeSkillName(rawSkillName || '')
    if (!skillName) { json(res, { error: 'required', field: 'name', hint: 'Skill name is required' }, 400); return true }
    if (!description) { json(res, { error: 'required', field: 'description', hint: 'Skill description is required' }, 400); return true }

    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const skillDir = join(GLOBAL_SKILLS_DIR, skillName)
    if (!skillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'invalid_value', field: 'name', hint: 'Invalid skill name' }, 400)
      return true
    }
    if (existsSync(skillDir)) { json(res, { error: 'conflict', hint: 'Skill already exists' }, 409); return true }

    let skillMd: string
    try {
      skillMd = await generateSkillMd(skillName, description)
    } catch {
      json(res, { error: 'internal_error', hint: 'Failed to generate skill' }, 500)
      return true
    }

    const sqlId = `global/${skillName}`
    try {
      createSkill({ id: sqlId, name: skillName, description, content: skillMd, tenant_id: 'fleet', is_global: true })
    } catch {
      json(res, { error: 'conflict', hint: 'Skill already exists' }, 409)
      return true
    }

    // SQL is the source of truth (Phase 4 of the file->SQL-only migration);
    // no direct file write here, matches the /api/skills/sql POST precedent above.
    regenSingleSkillFile(sqlId)

    json(res, { ok: true, name: skillName })
    return true
  }

  if (path === '/api/skills/import' && method === 'POST') {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''
    const { file } = parseMultipart(body, contentType)
    if (!file) { json(res, { error: 'required', field: 'file', hint: 'No file uploaded' }, 400); return true }

    const skillsDir = join(homedir(), '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })

    const tmpPath = join(skillsDir, `_import_${randomUUID()}.zip`)
    const before = new Set(readdirSync(skillsDir))
    try {
      writeFileSync(tmpPath, file.data)
      const listOutput = execSync(`unzip -Z1 "${tmpPath}" 2>&1`, { timeout: 5000, encoding: 'utf-8' })
      const entries = listOutput.split('\n').map(l => l.trim()).filter(Boolean)
      for (const entry of entries) {
        if (entry.includes('..') || entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
          unlinkSync(tmpPath)
          json(res, { error: 'invalid_value', field: 'file', hint: 'Invalid skill file: path traversal detected' }, 400)
          return true
        }
      }
      const topLevel = new Set<string>()
      for (const entry of entries) {
        const seg = entry.split('/')[0]
        if (seg) topLevel.add(seg)
      }
      for (const td of topLevel) {
        if (before.has(td)) {
          unlinkSync(tmpPath)
          json(res, {
            error: 'conflict',
            hint: `Skill already exists: ${td}. Delete it first if you want to overwrite.`,
          }, 409)
          return true
        }
      }
      execSync(`unzip -o "${tmpPath}" -d "${skillsDir}"`, { timeout: 10000 })
      unlinkSync(tmpPath)

      const after = readdirSync(skillsDir).filter(f => !before.has(f))
      const rejectSymlinks = (dir: string): boolean => {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry)
          const st = lstatSync(p)
          if (st.isSymbolicLink()) return true
          if (st.isDirectory() && rejectSymlinks(p)) return true
        }
        return false
      }
      const tainted: string[] = []
      for (const f of after) {
        const p = join(skillsDir, f)
        try {
          if (lstatSync(p).isSymbolicLink() || (statSync(p).isDirectory() && rejectSymlinks(p))) {
            tainted.push(f)
          }
        } catch { /* ignored */ }
      }
      if (tainted.length > 0) {
        for (const f of after) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
        json(res, { error: 'invalid_value', field: 'file', hint: 'Invalid skill file: symlink entries rejected' }, 400)
        return true
      }

      const extracted = after.filter(f => {
        const p = join(skillsDir, f)
        try { return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')) } catch { return false }
      })
      if (extracted.length === 0) {
        for (const f of after) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
        json(res, { error: 'invalid_value', field: 'file', hint: 'No valid skill (SKILL.md) found in archive' }, 400)
        return true
      }

      for (const dirName of extracted) {
        const skillMdPath = join(skillsDir, dirName, 'SKILL.md')
        const content = readFileOr(skillMdPath, '')
        const desc = parseFrontmatterField(content, 'description')
        try {
          seedSkillIfAbsent({ id: `global/${dirName}`, name: dirName, description: desc, content, tenant_id: 'fleet', is_global: true })
          // scripts/, references/ ... of the archive belong in the DB too (skill_files).
          importCompanionFilesOfDir(`global/${dirName}`, join(skillsDir, dirName))
        } catch (sqlErr) {
          logger.warn({ dirName, err: sqlErr }, 'Failed to upsert imported skill into SQL')
        }
      }

      logger.info({ skills: extracted }, 'Global skill(s) imported')
      json(res, { ok: true, imported: extracted })
      return true
    } catch (err) {
      try { unlinkSync(tmpPath) } catch { /* ignored */ }
      try {
        const leftover = readdirSync(skillsDir).filter(f => !before.has(f))
        for (const f of leftover) {
          try { rmSync(join(skillsDir, f), { recursive: true, force: true }) } catch { /* best effort */ }
        }
      } catch { /* dir gone or unreadable; nothing to do */ }
      logger.error({ err }, 'Failed to import global skill')
      json(res, { error: 'internal_error', hint: 'Failed to extract .skill file' }, 500)
      return true
    }
  }

  const globalSkillAssignMatch = path.match(/^\/api\/skills\/([^/]+)\/assign$/)
  if (globalSkillAssignMatch && method === 'POST') {
    const skillName = decodeURIComponent(globalSkillAssignMatch[1])
    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const globalSkillDir = join(GLOBAL_SKILLS_DIR, skillName)

    if (!globalSkillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'not_found', hint: 'Skill not found' }, 404)
      return true
    }

    if (!existsSync(globalSkillDir)) { json(res, { error: 'not_found', hint: 'Skill not found' }, 404); return true }

    const body = await readBody(req)
    const { agents: targetAgents } = JSON.parse(body.toString()) as { agents: string[] }

    const allAgentNames = listAgentNames()

    for (const agentName of targetAgents) {
      if (!allAgentNames.includes(agentName)) continue
      const agentSkillsDir = join(AGENTS_BASE_DIR, agentName, '.claude', 'skills')
      mkdirSync(agentSkillsDir, { recursive: true })
      const destDir = join(agentSkillsDir, skillName)
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
      execSync(`cp -r ${shellEscape(globalSkillDir)} ${shellEscape(destDir)}`, { timeout: 10000 })
      // Companion files (scripts/, references/) still travel via the copy above
      // until they live in the DB; SKILL.md is registered as the agent-local row
      // so the DB, not the copy, is what the agent's skill is generated from.
      const globalRow = getSkill(`global/${skillName}`)
      if (globalRow) {
        const localId = `agent/${agentName}/${skillName}`
        if (getSkill(localId)) updateSkill(localId, { content: globalRow.content, description: globalRow.description })
        else createSkill({ id: localId, name: skillName, description: globalRow.description, content: globalRow.content, tenant_id: 'fleet', is_global: false })
        regenSingleSkillFile(localId, true)
      }
    }

    for (const agentName of allAgentNames) {
      if (targetAgents.includes(agentName)) continue
      const agentSkillDir = join(AGENTS_BASE_DIR, agentName, '.claude', 'skills', skillName)
      if (existsSync(agentSkillDir)) {
        rmSync(agentSkillDir, { recursive: true, force: true })
        deleteSkill(`agent/${agentName}/${skillName}`)
      }
    }

    logger.info({ skillName, agents: targetAgents }, 'Skill assignment updated')
    json(res, { ok: true })
    return true
  }

  const globalSkillPutMatch = path.match(/^\/api\/skills\/([^/]+)$/)
  if (globalSkillPutMatch && method === 'PUT') {
    const skillName = decodeURIComponent(globalSkillPutMatch[1])
    if (skillName.includes(':')) {
      json(res, { error: 'forbidden', hint: 'Plugin skills cannot be edited' }, 403)
      return true
    }

    const agentPutParam = ctx.url.searchParams.get('agent')
    if (agentPutParam) {
      const validPutAgentIds = new Set([MAIN_AGENT_ID, ...listAgentNames()])
      if (!validPutAgentIds.has(agentPutParam)) {
        json(res, { error: 'not_found', hint: 'Skill not found' }, 404)
        return true
      }
      const agentSkillsRoot = agentPutParam === MAIN_AGENT_ID
        ? join(PROJECT_ROOT, '.claude', 'skills')
        : join(agentDir(agentPutParam), '.claude', 'skills')
      const skillDir = join(agentSkillsRoot, skillName)
      if (!skillDir.startsWith(agentSkillsRoot + sep)) {
        json(res, { error: 'invalid_value', field: 'name', hint: 'Invalid skill name' }, 400)
        return true
      }
      if (!existsSync(skillDir)) { json(res, { error: 'not_found', hint: 'Skill not found' }, 404); return true }
      const body = await readBody(req)
      const { content } = JSON.parse(body.toString()) as { content: string }
      if (typeof content !== 'string') { json(res, { error: 'required', field: 'content', hint: 'content is required' }, 400); return true }
      const agentSqlId = `agent/${agentPutParam}/${skillName}`
      const agentDesc = parseFrontmatterField(content, 'description')
      if (getSkill(agentSqlId)) {
        updateSkill(agentSqlId, { content, description: agentDesc })
      } else {
        createSkill({ id: agentSqlId, name: skillName, description: agentDesc, content, tenant_id: 'fleet', is_global: false })
      }
      // DB-first: the row above is the source of truth, the file is generated
      // from it. forceEnabled: this is an explicit user edit of an existing
      // file-backed skill, which always reached disk; the SKILL_SQL_REGEN
      // switch only governs the automatic write-back, not this.
      const agentRegen = regenSingleSkillFile(agentSqlId, true)
      if (agentRegen.reason === 'write_error' || agentRegen.reason === 'unrecognized_id') {
        logger.error({ skillName, agentId: agentPutParam, reason: agentRegen.reason }, 'Agent-local skill saved to SQL but file generation failed')
        json(res, { error: 'internal_error', hint: 'Saved, but generating the skill file failed' }, 500)
        return true
      }
      logger.info({ skillName, agentId: agentPutParam }, 'Agent-local skill updated via dashboard')
      json(res, { ok: true })
      return true
    }

    const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
    const skillDir = join(GLOBAL_SKILLS_DIR, skillName)
    if (!skillDir.startsWith(GLOBAL_SKILLS_DIR + sep)) {
      json(res, { error: 'invalid_value', field: 'name', hint: 'Invalid skill name' }, 400)
      return true
    }
    if (!existsSync(skillDir)) { json(res, { error: 'not_found', hint: 'Skill not found' }, 404); return true }
    const body = await readBody(req)
    const { content } = JSON.parse(body.toString()) as { content: string }
    if (typeof content !== 'string') { json(res, { error: 'required', field: 'content', hint: 'content is required' }, 400); return true }
    const globalSqlId = `global/${skillName}`
    const globalDesc = parseFrontmatterField(content, 'description')
    if (getSkill(globalSqlId)) {
      updateSkill(globalSqlId, { content, description: globalDesc })
    } else {
      createSkill({ id: globalSqlId, name: skillName, description: globalDesc, content, tenant_id: 'fleet', is_global: true })
    }
    // DB-first (see the agent-local branch above): generate the file from the row.
    const globalRegen = regenSingleSkillFile(globalSqlId, true)
    if (globalRegen.reason === 'write_error' || globalRegen.reason === 'unrecognized_id') {
      logger.error({ skillName, reason: globalRegen.reason }, 'Skill saved to SQL but file generation failed')
      json(res, { error: 'internal_error', hint: 'Saved, but generating the skill file failed' }, 500)
      return true
    }
    logger.info({ skillName }, 'Skill updated via dashboard')
    json(res, { ok: true })
    return true
  }

  // --- SQL-backed B2B skills (716) ------------------------------------------
  // Auth: admin sees everything; tenant session sees own + granted skills.
  // Endpoints: /api/skills/sql[/:id[/access[/:tenantId]]]

  const isAdmin = ctx.role === 'admin'
  const callerTenantId = ctx.tenantId ?? null

  // A fleet_agent token (an agent's own credential) may change only the skills of ITS OWN agent
  // ("agent/<token agent>/<name>", fleet tenant). It may read those plus the fleet-wide global ones.
  // It never writes a global skill, another agent's skill or a tenant-level skill (those are read by
  // other agents' sessions, so a write there would be a way into them): that stays admin work.
  const fleetAgent = ctx.role === 'fleet_agent'
  const isOwnAgentSkill = (skillId: string): boolean =>
    fleetAgent && !!ctx.tokenAgentId && skillId.startsWith(`agent/${ctx.tokenAgentId}/`) && fileBackedSkillSpec(skillId) !== null
  const fleetReadable = (skillId: string, skillTenant: string): boolean =>
    fleetAgent && skillTenant === 'fleet' && (skillId.startsWith('global/') || isOwnAgentSkill(skillId))

  // Skill ids contain '/' ("global/<dir>", "agent/<id>/<dir>"), so clients send
  // them percent-encoded (encodeURIComponent) as ONE path segment; the raw
  // '/' form cannot be matched by the [^/]+ segments below. url.pathname keeps
  // %2F intact, so decoding here is the only decode. A malformed escape
  // ("%", "%zz") is a client error, not a 500.
  const decodeSegment = (raw: string): string | null => {
    try { return decodeURIComponent(raw) } catch { return null }
  }
  const badSegment = () => { json(res, { error: 'invalid_value', field: 'id', hint: 'Malformed percent-encoding in path' }, 400); return true }

  const sqlSkillsBase = path === '/api/skills/sql' || path === '/api/v1/skills/sql'
  const sqlSkillIdMatch = path.match(/^\/api(?:\/v1)?\/skills\/sql\/([^/]+)$/)
  const sqlFilesBase = path.match(/^\/api(?:\/v1)?\/skills\/sql\/([^/]+)\/files$/)
  const sqlFilesItem = path.match(/^\/api(?:\/v1)?\/skills\/sql\/([^/]+)\/files\/([^/]+)$/)
  const sqlAccessBase = path.match(/^\/api(?:\/v1)?\/skills\/sql\/([^/]+)\/access$/)
  const sqlAccessItem = path.match(/^\/api(?:\/v1)?\/skills\/sql\/([^/]+)\/access\/([^/]+)$/)

  if (sqlSkillsBase && method === 'GET') {
    let rows = isAdmin ? listAllSkills() : (callerTenantId ? listSkillsForTenant(callerTenantId) : [])
    if (fleetAgent) {
      const have = new Set(rows.map(r => r.id))
      rows = [...rows, ...listAllSkills().filter(r => fleetReadable(r.id, r.tenant_id) && !have.has(r.id))]
    }
    json(res, { skills: rows })
    return true
  }

  if (sqlSkillsBase && method === 'POST') {
    if (fleetAgent) { json(res, { error: 'forbidden', hint: 'A fleet agent token changes its own agent skills only (PUT agent/<name>/<skill>)' }, 403); return true }
    if (!isAdmin && !callerTenantId) { json(res, { error: 'forbidden', hint: 'No tenant scope' }, 403); return true }
    const body = await readBody(req)
    let parsed: { name?: string; description?: string; content?: string; is_global?: boolean } = {}
    try { parsed = JSON.parse(body.toString()) } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    const { name, description, content, is_global } = parsed
    if (typeof name !== 'string' || !name.trim()) { json(res, { error: 'required', field: 'name', hint: 'name is required' }, 400); return true }
    if (typeof content !== 'string' || !content.trim()) { json(res, { error: 'required', field: 'content', hint: 'content is required' }, 400); return true }
    if (is_global && !isAdmin) { json(res, { error: 'forbidden', hint: 'Only admin can set is_global' }, 403); return true }
    const tenantId = callerTenantId ?? 'fleet'
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
    const id = `${tenantId}-${slug}`
    if (getSkill(id)) { json(res, { error: 'conflict', hint: 'A skill with this name already exists for this tenant' }, 409); return true }
    const row = createSkill({ id, name: name.trim(), description: description ?? '', content, tenant_id: tenantId, is_global: is_global ?? false, created_by: ctx.auth?.kind === 'session' ? (ctx.auth.user ?? null) : null })
    // Phase 1 of the file->SQL-only migration: push this
    // write to disk immediately rather than waiting for the next startup
    // regen. No-op (skipped) for non-fleet skills and while SKILL_SQL_REGEN
    // is off.
    regenSingleSkillFile(id)
    json(res, { ok: true, skill: row }, 201)
    return true
  }

  if (sqlSkillIdMatch && method === 'GET') {
    const id = decodeSegment(sqlSkillIdMatch[1])
    if (id === null) return badSegment()
    const row = getSkill(id)
    if (!row) { json(res, { error: 'not_found' }, 404); return true }
    if (!isAdmin && !fleetReadable(id, row.tenant_id)) {
      if (!callerTenantId) { json(res, { error: 'not_found' }, 404); return true }
      if (row.tenant_id !== callerTenantId) {
        const grants = listSkillAccess(id)
        if (!grants.some(g => g.tenant_id === callerTenantId)) { json(res, { error: 'not_found' }, 404); return true }
      }
    }
    json(res, row)
    return true
  }

  if (sqlSkillIdMatch && method === 'PUT') {
    const id = decodeSegment(sqlSkillIdMatch[1])
    if (id === null) return badSegment()
    const existing = getSkill(id)
    // A file-backed id (global/<dir>, agent/<agent>/<dir>) that has no row yet is CREATED by
    // the PUT (admin only, fleet tenant): the skill writers are DB-first, so an agent that
    // has the content must be able to create the row, not just patch an existing one.
    const createSpec = existing ? null : fileBackedSkillSpec(id)
    if (fleetAgent && !isOwnAgentSkill(id)) { json(res, { error: 'forbidden', hint: 'A fleet agent token changes its own agent skills only' }, 403); return true }
    if (!existing && !(createSpec && (isAdmin || isOwnAgentSkill(id)))) { json(res, { error: 'not_found' }, 404); return true }
    if (existing && !isAdmin && !fleetAgent && callerTenantId !== existing.tenant_id) { json(res, { error: 'not_found' }, 404); return true }
    const body = await readBody(req)
    let parsed: { name?: string; description?: string; content?: string; is_global?: boolean } = {}
    try { parsed = JSON.parse(body.toString()) } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    if (parsed.is_global !== undefined && !isAdmin) { json(res, { error: 'forbidden', hint: 'Only admin can set is_global' }, 403); return true }
    if (createSpec) {
      if (typeof parsed.content !== 'string' || !parsed.content.trim()) { json(res, { error: 'required', field: 'content', hint: 'content is required to create a skill' }, 400); return true }
      const row = createSkill({
        id, name: createSpec.name, description: parsed.description ?? parseSkillDescription(parsed.content),
        content: parsed.content, tenant_id: 'fleet', is_global: createSpec.isGlobal,
        created_by: ctx.auth?.kind === 'session' ? (ctx.auth.user ?? null) : null,
      })
      regenSingleSkillFile(id)
      json(res, { ok: true, skill: row }, 201)
      return true
    }
    // The description column mirrors the frontmatter (that is what the loader and the list show):
    // new content without an explicit description carries its frontmatter description along.
    if (typeof parsed.content === 'string' && parsed.description === undefined) {
      const fmDescription = parseSkillDescription(parsed.content)
      if (fmDescription) parsed = { ...parsed, description: fmDescription }
    }
    const updated = updateSkill(id, parsed)
    regenSingleSkillFile(id)
    json(res, { ok: true, skill: updated })
    return true
  }

  if (sqlSkillIdMatch && method === 'DELETE') {
    const id = decodeSegment(sqlSkillIdMatch[1])
    if (id === null) return badSegment()
    if (fleetAgent && !isOwnAgentSkill(id)) { json(res, { error: 'forbidden', hint: 'A fleet agent token changes its own agent skills only' }, 403); return true }
    const existing = getSkill(id)
    if (!existing) { json(res, { error: 'not_found' }, 404); return true }
    if (!isAdmin && !fleetAgent && callerTenantId !== existing.tenant_id) { json(res, { error: 'not_found' }, 404); return true }
    const companionFiles = listSkillFiles(id)   // read before the delete removes them
    deleteSkill(id)
    // The file is only a generated cache of the row: drop it too, or the loader
    // keeps serving a skill the DB no longer has (a hand-edited file is kept).
    removeGeneratedSkillFile(id, existing.content, existing.tenant_id, companionFiles)
    json(res, { ok: true })
    return true
  }

  // --- companion files (scripts/, references/, ...) of a skill: skill_files ---
  // Same visibility/ownership rules as the skill row itself (GET: owner, grantee
  // or admin; write: owner tenant or admin). The rel path is ONE percent-encoded
  // segment (scripts%2Frun.sh). Writes go to the DB, then the on-disk copy is
  // regenerated from it.
  const filesId = sqlFilesBase ?? sqlFilesItem
  if (filesId) {
    const id = decodeSegment(filesId[1])
    if (id === null) return badSegment()
    const skill = getSkill(id)
    if (!skill) { json(res, { error: 'not_found' }, 404); return true }
    const canWrite = isAdmin || (fleetAgent ? isOwnAgentSkill(id) : callerTenantId === skill.tenant_id)
    const canRead = canWrite || fleetReadable(id, skill.tenant_id) || (!!callerTenantId && listSkillAccess(id).some(g => g.tenant_id === callerTenantId))
    if (!canRead) { json(res, { error: 'not_found' }, 404); return true }
    const fileView = (f: { rel_path: string; content: Buffer; mode: number; updated_at: number }) =>
      ({ rel_path: f.rel_path, size: f.content.length, mode: f.mode, updated_at: f.updated_at })

    if (sqlFilesBase && method === 'GET') {
      json(res, { files: listSkillFiles(id).map(fileView) })
      return true
    }

    if (sqlFilesItem && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const rawRel = decodeSegment(sqlFilesItem[2])
      if (rawRel === null) return badSegment()
      const rel = normalizeSkillRelPath(rawRel)
      if (!rel) { json(res, { error: 'invalid_value', field: 'rel_path', hint: 'Relative posix path without .., empty segments or backslashes; SKILL.md itself is the skill content' }, 400); return true }

      if (method === 'GET') {
        const f = getSkillFile(id, rel)
        if (!f) { json(res, { error: 'not_found' }, 404); return true }
        json(res, { ...fileView(f), content_base64: f.content.toString('base64') })
        return true
      }

      if (!canWrite) { json(res, { error: 'not_found' }, 404); return true }

      if (method === 'DELETE') {
        const f = getSkillFile(id, rel)
        if (!f) { json(res, { error: 'not_found' }, 404); return true }
        deleteSkillFile(id, rel)
        // Drop the generated copy too (only while it still equals the deleted row).
        removeGeneratedCompanionFile(id, rel, f.content, skill.tenant_id)
        json(res, { ok: true })
        return true
      }

      let raw: Buffer
      try { raw = await readBody(req, { maxBytes: Math.ceil(MAX_SKILL_FILE_BYTES * 4 / 3) + 4096 }) } catch (err) {
        if (err instanceof RequestBodyTooLargeError) { json(res, { error: 'limit_exceeded', hint: `File too large (max ${MAX_SKILL_FILE_BYTES} bytes)` }, 413); return true }
        throw err
      }
      let parsed: { content?: unknown; content_base64?: unknown; mode?: unknown } = {}
      try { parsed = JSON.parse(raw.toString()) } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
      const hasText = typeof parsed.content === 'string'
      const hasB64 = typeof parsed.content_base64 === 'string'
      if (hasText === hasB64) { json(res, { error: 'required', field: 'content', hint: 'Send exactly one of content (utf-8 text) or content_base64' }, 400); return true }
      if (hasB64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.content_base64 as string)) { json(res, { error: 'invalid_value', field: 'content_base64', hint: 'Not valid base64' }, 400); return true }
      const bytes = hasText ? Buffer.from(parsed.content as string, 'utf-8') : Buffer.from(parsed.content_base64 as string, 'base64')
      if (bytes.length > MAX_SKILL_FILE_BYTES) { json(res, { error: 'limit_exceeded', hint: `File too large (max ${MAX_SKILL_FILE_BYTES} bytes)` }, 413); return true }
      if (parsed.mode !== undefined && (typeof parsed.mode !== 'number' || !Number.isInteger(parsed.mode))) { json(res, { error: 'invalid_value', field: 'mode', hint: 'mode must be an integer (permission bits)' }, 400); return true }
      const isNew = !getSkillFile(id, rel)
      if (isNew && countSkillFiles(id) >= MAX_SKILL_FILES_PER_SKILL) { json(res, { error: 'limit_exceeded', hint: `At most ${MAX_SKILL_FILES_PER_SKILL} companion files per skill` }, 400); return true }
      const saved = putSkillFile(id, rel, bytes, parsed.mode as number | undefined)
      const regen = regenSingleSkillFile(id, true)   // an explicit write always reaches disk, like PUT /api/skills/:name
      if (regen.reason === 'write_error') { json(res, { error: 'internal_error', hint: 'Saved to the DB, but the on-disk copy could not be written' }, 500); return true }
      json(res, { ok: true, file: fileView(saved) }, isNew ? 201 : 200)
      return true
    }
  }

  if (sqlAccessBase && method === 'GET') {
    const id = decodeSegment(sqlAccessBase[1])
    if (id === null) return badSegment()
    if (!isAdmin) { json(res, { error: 'forbidden', hint: 'Admin only' }, 403); return true }
    const existing = getSkill(id)
    if (!existing) { json(res, { error: 'not_found' }, 404); return true }
    json(res, { access: listSkillAccess(id) })
    return true
  }

  if (sqlAccessBase && method === 'POST') {
    const id = decodeSegment(sqlAccessBase[1])
    if (id === null) return badSegment()
    if (!isAdmin) { json(res, { error: 'forbidden', hint: 'Admin only' }, 403); return true }
    const existing = getSkill(id)
    if (!existing) { json(res, { error: 'not_found' }, 404); return true }
    const body = await readBody(req)
    let parsed: { tenant_id?: string } = {}
    try { parsed = JSON.parse(body.toString()) } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    if (typeof parsed.tenant_id !== 'string' || !parsed.tenant_id) { json(res, { error: 'required', field: 'tenant_id', hint: 'tenant_id is required' }, 400); return true }
    grantSkillAccess(id, parsed.tenant_id, ctx.auth?.kind === 'session' ? ctx.auth.user : undefined)
    // A granted tenant skill also lands under the grantee tenant's agents.
    regenSingleSkillFile(id)
    json(res, { ok: true })
    return true
  }

  if (sqlAccessItem && method === 'DELETE') {
    const [, rawId, rawTenantId] = sqlAccessItem
    const id = decodeSegment(rawId)
    const tenantId = decodeSegment(rawTenantId)
    if (id === null || tenantId === null) return badSegment()
    if (!isAdmin) { json(res, { error: 'forbidden', hint: 'Admin only' }, 403); return true }
    const ok = revokeSkillAccess(id, tenantId)
    if (!ok) { json(res, { error: 'not_found' }, 404); return true }
    // Drop the generated copy from the agents that only qualified through this grant.
    regenSingleSkillFile(id)
    json(res, { ok: true })
    return true
  }

  return false
}
