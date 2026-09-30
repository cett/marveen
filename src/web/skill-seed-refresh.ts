/**
 * Seed-skill refresh -> DB.
 *
 * update.sh refreshes a shipped skill's FILE under ~/.claude/skills while that
 * file is provably untouched. With the skills table as the source of truth, the
 * startup regen would then write the OLD row straight back over the refreshed
 * file. So update.sh leaves the names of the skills it (re)wrote in a marker
 * file, and the dashboard applies them to the DB before the regen runs.
 *
 * The marker is only ever written for a file update.sh proved untouched (or
 * force-reseeded on operator request), so applying it cannot clobber a
 * dashboard edit: a dashboard edit regenerates the file, the file then no
 * longer matches any shipped version, and update.sh keeps it.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { STORE_DIR } from '../config.js'
import { getSkill, updateSkill, seedSkillIfAbsent } from '../db.js'
import { stripGeneratedHeader } from '../skill-header.js'
import { resolveSkillPath } from './skill-regen.js'

export const SEED_REFRESH_MARKER = '.seed-refreshed-skills'

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export interface SeedRefreshResult {
  applied: number
  unchanged: number
  errors: number
}

function frontmatterField(content: string, field: string): string {
  const fm = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return ''
  const line = fm[1].match(new RegExp(`^${field}:[ \\t]*(.+)$`, 'im'))
  if (!line) return ''
  const val = line[1].trim()
  const quoted = val.match(/^(["'])(.*)\1$/)
  return quoted ? quoted[2] : val
}

/**
 * Apply the marker written by update.sh: for each listed skill, make the
 * global/<name> row equal to the refreshed file on disk. Removes the marker
 * when every entry was handled; keeps it (for the next start) when one failed.
 */
export function applySeedSkillRefreshMarker(markerPath = join(STORE_DIR, SEED_REFRESH_MARKER)): SeedRefreshResult {
  const out: SeedRefreshResult = { applied: 0, unchanged: 0, errors: 0 }
  if (!existsSync(markerPath)) return out

  const names = [...new Set(readFileSync(markerPath, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean))]
  for (const name of names) {
    const id = `global/${name}`
    try {
      const file = SAFE_NAME.test(name) && name !== '.' && name !== '..' ? resolveSkillPath(id) : null
      if (!file || !existsSync(file)) { out.errors++; logger.warn({ name }, 'Seed skill refresh: file missing or name unsafe'); continue }
      const content = stripGeneratedHeader(readFileSync(file, 'utf-8'))
      const description = frontmatterField(content, 'description')
      const row = getSkill(id)
      if (!row) {
        seedSkillIfAbsent({ id, name, description, content, tenant_id: 'fleet', is_global: true })
        out.applied++
      } else if (row.content === content && row.description === description) {
        out.unchanged++
      } else {
        updateSkill(id, { description, content })
        out.applied++
      }
    } catch (err) {
      out.errors++
      logger.warn({ err, name }, 'Seed skill refresh: DB update failed')
    }
  }
  if (out.errors === 0) {
    try { unlinkSync(markerPath) } catch { /* already gone */ }
  }
  return out
}
