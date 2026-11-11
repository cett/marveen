// Archive import of a skill, the quarantine way (step 3).
//
// An archive used to be unzipped straight into a skills directory, where its SKILL.md and scripts were live files the
// moment they landed. Now the archive is unzipped into a private staging directory OUTSIDE every skills root, read into
// memory, recorded as a pending revision (the skill row is 'pending_review', its companion files sit on the revision)
// and the staging directory is removed. Nothing of an imported skill is written where an agent loads skills from until
// a person activates it.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { STORE_DIR } from '../config.js'
import type { ProposedFile, SkillActor } from '../db.js'
import { getSkill, quarantineSkillImport } from '../db.js'
import { MAX_SKILL_FILES_PER_SKILL, MAX_SKILL_FILE_BYTES, normalizeSkillRelPath, sanitizeSkillFileMode } from '../skill-files.js'

/** Ceilings on what an archive may declare, checked before anything is unzipped (a declared size is a promise, unzip still enforces it). */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 2000

export type ExtractResult =
  | { kind: 'ok'; stage: string; root: string; skills: string[] }
  | { kind: 'invalid'; hint: string }

/** Removes a staging directory; never throws (a leftover temp directory is not worth failing a request over). */
export function removeStage(stage: string): void {
  try { rmSync(stage, { recursive: true, force: true }) } catch { /* best effort */ }
}

/**
 * Reads the zipinfo listing (`unzip -Z`, one ls-style line per entry: type and permissions, version, creator, size, ...)
 * and answers why the archive must be refused, or null. Only regular files ('-') and directories ('d') pass.
 */
export function inspectArchiveListing(listing: string, expectedEntries?: number): string | null {
  let entries = 0
  let bytes = 0
  for (const line of listing.split('\n')) {
    // The attribute field is 10 characters for an entry made on a unix host and shorter for one made on a FAT host
    // (`-rw-a--`), so only the leading type character and a run of non-blanks are required of it.
    const m = /^([-dlcbps?])\S{6,}\s+\S+\s+\S+\s+(\d+)\s/.exec(line)
    if (!m) continue
    if (m[1] !== '-' && m[1] !== 'd') return 'Invalid skill file: only regular files and directories are allowed'
    entries++
    bytes += Number(m[2])
  }
  // Fail closed: when the plain name list says there are more entries than the listing parsed, some line was not
  // understood, and an entry nobody judged must not be unzipped.
  if (expectedEntries !== undefined && entries !== expectedEntries) return 'Invalid skill file: the archive listing could not be read'
  if (entries > MAX_ARCHIVE_ENTRIES) return `Invalid skill file: more than ${MAX_ARCHIVE_ENTRIES} entries`
  if (bytes > MAX_ARCHIVE_BYTES) return `Invalid skill file: more than ${MAX_ARCHIVE_BYTES} bytes declared`
  return null
}

const hasSymlink = (dir: string): boolean => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return true
    if (st.isDirectory() && hasSymlink(p)) return true
  }
  return false
}

/**
 * Unzips `data` into a fresh staging directory and finds the skills in it (a top-level directory holding a SKILL.md).
 * 'invalid' leaves nothing behind. 'ok' hands the staging directory to the caller, who must removeStage() it.
 * A path that climbs out (`..`, absolute, drive letter) and a symlink anywhere in the archive are refused, as before.
 * Throws on an unzip failure (after removing the staging directory).
 */
