// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getEffectiveSettingValue } from '../settings-store.js'
import { writeAgentAuditLog } from './audit.js'
import { updateIdeaWithStatusLog } from './misc.js'
import { logger } from '../logger.js'
import { dbx, type Dbx, type SqlOps, type Tx } from './facade.js'

/** The card's running number (#N): the insertion-order id of the row. One definition, shared with the tenant-scoped list. */
export const KANBAN_SEQ_COLUMN = 'rowid AS seq'

export interface KanbanCard {
  id: string
  // Stable running number derived from the SQLite rowid (insertion order, never
  // reused) -- a human-friendly "#N" shown next to the 8-char hex id.
  seq?: number
  title: string
  description: string | null
  status: 'planned' | 'in_progress' | 'waiting' | 'testing' | 'done'
  assignee: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  project: string | null
  parent_id: string | null
  // Denormalized depth in the card tree: 0 = top-level, 1 = subtask, 2 = sub-subtask.
  // Maintained by createKanbanCard, updateKanbanCard, and reparentKanbanCard.
  // Max allowed depth is 2 (enforced at application layer).
  depth: number
  due_date: number | null
  sort_order: number
  created_at: number
  updated_at: number
  archived_at: number | null
  tenant_id?: string
  // Set the first time the card is moved to in_progress and the assigned agent
  // is woken (kanban -> agent dispatch). NULL = never dispatched; the once-only
  // guard so re-dragging a card does not re-prompt the agent.
  dispatched_at: number | null
  // Live-state provenance for a status='waiting' card, mirroring
  // fleet_blackboard's blocked_by/blocked_reason: who/why it stalled getting
  // here, when known (kanban has no 'blocked' status, only 'waiting').
  blocked_by: string | null
  blocked_reason: string | null
  // Free-text description of what the card is actually waiting on right now
  // (e.g. "PR review", "external API access") -- distinct from blocked_by/
  // blocked_reason above. Only meaningful while status === 'waiting'.
  waiting_for: string | null
  // Who closed out a waiting card (moved it off 'waiting'), for audit --
  // mirrors fleet_blackboard_history.resolved_by. Not cleared automatically;
  // a caller sets it explicitly on the transition, same as the blackboard.
  resolved_by: string | null
}

export interface KanbanComment {
  id: number
  card_id: string
  author: string
  content: string
  created_at: number
}

// status/limit/offset are all optional and additive: a bare listKanbanCards()
// call keeps returning the full unbounded, unfiltered board exactly as
// before (every existing caller relies on this). They exist for the kanban
// board's per-column "load more" (P1c) -- status scopes to one column,
// limit/offset paginate within it, ordered the same way the flat board
// itself sorts (sort_order ASC, matching idx_kanban_status_sort from
// 0055_pagination_indexes.sql; created_at DESC only breaks ties, since
// sort_order is not guaranteed unique).
export async function listKanbanCards(opts?: { status?: KanbanCard['status']; limit?: number; offset?: number }): Promise<KanbanCard[]> {
  const archiveDays = Number(getEffectiveSettingValue('KANBAN_ARCHIVE_DONE_DAYS'))
  const archiveCutoff = Math.floor(Date.now() / 1000) - archiveDays * 86400
  // Auto-archive done cards older than KANBAN_ARCHIVE_DONE_DAYS days
  await dbx.run("UPDATE kanban_cards SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?", Math.floor(Date.now() / 1000), archiveCutoff)

  const params: unknown[] = []
  let sql = `SELECT ${KANBAN_SEQ_COLUMN}, * FROM kanban_cards WHERE archived_at IS NULL`
  if (opts?.status) { sql += ' AND status = ?'; params.push(opts.status) }
  sql += ' ORDER BY sort_order ASC, created_at DESC'
  if (opts?.limit !== undefined) {
    sql += ' LIMIT ?'; params.push(opts.limit)
    if (opts.offset !== undefined) { sql += ' OFFSET ?'; params.push(opts.offset) }
  }
  return dbx.all<KanbanCard>(sql, ...params)
}

export async function countKanbanCards(status?: KanbanCard['status']): Promise<number> {
  const params: unknown[] = []
  let sql = 'SELECT COUNT(*) AS n FROM kanban_cards WHERE archived_at IS NULL'
  if (status) { sql += ' AND status = ?'; params.push(status) }
  return ((await dbx.get(sql, ...params)) as { n: number }).n
}

export async function listKanbanCardsSummary(): Promise<{ status: string; title: string; assignee: string | null; priority: string; id: string }[]> {
  return dbx.all<any>("SELECT id, title, status, assignee, priority FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC")
}

export async function getKanbanCard(id: string, ops: SqlOps = dbx): Promise<KanbanCard | undefined> {
  return ops.get<KanbanCard>(`SELECT ${KANBAN_SEQ_COLUMN}, * FROM kanban_cards WHERE id = ?`, id)
}

