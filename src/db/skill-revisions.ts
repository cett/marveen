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
import { writeAgentAuditLog } from './audit.js'
import { logger } from '../logger.js'

export type SkillRevisionAction = 'baseline' | 'create' | 'modify' | 'seed' | 'delete' | 'file_put' | 'file_delete' | 'file_seed' | 'revoke'
export type SkillActorKind = 'human' | 'agent' | 'import' | 'system' | 'operator'

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

/** What a writer may add to the trail beyond who: where the change came from and why. Both optional. */
export interface SkillWriteMeta {
  /** A file name, an import id, 'skill-sync': never a secret, never an absolute path under a home. */
  sourceRef?: string | null
  reason?: string | null
}

export interface WriteSkillRevisionOpts extends SkillWriteMeta {
  skill: SkillRevisionSubject
  action: SkillRevisionAction
  actor: SkillActor
  /**
   * Write the row even when the text and the file set equal the latest revision's. For a change the hashes cannot show
   * (the is_global flag): the caller names it in `reason`. Without it, an unchanged write is not recorded.
   */
  force?: boolean
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
  /** 'activated' for a state that is or was live; 'pending' waits for a decision (migration 0094). */
  status: SkillRevisionStatus
  touches_privilege: number
  submitted_by: string | null
  decided_by: string | null
  decided_at: number | null
  decision_ref: string | null
}

export type SkillRevisionStatus = 'activated' | 'pending' | 'rejected' | 'expired'

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
    "SELECT action, content_sha256, files_sha256 FROM skill_revisions WHERE skill_id = ? AND status = 'activated' ORDER BY seq DESC LIMIT 1", skill.id)

  if (!opts.force && IDEMPOTENT_ACTIONS.has(action) && latest && latest.action !== 'delete'
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
  const row = await tx.get<SkillRevisionRow>('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY seq DESC LIMIT 1', skill.id) ?? null
  if (row && row.action !== 'baseline') await auditSkillRevision(tx, row, row.action)
  return row
}

const AUDIT_ACTION: Record<Exclude<SkillRevisionAction, 'baseline'>, 'create' | 'update' | 'delete'> = {
  create: 'create', seed: 'create', modify: 'update', file_put: 'update', file_seed: 'update', file_delete: 'update', delete: 'delete', revoke: 'update',
}

/**
 * The audit-log row of a revision, written in the same transaction. The detail names the revision and the first 12
 * hex digits of the text hash: never the text itself (a skill can hold anything, the audit log is read more widely).
 * The baseline is not audited: it records the state a skill already had, not a change.
 */
async function auditSkillRevision(tx: SqlOps, row: SkillRevisionRow, action: Exclude<SkillRevisionAction, 'baseline'>): Promise<void> {
  await writeAgentAuditLog({
    agent_id: row.author_id ?? row.author_kind,
    entity: 'skill',
    action: AUDIT_ACTION[action],
    entity_id: row.skill_id,
    detail: { seq: row.seq, action: row.action, author_kind: row.author_kind, content_sha256: row.content_sha256?.slice(0, 12) ?? null },
    tenant_id: row.tenant_id,
  }, tx)
}

/**
 * Makes sure a skill that predates the trail has its baseline before the write that is about to change it, so the
 * state before that write is on record whatever the boot backfill has or has not reached yet. Call it inside the
 * transaction, BEFORE the write. A skill that is already traced, or does not exist, is left alone. Returns true when
 * it wrote the baseline.
 */
export async function ensureSkillBaseline(tx: SqlOps, skillId: string): Promise<boolean> {
  if (await tx.get('SELECT 1 FROM skill_revisions WHERE skill_id = ?', skillId)) return false
  const skill = await tx.get<SkillRevisionSubject>('SELECT id, tenant_id, content FROM skills WHERE id = ?', skillId)
  if (!skill) return false
  await writeSkillRevision(tx, { skill, action: 'baseline', actor: { kind: 'system', id: 'baseline' } })
  return true
}

/** One revision as the read API shows it: who, what changed (as hashes) and when, never the text or the file bytes. */
export interface SkillRevisionMeta {
  seq: number
  action: SkillRevisionAction
  content_sha256: string | null
  prev_sha256: string | null
  files_sha256: string | null
  has_scripts: boolean
  author_kind: SkillActorKind
  author_id: string | null
  source_ref: string | null
  reason: string | null
  created_at: number
  status: SkillRevisionStatus
  touches_privilege: boolean
}

/**
 * The trail of one skill, oldest first. The skill may be gone (a deleted skill's trail is the point) or may never
 * have existed: both answer the same, an empty list. The text (`content`) is deliberately not selected.
 */
export async function listSkillRevisions(skillId: string): Promise<SkillRevisionMeta[]> {
  const rows = await dbx.all<Omit<SkillRevisionMeta, 'has_scripts' | 'touches_privilege'> & { has_scripts: number; touches_privilege: number }>(`
    SELECT seq, action, content_sha256, prev_sha256, files_sha256, has_scripts, author_kind, author_id, source_ref, reason, created_at,
           status, touches_privilege
    FROM skill_revisions WHERE skill_id = ? ORDER BY seq`, skillId)
  return rows.map((r) => ({ ...r, has_scripts: r.has_scripts === 1, touches_privilege: r.touches_privilege === 1 }))
}

/** One companion file a pending revision proposes. */
export interface ProposedFile {
  rel_path: string
  mode: number
  content: Buffer
}