export function extractSkillArchive(data: Buffer): ExtractResult {
  // Under the data directory, in a directory only this process can enter (mkdtemp creates it 0700); never under a skills root.
  const base = join(STORE_DIR, 'skill-import')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(base, 'run-'))
  try {
    const zip = join(stage, 'in.zip')
    const root = join(stage, 'out')
    mkdirSync(root)
    writeFileSync(zip, data)
    const entries = execFileSync('unzip', ['-Z1', zip], { timeout: 5000, encoding: 'utf-8' }).split('\n').map((l) => l.trim()).filter(Boolean)
    for (const entry of entries) {
      if (entry.includes('..') || entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
        removeStage(stage)
        return { kind: 'invalid', hint: 'Invalid skill file: path traversal detected' }
      }
    }
    // The type and the declared size of every entry are read BEFORE unzip writes anything: a symlink, a device or a
    // fifo is refused (unzip would create it), and so is an archive that declares more than the ceilings.
    const verdict = inspectArchiveListing(execFileSync('unzip', ['-Z', zip], { timeout: 5000, encoding: 'utf-8' }), entries.length)
    if (verdict) {
      removeStage(stage)
      return { kind: 'invalid', hint: verdict }
    }
    execFileSync('unzip', ['-o', zip, '-d', root], { timeout: 10000, stdio: 'ignore' })
    const top = readdirSync(root)
    for (const f of top) {
      const p = join(root, f)
      if (lstatSync(p).isSymbolicLink() || (statSync(p).isDirectory() && hasSymlink(p))) {
        removeStage(stage)
        return { kind: 'invalid', hint: 'Invalid skill file: symlink entries rejected' }
      }
    }
    const skills = top.filter((f) => {
      const p = join(root, f)
      try { return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')) } catch { return false }
    })
    if (skills.length === 0) {
      removeStage(stage)
      return { kind: 'invalid', hint: 'No valid skill (SKILL.md) found in archive' }
    }
    return { kind: 'ok', stage, root, skills }
  } catch (err) {
    removeStage(stage)
    throw err
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.cache'])
const SKIP_FILES = new Set(['.DS_Store'])

export type ReadFilesResult = { ok: true; files: ProposedFile[] } | { ok: false; hint: string }

/**
 * The companion files of an extracted skill directory (everything but SKILL.md), as the proposal records them. Same
 * selection as the live importer (no symlinks, no tool caches, the path rules of skill-files.ts), but a file that
 * cannot be recorded (too big, a path the rules refuse, too many files) refuses the WHOLE archive: a quarantined
 * proposal must be exactly what the archive holds, never a partial set a reviewer would take for the whole.
 */
export function readProposedFiles(skillDir: string): ReadFilesResult {
  const found: Array<{ rel: string; abs: string }> = []
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(abs, rel); continue }
      if (!st.isFile() || SKIP_FILES.has(name) || rel === 'SKILL.md') continue
      found.push({ rel, abs })
    }
  }
  walk(skillDir, '')
  if (found.length > MAX_SKILL_FILES_PER_SKILL) return { ok: false, hint: `Too many files in the skill (limit ${MAX_SKILL_FILES_PER_SKILL})` }
  const files: ProposedFile[] = []
  for (const f of found) {
    const rel = normalizeSkillRelPath(f.rel)
    if (!rel) return { ok: false, hint: 'A file path in the skill is not allowed' }
    const st = statSync(f.abs)
    if (st.size > MAX_SKILL_FILE_BYTES) return { ok: false, hint: `A file in the skill is over the size limit (${MAX_SKILL_FILE_BYTES} bytes)` }
    files.push({ rel_path: rel, mode: sanitizeSkillFileMode(st.mode), content: readFileSync(f.abs) })
  }
  return { ok: true, files }
}

export interface QuarantinedSkillInfo {
  name: string
  /** The seq of the pending revision. */
  revision: number
  touches_privilege: boolean
  has_scripts: boolean
}

export interface QuarantineImportOutcome {
  quarantined: QuarantinedSkillInfo[]
  /** Set when a skill of the archive already exists under that id: nothing is recorded then (all or nothing). */
  conflict: string | null
  /** Skills the archive could not be read for (a file refused by the rules above). */
  refused: Array<{ skill: string; hint: string }>
}

/**
 * Records each skill of a staged archive as a quarantined import. `idFor` names the skill row (`global/<dir>` or
 * `agent/<agent>/<dir>`), `description` reads the description of a directory. A failure of one skill is logged and
 * leaves the others to go on, as the live importer did.
 */
export async function quarantineStagedSkills(
  staged: { root: string; skills: readonly string[] },
  opts: { idFor: (dir: string) => string; isGlobal: boolean; describe: (skillDir: string) => string; actor: SkillActor },
): Promise<QuarantineImportOutcome> {
  const out: QuarantineImportOutcome = { quarantined: [], conflict: null, refused: [] }
  // A name that is taken (a live skill, a disabled one, one waiting for review) is a conflict, as it is on disk: decided
  // for the whole archive before anything is written.
  for (const dirName of staged.skills) {
    if (await getSkill(opts.idFor(dirName))) { out.conflict = dirName; return out }
  }
  for (const dirName of staged.skills) {
    const skillDir = join(staged.root, dirName)
    const read = readProposedFiles(skillDir)
    if (!read.ok) { out.refused.push({ skill: dirName, hint: read.hint }); continue }
    let content = ''
    try { content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8') } catch { out.refused.push({ skill: dirName, hint: 'SKILL.md could not be read' }); continue }
    try {
      const r = await quarantineSkillImport(
        { id: opts.idFor(dirName), name: dirName, description: opts.describe(skillDir), content, tenant_id: 'fleet', is_global: opts.isGlobal, files: read.files },
        opts.actor, { sourceRef: `skill-archive:${dirName}` })
      if (r.outcome === 'quarantined') {
        out.quarantined.push({ name: dirName, revision: r.revision.seq, touches_privilege: r.revision.touches_privilege === 1, has_scripts: r.revision.has_scripts === 1 })
      } else {
        out.conflict = dirName // created by someone else between the check and the write
        return out
      }
    } catch (err) {
      logger.warn({ dirName, err }, 'Failed to record the imported skill as a pending revision')
      out.refused.push({ skill: dirName, hint: 'Recording the skill failed' })
    }
  }
  return out
}