export interface NewKanbanCard {
  id: string
  title: string
  description?: string
  status?: KanbanCard['status']
  assignee?: string
  priority?: KanbanCard['priority']
  project?: string
  parent_id?: string
  due_date?: number | string | null
  tenant_id?: string
}

/** What createKanbanCard audits once its rows are written (the audit write itself is asynchronous). */
export interface KanbanCreateAudit {
  agent_id: string
  entity_id: string
  detail: { title: string; status: string; priority: string }
}

/**
 * The synchronous half of createKanbanCard: it writes the rows and returns the audit entry. It is the one to call
 * inside a synchronous (better-sqlite3) transaction, where an `await` would end the transaction early; the caller
 * writes the entry with writeKanbanCreateAudit after the commit.
 */
export async function insertKanbanCardRows(card: NewKanbanCard, ops: Dbx | Tx = dbx): Promise<KanbanCreateAudit> {
  const now = Math.floor(Date.now() / 1000)
  const status = card.status ?? 'planned'
  const dueDate = card.due_date === undefined ? null : parseKanbanDueDate(card.due_date)
  if (dueDate === undefined) throw new Error('Invalid due_date: an integer epoch in seconds, a YYYY-MM-DD date or null')

  // Compute depth from parent; enforce max 2 (3 levels: 0, 1, 2).
  let depth = 0
  if (card.parent_id) {
    const parent = await getKanbanCard(card.parent_id, ops)
    if (!parent) throw new Error(`Parent card not found: ${card.parent_id}`)
    depth = parent.depth + 1
    if (depth > 2) throw new Error('Cannot create card: exceeds max depth of 3 levels')
  }

  const maxRow = (await ops.get('SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = ? AND archived_at IS NULL', status)) as { m: number | null }
  const sortOrder = (maxRow?.m ?? -1) + 1

  await ops.tx(async (tx) => {
    await tx.run(`INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id, depth, due_date, sort_order, created_at, updated_at, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, card.id, card.title, card.description ?? null, status,
      card.assignee ?? null, card.priority ?? 'normal',
      card.project ?? null, card.parent_id ?? null, depth, dueDate, sortOrder, now, now,
      card.tenant_id ?? 'default',
    )
    // A card BORN in a status other than 'planned' gets its opening event row
    // here, because nothing else will ever write one for it: kanban_card_events
    // is only appended on a MOVE, so a card created straight into in_progress had
    // no history and its "time in progress" read "not measured" forever.
    // from_status is NULL, which is the honest value -- the card came into being
    // here, it did not move from somewhere.
    if (status !== 'planned') {
      await tx.run('INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)', card.id, null, status, card.assignee ?? null, now)
    }
  })
  return { agent_id: card.assignee || 'system', entity_id: card.id, detail: { title: card.title, status, priority: card.priority ?? 'normal' } }
}

/** Best effort: an audit failure must not abort card creation. */
export async function writeKanbanCreateAudit(entry: KanbanCreateAudit): Promise<void> {
  try {
    await writeAgentAuditLog({ agent_id: entry.agent_id, entity: 'kanban', action: 'create', entity_id: entry.entity_id, detail: entry.detail })
  } catch { /* audit failure must not abort card creation */ }
}

export async function createKanbanCard(card: NewKanbanCard): Promise<void> {
  await writeKanbanCreateAudit(await insertKanbanCardRows(card))
}

/**
 * Auto-breakdown: the subtasks of one parent and the parent's summary comment are ONE transaction (a failing
 * subtask leaves no child and no comment). The creation audits are written inside it, each in its own savepoint:
 * a failing audit is logged and rolls back only itself, it never takes a subtask with it.
 */
export async function createKanbanSubtasks(
  parentId: string,
  subtasks: Array<{ title: string; description?: string | null; assignee?: string | null; priority?: string | null }>,
  actor: string,
): Promise<string[]> {
  return dbx.tx(async (tx) => {
    const parent = await getKanbanCard(parentId, tx)
    if (!parent) throw new Error(`Parent card not found: ${parentId}`)
    const ids: string[] = []
    const audits: KanbanCreateAudit[] = []
    for (const st of subtasks) {
      const id = randomUUID().slice(0, 8).toUpperCase()
      audits.push(await insertKanbanCardRows({
        id,
        title: st.title,
        description: st.description ?? undefined,
        assignee: st.assignee ?? undefined,
        priority: (st.priority as NewKanbanCard['priority']) ?? 'normal',
        project: parent.project ?? undefined,
        parent_id: parentId,
        // the subtasks belong to the tenant of the card they hang under
        tenant_id: parent.tenant_id,
      }, tx))
      ids.push(id)
    }
    await addKanbanComment(parentId, actor, `Auto-breakdown: ${ids.length} subtask létrehozva (${ids.join(', ')})`, tx)
    for (const entry of audits) await auditInSavepoint(tx, () => writeKanbanCreateAudit(entry), 'kanban create', entry.entity_id)
    return ids
  })
}

class IdeaGoneError extends Error {}

/**
 * Promoting an idea: the new cards (the first one is the card the idea points at, the rest hang under it) and the
 * idea's status change with its log row are ONE transaction, so a failing second step leaves no orphan card and a
 * failing card leaves the idea untouched. The creation audits are written inside it, each in its own savepoint
 * (a failing audit is logged, it never takes a card with it). Returns false, with nothing written, when the idea row
 * is gone by the time its update runs.
 */
export async function promoteIdeaToKanban(
  ideaId: string,
  cards: NewKanbanCard[],
  idea: { from: string | null; actor: string; note: string },
): Promise<boolean> {
  if (cards.length === 0) throw new Error('promoteIdeaToKanban needs at least one card')
  try {
    await dbx.tx(async (tx) => {
      const audits: KanbanCreateAudit[] = []
      for (const card of cards) audits.push(await insertKanbanCardRows(card, tx))
      // TODO(phase2): the idea write joins this transaction through the ambient connection; pass the tx handle.
      const changed = await updateIdeaWithStatusLog(ideaId, { status: 'kanban', kanban_id: cards[0].id }, { from: idea.from, to: 'kanban', actor: idea.actor, note: idea.note })
      if (!changed) throw new IdeaGoneError()
      for (const entry of audits) await auditInSavepoint(tx, () => writeKanbanCreateAudit(entry), 'kanban create', entry.entity_id)
    })
    return true
  } catch (err) {
    if (err instanceof IdeaGoneError) return false
    throw err
  }
}

/** Runs one audit write in its own savepoint: a failure is logged, rolls back only itself and is never rethrown. */
async function auditInSavepoint(tx: Tx, write: () => Promise<void>, what: string, entityId: string): Promise<void> {
  try {
    await tx.tx(write)
  } catch (err) {
    logger.warn({ err, what, entityId }, 'kanban: audit write failed, the card change stays')
  }
}

/**
 * due_date is an integer epoch in seconds, or null. A calendar date ('2026-07-15') is accepted and
 * stored as its UTC midnight, the way the other rows hold dates. Anything else is invalid: the
 * function returns undefined for it, and the routes answer 400 (a text date once reached the column
 * and a PostgreSQL integer column would reject it). null and '' clear the date.
 */
export function parseKanbanDueDate(v: unknown): number | null | undefined {
  if (v === null || v === '') return null
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : undefined
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (/^\d{1,12}$/.test(s)) return Number(s)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return undefined
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(ms)
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return undefined
  return ms / 1000
}

/**
 * Who made a card edit, for the audit row. `token` is the agent a credential names, `session` a signed-in
 * dashboard user, `self_declared` the X-Agent-Id header of a caller the credential cannot name (the shared
 * token): the last one is a claim, not an identity, and the row says so.
 */
export interface KanbanAuditActor {
  id: string
  source: 'token' | 'session' | 'self_declared'
}

/**
 * The once-only dispatch guard (dispatched_at) belongs to ONE stay in in_progress. Any write that leaves
 * in_progress clears it, so the next entry into in_progress wakes the assignee again; a write that stays in
 * (or enters) in_progress keeps whatever stamp is there. Only the POST /move route wakes an agent: this
 * rule only ever clears. The same rule for every writer of a card's status (move, full-card update,
 * parent auto-status, tenant-scoped update), so no path can leave a stale stamp behind.
 */
export function kanbanWriteClearsDispatch(nextStatus: string): boolean {
  return nextStatus !== 'in_progress'
}

export async function updateKanbanCard(id: string, fields: Partial<Omit<KanbanCard, 'id' | 'created_at'>>, actor?: KanbanAuditActor): Promise<boolean> {
  const card = await getKanbanCard(id)
  if (!card) return false
  if ('due_date' in fields) {
    const due = parseKanbanDueDate(fields.due_date)
    if (due === undefined) throw new Error('Invalid due_date: an integer epoch in seconds, a YYYY-MM-DD date or null')
    fields = { ...fields, due_date: due }
  }
  const now = Math.floor(Date.now() / 1000)

  // When parent_id changes, recompute depth and validate the constraint.
  let newDepth = card.depth
  const parentChanging = 'parent_id' in fields && fields.parent_id !== card.parent_id
  if (parentChanging) {
    if (fields.parent_id) {
      const newParent = await getKanbanCard(fields.parent_id)
      if (!newParent) return false
      newDepth = newParent.depth + 1
      // Ensure no descendant would exceed depth 2 after the move.
      if (newDepth + await getSubtreeHeight(id) > 2) return false
    } else {
      newDepth = 0
    }
  }

  const f = { ...card, ...fields, depth: newDepth, updated_at: now }
  // The row update and the depth cascade over its subtree are one transaction (they ran without a yield before).
  const ok = await dbx.tx(async (tx) => {
    const updated = (await tx.run(`UPDATE kanban_cards SET title=?, description=?, status=?, assignee=?, priority=?, project=?, parent_id=?, depth=?, due_date=?, sort_order=?, updated_at=?, archived_at=?, blocked_by=?, blocked_reason=?, waiting_for=?, resolved_by=?,
     dispatched_at=CASE WHEN ? THEN NULL ELSE dispatched_at END
     WHERE id=?`, f.title, f.description, f.status, f.assignee, f.priority, f.project, f.parent_id, f.depth, f.due_date, f.sort_order, f.updated_at, f.archived_at,
    f.blocked_by, f.blocked_reason, f.waiting_for, f.resolved_by,
    // In SQL and not as a value read earlier: a stamp set between the read and the write must not be overwritten.
    kanbanWriteClearsDispatch(f.status) ? 1 : 0,
    id,
    )).changes > 0
    if (updated && parentChanging) await cascadeDepth(id, newDepth, tx)
    return updated
  })

  if (ok) {
    try {
      // The audit row names whoever made the edit; the assignee is only the fallback for a caller nobody can name
      // (a script on the shared token), because an agent that edits another agent's card is not the assignee.
      await writeAgentAuditLog({
        agent_id: actor?.id ?? (f.assignee || 'system'),
        entity: 'kanban',
        action: 'update',
        entity_id: id,
        detail: { status: f.status, priority: f.priority, ...(actor ? { actor_source: actor.source } : {}) },
      })
    } catch { /* audit failure must not abort card update */ }
  }
  return ok
}

export async function getChildCards(parentId: string): Promise<KanbanCard[]> {
  return dbx.all<KanbanCard>('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL ORDER BY sort_order ASC', parentId)
}

// Recursively update the depth of all descendants of parentId.
// Called after any parent_id change so the denormalized depth stays consistent.
async function cascadeDepth(parentId: string, parentDepth: number, ops: SqlOps = dbx): Promise<void> {
  const children = (await ops.all('SELECT id FROM kanban_cards WHERE parent_id = ?', parentId)) as { id: string }[]
  for (const child of children) {
    await ops.run('UPDATE kanban_cards SET depth = ? WHERE id = ?', parentDepth + 1, child.id)
    await cascadeDepth(child.id, parentDepth + 1, ops)
  }
}

// Returns the full subtree rooted at cardId (including the root card itself),
// ordered by depth then sort_order. Archived descendants are excluded.
export async function getSubtree(cardId: string): Promise<KanbanCard[]> {
  return dbx.all<KanbanCard>(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM kanban_cards WHERE id = ?
      UNION ALL
      SELECT c.id FROM kanban_cards c JOIN subtree s ON c.parent_id = s.id
    )
    SELECT ${KANBAN_SEQ_COLUMN}, kc.* FROM kanban_cards kc
    WHERE kc.id IN (SELECT id FROM subtree) AND kc.archived_at IS NULL
    ORDER BY kc.depth ASC, kc.sort_order ASC
  `, cardId)
}

// Returns the height of the subtree rooted at cardId: 0 means the card is a
// leaf, 1 means it has children but no grandchildren, 2 means it has grandchildren.
// Used to validate depth constraints when reparenting.
export async function getSubtreeHeight(cardId: string): Promise<number> {
  const children = (await dbx.all('SELECT id FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL', cardId)) as { id: string }[]
  if (children.length === 0) return 0
  return 1 + Math.max(...(await Promise.all(children.map(c => getSubtreeHeight(c.id)))))
}

// Reparent a card to a new parent (or to top-level when newParentId is null).
// Validates the depth constraint: target.depth + 1 + subtreeHeight(id) <= 2.
// Cascades depth to all descendants and triggers status propagation on both
// the old and new parent.
export async function reparentKanbanCard(
  id: string, newParentId: string | null,
): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'invalid_value' | 'limit_exceeded'; hint: string }> {
  const card = await getKanbanCard(id)
  if (!card) return { ok: false, code: 'not_found', hint: 'Card not found' }
  if (newParentId === id) return { ok: false, code: 'invalid_value', hint: 'Card cannot be its own parent' }

  let newDepth = 0
  if (newParentId) {
    const newParent = await getKanbanCard(newParentId)
    if (!newParent) return { ok: false, code: 'not_found', hint: 'Parent card not found' }
    newDepth = newParent.depth + 1
    const sh = await getSubtreeHeight(id)
    if (newDepth + sh > 2) return { ok: false, code: 'limit_exceeded', hint: 'Reparenting would exceed max depth of 3 levels' }
  } else {
    const sh = await getSubtreeHeight(id)
    if (sh > 2) return { ok: false, code: 'limit_exceeded', hint: 'Subtree too deep to move to top-level (descendants would exceed depth 2)' }
  }

  const oldParentId = card.parent_id
  const now = Math.floor(Date.now() / 1000)
  await dbx.tx(async (tx) => {
    await tx.run('UPDATE kanban_cards SET parent_id=?, depth=?, updated_at=? WHERE id=?', newParentId, newDepth, now, id)
    await cascadeDepth(id, newDepth, tx)
  })

  if (oldParentId) await propagateStatusForParent(oldParentId)
  if (newParentId) await propagateStatusForParent(newParentId)

  return { ok: true }
}

// Re-evaluates a parent card's status based on its children and auto-updates
// if needed, then bubbles up to the grandparent. Rules:
//   - All children done AND parent not done -> auto-set parent to done.
//   - Some children not done AND parent is done -> auto-revert to in_progress.
//   - Manual status changes override: this only fires on child status events.
async function propagateStatusForParent(parentId: string): Promise<void> {
  const parent = await getKanbanCard(parentId)
  if (!parent || parent.archived_at) return
  const children = await getChildCards(parentId)
  if (children.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const allDone = children.every(c => c.status === 'done')
  if (allDone && parent.status !== 'done') {
    const prev = parent.status
    await dbx.run("UPDATE kanban_cards SET status='done', dispatched_at=NULL, updated_at=? WHERE id=?", now, parent.id)
    await dbx.run("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, 'done', 'auto', ?)", parent.id, prev, now)
    if (parent.parent_id) await propagateStatusForParent(parent.parent_id)
  } else if (!allDone && parent.status === 'done') {
    const prev = parent.status
    // dispatched_at too: a done parent may carry an old stamp (rows from before the clear rule), and the stamp
    // belongs to ONE stay in in_progress, so the revert starts a fresh stay.
    await dbx.run("UPDATE kanban_cards SET status='in_progress', dispatched_at=NULL, updated_at=? WHERE id=?", now, parent.id)
    await dbx.run("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, 'in_progress', 'auto', ?)", parent.id, prev, now)
    if (parent.parent_id) await propagateStatusForParent(parent.parent_id)
  }
}

// Called from route handlers after a card's status changes so the parent
// hierarchy is kept consistent automatically.
export async function propagateStatus(cardId: string): Promise<void> {
  const card = await getKanbanCard(cardId)
  if (!card || !card.parent_id) return
  await propagateStatusForParent(card.parent_id)
}

// opts.expectedStatus turns the move into a compare-and-set: the UPDATE only matches a card that is
// still in that status, so a caller that decided from a stale read (an agent finishing a card the owner
// parked in the meantime) does not overwrite the newer state. false = no row matched, i.e. the card does
// not exist OR is not in the expected status; the route tells the two apart with a re-read.
export async function moveKanbanCard(
  id: string,
  status: KanbanCard['status'],
  sortOrder: number,
  actor?: string,
  orderedIds?: string[],
  opts?: { expectedStatus?: KanbanCard['status'] }
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const expected = opts?.expectedStatus
  // Read the previous status first so we only record an audit event on a real
  // status transition (not a pure sort_order reorder within the same column).
  const prev = (await dbx.get<{ status: string }>('SELECT status FROM kanban_cards WHERE id=?', id))?.status
  // With a CAS the UPDATE below is what proves the card was in `expected`, while `prev` was read a moment
  // earlier and can be stale: the audit event names the status the CAS proved.
  const from = expected ?? prev
  // Leaving in_progress ends the stay the dispatch guard belongs to (kanbanWriteClearsDispatch). It is cleared
  // whatever the previous status was, so a card that is already stuck with a stale stamp heals on its next write.
  const clear = kanbanWriteClearsDispatch(status) ? ', dispatched_at=NULL' : ''
  const sql = expected !== undefined
    ? `UPDATE kanban_cards SET status=?, sort_order=?, updated_at=?${clear} WHERE id=? AND status=?`
    : `UPDATE kanban_cards SET status=?, sort_order=?, updated_at=?${clear} WHERE id=?`

  if (orderedIds && orderedIds.length > 0) {
    // Transactional renumber: status update + full column sort_order renumber in
    // one shot so every card in the target column gets a clean 0..N sequence.
    // Only the moved card's updated_at changes (sort_order is presentation-only).
    let changed = false
    await dbx.tx(async (tx) => {
      const params: unknown[] = [status, orderedIds.indexOf(id), now, id]
      if (expected !== undefined) params.push(expected)
      changed = (await tx.run(sql, ...params)).changes > 0
      // A refused move (no such card, or not in the expected status) must not renumber the column: the
      // other cards' sort_order would change for a move that never happened.
      if (!changed) return
      if (from !== undefined && from !== status) {
        await tx.run(
          'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)',
          id, from, status, actor ?? null, now,
        )
      }
      for (const [i, cardId] of orderedIds.entries()) await tx.run('UPDATE kanban_cards SET sort_order=? WHERE id=?', i, cardId)
    })
    return changed
  }

  // Legacy path: single-card sort_order update (used by schedule-runner and
  // callers that don't supply the full column order).
  const params: unknown[] = [status, sortOrder, now, id]
  if (expected !== undefined) params.push(expected)
  const changed = (await dbx.run(sql, ...params)).changes > 0
  if (changed && from !== undefined && from !== status) {
    await dbx.run('INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)', id, from, status, actor ?? null, now)
  }
  return changed
}

// Claim the once-only kanban -> agent dispatch guard in ONE conditional UPDATE: true for the caller whose
// UPDATE found the stamp unset, false for a card that does not exist or one another dispatcher claimed first.
// Two dispatchers (the move route and the schedule runner) that read the card at the same moment therefore
// cannot both wake the assignee.
export async function markKanbanCardDispatched(id: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run('UPDATE kanban_cards SET dispatched_at=? WHERE id=? AND dispatched_at IS NULL', now, id)).changes > 0
}

// Gives the guard back when the wake-up could not be sent, so the next move to in_progress tries again.
export async function releaseKanbanCardDispatch(id: string): Promise<void> {
  await dbx.run('UPDATE kanban_cards SET dispatched_at=NULL WHERE id=?', id)
}

export async function archiveKanbanCard(id: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run('UPDATE kanban_cards SET archived_at=?, updated_at=? WHERE id=?', now, now, id)).changes > 0
}

