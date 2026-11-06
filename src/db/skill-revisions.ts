// The trail of skill writes (migration 0091, skill_revisions).
//
// Every write to a skill (its SKILL.md or one of its companion files) records one row here, in the SAME transaction
// as the write: the two commit together or roll back together, so a skill never changes without a trace. The trail
// has no foreign key to skills and survives a skill delete on purpose.
//
// This module only records. Nothing reads the trail to decide anything (no status, no approval, no filter): a skill
// write behaves exactly as before and the trail is the addition.
import { createHash } from 'node:crypto'
import { dbx, type SqlOps } from './facade.js'
import { logger } from '../logger.js'

export type SkillRevisionAction = 'baseline' | 'create' | 'modify' | 'seed' | 'delete' | 'file_put' | 'file_delete' | 'file_seed'
export type SkillActorKind = 'human' | 'agent' | 'import' | 'system'

/**
 * Who is making a skill write. Required by every writer function, so the compiler refuses a caller that forgot to say.
 * `id` names the actor when there is a name to give (a dashboard user, an agent id) and is null otherwise.
 */
export interface SkillActor {
  kind: SkillActorKind
  id: string | null
}

/** The part of a skill row the trail needs: which skill, whose, and the stored SKILL.md text (header already stripped). */
export interface SkillRevisionSubject {
  id: string
  tenant_id: string
  content: string
}

export interface WriteSkillRevisionOpts {
  skill: SkillRevisionSubject
  action: SkillRevisionAction
  actor: SkillActor
  /** Where the change came from (a file name, an import id, 'skill-sync'): never a secret, never an absolute path under a home. */
  sourceRef?: string | null
  reason?: string | null
}

export interface SkillRevisionRow {
  id: number
  skill_id: string
  tenant_id: string
  seq: number
  action: SkillRevisionAction
  content_sha256: string | null
  prev_sha256: string | null
  files_sha256: string | null
  has_scripts: number
  content: string | null
  author_kind: SkillActorKind
  author_id: string | null
  source_ref: string | null
  reason: string | null
  created_at: number
}

/** Actions that carry no state change of their own on repeat: an identical result writes no row (see writeSkillRevision). */
const IDEMPOTENT_ACTIONS: ReadonlySet<SkillRevisionAction> = new Set(['modify', 'file_put', 'file_seed', 'file_delete'])

/** Actions whose row keeps the SKILL.md text (the companion file actions do not: the file bytes are never copied). */
const CONTENT_ACTIONS: ReadonlySet<SkillRevisionAction> = new Set(['baseline', 'create', 'modify', 'seed', 'delete'])

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

interface FileFacts {
  rel_path: string
  mode: number
  content: Buffer
}

/**
 * Hash of the companion file set: SHA-256 over the lines "<rel_path>\0<mode>\0<sha256 of the bytes>\n", sorted by path
 * (plain code-unit order, so it does not depend on the database collation or on the order the rows came back in).
 * Null when the skill has no companion files. Two sets with the same files give the same hash in any row order.
 */
