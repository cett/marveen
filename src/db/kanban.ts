// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { join } from 'node:path'
import { getEffectiveSettingValue } from '../settings-store.js'
import { writeAgentAuditLog } from './audit.js'
import { db } from './connection.js'

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
  // Set the first time the card is moved to in_progress and the assigned agent
  // is woken (kanban -> agent dispatch). NULL = never dispatched; the once-only
  // guard so re-dragging a card does not re-prompt the agent.
  dispatched_at: number | null
}

export interface KanbanComment {
  id: number
  card_id: string
  author: string
  content: string
  created_at: number
}

export function listKanbanCards(): KanbanCard[] {
  const archiveDays = Number(getEffectiveSettingValue('KANBAN_ARCHIVE_DONE_DAYS'))
  const archiveCutoff = Math.floor(Date.now() / 1000) - archiveDays * 86400
  // Auto-archive done cards older than KANBAN_ARCHIVE_DONE_DAYS days
  db.prepare(
    "UPDATE kanban_cards SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?"
  ).run(Math.floor(Date.now() / 1000), archiveCutoff)
  return db
    .prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE archived_at IS NULL ORDER BY sort_order ASC')
    .all() as KanbanCard[]
}

export function listKanbanCardsSummary(): { status: string; title: string; assignee: string | null; priority: string; id: string }[] {
  return db
    .prepare("SELECT id, title, status, assignee, priority FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC")
    .all() as any[]
}

export function getKanbanCard(id: string): KanbanCard | undefined {
  return db.prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE id = ?').get(id) as KanbanCard | undefined
}

export function createKanbanCard(card: {
  id: string
  title: string
  description?: string
  status?: KanbanCard['status']
  assignee?: string
  priority?: KanbanCard['priority']
  project?: string
  parent_id?: string
  due_date?: number
  tenant_id?: string
}): void {
  const now = Math.floor(Date.now() / 1000)
  const status = card.status ?? 'planned'

  // Compute depth from parent; enforce max 2 (3 levels: 0, 1, 2).
  let depth = 0
  if (card.parent_id) {
    const parent = getKanbanCard(card.parent_id)
    if (!parent) throw new Error(`Parent card not found: ${card.parent_id}`)
    depth = parent.depth + 1
    if (depth > 2) throw new Error('Cannot create card: exceeds max depth of 3 levels')
  }

  const maxRow = db.prepare(
    'SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = ? AND archived_at IS NULL'
  ).get(status) as { m: number | null }
  const sortOrder = (maxRow?.m ?? -1) + 1

  db.prepare(
    `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id, depth, due_date, sort_order, created_at, updated_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id, card.title, card.description ?? null, status,
    card.assignee ?? null, card.priority ?? 'normal',
    card.project ?? null, card.parent_id ?? null, depth, card.due_date ?? null, sortOrder, now, now,
    card.tenant_id ?? 'default',
  )
  try {
    writeAgentAuditLog({ agent_id: card.assignee || 'system', entity: 'kanban', action: 'create', entity_id: card.id, detail: { title: card.title, status, priority: card.priority ?? 'normal' } })
  } catch { /* audit failure must not abort card creation */ }
}

export function updateKanbanCard(id: string, fields: Partial<Omit<KanbanCard, 'id' | 'created_at'>>): boolean {
  const card = getKanbanCard(id)
  if (!card) return false
  const now = Math.floor(Date.now() / 1000)

  // When parent_id changes, recompute depth and validate the constraint.
  let newDepth = card.depth
  const parentChanging = 'parent_id' in fields && fields.parent_id !== card.parent_id
  if (parentChanging) {
    if (fields.parent_id) {
      const newParent = getKanbanCard(fields.parent_id)
      if (!newParent) return false
      newDepth = newParent.depth + 1
      // Ensure no descendant would exceed depth 2 after the move.
      if (newDepth + getSubtreeHeight(id) > 2) return false
    } else {
      newDepth = 0
    }
  }

  const f = { ...card, ...fields, depth: newDepth, updated_at: now }
  const ok = db.prepare(
    `UPDATE kanban_cards SET title=?, description=?, status=?, assignee=?, priority=?, project=?, parent_id=?, depth=?, due_date=?, sort_order=?, updated_at=?, archived_at=?
     WHERE id=?`
  ).run(f.title, f.description, f.status, f.assignee, f.priority, f.project, f.parent_id, f.depth, f.due_date, f.sort_order, f.updated_at, f.archived_at, id).changes > 0

  if (ok) {
    if (parentChanging) cascadeDepth(id, newDepth)
    try {
      writeAgentAuditLog({ agent_id: f.assignee || 'system', entity: 'kanban', action: 'update', entity_id: id, detail: { status: f.status, priority: f.priority } })
    } catch { /* audit failure must not abort card update */ }
  }
  return ok
}

export function getChildCards(parentId: string): KanbanCard[] {
  return db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL ORDER BY sort_order ASC').all(parentId) as KanbanCard[]
}

// Recursively update the depth of all descendants of parentId.
// Called after any parent_id change so the denormalized depth stays consistent.
function cascadeDepth(parentId: string, parentDepth: number): void {
  const children = db.prepare('SELECT id FROM kanban_cards WHERE parent_id = ?').all(parentId) as { id: string }[]
  for (const child of children) {
    db.prepare('UPDATE kanban_cards SET depth = ? WHERE id = ?').run(parentDepth + 1, child.id)
    cascadeDepth(child.id, parentDepth + 1)
  }
}

// Returns the full subtree rooted at cardId (including the root card itself),
// ordered by depth then sort_order. Archived descendants are excluded.
export function getSubtree(cardId: string): KanbanCard[] {
  return db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM kanban_cards WHERE id = ?
      UNION ALL
      SELECT c.id FROM kanban_cards c JOIN subtree s ON c.parent_id = s.id
    )
    SELECT rowid AS seq, kc.* FROM kanban_cards kc
    WHERE kc.id IN (SELECT id FROM subtree) AND kc.archived_at IS NULL
    ORDER BY kc.depth ASC, kc.sort_order ASC
  `).all(cardId) as KanbanCard[]
}