export async function unarchiveKanbanCard(id: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run('UPDATE kanban_cards SET archived_at=NULL, updated_at=? WHERE id=? AND archived_at IS NOT NULL', now, id)).changes > 0
}

// Unified search across active AND archived cards -- the single dual-ID text
// search used by both the global sidebar search and the archived view's q
// field. Three match modes, tried in order:
//   1. "#NNN" -> exact rowid match (the human-facing running number).
//   2. 4-8 hex chars -> id prefix match (the stable hex id shown in the UI).
//   3. otherwise -> title/project/assignee substring match.
// Active cards rank before archived ones (archived_at IS NOT NULL ASC), then
// by recency, so a noisy archive (the common case) never buries a live card.
export async function searchKanbanCards(opts: {
  q: string
  limit?: number
  // null/undefined = no tenant restriction (admin, unscoped).
  tenantId?: string | null
}): Promise<(KanbanCard & { seq: number; archived: boolean })[]> {
  const { q, limit = 50, tenantId } = opts
  const like = `%${q}%`
  let sql = `
    SELECT rowid AS seq, *
    FROM kanban_cards
    WHERE (
      (? GLOB '#[0-9]*' AND CAST(rowid AS TEXT) = LTRIM(?, '#'))
      OR (LENGTH(?) >= 4 AND ? GLOB '[0-9a-fA-F]*' AND id LIKE ? || '%')
      OR title LIKE ?
      OR project LIKE ?
      OR assignee LIKE ?
    )
  `
  const params: unknown[] = [q, q, q, q, q, like, like, like]
  if (tenantId != null) {
    sql += ' AND tenant_id = ?'
    params.push(tenantId)
  }
  sql += ' ORDER BY (archived_at IS NOT NULL) ASC, updated_at DESC LIMIT ?'
  params.push(limit)
  const rows = (await dbx.all(sql, ...params)) as (KanbanCard & { seq: number })[]
  return rows.map((r) => ({ ...r, archived: r.archived_at != null }))
}