export function hashFileSet(files: readonly FileFacts[]): string | null {
  if (files.length === 0) return null
  const lines = files
    .map((f) => `${f.rel_path}\0${f.mode}\0${sha256Hex(f.content)}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256Hex(lines.join(''))
}

/** True when any companion file lives under scripts/ or is executable (the part of a skill that can run). */
export function hasRunnableFiles(files: readonly FileFacts[]): boolean {
  return files.some((f) => f.rel_path.startsWith('scripts/') || (f.mode & 0o111) !== 0)
}

/**
 * Records one revision of a skill. Call it with the transaction handle of the skill write, AFTER the write (the
 * companion files and, for everything but a delete, the skill row are read in their new state) and BEFORE a delete
 * removes the files, so a delete row keeps the last state.
 *
 * The hashes are computed here: content_sha256 of the stored SKILL.md (the text after the generated header is
 * stripped, i.e. what the skills table holds), prev_sha256 from the latest revision of the skill, files_sha256 and
 * has_scripts from the companion files as they are in the transaction. seq is the next number of the skill, taken by
 * the insert statement itself (MAX+1 under UNIQUE(skill_id, seq)).
 *
 * A write that changes nothing writes no row: for modify, file_put, file_seed and file_delete, when the SKILL.md hash
 * and the file-set hash both equal those of the latest revision, the trail is left alone (the seed refresh and a
 * repeated sync would otherwise fill it with identical rows). Returns the new row, or null when nothing was written.
 */
export async function writeSkillRevision(tx: SqlOps, opts: WriteSkillRevisionOpts): Promise<SkillRevisionRow | null> {
  const { skill, action, actor } = opts
  const contentSha = sha256Hex(skill.content)
  const files = await tx.all<FileFacts>('SELECT rel_path, mode, content FROM skill_files WHERE skill_id = ?', skill.id)
  const filesSha = hashFileSet(files)

  const latest = await tx.get<{ action: SkillRevisionAction; content_sha256: string | null; files_sha256: string | null }>(
    'SELECT action, content_sha256, files_sha256 FROM skill_revisions WHERE skill_id = ? ORDER BY seq DESC LIMIT 1', skill.id)

  if (IDEMPOTENT_ACTIONS.has(action) && latest && latest.action !== 'delete'
      && latest.content_sha256 === contentSha && latest.files_sha256 === filesSha) {
    return null
  }

  await tx.run(`
    INSERT INTO skill_revisions
      (skill_id, tenant_id, seq, action, content_sha256, prev_sha256, files_sha256, has_scripts, content,
       author_kind, author_id, source_ref, reason)
    VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM skill_revisions WHERE skill_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, skill.id, skill.tenant_id, skill.id, action, contentSha, latest?.content_sha256 ?? null, filesSha,
    hasRunnableFiles(files) ? 1 : 0, CONTENT_ACTIONS.has(action) ? skill.content : null,
    actor.kind, actor.id, opts.sourceRef ?? null, opts.reason ?? null)
  // The row just written is the skill's highest seq in this transaction (no other writer can interleave on it).
  return await tx.get<SkillRevisionRow>('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY seq DESC LIMIT 1', skill.id) ?? null
}

export interface BaselineResult {
  written: number
  errors: number
}

/**
 * Gives every skill that has no revision yet its first one: a 'baseline' row (seq 1, system actor 'baseline') with the
 * hash and the text it has now. The migration cannot do this (SQLite has no sha256), so it runs at boot. Idempotent:
 * a skill that already has a revision is left alone, so a second run writes nothing. A skill that fails is logged and
 * skipped; the others still get theirs and the boot goes on.
 */
export async function backfillSkillBaselines(): Promise<BaselineResult> {
  const out: BaselineResult = { written: 0, errors: 0 }
  const missing = await dbx.all<{ id: string; tenant_id: string }>(
    'SELECT s.id, s.tenant_id FROM skills s WHERE NOT EXISTS (SELECT 1 FROM skill_revisions r WHERE r.skill_id = s.id) ORDER BY s.id')
  for (const { id } of missing) {
    try {
      const wrote = await dbx.tx(async (tx) => {
        // Re-read inside the transaction: the skill may have been written (and so already traced) since the listing.
        const skill = await tx.get<SkillRevisionSubject>('SELECT id, tenant_id, content FROM skills WHERE id = ?', id)
        if (!skill) return false
        const has = await tx.get('SELECT 1 FROM skill_revisions WHERE skill_id = ?', id)
        if (has) return false
        await writeSkillRevision(tx, { skill, action: 'baseline', actor: { kind: 'system', id: 'baseline' } })
        return true
      })
      if (wrote) out.written++
    } catch (err) {
      out.errors++
      logger.warn({ err, skillId: id }, 'Skill baseline revision failed')
    }
  }
  return out
}
