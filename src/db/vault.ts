// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { dbx, type SqlOps } from './facade.js'

export interface VaultSshKey {
  id: string
  label: string
  username: string
  vault_key_id: string
  public_key: string
  fingerprint: string
  key_type: string
  created_at: number
  tenant_id: string
}

/** tenantId null -- admin global view (no filter, every tenant's keys). */
export async function listVaultSshKeys(tenantId: string | null = null): Promise<VaultSshKey[]> {
  if (tenantId === null) return dbx.all<VaultSshKey>('SELECT * FROM vault_ssh_keys ORDER BY label ASC')
  return dbx.all<VaultSshKey>('SELECT * FROM vault_ssh_keys WHERE tenant_id = ? ORDER BY label ASC', tenantId)
}

export async function getVaultSshKey(id: string): Promise<VaultSshKey | undefined> {
  return dbx.get<VaultSshKey>('SELECT * FROM vault_ssh_keys WHERE id = ?', id)
}

export async function createVaultSshKey(key: Pick<VaultSshKey, 'id' | 'label' | 'username' | 'vault_key_id' | 'public_key' | 'fingerprint' | 'key_type' | 'tenant_id'>): Promise<VaultSshKey> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`INSERT INTO vault_ssh_keys (id, label, username, vault_key_id, public_key, fingerprint, key_type, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, key.id, key.label, key.username, key.vault_key_id, key.public_key, key.fingerprint, key.key_type, now, key.tenant_id)
  return { ...key, created_at: now }
}

// Unassign the key from all servers, then delete it. Returns the count of
// servers that were unassigned so callers can surface that in the response.
export async function deleteVaultSshKey(id: string): Promise<{ deleted: boolean; unassigned: number }> {
  return dbx.tx(async (tx) => {
    const unassigned = (await tx.run('UPDATE vault_ssh_servers SET ssh_key_id = NULL, updated_at = ? WHERE ssh_key_id = ?', Math.floor(Date.now() / 1000), id)).changes
    const deleted = (await tx.run('DELETE FROM vault_ssh_keys WHERE id = ?', id)).changes > 0
    return { deleted, unassigned }
  })
}

// Stores server metadata. The ssh_key_id FK points to vault_ssh_keys (nullable;
// null = no key assigned = keyStatus "missing"). Legacy per-server key columns
// (vault_key_id, key_type, fingerprint, key_expires_at) have been removed via
// DROP COLUMN migration above.

export interface VaultSshServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  ssh_key_id: string | null
  description: string | null
  tenant_id: string
  created_at: number
  updated_at: number
}

export type SshKeyStatus = 'ok' | 'missing'

export function computeSshKeyStatus(server: VaultSshServer): SshKeyStatus {
  return server.ssh_key_id ? 'ok' : 'missing'
}

export async function listVaultSshServers(tenantId?: string | null): Promise<VaultSshServer[]> {
  const tc = tenantId ? ' WHERE tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  return dbx.all<VaultSshServer>(`SELECT * FROM vault_ssh_servers${tc} ORDER BY name ASC`, ...tp)
}

export async function getVaultSshServer(id: string): Promise<VaultSshServer | undefined> {
  return dbx.get<VaultSshServer>('SELECT * FROM vault_ssh_servers WHERE id = ?', id)
}

export async function createVaultSshServer(server: Pick<VaultSshServer, 'id' | 'name' | 'host' | 'port' | 'username' | 'description' | 'tenant_id'>): Promise<VaultSshServer> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`INSERT INTO vault_ssh_servers (id, name, host, port, username, description, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, server.id, server.name, server.host, server.port, server.username, server.description ?? null, server.tenant_id, now, now)
  return { ...server, ssh_key_id: null, created_at: now, updated_at: now }
}

export async function updateVaultSshServer(id: string, patch: Partial<Pick<VaultSshServer, 'name' | 'host' | 'port' | 'username' | 'ssh_key_id' | 'description'>>): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.name !== undefined)        { sets.push('name = ?');        params.push(patch.name) }
  if (patch.host !== undefined)        { sets.push('host = ?');        params.push(patch.host) }
  if (patch.port !== undefined)        { sets.push('port = ?');        params.push(patch.port) }
  if (patch.username !== undefined)    { sets.push('username = ?');    params.push(patch.username) }
  if (patch.ssh_key_id !== undefined)  { sets.push('ssh_key_id = ?'); params.push(patch.ssh_key_id) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  params.push(id)
  return (await dbx.run(`UPDATE vault_ssh_servers SET ${sets.join(', ')} WHERE id = ?`, ...params)).changes > 0
}