export interface SubmitPendingRevisionOpts extends SkillWriteMeta {
  skill: { id: string; tenant_id: string }
  /** 'create': the skill has no live state yet (an import); 'modify': a change proposed to a live skill. */
  action: 'create' | 'modify'
  /** The proposed SKILL.md (header already stripped) and the COMPLETE proposed companion file set. */
  content: string
  files: readonly ProposedFile[]
  actor: SkillActor
  touchesPrivilege: boolean
}

export interface SubmitPendingRevisionResult {
  revision: SkillRevisionRow
  /** False when an identical proposal was already waiting: nothing is written then, the existing one is returned. */
  created: boolean
}

/**
 * Records a change that must be reviewed before it goes live, as a revision of its own with status 'pending'. The
 * live skill row and its files are NOT touched: the proposed text sits on the revision and the proposed companion files
 * in skill_revision_files, until a decision (a later step) activates or rejects it. Call it with the transaction handle.
 *
 * The same proposal (same text hash and file-set hash) for the same skill is recorded once: while it waits, a repeat
 * returns the waiting revision instead of filling the trail. prev_sha256 is the hash of the latest ACTIVATED state, so
 * a reviewer sees what the proposal replaces. A skill that predates the trail gets its baseline first, so the state
 * before the proposal is on record.
 */
export async function submitPendingRevision(tx: SqlOps, opts: SubmitPendingRevisionOpts): Promise<SubmitPendingRevisionResult> {
  const { skill, actor } = opts
  // A proposal for a skill that already has a live state records that state first; a new skill has none to record
  // (a baseline of the proposed text would read as a live state, which it is not).
  if (opts.action === 'modify') await ensureSkillBaseline(tx, skill.id)
  const contentSha = sha256Hex(opts.content)
  const filesSha = hashFileSet(opts.files)
  // A NULL file-set hash (no companion files) is compared with IS NULL, not "= NULL": the portable form of a null-safe match.
  const waiting = await tx.get<SkillRevisionRow>(
    `SELECT * FROM skill_revisions WHERE skill_id = ? AND status = 'pending' AND content_sha256 = ?
       AND ${filesSha === null ? 'files_sha256 IS NULL' : 'files_sha256 = ?'} ORDER BY seq DESC LIMIT 1`,
    skill.id, contentSha, ...(filesSha === null ? [] : [filesSha]))
  if (waiting) return { revision: waiting, created: false }

  const latest = await tx.get<{ content_sha256: string | null }>(
    "SELECT content_sha256 FROM skill_revisions WHERE skill_id = ? AND status = 'activated' ORDER BY seq DESC LIMIT 1", skill.id)
  await tx.run(`
    INSERT INTO skill_revisions
      (skill_id, tenant_id, seq, action, content_sha256, prev_sha256, files_sha256, has_scripts, content,
       author_kind, author_id, source_ref, reason, status, touches_privilege, submitted_by)
    VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM skill_revisions WHERE skill_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `, skill.id, skill.tenant_id, skill.id, opts.action, contentSha, latest?.content_sha256 ?? null, filesSha,
    hasRunnableFiles(opts.files) ? 1 : 0, opts.content, actor.kind, actor.id, opts.sourceRef ?? null, opts.reason ?? null,
    opts.touchesPrivilege ? 1 : 0, actor.id)
  const row = await tx.get<SkillRevisionRow>('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY seq DESC LIMIT 1', skill.id) as SkillRevisionRow
  for (const f of opts.files) {
    await tx.run('INSERT INTO skill_revision_files (revision_id, rel_path, mode, content) VALUES (?, ?, ?, ?)', row.id, f.rel_path, f.mode, f.content)
  }
  // Like every other revision, audited by hash, never by text; the detail says it is a proposal, not a live change.
  await writeAgentAuditLog({
    agent_id: row.author_id ?? row.author_kind,
    entity: 'skill',
    action: 'update',
    entity_id: row.skill_id,
    detail: { seq: row.seq, action: row.action, status: 'pending', author_kind: row.author_kind, content_sha256: row.content_sha256?.slice(0, 12) ?? null },
    tenant_id: row.tenant_id,
  }, tx)
  return { revision: row, created: true }
}

/** The revisions waiting for a decision, oldest first: hashes and who proposed, never the text. Optionally one skill. */
export interface PendingRevisionMeta {
  skill_id: string
  tenant_id: string
  seq: number
  action: SkillRevisionAction
  content_sha256: string | null
  prev_sha256: string | null
  files_sha256: string | null
  has_scripts: boolean
  touches_privilege: boolean
  author_kind: SkillActorKind
  submitted_by: string | null
  source_ref: string | null
  created_at: number
}

export async function listPendingRevisions(skillId?: string): Promise<PendingRevisionMeta[]> {
  const rows = await dbx.all<Omit<PendingRevisionMeta, 'has_scripts' | 'touches_privilege'> & { has_scripts: number; touches_privilege: number }>(`
    SELECT skill_id, tenant_id, seq, action, content_sha256, prev_sha256, files_sha256, has_scripts, touches_privilege,
           author_kind, submitted_by, source_ref, created_at
    FROM skill_revisions WHERE status = 'pending'${skillId === undefined ? '' : ' AND skill_id = ?'} ORDER BY created_at, skill_id, seq`,
    ...(skillId === undefined ? [] : [skillId]))
  return rows.map((r) => ({ ...r, has_scripts: r.has_scripts === 1, touches_privilege: r.touches_privilege === 1 }))
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
      // Re-checked inside the transaction: the skill may have been written (and so already traced) since the listing.
      const wrote = await dbx.tx((tx) => ensureSkillBaseline(tx, id))
      if (wrote) out.written++
    } catch (err) {
      out.errors++
      logger.warn({ err, skillId: id }, 'Skill baseline revision failed')
    }
  }
  return out
}