// Returns the height of the subtree rooted at cardId: 0 means the card is a
// leaf, 1 means it has children but no grandchildren, 2 means it has grandchildren.
// Used to validate depth constraints when reparenting.
export function getSubtreeHeight(cardId: string): number {
  const children = db.prepare(
    'SELECT id FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL'
  ).all(cardId) as { id: string }[]
  if (children.length === 0) return 0
  return 1 + Math.max(...children.map(c => getSubtreeHeight(c.id)))
}

// Reparent a card to a new parent (or to top-level when newParentId is null).
// Validates the depth constraint: target.depth + 1 + subtreeHeight(id) <= 2.
// Cascades depth to all descendants and triggers status propagation on both
// the old and new parent.
export function reparentKanbanCard(
  id: string, newParentId: string | null,
): { ok: true } | { ok: false; code: 'not_found' | 'invalid_value' | 'limit_exceeded'; hint: string } {
  const card = getKanbanCard(id)
  if (!card) return { ok: false, code: 'not_found', hint: 'Card not found' }
  if (newParentId === id) return { ok: false, code: 'invalid_value', hint: 'Card cannot be its own parent' }

  let newDepth = 0
  if (newParentId) {
    const newParent = getKanbanCard(newParentId)
    if (!newParent) return { ok: false, code: 'not_found', hint: 'Parent card not found' }
    newDepth = newParent.depth + 1
    const sh = getSubtreeHeight(id)
    if (newDepth + sh > 2) return { ok: false, code: 'limit_exceeded', hint: 'Reparenting would exceed max depth of 3 levels' }
  } else {
    const sh = getSubtreeHeight(id)
    if (sh > 2) return { ok: false, code: 'limit_exceeded', hint: 'Subtree too deep to move to top-level (descendants would exceed depth 2)' }
  }

  const oldParentId = card.parent_id
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    db.prepare('UPDATE kanban_cards SET parent_id=?, depth=?, updated_at=? WHERE id=?').run(newParentId, newDepth, now, id)
    cascadeDepth(id, newDepth)
  })()

  if (oldParentId) propagateStatusForParent(oldParentId)
  if (newParentId) propagateStatusForParent(newParentId)

  return { ok: true }
}

