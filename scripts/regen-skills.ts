#!/usr/bin/env node
/**
 * Manual runner for the SQL -> file skill regeneration (716-D).
 *
 * Reads the skills from the SQL `skills` table (fleet + agent-local skills,
 * their companion files, and tenant skills under the tenants' own agents) and
 * writes them back to their canonical file locations. Safe to run repeatedly
 * -- atomic writes, skips content-equal files, never touches files not in SQL.
 * This is the post-restore step: after the database is restored, the skill
 * files are rebuilt from it.
 *
 * Usage:
 *   npx tsx scripts/regen-skills.ts [--dry-run] [--force] [--check]
 *
 *   --dry-run   Log what would be written without touching disk. Works even
 *               when SKILL_SQL_REGEN=0 (useful for the proof step).
 *   --force     Bypass the SKILL_SQL_REGEN kill-switch for a live manual run.
 *               The startup hook honours the same switch.
 *   --check     Write nothing; list the skills / companion files / tenant
 *               copies that are in the DB but missing on disk. Exit 1 if any.
 */
import { initDatabase, countSkills } from '../src/db.js'
import { regenSkillFilesFromSQL, findSkillFileGaps } from '../src/web/skill-regen.js'
import { SKILL_SQL_REGEN } from '../src/config.js'

const dryRun = process.argv.includes('--dry-run')
const force  = process.argv.includes('--force')
const check  = process.argv.includes('--check')

// Initialize DB before any queries.
initDatabase()

function reportGaps(): number {
  const gaps = findSkillFileGaps()
  const groups: Array<[string, string[]]> = [
    ['SKILL.md missing', gaps.skillFiles],
    ['companion file missing', gaps.companionFiles],
    ['tenant copy missing', gaps.tenantCopies],
  ]
  let n = 0
  for (const [label, list] of groups) {
    n += list.length
    for (const item of list) console.error(`  ${label}: ${item}`)
  }
  return n
}

if (check) {
  const n = reportGaps()
  console.log(n === 0 ? 'All skills, companion files and tenant copies in the DB are present on disk.' : `\n${n} item(s) in the DB are missing on disk. Run without --check (add --force if SKILL_SQL_REGEN=0).`)
  process.exit(n === 0 ? 0 : 1)
}

if (!dryRun && !force && !SKILL_SQL_REGEN) {
  console.error('SKILL_SQL_REGEN kill-switch is off (SKILL_SQL_REGEN=0). Pass --dry-run for a preview, or --force for a live manual run.')
  process.exit(1)
}

const totalRows = countSkills()
console.log(`SQL skills table: ${totalRows} row(s) total.`)
console.log(dryRun ? '[dry-run] Simulating regen...' : `Running regen (force=${force}, kill-switch=${SKILL_SQL_REGEN})...`)

const result = regenSkillFilesFromSQL(dryRun, force || SKILL_SQL_REGEN)

console.log(`\nResult: enabled=${result.enabled}, written=${result.written}, skipped=${result.skipped}, errors=${result.errors}`)

if (result.errors > 0) {
  console.error('Some skills failed to write -- check logs above.')
  process.exit(1)
}

if (!dryRun && result.enabled) {
  const missing = reportGaps()
  if (missing > 0) {
    console.error(`\nWARN: ${missing} item(s) in the DB still have no file on disk (see above).`)
    process.exit(1)
  } else {
    console.log('\nAll skills, companion files and tenant copies verified present on disk.')
    console.log('Restart the running agents so their sessions load the regenerated skills (see the operations guide, "After a restore").')
  }
}