export async function deleteVaultSshServer(id: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM vault_ssh_servers WHERE id = ?', id)).changes > 0
}

export interface Approval {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload: string | null
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  timeout_at: number | null
  telegram_message_id: number | null
  requested_at: number
  resolved_at: number | null
  resolved_by: string | null
  tenant_id: string
  // Optional on the type so older fixtures keep compiling; the columns exist on every row (migration 0080).
  /** 1 = the category was human-only when the request was made (a snapshot, it does not follow later changes). */
  human_only?: number
  /** How the decision arrived: 'dashboard_session' | 'bearer'. NULL while pending and for rows decided before 0080. */
  resolved_via?: string | null
  /** 64 lowercase hex: the hash of the exact action this approval covers. NULL = the requester gave none. */
  content_hash?: string | null
  consumed_at?: number | null
  consumed_by?: string | null
  consumed_ref?: string | null
  /** Epoch seconds the official sender sealed the effect (migration 0084); NULL = reserved only, or not used. */
  used_at?: number | null
  /** The sender's own reference of that use; the same ref again inside the replay window is a retry. */
  used_ref?: string | null
}

interface CreateApprovalParams {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload?: string | null
  timeout_at?: number | null
  tenant_id?: string | null
  human_only?: boolean
  content_hash?: string | null
}

// The request as it starts out; the INSERT writes exactly these values.
function pendingApproval(params: CreateApprovalParams, now: number): Approval {
  const humanOnly = params.human_only ? 1 : 0
  return {
    id: params.id,
    agent_id: params.agent_id,
    category: params.category,
    action_description: params.action_description,
    action_payload: params.action_payload ?? null,
    status: 'pending',
    timeout_at: params.timeout_at ?? null,
    telegram_message_id: null,
    requested_at: now,
    resolved_at: null,
    resolved_by: null,
    tenant_id: params.tenant_id ?? 'default',
    human_only: humanOnly,
    resolved_via: null,
    content_hash: params.content_hash ?? null,
    consumed_at: null,
    consumed_by: null,
    consumed_ref: null,
  }
}