// Re-evaluates a parent card's status based on its children and auto-updates
// if needed, then bubbles up to the grandparent. Rules:
//   - All children done AND parent not done -> auto-set parent to done.
//   - Some children not done AND parent is done -> auto-revert to in_progress.
//   - Manual status changes override: this only fires on child status events.
function propagateStatusForParent(parentId: string): void {
  const parent = getKanbanCard(parentId)
  if (!parent || parent.archived_at) return
  const children = getChildCards(parentId)
  if (children.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const allDone = children.every(c => c.status === 'done')
  if (allDone && parent.status !== 'done') {
    const prev = parent.status
    db.prepare("UPDATE kanban_cards SET status='done', updated_at=? WHERE id=?").run(now, parent.id)
    db.prepare("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, 'done', 'auto', ?)").run(parent.id, prev, now)
    if (parent.parent_id) propagateStatusForParent(parent.parent_id)
  } else if (!allDone && parent.status === 'done') {
    const prev = parent.status
    db.prepare("UPDATE kanban_cards SET status='in_progress', updated_at=? WHERE id=?").run(now, parent.id)
    db.prepare("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, 'in_progress', 'auto', ?)").run(parent.id, prev, now)
    if (parent.parent_id) propagateStatusForParent(parent.parent_id)
  }
}

// Called from route handlers after a card's status changes so the parent
// hierarchy is kept consistent automatically.
export function propagateStatus(cardId: string): void {
  const card = getKanbanCard(cardId)
  if (!card || !card.parent_id) return
  propagateStatusForParent(card.parent_id)
}

export function moveKanbanCard(
  id: string,
  status: KanbanCard['status'],
  sortOrder: number,
  actor?: string,
  orderedIds?: string[]
): boolean {
  const now = Math.floor(Date.now() / 1000)
  // Read the previous status first so we only record an audit event on a real
  // status transition (not a pure sort_order reorder within the same column).
  const prev = (db.prepare('SELECT status FROM kanban_cards WHERE id=?').get(id) as { status: string } | undefined)?.status

  if (orderedIds && orderedIds.length > 0) {
    // Transactional renumber: status update + full column sort_order renumber in
    // one shot so every card in the target column gets a clean 0..N sequence.
    // Only the moved card's updated_at changes (sort_order is presentation-only).
    let changed = false
    db.transaction(() => {
      changed = db.prepare(
        'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=? WHERE id=?'
      ).run(status, orderedIds.indexOf(id), now, id).changes > 0
      if (changed && prev !== undefined && prev !== status) {
        db.prepare(
          'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(id, prev, status, actor ?? null, now)
      }
      const updateOrder = db.prepare('UPDATE kanban_cards SET sort_order=? WHERE id=?')
      orderedIds.forEach((cardId, i) => updateOrder.run(i, cardId))
    })()
    return changed
  }

  // Legacy path: single-card sort_order update (used by schedule-runner and
  // callers that don't supply the full column order).
  const changed = db.prepare(
    'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=? WHERE id=?'
  ).run(status, sortOrder, now, id).changes > 0
  if (changed && prev !== undefined && prev !== status) {
    db.prepare(
      'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, prev, status, actor ?? null, now)
  }
  return changed
}

// Stamp the once-only kanban -> agent dispatch guard. Returns false if the
// card id does not exist.
export function markKanbanCardDispatched(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET dispatched_at=? WHERE id=?').run(now, id).changes > 0
}

export function archiveKanbanCard(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET archived_at=?, updated_at=? WHERE id=?').run(now, now, id).changes > 0
}

export function unarchiveKanbanCard(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET archived_at=NULL, updated_at=? WHERE id=? AND archived_at IS NOT NULL').run(now, id).changes > 0
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

export function listArchivedKanbanCards(opts: {
  q?: string
  project?: string
  label?: string
  from?: number
  to?: number
  limit: number
}): ArchivedKanbanCard[] {
  const { q, project, label, from, to, limit } = opts
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
  if (project) { sql += ' AND kc.project = ?'; params.push(project) }
  if (from)    { sql += ' AND kc.archived_at >= ?'; params.push(from) }
  if (to)      { sql += ' AND kc.archived_at <= ?'; params.push(to) }
  if (q) {
    sql += ' AND (kc.title LIKE ? OR kc.project LIKE ? OR kc.assignee LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like)
  }
  sql += ' ORDER BY kc.archived_at DESC LIMIT ?'
  params.push(limit)
  return db.prepare(sql).all(...params) as ArchivedKanbanCard[]
}

export function listKanbanProjects(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT project FROM kanban_cards WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL ORDER BY project"
  ).all() as Array<{ project: string }>
  return rows.map(r => r.project)
}

export function deleteKanbanCard(id: string): boolean {
  // Wrapped in a transaction to ensure atomicity. Steps in FK-safe order:
  //   1. Delete comments referencing this card (FK: kanban_comments.card_id).
  //   2. Delete this card's label associations (FK: kanban_card_labels.card_id).
  //   3. Promote children to the deleted card's parent (grandparent adoption):
  //      if the deleted card has a parent, its children inherit that parent
  //      and get depth = grandparent.depth + 1; if the deleted card is
  //      top-level, children become top-level (parent_id = NULL, depth = 0).
  //      Grandchildren are depth-cascaded accordingly.
  //   4. Delete the card itself.
  const card = getKanbanCard(id)
  if (!card) return false
  const grandparentId = card.parent_id
  const grandparentDepth = grandparentId ? (getKanbanCard(grandparentId)?.depth ?? 0) : -1
  const now = Math.floor(Date.now() / 1000)

  return db.transaction(() => {
    db.prepare('DELETE FROM kanban_comments WHERE card_id = ?').run(id)
    db.prepare('DELETE FROM kanban_card_labels WHERE card_id = ?').run(id)
    const children = db.prepare('SELECT id FROM kanban_cards WHERE parent_id = ?').all(id) as { id: string }[]
    for (const child of children) {
      const newChildDepth = grandparentDepth + 1  // -1+1=0 when grandparent is null
      db.prepare('UPDATE kanban_cards SET parent_id=?, depth=?, updated_at=? WHERE id=?').run(
        grandparentId, newChildDepth, now, child.id
      )
      cascadeDepth(child.id, newChildDepth)
    }
    const deleted = db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id).changes > 0
    if (deleted) {
      try {
        writeAgentAuditLog({ agent_id: card.assignee || 'system', entity: 'kanban', action: 'delete', entity_id: id, detail: { title: card.title } })
      } catch { /* audit failure must not abort card deletion */ }
    }
    return deleted
  })() as boolean
}

export function getKanbanComments(cardId: string): KanbanComment[] {
  return db.prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as KanbanComment[]
}

export interface KanbanCardEvent {
  id: number
  card_id: string
  from_status: string | null
  to_status: string
  actor: string | null
  created_at: number
}

export function getKanbanCardEvents(cardId: string): KanbanCardEvent[] {
  return db.prepare('SELECT * FROM kanban_card_events WHERE card_id = ? ORDER BY created_at ASC, id ASC').all(cardId) as KanbanCardEvent[]
}

// Lookup a kanban card's `seq` (its sqlite rowid) by the 8-char hex id stored
// in `kanban_cards.id`. Used by the kanban-ref normalizer to rewrite hex
// references to the human-facing `#<seq>` form. Returns null when the prefix
// matches zero rows OR more than one row (ambiguous → leave the message
// untouched rather than guess). Case-insensitive: breakdown subtask ids are
// uppercased while createKanbanCard ids stay lowercase.
export function getKanbanSeqByIdPrefix(prefix: string): number | null {
  const rows = db.prepare(
    'SELECT rowid AS seq FROM kanban_cards WHERE id = ? COLLATE NOCASE LIMIT 2'
  ).all(prefix) as { seq: number }[]
  if (rows.length !== 1) return null
  return rows[0].seq
}

// Find an active (non-archived) kanban card by exact title match, or
// undefined when none exists.
export function findActiveKanbanCardByTitle(title: string): KanbanCard | undefined {
  return db.prepare(
    'SELECT rowid AS seq, * FROM kanban_cards WHERE title = ? AND archived_at IS NULL LIMIT 1'
  ).get(title) as KanbanCard | undefined
}

// Move the first active kanban card whose title equals `taskName` to the
// 'waiting' status, appending it at the end of the waiting column.
// Returns the card id when a match was found and updated, null otherwise.
// Used by the scheduled-task fire-timeout watchdog when alerting about a
// potentially stuck task.
export function markScheduledTaskKanbanWaiting(taskName: string): string | null {
  const card = findActiveKanbanCardByTitle(taskName)
  if (!card) return null
  const maxResult = db.prepare(
    "SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = 'waiting' AND archived_at IS NULL"
  ).get() as { m: number | null }
  const sortOrder = (maxResult.m ?? 0) + 100
  moveKanbanCard(card.id, 'waiting', sortOrder, 'scheduler')
  return card.id
}

export function addKanbanComment(cardId: string, author: string, content: string): KanbanComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(cardId, author, content, now)
  db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(now, cardId)
  return { id: Number(info.lastInsertRowid), card_id: cardId, author, content, created_at: now }
}

export interface Label {
  id: string
  name: string
  color: string
  created_at: number
}

export function listLabels(): Label[] {
  return db.prepare('SELECT * FROM labels ORDER BY name ASC').all() as Label[]
}

export function getLabel(id: string): Label | undefined {
  return db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as Label | undefined
}

export function createLabel(label: { id: string; name: string; color: string }): Label {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)'
  ).run(label.id, label.name, label.color, now)
  return { ...label, created_at: now }
}