export interface ArchivedKanbanCard {
  id: string
  title: string
  status: string
  project: string | null
  priority: string
  assignee: string | null
  archived_at: number
  updated_at: number
}

export async function listArchivedKanbanCards(opts: {
  project?: string
  label?: string
  from?: number
  to?: number
  limit: number
  /** Only this tenant's cards; omitted or null = every tenant (the admin view). */
  tenantId?: string | null
}): Promise<ArchivedKanbanCard[]> {
  const { project, label, from, to, limit, tenantId } = opts
  let sql = `
    SELECT DISTINCT kc.id, kc.title, kc.status, kc.project, kc.priority, kc.assignee, kc.archived_at, kc.updated_at
    FROM kanban_cards kc
  `
  const params: unknown[] = []
  if (label) {
    sql += `
      JOIN kanban_card_labels kcl ON kcl.card_id = kc.id
      JOIN labels l ON l.id = kcl.label_id AND l.name = ?
    `
    params.push(label)
  }
  sql += ' WHERE kc.archived_at IS NOT NULL'
  if (tenantId) { sql += ' AND kc.tenant_id = ?'; params.push(tenantId) }
  if (project) { sql += ' AND kc.project = ?'; params.push(project) }
  if (from)    { sql += ' AND kc.archived_at >= ?'; params.push(from) }
  if (to)      { sql += ' AND kc.archived_at <= ?'; params.push(to) }
  sql += ' ORDER BY kc.archived_at DESC LIMIT ?'
  params.push(limit)
  return dbx.all<ArchivedKanbanCard>(sql, ...params)
}

