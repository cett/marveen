// The Skills screen lists from the DATABASE: the skills rows (GET /api/skills/sql) are the source of truth, the SKILL.md files
// are the loader's cache. The two file scans (GET /api/skills, GET /api/skills/local) only add what the database does not hold:
// plugin skills, and user / agent files that have no row yet. This module is the pure merge, no DOM and no fetch, so it is unit
// tested on its own (src/__tests__/skills-merge.test.ts).
//
// The key that joins a row and a scanned folder is the row id: `global/<dir>` for a user skill, `agent/<agentId>/<dir>` for an
// agent-local one (the id scheme of src/web/skill-regen.ts resolveSkillPath). A row that has no such shape (a tenant skill, id
// `<tenant>-<slug>`) has no scanned folder to match and is listed on its own.
//
// Rule of the screen: a skill never disappears because its file is gone; it disappears only when its row is deleted.

/** The `keywords:` list of a SKILL.md frontmatter, as the file scan reads it (comma separated). */
export function parseKeywords(content) {
  if (typeof content !== 'string') return []
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm) return []
  const line = fm[1].match(/^keywords:\s*(.+)/im)
  if (!line) return []
  return line[1].replace(/^["']|["']$/g, '').split(',').map((k) => k.trim()).filter(Boolean)
}

/** Parses a row id into where the skill lives: { source, name, agentId? } (tenant skills: source 'user', name = the row name). */
export function classifySkillId(id, rowName) {
  const parts = String(id).split('/')
  if (parts.length === 2 && parts[0] === 'global' && parts[1]) return { source: 'user', name: parts[1], scanKey: id }
  if (parts.length === 3 && parts[0] === 'agent' && parts[1] && parts[2]) return { source: 'agent', name: parts[2], agentId: parts[1], scanKey: id }
  return { source: 'user', name: rowName || String(id), scanKey: null }
}

/**
 * The folder a tenant skill's generated copy lives in under agents/<agent>/.claude/skills/ (mirror of tenantSkillDirName in
 * src/web/skill-regen.ts: characters outside [A-Za-z0-9._-] become '-', leading '.' and '-' are dropped). null = no valid folder.
 */
export function tenantSkillDirName(id) {
  const dir = String(id).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dir) ? dir : null
}

/**
 * The key of an entry in the skill-usage summary. The usage hook records the skill FOLDER name, so a fleet or file entry is looked
 * up by its name (the folder), and a tenant row by the folder its generated copies carry (tenantSkillDirName(id)), never by its
 * display name: that would show the counts of a fleet skill of the same name, or nothing. null = nothing can be recorded for it.
 */
export function usageKey(entry) {
  if (entry.origin === 'sql' && entry.tenantId && entry.tenantId !== 'fleet') return tenantSkillDirName(entry.sqlId)
  return entry.name
}

/**
 * The admin file scans that did not answer: [{ path, status }]. A scan the caller did not make (null) is not a failure.
 * The screen shows a notice for these, so plugin skills and files without a row never vanish without a word.
 */
export function scanFailures({ globalRes = null, localRes = null } = {}) {
  const out = []
  if (globalRes && !globalRes.ok) out.push({ path: '/api/skills', status: globalRes.status })
  if (localRes && !localRes.ok) out.push({ path: '/api/skills/local', status: localRes.status })
  return out
}

/**
 * @param {object} input
 * @param {Array} input.sqlRows  GET /api/skills/sql -> skills (admin rows carry file_present: true | false | null)
 * @param {Array} input.userScan  GET /api/skills (entries typed source 'user' | 'plugin'); [] when the caller may not scan
 * @param {Array} input.localScan GET /api/skills/local (agent-local files); [] when the caller may not scan
 * @returns {Array} one entry per skill, see the fields below
 */
export function mergeSkills({ sqlRows = [], userScan = [], localScan = [] }) {
  const entries = []
  const byScanKey = new Map()
  // tenant rows (no scan key) by the folder their generated copies carry; a copy is not a skill of its own
  const byTenantDir = new Map()

  for (const row of sqlRows) {
    const c = classifySkillId(row.id, row.name)
    const entry = {
      key: row.id,
      origin: 'sql',
      sqlId: row.id,
      name: c.name,
      label: c.name,
      description: row.description || '',
      keywords: parseKeywords(row.content),
      source: c.source,
      agentId: c.agentId,
      agents: [],
      mtime: row.updated_at ? row.updated_at * 1000 : 0,
      tenantId: row.tenant_id,
      status: row.status || 'live',
      // true | false | null (unknown: a tenant skill, or a caller that is not told)
      filePresent: row.file_present === true ? true : row.file_present === false ? false : null,
    }
    entries.push(entry)
    if (c.scanKey) byScanKey.set(c.scanKey, entry)
    else if (row.tenant_id && row.tenant_id !== 'fleet') {
      const dir = tenantSkillDirName(row.id)
      if (dir) byTenantDir.set(dir, entry)
    }
  }

  for (const f of userScan) {
    if (f.source === 'plugin') {
      entries.push({
        key: `plugin:${f.name}`, origin: 'plugin', sqlId: null, name: f.name, label: f.label || f.name,
        description: f.description || '', keywords: f.keywords || [], source: 'plugin', agents: f.agents || [],
        mtime: f.mtime || 0, pluginPackage: f.pluginPackage,
      })
      continue
    }
    const row = byScanKey.get(`global/${f.name}`)
    if (row) {
      // the same skill: the row stays the entry; the file only adds what it knows (when it was written, who it covers)
      row.agents = f.agents || []
      if (f.mtime) row.mtime = f.mtime
      continue
    }
    entries.push({
      key: `global/${f.name}`, origin: 'file', sqlId: null, name: f.name, label: f.label || f.name,
      description: f.description || '', keywords: f.keywords || [], source: 'user', agents: f.agents || [], mtime: f.mtime || 0,
    })
  }

  for (const f of localScan) {
    const row = byScanKey.get(`agent/${f.agentId}/${f.name}`)
    if (row) {
      if (f.mtime) row.mtime = f.mtime
      continue
    }
    // a generated copy of a tenant skill: the row stays the entry, the copy only says which agent carries it
    const tenantRow = byTenantDir.get(f.name)
    if (tenantRow) {
      if (f.agentId && !tenantRow.agents.includes(f.agentId)) tenantRow.agents.push(f.agentId)
      if (f.mtime && f.mtime > tenantRow.mtime) tenantRow.mtime = f.mtime
      continue
    }
    entries.push({
      key: `agent/${f.agentId}/${f.name}`, origin: 'file', sqlId: null, name: f.name, label: f.label || f.name,
      description: f.description || '', keywords: f.keywords || [], source: 'agent', agentId: f.agentId, agents: [], mtime: f.mtime || 0,
    })
  }

  return entries
}

/**
 * What the card and the detail show and allow, from one merged entry:
 *   badge  'file_missing' (row, live, file known to be absent) | 'not_synced' (file without a row) | 'not_live' (row, status not live) | null
 *   canEdit    row: yes (PUT /api/skills/sql/:id); a file without a row and a plugin skill: read only
 *   canDelete  row: yes (DELETE /api/skills/sql/:id); a file without a row would only delete the file, so no; plugin: no
 */
export function skillFlags(entry) {
  if (entry.origin === 'plugin') return { badge: null, canEdit: false, canDelete: false }
  if (entry.origin === 'file') return { badge: 'not_synced', canEdit: false, canDelete: false }
  let badge = null
  if (entry.status && entry.status !== 'live') badge = 'not_live'
  else if (entry.filePresent === false) badge = 'file_missing'
  return { badge, canEdit: true, canDelete: true }
}
