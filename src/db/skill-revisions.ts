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
  proposed_description: string | null
  /** Hash of the whole live state (text, description, file set) a proposal was built against; NULL: see hashSkillState. */
  prev_state_sha256: string | null
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

/**
 * Hash of the whole live state of a skill: SHA-256 over "<sha256 of the SKILL.md text>\0<description>\0<file-set hash>",
 * the file-set hash being empty when the skill has no companion files. A proposal records it when it is built and the
 * activation recomputes it from the live tables, so a change to the description or to the companion files counts as
 * much as a change to the text. One function for both sides: the two cannot drift.
 */
export function hashSkillState(content: string, description: string, files: readonly FileFacts[]): string {
  return sha256Hex(`${sha256Hex(content)}\0${description}\0${hashFileSet(files) ?? ''}`)
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
  /** The description column the proposal carries; omitted/null: it is derived from the proposed SKILL.md when it is activated. */
  description?: string | null
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
  // The LIVE state the proposal is built against, read from the tables (not from the revision trail: a description-only
  // edit and some file writes leave no revision). Always present for a real caller (the live row, or the placeholder
  // of a create); a row that is missing leaves it NULL, which activation reads as "compare the text only".
  const liveSkill = await tx.get<{ content: string; description: string }>('SELECT content, description FROM skills WHERE id = ?', skill.id)
  const liveFiles = await tx.all<FileFacts>('SELECT rel_path, mode, content FROM skill_files WHERE skill_id = ?', skill.id)
  const prevState = liveSkill ? hashSkillState(liveSkill.content, liveSkill.description, liveFiles) : null
  await tx.run(`
    INSERT INTO skill_revisions
      (skill_id, tenant_id, seq, action, content_sha256, prev_sha256, files_sha256, has_scripts, content,
       author_kind, author_id, source_ref, reason, status, touches_privilege, submitted_by, proposed_description, prev_state_sha256)
    VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM skill_revisions WHERE skill_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `, skill.id, skill.tenant_id, skill.id, opts.action, contentSha, latest?.content_sha256 ?? null, filesSha,
    hasRunnableFiles(opts.files) ? 1 : 0, opts.content, actor.kind, actor.id, opts.sourceRef ?? null, opts.reason ?? null,
    opts.touchesPrivilege ? 1 : 0, actor.id, opts.description ?? null, prevState)
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

/** The description a SKILL.md frontmatter names, or '' when there is none. Single-line only (no folded blocks): the
 * same shape skill-seed-refresh.ts reads, duplicated here rather than imported across the web/db layer boundary. */
function frontmatterDescription(content: string): string {
  const fm = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return ''
  const line = fm[1].match(/^description:[ \t]*(.+)$/im)
  if (!line) return ''
  const val = line[1].trim()
  const quoted = val.match(/^(["'])(.*)\1$/)
  return quoted ? quoted[2] : val
}

// Thrown INSIDE decideSkillRevision's transaction to abort and roll back everything written so far (the revision's
// own status flip included), converted to a result outcome by the catch below -- the same shape SkillNotLiveAtWrite
// (tasks.ts, deleteSkill) uses for its own in-tx CAS.
class SkillNotDecidableAtActivate extends Error {}
class SkillRevisionStaleAtActivate extends Error {}
class SkillRevisionCorruptAtActivate extends Error {}

export type DecideSkillRevisionOutcome =
  | 'not_found' | 'not_pending' | 'self_approval_forbidden' | 'skill_not_decidable' | 'stale_proposal' | 'corrupt_proposal'
  | 'activated' | 'rejected'
export interface DecideSkillRevisionResult {
  outcome: DecideSkillRevisionOutcome
  /** Set only on 'activated': the caller regenerates this skill's disk file AFTER the transaction, the same way
   * every other skill write path regenerates from the route layer, never from inside db/. */
  skillId?: string
  /** Set only on 'activated': the companion files the skill HAD that the activated set no longer carries (rel_path +
   * the bytes that were in the DB), read inside the transaction just before the whole-set replace. The caller removes
   * their generated copies from disk after the commit (removeGeneratedCompanionFile, byte-equal only), the way the
   * single-file DELETE route does: the regen only writes, so without this a dropped (possibly executable) script
   * stays on disk and the boot-time companion import copies it back into the live skill unreviewed. */
  removedFiles?: { rel_path: string; content: Buffer }[]
  /** Set only on 'activated': the skill row's tenant, which removeGeneratedCompanionFile needs to find the disk copy. */
  tenantId?: string
}

/**
 * Author kinds whose own submitter MAY activate what they submitted: 'import' / 'human' / 'operator' are the people at
 * the dashboard (the import route's actor is the uploading session user), the only approvers by design. Everything
 * else ('agent', 'system', 'auto') is not exempt.
 */
const SELF_APPROVAL_EXEMPT_AUTHOR_KINDS: ReadonlySet<string> = new Set(['import', 'human', 'operator'])

/**
 * Decides a pending revision: 'activate' makes its proposed content/files the skill's live state, 'reject' leaves
 * the live skill untouched. The decision itself is a CAS on the revision row (`WHERE id = ? AND status = 'pending'`,
 * same pattern as `requireLive` in updateSkill/deleteSkill): of two concurrent decisions on the same id, only the one
 * whose UPDATE actually changes a row proceeds, the other gets 'not_pending'. A revision id that never existed
 * answers 'not_found'; one that exists but was never 'pending' (already decided, or expired) answers 'not_pending' --
 * the CAS alone cannot tell "never existed" from "already decided", so the row is read once, outside the CAS, to
 * distinguish the two for the caller.
 *
 * Separation of duties: 'activate' on a revision whose `submitted_by` is this same `decider.id` answers
 * 'self_approval_forbidden' without touching the row (it stays pending for a DIFFERENT approver), BUT only when the
 * revision's author kind is not import / human / operator (SELF_APPROVAL_EXEMPT_AUTHOR_KINDS). The rule is about the
 * AUTHOR of a skill (an agent, or a delegated approver approving their own text), not about the operator who carries
 * an external archive in: external-import approval is the dashboard admin's alone, so banning the importer from
 * approving their own import would make an import impossible to activate on a single-admin install. For an
 * agent-authored proposal the ban stays (and guards the day a delegated, non-admin approver exists). 'reject' has no
 * such check -- withdrawing your own proposal is not an approval.
 *
 * activate:
 *  - the skill must still be in the exact state the proposal assumed: 'pending_review' for action 'create' (nobody
 *    else activated or deleted it since), 'live' for anything else (nobody revoked or deleted it since). This is a
 *    second CAS, on the skill row itself (`WHERE id = ? AND status = <expected>`); 0 rows changed aborts the whole
 *    decision ('skill_not_decidable', the revision stays pending) -- without it, activating an old pending proposal
 *    could silently resurrect a skill an admin had deliberately revoked in the meantime.
 *  - a 'modify' proposal also carries `prev_state_sha256`, the hash of the whole live state (text, description, companion
 *    file set) at the time it was submitted; if the live skill has since moved past that (another activation landed
 *    first, a direct write changed the description, a file was put or deleted), applying this older proposal now would
 *    silently discard that change, so the decision aborts ('stale_proposal') instead. The live state is read from the
 *    tables under the row lock, not from the revision trail. A proposal without that hash (written before migration
 *    0095) falls back to comparing the text hash `prev_sha256` with the latest activated revision.
 *  - the companion files (skill_revision_files, no FK) are re-hashed and compared with the revision's own
 *    `files_sha256` before use ('corrupt_proposal' on a mismatch): nothing else protects that table between the
 *    propose and the decide, unlike `content`, which only this module ever writes to the revision row.
 *  - action 'create': the skill row is still the gate's `pending_review` placeholder -> it is promoted to 'live'
 *    with the proposed content/description. Anything else: the skill is already live -> only content/description
 *    are overwritten.
 *  - the companion files become EXACTLY the proposed set: a DELETE of the skill's current files followed by an
 *    INSERT of the proposed ones, the same "whole set" shape putSkillFile's gated branch uses.
 *  - the result carries `skillId` so the CALLER regenerates the disk file after the transaction commits, the same
 *    way every other skill write path regenerates from the route layer (db/ never imports skill-regen.js). It also
 *    carries `removedFiles` (the files the skill had that the proposed set drops) and `tenantId`, so the caller can
 *    take their generated copies off the disk: the regen only writes, it never deletes.
 *
 * reject:
 *  - the revision row is marked 'rejected'; the live skill and its files are untouched.
 *  - EXCEPT when action is 'create' and the skill is still 'pending_review' (nothing else activated it meanwhile):
 *    that skill row never had a live state to begin with, so it and its (always empty, by construction) file set
 *    are deleted outright -- otherwise a rejected create leaves silent pending_review debris behind forever.
 */
export async function decideSkillRevision(
  revisionId: number,
  decision: 'activate' | 'reject',
  decider: SkillActor,
  decisionRef?: string | null,
): Promise<DecideSkillRevisionResult> {
  const now = Math.floor(Date.now() / 1000)
  try {
    return await dbx.tx(async (tx) => {
      const revision = await tx.get<SkillRevisionRow>('SELECT * FROM skill_revisions WHERE id = ?', revisionId)
      if (!revision) return { outcome: 'not_found' as const }

      // Separation of duties: the AUTHOR of a change (an agent) may withdraw it (reject), but may not be the one who
      // puts it live. Not applied to import / human / operator submitters (SELF_APPROVAL_EXEMPT_AUTHOR_KINDS): that is
      // the dashboard admin, who is the only approver by design. Checked before the CAS below, so a refused
      // self-activate leaves the revision untouched (still pending for a DIFFERENT approver), not consumed.
      if (decision === 'activate' && revision.submitted_by !== null && revision.submitted_by === decider.id
          && !SELF_APPROVAL_EXEMPT_AUTHOR_KINDS.has(revision.author_kind)) {
        return { outcome: 'self_approval_forbidden' as const }
      }

      const claimed = (await tx.run(
        `UPDATE skill_revisions SET status = ?, decided_by = ?, decided_at = ?, decision_ref = ? WHERE id = ? AND status = 'pending'`,
        decision === 'activate' ? 'activated' : 'rejected', decider.id, now, decisionRef ?? null, revisionId,
      )).changes
      if (claimed === 0) return { outcome: 'not_pending' as const }

      if (decision === 'reject') {
        if (revision.action === 'create') {
          const skill = await tx.get<{ status: string }>('SELECT status FROM skills WHERE id = ?', revision.skill_id)
          if (skill && skill.status === 'pending_review') {
            await tx.run('DELETE FROM skill_files WHERE skill_id = ?', revision.skill_id)
            await tx.run('DELETE FROM skills WHERE id = ?', revision.skill_id)
          }
        }
        await writeAgentAuditLog({
          agent_id: decider.id ?? decider.kind,
          entity: 'skill',
          action: 'update',
          entity_id: revision.skill_id,
          detail: { seq: revision.seq, decision: 'reject' },
          tenant_id: revision.tenant_id,
        }, tx)
        return { outcome: 'rejected' as const }
      }

      // activate
      // Integrity: skill_revision_files has no FK and nothing else protects it between the propose and the decide
      // (unlike skill_revisions.content, which only this module ever writes). Refuse rather than install bytes that
      // no longer match the hash the proposal was recorded with.
      const files = await tx.all<{ rel_path: string; mode: number; content: Buffer }>(
        'SELECT rel_path, mode, content FROM skill_revision_files WHERE revision_id = ?', revisionId)
      if (hashFileSet(files) !== revision.files_sha256) throw new SkillRevisionCorruptAtActivate()
      // Same check for the proposed text itself: its hash was recorded at propose time, and the row sits in the same
      // table family as the files. A row without a recorded hash (legacy) has nothing to compare against.
      if (revision.content_sha256 !== null && sha256Hex(revision.content ?? '') !== revision.content_sha256) {
        throw new SkillRevisionCorruptAtActivate()
      }

      // ORDER IS DELIBERATE (do not move the staleness read above the lock, and do not move the lock below the real
      // write). The first statement that touches the skill row is the lock-taking no-op below: it takes that row's
      // write lock before anything is read from it. The live-state read for the staleness check runs AFTER the lock and
      // BEFORE the real write (a read after the real write would read this proposal's own values). Two concurrent
      // activations of the same skill serialize on the row: the second one waits for the first to commit and then sees
      // its activation in the staleness read (stale_proposal) instead of reading the old state and overwriting the
      // first. On serial SQLite the orders behave the same, so no test can tell them apart (a mutant that swaps them
      // stays green); the ordering matters under Postgres READ COMMITTED (planned migration) and is on that migration's
      // checklist. Every throw below rolls the writes back.
      const content = revision.content ?? ''
      const description = revision.proposed_description ?? frontmatterDescription(content)
      // The skill must still be in the state this proposal assumed: 'pending_review' for a create (nobody else
      // activated or deleted it since), 'live' for anything else (nobody revoked or deleted it since). The no-op
      // UPDATE is the CAS and the lock in one, like requireLive in updateSkill/deleteSkill -- 0 rows changed aborts the
      // whole decision, the revision stays pending (the throw rolls back the status flip above too).
      const expectedSkillStatus = revision.action === 'create' ? 'pending_review' : 'live'
      const locked = (await tx.run(
        'UPDATE skills SET updated_at = updated_at WHERE id = ? AND status = ?', revision.skill_id, expectedSkillStatus,
      )).changes
      if (locked === 0) throw new SkillNotDecidableAtActivate()

      // The live state NOW, read under the lock and before the real write: the skill row and the companion files. The
      // files are also what the whole-set replace below drops (the ones whose rel_path is not in the proposed set are
      // handed back so the caller can remove their disk copies, see removedFiles on the result).
      const live = await tx.get<{ content: string; description: string; tenant_id: string }>(
        'SELECT content, description, tenant_id FROM skills WHERE id = ?', revision.skill_id)
      const before = await tx.all<{ rel_path: string; mode: number; content: Buffer }>(
        'SELECT rel_path, mode, content FROM skill_files WHERE skill_id = ?', revision.skill_id)

      // Staleness: a 'modify' proposal was built against the live state at the time it was submitted. If the live skill
      // moved on since, applying this older proposal now would silently discard that change. Two ways the state moves
      // that the text hash cannot see: a write that changes only the description (no revision is written for it) and a
      // companion file put or delete (the whole-set replace below would discard it). So a proposal records the hash of
      // the whole live state (prev_state_sha256, see hashSkillState) and it is compared with the same hash computed
      // from the live tables here, not from the revision trail. A 'create' has no prior state -- nothing to compare.
      if (revision.action !== 'create') {
        if (revision.prev_state_sha256 !== null) {
          if (live === undefined || hashSkillState(live.content, live.description, before) !== revision.prev_state_sha256) {
            throw new SkillRevisionStaleAtActivate()
          }
        } else {
          // A proposal recorded before migration 0095 (only a pending dashboard import can still be one) carries no
          // state hash. It keeps the old comparison, the SKILL.md text alone against the latest activated revision: not
          // stale on purpose (that would strand the pending import for no safety gain). No new row has a NULL here.
          // Excludes THIS row: the CAS above already flipped it to 'activated', so without the exclusion it would be
          // its own "latest activated" -- its content_sha256 is the proposed (new) text, which can never equal its
          // own prev_sha256 (the old text it was proposed against), so every activation would wrongly read as stale.
          const latestActivated = await tx.get<{ content_sha256: string | null }>(
            "SELECT content_sha256 FROM skill_revisions WHERE skill_id = ? AND status = 'activated' AND id != ? ORDER BY seq DESC LIMIT 1",
            revision.skill_id, revisionId)
          if ((latestActivated?.content_sha256 ?? null) !== revision.prev_sha256) throw new SkillRevisionStaleAtActivate()
        }
      }

      const skillChanges = (await tx.run(
        "UPDATE skills SET content = ?, description = ?, status = 'live', updated_at = ? WHERE id = ? AND status = ?",
        content, description, now, revision.skill_id, expectedSkillStatus,
      )).changes
      if (skillChanges === 0) throw new SkillNotDecidableAtActivate()

      const proposedPaths = new Set(files.map((f) => f.rel_path))
      const removedFiles = before.filter((f) => !proposedPaths.has(f.rel_path)).map((f) => ({ rel_path: f.rel_path, content: f.content }))
      const skillRow = live
      await tx.run('DELETE FROM skill_files WHERE skill_id = ?', revision.skill_id)
      for (const f of files) {
        await tx.run(
          'INSERT INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          revision.skill_id, f.rel_path, f.content, f.mode, now, now,
        )
      }
      await writeAgentAuditLog({
        agent_id: decider.id ?? decider.kind,
        entity: 'skill',
        action: 'update',
        entity_id: revision.skill_id,
        detail: { seq: revision.seq, decision: 'activate', content_sha256: revision.content_sha256?.slice(0, 12) ?? null },
        tenant_id: revision.tenant_id,
      }, tx)
      return { outcome: 'activated' as const, skillId: revision.skill_id, removedFiles, tenantId: skillRow?.tenant_id ?? revision.tenant_id }
    })
  } catch (err) {
    if (err instanceof SkillNotDecidableAtActivate) return { outcome: 'skill_not_decidable' }
    if (err instanceof SkillRevisionStaleAtActivate) return { outcome: 'stale_proposal' }
    if (err instanceof SkillRevisionCorruptAtActivate) return { outcome: 'corrupt_proposal' }
    throw err
  }
}

export interface SkillRevisionFileView {
  rel_path: string
  mode: number
  content_base64: string
}

export interface SkillRevisionDetail extends SkillRevisionRow {
  files: SkillRevisionFileView[]
}

/**
 * One revision's full data for admin review: the row (including its proposed `content`, unlike
 * listPendingRevisions/listSkillRevisions which both omit it on purpose) plus its proposed companion files. Any
 * status, not only 'pending': a decided revision stays reviewable. Null when the id does not exist.
 */
export async function getRevisionDetail(id: number): Promise<SkillRevisionDetail | null> {
  const revision = await dbx.get<SkillRevisionRow>('SELECT * FROM skill_revisions WHERE id = ?', id)
  if (!revision) return null
  const files = await dbx.all<{ rel_path: string; mode: number; content: Buffer }>(
    'SELECT rel_path, mode, content FROM skill_revision_files WHERE revision_id = ? ORDER BY rel_path', id)
  return { ...revision, files: files.map((f) => ({ rel_path: f.rel_path, mode: f.mode, content_base64: f.content.toString('base64') })) }
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