/** The project names of the active cards; `tenantId` limits them to that tenant (omitted or null = every tenant). */
export async function listKanbanProjects(tenantId?: string | null): Promise<string[]> {
  const rows = (await dbx.all(`SELECT DISTINCT project FROM kanban_cards
     WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL AND (? IS NULL OR tenant_id = ?)
     ORDER BY project`, tenantId ?? null, tenantId ?? null)) as Array<{ project: string }>
  return rows.map(r => r.project)
}

export async function deleteKanbanCard(id: string): Promise<boolean> {
  // Wrapped in a transaction to ensure atomicity. Steps in FK-safe order:
  //   1. Delete comments referencing this card (FK: kanban_comments.card_id).
  //   2. Delete this card's label associations (FK: kanban_card_labels.card_id).
  //   3. Promote children to the deleted card's parent (grandparent adoption):
  //      if the deleted card has a parent, its children inherit that parent
  //      and get depth = grandparent.depth + 1; if the deleted card is
  //      top-level, children become top-level (parent_id = NULL, depth = 0).
  //      Grandchildren are depth-cascaded accordingly.
  //   4. Delete the card itself.
  const card = await getKanbanCard(id)
  if (!card) return false
  const grandparentId = card.parent_id
  const grandparentDepth = grandparentId ? ((await getKanbanCard(grandparentId))?.depth ?? 0) : -1
  const now = Math.floor(Date.now() / 1000)

  const deleted = await dbx.tx(async (tx) => {
    await tx.run('DELETE FROM kanban_comments WHERE card_id = ?', id)
    await tx.run('DELETE FROM kanban_card_labels WHERE card_id = ?', id)
    const children = (await tx.all('SELECT id FROM kanban_cards WHERE parent_id = ?', id)) as { id: string }[]
    for (const child of children) {
      const newChildDepth = grandparentDepth + 1  // -1+1=0 when grandparent is null
      await tx.run('UPDATE kanban_cards SET parent_id=?, depth=?, updated_at=? WHERE id=?', grandparentId, newChildDepth, now, child.id
      )
      await cascadeDepth(child.id, newChildDepth, tx)
    }
    const removed = (await tx.run('DELETE FROM kanban_cards WHERE id = ?', id)).changes > 0
    // The delete and its audit commit together; the audit runs in its own savepoint, so a failing audit is logged
    // and rolls back only itself, the delete stays.
    if (removed) {
      await auditInSavepoint(
        tx,
        () => writeAgentAuditLog({ agent_id: card.assignee || 'system', entity: 'kanban', action: 'delete', entity_id: id, detail: { title: card.title } }),
        'kanban delete', id,
      )
    }
    return removed
  })
  return deleted
}