const INSERT_APPROVAL_SQL = `
  INSERT INTO approvals (id, agent_id, category, action_description, action_payload, timeout_at, requested_at, tenant_id, human_only, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const insertApprovalArgs = (a: Approval): unknown[] =>
  [a.id, a.agent_id, a.category, a.action_description, a.action_payload, a.timeout_at, a.requested_at, a.tenant_id, a.human_only, a.content_hash]

// `ops` is the handle the statement runs on: the facade by default, the `tx` handle inside a transaction body.
export async function createApproval(params: CreateApprovalParams, ops: SqlOps = dbx): Promise<Approval> {
  const approval = pendingApproval(params, Math.floor(Date.now() / 1000))
  await ops.run(INSERT_APPROVAL_SQL, ...insertApprovalArgs(approval))
  return approval
}

export async function getApproval(id: string, ops: SqlOps = dbx): Promise<Approval | undefined> {
  return ops.get<Approval>('SELECT * FROM approvals WHERE id = ?', id)
}

// Approving or rejecting a request whose deadline has passed is refused even in the up-to-60 s window
// before the sweeper marks it `timeout`; recording the `timeout` status itself stays allowed.
export async function resolveApproval(
  id: string,
  status: 'approved' | 'rejected' | 'timeout',
  resolvedBy: string,
  telegramMessageId?: number | null,
  resolvedVia?: ApprovalResolvedVia | null,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run(`
    UPDATE approvals
    SET status = ?, resolved_at = ?, resolved_by = ?,
        telegram_message_id = COALESCE(?, telegram_message_id),
        resolved_via = ?
    WHERE id = ? AND status = 'pending'
      AND (? = 'timeout' OR timeout_at IS NULL OR timeout_at > ?)
  `, status, now, resolvedBy, telegramMessageId ?? null, resolvedVia ?? null, id, status, now)).changes > 0
}

/** How a decision reached the server: a logged-in dashboard session, or any bearer token. */
export type ApprovalResolvedVia = 'dashboard_session' | 'bearer'

/**
 * The kinds of approval_events rows. The table has no CHECK on `event` (widening one needs a table
 * rebuild, see migration 0081), so this union is what keeps the writers honest.
 */
export type ApprovalEventKind = 'consumed' | 'used' | 'consume_refused' | 'bearer_denied' | 'owner_unreached' | 'created_deduplicated' | 'notify_suppressed'

/**
 * Append one row to the approval journal. The journal is for diagnosis: nothing branches on it, and a
 * failure to write it must not turn a refusal into a success, so the caller decides what to do with a
 * throw (the callers on a refusal path catch it).
 */
export async function recordApprovalEvent(params: ApprovalEventParams, ops: SqlOps = dbx): Promise<void> {
  await ops.run(INSERT_APPROVAL_EVENT_SQL, ...approvalEventArgs(params))
}

interface ApprovalEventParams {
  approval_id: string
  tenant_id?: string | null
  event: ApprovalEventKind
  reason?: string | null
  actor?: string | null
  ref?: string | null
}

const INSERT_APPROVAL_EVENT_SQL = `
  INSERT INTO approval_events (approval_id, tenant_id, event, reason, actor, ref, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`

const approvalEventArgs = (params: ApprovalEventParams): unknown[] => [
  params.approval_id,
  params.tenant_id ?? 'default',
  params.event,
  params.reason ?? null,
  params.actor ?? null,
  params.ref ?? null,
  Math.floor(Date.now() / 1000),
]

export interface ApprovalEvent {
  id: number
  approval_id: string
  tenant_id: string
  event: string
  reason: string | null
  actor: string | null
  ref: string | null
  created_at: number
}

/** The journal rows of one approval, oldest first. */
export async function listApprovalEvents(approvalId: string): Promise<ApprovalEvent[]> {
  return dbx.all<ApprovalEvent>('SELECT * FROM approval_events WHERE approval_id = ? ORDER BY created_at ASC, id ASC', approvalId)
}

/**
 * Categories whose approval is bound to the hash of one exact action and can be used up once. Anything
 * else (a plain yes/no approval, an `email_standing_recipient` request) has no hash to consume.
 */
export const CONSUMABLE_APPROVAL_CATEGORIES: readonly string[] = ['email_send']

/** A consume that arrives again with the same ref inside this many seconds is a retry, not a second use. */
export const CONSUME_REPLAY_WINDOW_S = 60

/** Why a consume by id was refused. Checked on the row after the guarded write found nothing to update. */
export type ConsumeRefusal =
  | 'not_found'
  | 'agent_mismatch'
  | 'wrong_category'
  | 'already_consumed'
  | 'not_approved'
  | 'hash_mismatch'
  | 'expired'
  | 'not_human_decided'

/** Why a claim by hash found nothing to use. `pending` and `none` mean there is nothing decided yet. */
export type ClaimRefusal = 'wrong_category' | 'hash_mismatch' | 'pending' | 'none' | 'rejected' | 'expired' | 'already_consumed' | 'already_used' | 'not_human_decided'

export type ConsumeOutcome =
  | { ok: true; replayed: boolean; approval: Approval }
  | { ok: false; reason: ConsumeRefusal; approval?: Approval }

export type ClaimOutcome =
  | { ok: true; replayed: boolean; approval: Approval; /** mode 'send' only: the sender took over the gate's reservation */ adopted?: boolean }
  | { ok: false; reason: ClaimRefusal; approval?: Approval }

interface ConsumeParams {
  /** The hash the caller computed for the action it is about to take. */
  content_hash: string
  /** The authenticated agent asking: only the agent that requested an approval can use it up. */
  principal: string
  tenant_id: string
  /** How long after the decision the approval may still be used, in seconds. */
  window_s: number
  /** An opaque reference of the consuming action; the same ref again within the replay window is a retry. */
  ref?: string | null
  /** A label for the journal (which gate or script asked); it decides nothing. */
  consumer?: string | null
  /** Epoch seconds. The server clock decides; the parameter exists for tests. */
  now?: number
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * A content hash is 64 lowercase hex characters, nothing else. The functions below check it before
 * they touch a row, so a malformed or differently-cased value can never match, create or use one up.
 */
export function isContentHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
}

/** The journal label of a consume: the consumer name, bounded. */
function consumerLabel(consumer: string | null | undefined): string | null {
  const label = typeof consumer === 'string' ? consumer.trim().slice(0, 64) : ''
  return label || null
}

/**
 * Journal a refused consume. Never rejects: a journal fault must not turn a refusal into a success. The write is
 * awaited INSIDE the try: a call that is started and not awaited would reject outside the catch (an unhandled
 * rejection, which ends the process by default).
 */
export async function journalConsumeRefusal(approval: Approval, reason: string, principal: string, ref: string | null): Promise<void> {
  try {
    await recordApprovalEvent({ approval_id: approval.id, tenant_id: approval.tenant_id, event: 'consume_refused', reason, actor: principal, ref })
  } catch { /* the refusal stands without its journal row */ }
}

// The one write that uses an approval up. Every condition is in the WHERE, so the check and the write are
// a single statement: of two callers racing for the same row exactly one changes it. The category list is
// spliced in as bound parameters. A consumable approval is always decided by a person's dashboard
// session, whatever the human_only snapshot of the row says.
// With `seal`, the same write also stamps the effect (used_at / used_ref): the official sender, when no gate
// reserved the approval before it, reserves and seals in one step.
export function consumeStatement(seal = false): string {
  const marks = CONSUMABLE_APPROVAL_CATEGORIES.map(() => '?').join(', ')
  return `
    UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = ?${seal ? ', used_at = ?, used_ref = ?' : ''}
    WHERE id = ? AND category IN (${marks}) AND status = 'approved' AND consumed_at IS NULL
      AND content_hash = ? AND tenant_id = ? AND agent_id = ?
      AND resolved_at >= ? AND resolved_via = 'dashboard_session'
  `
}

/** Run the guarded write for one row. True when this call is the one that used the approval up. */
export async function useUpApproval(id: string, p: ConsumeParams, now: number, ref: string | null, seal = false, ops: SqlOps = dbx): Promise<boolean> {
  return (await ops.run(
    consumeStatement(seal),
    now, p.principal, ref, ...(seal ? [now, ref] : []), id, ...CONSUMABLE_APPROVAL_CATEGORIES, p.content_hash, p.tenant_id, p.principal, now - p.window_s,
  )).changes > 0
}

// The sender's write: it takes over the reservation the gate made for this very mail and seals it. Every
// condition is in the WHERE (not read from a snapshot), so of two senders racing for one reservation exactly one
// changes the row. Nothing here creates, decides or re-opens an approval: it only stamps a row a person decided in
// a dashboard session and the SAME agent's gate already reserved FOR THE OFFICIAL SENDER (a `gate-send-` ref: the
// gate only writes that prefix when it read the call as gmail-send.py), a moment ago, and not sealed yet.
// The SELECT that picks the candidate repeats these conditions, and inside one transaction on one connection (the
// facade's transaction lock keeps every other facade caller out of the body) nothing can change between the two
// statements, so a test through claimApproval() cannot tell the UPDATE's WHERE from the SELECT's. This WHERE is the
// second line (a second connection or process would make it the only one), and adoptReservation() is exported so a
// test can run it alone against rows that break one condition.
const ADOPT_STATEMENT = `
  UPDATE approvals SET used_at = ?, used_ref = ?
  WHERE id = ? AND category = ? AND status = 'approved' AND content_hash = ? AND tenant_id = ? AND agent_id = ?
    AND resolved_via = 'dashboard_session'
    AND consumed_at IS NOT NULL AND consumed_at >= ? AND consumed_by = ? AND consumed_ref LIKE 'gate-send-%'
    AND used_at IS NULL
`

/** Stamp the gate's reservation `id` as sealed by the sender's `ref`; false when any adoption condition does not hold. */
export async function adoptReservation(
  id: string, p: Pick<ConsumeParams, 'principal' | 'tenant_id' | 'content_hash'> & { category: string }, adoptSince: number, now: number, ref: string,
  ops: SqlOps = dbx,
): Promise<boolean> {
  return (await ops.run(
    ADOPT_STATEMENT,
    now, ref, id, p.category, p.content_hash, p.tenant_id, p.principal, adoptSince, p.principal,
  )).changes > 0
}

/** The ref prefix by which the gate marks a reservation made for the official sender (the intent the sender may adopt). */
export const GATE_SEND_REF_PREFIX = 'gate-send-'

/**
 * How long after the gate's reservation the sender may still adopt it. The gate allows the call and the sender
 * starts a moment later, so seconds are enough; a reservation older than this is not "the call the gate just
 * allowed" and must not become a mail. Shorter than the use window on purpose (the window is minutes).
 */
export const SEND_ADOPT_WINDOW_S = 120

/** Who takes the approval: the send gate reserves it (no mode), the official sender seals it (`send`). */
export type ClaimMode = 'send'

/** The same principal consuming the same hash with the same ref a moment ago: a retry of a lost answer. */
function isReplay(row: Approval, p: ConsumeParams, now: number): boolean {
  return typeof p.ref === 'string' && p.ref !== '' &&
    row.consumed_at != null && row.consumed_by === p.principal && row.consumed_ref === p.ref &&
    row.content_hash === p.content_hash && now - row.consumed_at <= CONSUME_REPLAY_WINDOW_S
}

/**
 * Use up one approval by id. Succeeds only for an approved, unconsumed row of this tenant and this agent,
 * of a consumable category, bound to exactly this hash, decided by a human session no longer ago than
 * the window. The success and its journal row are one transaction; a refusal is classified from the row
 * afterwards (the write itself never says why it matched nothing) and journalled best-effort.
 */
export async function consumeApproval(p: ConsumeParams & { id: string }): Promise<ConsumeOutcome> {
  const now = p.now ?? nowSeconds()
  const ref = p.ref ?? null
  const hashOk = isContentHash(p.content_hash)
  // The default (deferred) transaction mode, as the synchronous transaction it replaces: the guarded write below
  // is the line that decides, and the body holds database calls and pure policy only.
  const outcome = await dbx.tx(async (tx): Promise<ConsumeOutcome> => {
    // A malformed hash skips the guarded write; it is then refused below as a mismatch.
    if (hashOk && await useUpApproval(p.id, p, now, ref, false, tx)) {
      const approval = await getApproval(p.id, tx) as Approval
      await recordApprovalEvent({ approval_id: p.id, tenant_id: approval.tenant_id, event: 'consumed', reason: consumerLabel(p.consumer), actor: p.principal, ref }, tx)
      return { ok: true, replayed: false, approval }
    }
    const row = await getApproval(p.id, tx)
    // Another tenant's row answers exactly like a missing one.
    if (!row || row.tenant_id !== p.tenant_id) return { ok: false, reason: 'not_found' }
    if (row.agent_id !== p.principal) return { ok: false, reason: 'agent_mismatch', approval: row }
    if (!CONSUMABLE_APPROVAL_CATEGORIES.includes(row.category)) return { ok: false, reason: 'wrong_category', approval: row }
    if (!hashOk) return { ok: false, reason: 'hash_mismatch', approval: row }
    if (row.consumed_at != null) {
      if (isReplay(row, p, now)) return { ok: true, replayed: true, approval: row }
      return { ok: false, reason: 'already_consumed', approval: row }
    }
    if (row.status !== 'approved') return { ok: false, reason: 'not_approved', approval: row }
    if (row.content_hash !== p.content_hash) return { ok: false, reason: 'hash_mismatch', approval: row }
    if (row.resolved_at == null || row.resolved_at < now - p.window_s) return { ok: false, reason: 'expired', approval: row }
    return { ok: false, reason: 'not_human_decided', approval: row }
  })
  if (!outcome.ok && outcome.approval) await journalConsumeRefusal(outcome.approval, outcome.reason, p.principal, ref)
  return outcome
}

/**
 * Use up the approval for one exact action, found by its hash instead of its id: the caller (the send
 * gate) knows what it is about to do, not which request covers it. Looks at this agent's rows of this
 * tenant and category with this hash, tries the newest usable one with the same guarded write as
 * consumeApproval, and when none is usable says why, best reason first: a pending request, then what
 * became of the latest decision. A retry with the ref that already used a row answers as a replay
 * before anything else, so a lost answer cannot burn a second approval.
 *
 * Every lookup here orders by its time column and then by id. Two rows sharing a second is a tie that
 * carries no meaning (any usable row is as good as another, one open request as good as another, and
 * the latest-decision lookup only names the reason once nothing is usable), so the id only has to make
 * the pick deterministic; it does not need to be the insertion order.
 */
export async function claimApproval(p: ConsumeParams & { category: string; mode?: ClaimMode }): Promise<ClaimOutcome> {
  const now = p.now ?? nowSeconds()
  const ref = p.ref ?? null
  const send = p.mode === 'send'
  // Adoption looks only a moment back (and never past the use window itself).
  const adoptSince = now - Math.min(p.window_s, SEND_ADOPT_WINDOW_S)
  if (!CONSUMABLE_APPROVAL_CATEGORIES.includes(p.category)) return { ok: false, reason: 'wrong_category' }
  if (!isContentHash(p.content_hash)) return { ok: false, reason: 'hash_mismatch' }
  // The sender seals under its own reference: without one there would be nothing to retry or audit with.
  if (send && ref === null) throw new Error("claimApproval: mode 'send' needs a ref")
  const outcome = await dbx.tx(async (tx): Promise<ClaimOutcome> => {
    const scope = [p.principal, p.tenant_id, p.category, p.content_hash]
    if (send) {
      // A retry of the sender's own lost answer: the row it sealed under this ref a moment ago.
      const sealed = await tx.get<Approval>(`
        SELECT * FROM approvals
        WHERE agent_id = ? AND tenant_id = ? AND category = ? AND content_hash = ?
          AND used_ref = ? AND used_at >= ?
        ORDER BY used_at DESC, id DESC LIMIT 1
      `, ...scope, ref, now - CONSUME_REPLAY_WINDOW_S)
      if (sealed) return { ok: true, replayed: true, adopted: sealed.consumed_ref !== sealed.used_ref, approval: sealed }
      // The gate reserved this very mail a moment ago: take that reservation over instead of asking for a second approval.
      const reserved = await tx.get<{ id: string }>(`
        SELECT id FROM approvals
        WHERE agent_id = ? AND tenant_id = ? AND category = ? AND content_hash = ?
          AND status = 'approved' AND resolved_via = 'dashboard_session'
          AND consumed_at IS NOT NULL AND consumed_at >= ? AND consumed_by = ? AND consumed_ref LIKE 'gate-send-%' AND used_at IS NULL
        ORDER BY consumed_at DESC, id DESC LIMIT 1
      `, ...scope, adoptSince, p.principal)
      if (reserved && await adoptReservation(reserved.id, p, adoptSince, now, ref as string, tx)) {   // send implies a ref (checked above)
        const approval = await getApproval(reserved.id, tx) as Approval
        await recordApprovalEvent({ approval_id: reserved.id, tenant_id: approval.tenant_id, event: 'used', reason: 'adopted_gate_reservation', actor: p.principal, ref }, tx)
        return { ok: true, replayed: false, adopted: true, approval }
      }
    } else if (typeof p.ref === 'string' && p.ref !== '') {
      const again = await tx.get<Approval>(`
        SELECT * FROM approvals
        WHERE agent_id = ? AND tenant_id = ? AND category = ? AND content_hash = ?
          AND consumed_by = ? AND consumed_ref = ? AND consumed_at >= ?
        ORDER BY consumed_at DESC, id DESC LIMIT 1
      `, ...scope, p.principal, p.ref, now - CONSUME_REPLAY_WINDOW_S)
      if (again) return { ok: true, replayed: true, approval: again }
    }
    const usable = await tx.get<{ id: string }>(`
      SELECT id FROM approvals
      WHERE agent_id = ? AND tenant_id = ? AND category = ? AND content_hash = ?
        AND status = 'approved' AND consumed_at IS NULL AND resolved_at >= ? AND resolved_via = 'dashboard_session'
      ORDER BY resolved_at DESC, id DESC LIMIT 1
    `, ...scope, now - p.window_s)
    if (usable && await useUpApproval(usable.id, p, now, ref, send, tx)) {
      const approval = await getApproval(usable.id, tx) as Approval
      await recordApprovalEvent({ approval_id: usable.id, tenant_id: approval.tenant_id, event: 'consumed', reason: consumerLabel(p.consumer), actor: p.principal, ref }, tx)
      if (send) await recordApprovalEvent({ approval_id: usable.id, tenant_id: approval.tenant_id, event: 'used', reason: 'reserved_and_sealed', actor: p.principal, ref }, tx)
      return send ? { ok: true, replayed: false, adopted: false, approval } : { ok: true, replayed: false, approval }
    }
    // A request still open (its deadline not passed, even if the sweeper has not marked it yet) beats any old decision.
    const open = await tx.get<Approval>(`
      SELECT * FROM approvals
      WHERE agent_id = ? AND tenant_id = ? AND category = ? AND content_hash = ?
        AND status = 'pending' AND (timeout_at IS NULL OR timeout_at > ?)
      ORDER BY requested_at DESC, id DESC LIMIT 1
    `, ...scope, now)
    if (open) return { ok: false, reason: 'pending', approval: open }
    const last = await tx.get<Approval>(`
      SELECT * FROM approvals
      WHERE agent_id = ? AND tenant_id = ? AND category = ? AND content_hash = ?
        AND status != 'pending' AND resolved_at IS NOT NULL
      ORDER BY resolved_at DESC, id DESC LIMIT 1
    `, ...scope)
    if (!last) return { ok: false, reason: 'none' }
    if (last.status === 'rejected') return { ok: false, reason: 'rejected', approval: last }
    // A request that timed out unanswered leaves nothing to use: the caller starts over.
    if (last.status !== 'approved') return { ok: false, reason: 'none', approval: last }
    // Only the sender is told apart "reserved" from "sealed"; the gate keeps seeing the one reason it always did.
    if (last.consumed_at != null) return { ok: false, reason: send && last.used_at != null ? 'already_used' : 'already_consumed', approval: last }
    if (last.resolved_at != null && last.resolved_at < now - p.window_s) return { ok: false, reason: 'expired', approval: last }
    return { ok: false, reason: 'not_human_decided', approval: last }
  })
  if (!outcome.ok && outcome.approval && outcome.reason !== 'pending' && outcome.reason !== 'none') {
    await journalConsumeRefusal(outcome.approval, outcome.reason, p.principal, ref)
  }
  return outcome
}

/**
 * How many requests of one agent and category (in one tenant) were made since `since`, the one named by
 * `exceptId` left out. Read from the rows, not from memory, so a restart does not reset a rate limit.
 */
export async function countApprovalsRequestedSince(params: { agent_id: string; category: string; tenant_id: string; since: number; exceptId?: string }): Promise<number> {
  const row = (await dbx.get(`
    SELECT COUNT(*) AS n FROM approvals
    WHERE agent_id = ? AND category = ? AND tenant_id = ? AND requested_at >= ? AND id != ?
  `, params.agent_id, params.category, params.tenant_id, params.since, params.exceptId ?? '')) as { n: number }
  return row.n
}

/** What createApprovalOnce did: the row, and whether it was an open request already or a new one. */
export type OpenOnceOutcome =
  | { ok: true; approval: Approval; deduplicated: boolean }
  | { ok: false; reason: 'too_many_pending' | 'hash_mismatch' }

/**
 * Open a hash-bound request unless the same agent already has the same one open in this tenant (then
 * that row is returned, nothing is written) or already has `max_pending` open requests of this category.
 * The look and the write are one transaction, so a burst of identical requests leaves one row. "Open"
 * means pending with its deadline not passed: an expired row the sweeper has not marked yet neither
 * answers a new request nor counts against the cap.
 */
export async function createApprovalOnce(params: Parameters<typeof createApproval>[0] & { content_hash: string; max_pending: number }): Promise<OpenOnceOutcome> {
  const tenant = params.tenant_id ?? 'default'
  if (!isContentHash(params.content_hash)) return { ok: false, reason: 'hash_mismatch' }
  const outcome = await dbx.tx(async (tx): Promise<OpenOnceOutcome> => {
    const now = nowSeconds()
    const same = await tx.get<Approval>(`
      SELECT * FROM approvals
      WHERE agent_id = ? AND tenant_id = ? AND category = ? AND content_hash = ?
        AND status = 'pending' AND (timeout_at IS NULL OR timeout_at > ?)
      ORDER BY requested_at DESC, id DESC LIMIT 1
    `, params.agent_id, tenant, params.category, params.content_hash, now)
    if (same) return { ok: true, approval: same, deduplicated: true }
    const open = await tx.get<{ n: number }>(`
      SELECT COUNT(*) AS n FROM approvals
      WHERE agent_id = ? AND tenant_id = ? AND category = ? AND status = 'pending' AND (timeout_at IS NULL OR timeout_at > ?)
    `, params.agent_id, tenant, params.category, now) as { n: number }
    if (open.n >= params.max_pending) return { ok: false, reason: 'too_many_pending' }
    return { ok: true, approval: await createApproval(params, tx), deduplicated: false }
  }, { mode: 'immediate' })
  if (outcome.ok && outcome.deduplicated) {
    try {
      await recordApprovalEvent({ approval_id: outcome.approval.id, tenant_id: tenant, event: 'created_deduplicated', actor: params.agent_id })
    } catch { /* the request stands without its journal row */ }
  }
  return outcome
}

// agent_id/category use LIKE substring matching, not exact equality -- this
// mirrors the dashboard's approvals.js filter inputs, which have always done
// client-side substring matching. Keeping the DB-level filter as exact match
// while the UI did substring search only worked because the frontend
// re-filtered the (unpaginated, up-to-500) result set itself; once the UI
// switches to server-side pagination that client-side re-filter goes away,
// so the DB filter must implement the same substring semantics.
function approvalsWhere(opts: {
  agent_id?: string
  category?: string
  status?: string
  content_hash?: string
  tenantId?: string
}): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.agent_id) { conditions.push('agent_id LIKE ?'); params.push(`%${opts.agent_id}%`) }
  if (opts.category) { conditions.push('category LIKE ?'); params.push(`%${opts.category}%`) }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status) }
  // Exact match, unlike agent_id/category: a hash is looked up whole, never searched by substring.
  if (opts.content_hash) { conditions.push('content_hash = ?'); params.push(opts.content_hash) }
  // SQL-level tenant filter must come before LIMIT (per 626/704 pagination lesson).
  if (opts.tenantId !== undefined) { conditions.push('tenant_id = ?'); params.push(opts.tenantId) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return { where, params }
}

export async function listApprovals(opts: {
  agent_id?: string
  category?: string
  status?: string
  content_hash?: string
  limit?: number
  offset?: number
  tenantId?: string
}): Promise<Approval[]> {
  const { where, params } = approvalsWhere(opts)
  const limit = Math.min(opts.limit ?? 100, 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  return dbx.all<Approval>(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset)
}

export async function countApprovals(opts: {
  agent_id?: string
  category?: string
  status?: string
  content_hash?: string
  tenantId?: string
}): Promise<number> {
  const { where, params } = approvalsWhere(opts)
  const row = (await dbx.get(`SELECT COUNT(*) AS n FROM approvals ${where}`, ...params)) as { n: number }
  return row.n
}

// Tenant-scoped only (no status/category/agent filter) so the stat cards
// stay accurate regardless of which filtered/paginated page is showing --
// same reasoning as getIdeaStatusCounts (Ideas P1b).
export async function getApprovalStatusCounts(tenantId?: string): Promise<Record<'pending' | 'approved' | 'rejected' | 'timeout', number>> {
  const params: unknown[] = []
  let where = ''
  if (tenantId !== undefined) { where = 'WHERE tenant_id = ?'; params.push(tenantId) }
  const rows = (await dbx.all(`SELECT status, COUNT(*) AS n FROM approvals ${where} GROUP BY status`, ...params)) as { status: string; n: number }[]
  const counts = { pending: 0, approved: 0, rejected: 0, timeout: 0 }
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof typeof counts] = r.n
  }
  return counts
}

// Oldest still-pending approval, tenant-scoped only -- drives the "N pending,
// oldest waiting Xm" banner without the frontend having to fetch (and
// re-filter) the whole pending set itself.
export async function getOldestPendingApproval(tenantId?: string): Promise<{ agent_id: string; category: string; requested_at: number; timeout_at: number | null } | undefined> {
  const params: unknown[] = []
  let where = `status = 'pending'`
  if (tenantId !== undefined) { where += ' AND tenant_id = ?'; params.push(tenantId) }
  return dbx.get<{ agent_id: string; category: string; requested_at: number; timeout_at: number | null }>(`
    SELECT agent_id, category, requested_at, timeout_at FROM approvals
    WHERE ${where} ORDER BY requested_at ASC LIMIT 1
  `, ...params)
}

// Stamp trace context onto an agent_messages row that was created without one.
// Called by the message-router tick BEFORE delivery so the span is stamped
// exactly once (pending rows only -- delivered/done rows are already closed).
export async function stampMessageTrace(
  id: number,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
): Promise<boolean> {
  return (await dbx.run(`
    UPDATE agent_messages
       SET trace_id = ?, span_id = ?, parent_span_id = ?
     WHERE id = ? AND status = 'pending' AND trace_id IS NULL
  `, traceId, spanId, parentSpanId, id)).changes > 0
}

export async function expireTimedOutApprovals(): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run(`
    UPDATE approvals SET status = 'timeout', resolved_at = ?, resolved_by = 'system:timeout'
    WHERE status = 'pending' AND timeout_at IS NOT NULL AND timeout_at <= ?
  `, now, now)).changes
}