export function updateLabel(id: string, fields: Partial<Pick<Label, 'name' | 'color'>>): boolean {
  const label = getLabel(id)
  if (!label) return false
  const f = { ...label, ...fields }
  return db.prepare('UPDATE labels SET name=?, color=? WHERE id=?').run(f.name, f.color, id).changes > 0
}

export function deleteLabel(id: string): boolean {
  // Transaction: drop every card<->label link before the label row itself,
  // otherwise the join table keeps dangling references to a label that no
  // longer exists (FK enforcement is off by default, but the orphan rows
  // would still silently resurrect a "deleted" label in card detail views).
  return db.transaction((labelId: string) => {
    db.prepare('DELETE FROM kanban_card_labels WHERE label_id = ?').run(labelId)
    return db.prepare('DELETE FROM labels WHERE id = ?').run(labelId).changes > 0
  })(id) as boolean
}

export function addLabelToCard(cardId: string, labelId: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT OR IGNORE INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?)'
  ).run(cardId, labelId, now)
}

export function removeLabelFromCard(cardId: string, labelId: string): boolean {
  return db.prepare(
    'DELETE FROM kanban_card_labels WHERE card_id = ? AND label_id = ?'
  ).run(cardId, labelId).changes > 0
}

export function getLabelsForCard(cardId: string): Label[] {
  return db.prepare(`
    SELECT l.* FROM labels l
    JOIN kanban_card_labels cl ON cl.label_id = l.id
    WHERE cl.card_id = ?
    ORDER BY l.name ASC
  `).all(cardId) as Label[]
}

// Bulk variant for the board list view -- one JOIN query instead of an N+1
// per-card lookup when rendering footer pills for every card at once.
export function getLabelsForAllCards(): Map<string, Label[]> {
  const rows = db.prepare(`
    SELECT cl.card_id AS card_id, l.id AS id, l.name AS name, l.color AS color, l.created_at AS created_at
    FROM kanban_card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY l.name ASC
  `).all() as Array<Label & { card_id: string }>
  const map = new Map<string, Label[]>()
  for (const row of rows) {
    const { card_id, ...label } = row
    const list = map.get(card_id)
    if (list) list.push(label)
    else map.set(card_id, [label])
  }
  return map
}