export async function getKanbanComments(cardId: string): Promise<KanbanComment[]> {
  return dbx.all<KanbanComment>('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC', cardId)
}

export interface KanbanCardEvent {
  id: number
  card_id: string
  from_status: string | null
  to_status: string
  actor: string | null
  created_at: number
}

export async function getKanbanCardEvents(cardId: string): Promise<KanbanCardEvent[]> {
  return dbx.all<KanbanCardEvent>('SELECT * FROM kanban_card_events WHERE card_id = ? ORDER BY created_at ASC, id ASC', cardId)
}

/** Ids of the other cards (any column) assigned to one of `assignees` (lowercase) that were ever moved into or out of in_progress. */
export async function listOtherCardIdsWithProgressEvents(cardId: string, assignees: string[]): Promise<string[]> {
  if (assignees.length === 0) return []
  const rows = (await dbx.all(`
    SELECT DISTINCT e.card_id AS id FROM kanban_card_events e
    JOIN kanban_cards c ON c.id = e.card_id
    WHERE e.card_id <> ? AND lower(c.assignee) IN (${assignees.map(() => '?').join(',')})
      AND (e.to_status = 'in_progress' OR e.from_status = 'in_progress')
  `, cardId, ...assignees)) as { id: string }[]
  return rows.map(r => r.id)
}

// Lookup a kanban card's `seq` (its sqlite rowid) by the 8-char hex id stored
// in `kanban_cards.id`. Used by the kanban-ref normalizer to rewrite hex
// references to the human-facing `#<seq>` form. Returns null when the prefix
// matches zero rows OR more than one row (ambiguous → leave the message
// untouched rather than guess). Case-insensitive: breakdown subtask ids are
// uppercased while createKanbanCard ids stay lowercase.
export async function getKanbanSeqByIdPrefix(prefix: string): Promise<number | null> {
  const rows = (await dbx.all('SELECT rowid AS seq FROM kanban_cards WHERE id = ? COLLATE NOCASE LIMIT 2', prefix)) as { seq: number }[]
  if (rows.length !== 1) return null
  return rows[0].seq
}

// Find an active (non-archived) kanban card by exact title match, or
// undefined when none exists.
export async function findActiveKanbanCardByTitle(title: string): Promise<KanbanCard | undefined> {
  return dbx.get<KanbanCard>('SELECT rowid AS seq, * FROM kanban_cards WHERE title = ? AND archived_at IS NULL LIMIT 1', title)
}

// Move the first active kanban card whose title equals `taskName` to the
// 'waiting' status, appending it at the end of the waiting column.
// Returns the card id when a match was found and updated, null otherwise.
// Used by the scheduled-task fire-timeout watchdog when alerting about a
// potentially stuck task.
export async function markScheduledTaskKanbanWaiting(taskName: string): Promise<string | null> {
  const card = await findActiveKanbanCardByTitle(taskName)
  if (!card) return null
  const maxResult = (await dbx.get("SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = 'waiting' AND archived_at IS NULL")) as { m: number | null }
  const sortOrder = (maxResult.m ?? 0) + 100
  // Compare-and-set on the status that was read: a card the owner moved (to done, say) while the sort order was
  // computed is not dragged back into waiting by the watchdog; the mark then reports "no card".
  const moved = await moveKanbanCard(card.id, 'waiting', sortOrder, 'scheduler', undefined, { expectedStatus: card.status })
  return moved ? card.id : null
}

export async function addKanbanComment(cardId: string, author: string, content: string, ops: SqlOps = dbx): Promise<KanbanComment> {
  const now = Math.floor(Date.now() / 1000)
  const { id } = (await ops.get('INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?) RETURNING id', cardId, author, content, now)) as { id: number }
  await ops.run('UPDATE kanban_cards SET updated_at = ? WHERE id = ?', now, cardId)
  return { id, card_id: cardId, author, content, created_at: now }
}

export interface Label {
  id: string
  name: string
  color: string
  created_at: number
  tenant_id: string
}

/** Label names are a tenant's own vocabulary: `tenantId` narrows to that tenant, null = all (admin). */
export async function listLabels(tenantId: string | null = null): Promise<Label[]> {
  return tenantId !== null
    ? await dbx.all<Label>('SELECT * FROM labels WHERE tenant_id = ? ORDER BY name ASC', tenantId)
    : await dbx.all<Label>('SELECT * FROM labels ORDER BY name ASC')
}

export async function getLabel(id: string): Promise<Label | undefined> {
  return dbx.get<Label>('SELECT * FROM labels WHERE id = ?', id)
}

export async function createLabel(label: { id: string; name: string; color: string; tenant_id?: string }): Promise<Label> {
  const now = Math.floor(Date.now() / 1000)
  const tenantId = label.tenant_id ?? 'default'
  await dbx.run('INSERT INTO labels (id, name, color, created_at, tenant_id) VALUES (?, ?, ?, ?, ?)', label.id, label.name, label.color, now, tenantId)
  return { ...label, created_at: now, tenant_id: tenantId }
}

export async function updateLabel(id: string, fields: Partial<Pick<Label, 'name' | 'color'>>): Promise<boolean> {
  const label = await getLabel(id)
  if (!label) return false
  const f = { ...label, ...fields }
  return (await dbx.run('UPDATE labels SET name=?, color=? WHERE id=?', f.name, f.color, id)).changes > 0
}

export async function deleteLabel(id: string): Promise<boolean> {
  // Transaction: drop every card<->label link before the label row itself,
  // otherwise the join table keeps dangling references to a label that no
  // longer exists (foreign_keys is on by default, but the explicit delete keeps
  // this independent of the FK's ON DELETE action; orphan rows would silently
  // resurrect a "deleted" label in card detail views).
  return dbx.tx(async (tx) => {
    await tx.run('DELETE FROM kanban_card_labels WHERE label_id = ?', id)
    return (await tx.run('DELETE FROM labels WHERE id = ?', id)).changes > 0
  })
}

export async function addLabelToCard(cardId: string, labelId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run('INSERT INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', cardId, labelId, now)
}

export async function removeLabelFromCard(cardId: string, labelId: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM kanban_card_labels WHERE card_id = ? AND label_id = ?', cardId, labelId)).changes > 0
}

export async function getLabelsForCard(cardId: string): Promise<Label[]> {
  return dbx.all<Label>(`
    SELECT l.* FROM labels l
    JOIN kanban_card_labels cl ON cl.label_id = l.id
    WHERE cl.card_id = ?
    ORDER BY l.name ASC
  `, cardId)
}

// Bulk variant for the board list view -- one JOIN query instead of an N+1
// per-card lookup when rendering footer pills for every card at once.
export async function getLabelsForAllCards(): Promise<Map<string, Label[]>> {
  const rows = (await dbx.all(`
    SELECT cl.card_id AS card_id, l.id AS id, l.name AS name, l.color AS color, l.created_at AS created_at, l.tenant_id AS tenant_id
    FROM kanban_card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY l.name ASC
  `)) as Array<Label & { card_id: string }>
  const map = new Map<string, Label[]>()
  for (const row of rows) {
    const { card_id, ...label } = row
    const list = map.get(card_id)
    if (list) list.push(label)
    else map.set(card_id, [label])
  }
  return map
}

export interface KanbanAssigneePriorityCount {
  assignee: string | null
  priority: string
  cnt: number
}

/** Open (non-archived) card counts per assignee and priority. */
export async function getOpenKanbanCountsByAssignee(): Promise<KanbanAssigneePriorityCount[]> {
  return dbx.all<KanbanAssigneePriorityCount>(`SELECT assignee, priority, COUNT(*) as cnt
     FROM kanban_cards
     WHERE archived_at IS NULL AND assignee IS NOT NULL
     GROUP BY assignee, priority`)
}
