// decideSkillRevision (DB) + the 3 decide-route endpoints (quarantine, step 3's missing piece): a pending
// revision is queued by createSkill/updateSkill's privilege gate, and until this, nothing could ever move it out
// of 'pending' again. Real in-memory SQLite throughout; only on-disk regeneration is stubbed (a different concern).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  initDatabase, db, createSkill, updateSkill, getSkill, getSkillFile, revokeSkill, deleteSkill,
  decideSkillRevision, listPendingRevisions, getRevisionDetail, hashFileSet, sha256Hex,
} from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/skill-regen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/skill-regen.js')>()),
  regenSingleSkillFile: vi.fn().mockResolvedValue({ reason: 'ok' }),
  removeGeneratedSkillFile: vi.fn().mockResolvedValue(undefined),
  removeGeneratedCompanionFile: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  initDatabase(':memory:')
})

const SYSTEM = { kind: 'system' as const, id: null }
const PRIVILEGED = '---\nname: x\ndescription: d\nallowed-tools: Bash\n---\nbody\n'
const PLAIN = '---\nname: x\ndescription: d\n---\nbody\n'

type Extras = Partial<Pick<RouteContext, 'auth' | 'role' | 'tokenAgentId' | 'agentId' | 'tenantId'>>
const SESSION: Extras = { auth: { kind: 'session', user: 'reviewer' }, role: 'admin' }
const AGENT_TOKEN: Extras = { auth: { kind: 'token', tokenName: 'tok' }, role: 'fleet_agent', tokenAgentId: 'agent-a' }
// The legacy shared admin bearer: role admin, but NOT a dashboard session. The review routes need a human session, so
// admin-by-role alone must not be enough (a leaked shared token would otherwise be able to approve a quarantined skill).
const LEGACY_ADMIN_TOKEN: Extras = { auth: { kind: 'token', tokenName: 'legacy-shared' }, role: 'admin' }
const TENANT_SESSION: Extras ={ auth: { kind: 'session', user: 'viewer' }, role: 'viewer', tenantId: 'co-x' }

async function call(method: string, path: string, body: unknown, extras: Extras) {
  const buf = Buffer.from(JSON.stringify(body ?? {}))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420' + path)
  const ctx = { req, res, path: url.pathname, method, url, tenantId: null, ...extras } as unknown as RouteContext
  expect(await tryHandleSkills(ctx)).toBe(true)
  return out
}

async function pendingCreate(id: string): Promise<number> {
  const r = await createSkill({ id, name: id, content: PRIVILEGED, tenant_id: 'fleet' }, SYSTEM, {}, { gatePrivilege: true })
  if (r.outcome !== 'pending') throw new Error('fixture did not queue a pending create')
  return r.revision.id
}

async function pendingModify(id: string): Promise<number> {
  await createSkill({ id, name: id, content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
  const r = await updateSkill(id, { content: PRIVILEGED }, SYSTEM, {}, { gatePrivilege: true })
  if (r.outcome !== 'pending') throw new Error('fixture did not queue a pending modify')
  return r.revision.id
}

describe('decideSkillRevision', () => {
  it('activate on a pending create: the skill goes live with the proposed content', async () => {
    const id = await pendingCreate('agent/a/new-skill')
    const result = await decideSkillRevision(id, 'activate', { kind: 'human', id: 'reviewer' })
    expect(result).toEqual({ outcome: 'activated', skillId: 'agent/a/new-skill' })
    const skill = await getSkill('agent/a/new-skill')
    expect(skill).toMatchObject({ status: 'live', content: PRIVILEGED, description: 'd' })
  })

  it('activate on a pending modify: the already-live skill is overwritten, nothing else changes', async () => {
    const id = await pendingModify('agent/a/existing')
    const result = await decideSkillRevision(id, 'activate', { kind: 'human', id: 'reviewer' })
    expect(result).toEqual({ outcome: 'activated', skillId: 'agent/a/existing' })
    const skill = await getSkill('agent/a/existing')
    expect(skill).toMatchObject({ status: 'live', content: PRIVILEGED })
  })

  it('activate replaces the companion files with exactly the proposed set', async () => {
    const r = await createSkill({ id: 'agent/a/with-files', name: 'x', content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
    expect(r.outcome).toBe('created')
    // seed a live companion file that the proposal below does NOT carry
    db.prepare('INSERT INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)')
      .run('agent/a/with-files', 'old.txt', Buffer.from('old'), 0o644)
    // Built directly on the tables (not via updateSkill, which always carries the CURRENT file set into its own
    // proposal): this revision's proposed set is deliberately just scripts/run.sh, so activate must remove old.txt.
    // prev_sha256/files_sha256 are set to what decideSkillRevision's own integrity/staleness checks require
    // (the hash of the skill's content at propose time, and of the proposed file set, respectively).
    const proposedFiles = [{ rel_path: 'scripts/run.sh', mode: 0o755, content: Buffer.from('#!/bin/sh\n') }]
    const revisionId = db.prepare(`
      INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, content, prev_sha256, files_sha256, author_kind, status)
      VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM skill_revisions WHERE skill_id = ?), 'modify', ?, ?, ?, 'human', 'pending')
    `).run('agent/a/with-files', 'fleet', 'agent/a/with-files', PRIVILEGED, sha256Hex(PLAIN), hashFileSet(proposedFiles)).lastInsertRowid as number
    db.prepare('INSERT INTO skill_revision_files (revision_id, rel_path, mode, content) VALUES (?, ?, ?, ?)')
      .run(revisionId, 'scripts/run.sh', 0o755, Buffer.from('#!/bin/sh\n'))
    await decideSkillRevision(revisionId, 'activate', { kind: 'human', id: 'reviewer' })
    expect(await getSkillFile('agent/a/with-files', 'old.txt')).toBeUndefined()
    const newFile = await getSkillFile('agent/a/with-files', 'scripts/run.sh')
    expect(newFile).toMatchObject({ mode: 0o755 })
  })

  it('reject on a pending create: the skill (still pending_review) and its files are removed', async () => {
    const id = await pendingCreate('agent/a/rejected-new')
    const result = await decideSkillRevision(id, 'reject', { kind: 'human', id: 'reviewer' })
    expect(result).toEqual({ outcome: 'rejected' })
    expect(await getSkill('agent/a/rejected-new')).toBeUndefined()
  })

  it('reject on a pending modify: the live skill keeps its old content, untouched', async () => {
    const id = await pendingModify('agent/a/rejected-mod')
    const result = await decideSkillRevision(id, 'reject', { kind: 'human', id: 'reviewer' })
    expect(result).toEqual({ outcome: 'rejected' })
    const skill = await getSkill('agent/a/rejected-mod')
    expect(skill).toMatchObject({ status: 'live', content: PLAIN })
  })

  it('a revision id that never existed is not_found', async () => {
    expect(await decideSkillRevision(999999, 'activate', { kind: 'human', id: 'reviewer' })).toEqual({ outcome: 'not_found' })
  })

  it('a revision already decided is not_pending on the second decide (CAS loses the race)', async () => {
    const id = await pendingCreate('agent/a/double-decide')
    expect((await decideSkillRevision(id, 'activate', { kind: 'human', id: 'reviewer' })).outcome).toBe('activated')
    expect(await decideSkillRevision(id, 'reject', { kind: 'human', id: 'reviewer-2' })).toEqual({ outcome: 'not_pending' })
  })

  it('F1: a skill revoked after a modify was proposed stays disabled -- activate is refused, not resurrected', async () => {
    const id = await pendingModify('agent/a/revoked')
    expect((await revokeSkill('agent/a/revoked', { kind: 'human', id: 'admin-1' }, 'security issue')).outcome).toBe('revoked')
    const result = await decideSkillRevision(id, 'activate', { kind: 'human', id: 'admin-2' })
    expect(result).toEqual({ outcome: 'skill_not_decidable' })
    expect((await getSkill('agent/a/revoked'))?.status).toBe('disabled')
  })

  it('F1: a skill deleted after a create was proposed is not phantom-activated', async () => {
    const id = await pendingCreate('agent/a/deleted-first')
    await deleteSkill('agent/a/deleted-first', { kind: 'human', id: 'admin-1' }, {}, { requireLive: false })
    const result = await decideSkillRevision(id, 'activate', { kind: 'human', id: 'admin-2' })
    expect(result).toEqual({ outcome: 'skill_not_decidable' })
    expect(await getSkill('agent/a/deleted-first')).toBeUndefined()
    // the revision must stay 'pending', not left dangling as 'activated' with nothing to show for it
    expect(await listPendingRevisions('agent/a/deleted-first')).toHaveLength(1)
  })

  it('F2: a modify proposal activated after a newer one already landed is refused as stale', async () => {
    await createSkill({ id: 'agent/a/stale', name: 'x', content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
    const first = await updateSkill('agent/a/stale', { content: PRIVILEGED }, SYSTEM, {}, { gatePrivilege: true })
    if (first.outcome !== 'pending') throw new Error('expected pending')
    const second = await updateSkill('agent/a/stale', { content: PRIVILEGED.replace('body', 'body v2') }, SYSTEM, {}, { gatePrivilege: true })
    if (second.outcome !== 'pending') throw new Error('expected pending')
    // decide the SECOND one first -- it lands fine, its prev_sha256 still matches the live PLAIN text
    expect((await decideSkillRevision(second.revision.id, 'activate', { kind: 'human', id: 'reviewer' })).outcome).toBe('activated')
    // the FIRST one is now stale: its prev_sha256 was PLAIN's hash, but the live text has moved past that
    const result = await decideSkillRevision(first.revision.id, 'activate', { kind: 'human', id: 'reviewer' })
    expect(result).toEqual({ outcome: 'stale_proposal' })
    // The skills write now happens BEFORE the staleness check (row lock first, see the comment in decideSkillRevision),
    // so a stale refusal must roll that write back: the newer live text survives and the stale revision stays pending.
    // NOTE: on serial SQLite this cannot tell "write before the check" from "check before the write" apart (the order
    // only matters under Postgres READ COMMITTED, migration checklist), so a mutant that swaps them is not killed here.
    // What this pins is the rollback, which the new order depends on.
    expect((await getSkill('agent/a/stale'))?.content).toBe(PRIVILEGED.replace('body', 'body v2'))
    expect(await listPendingRevisions('agent/a/stale')).toHaveLength(1)
  })

  it('a proposal whose stored text no longer matches its recorded hash is refused as corrupt and stays pending', async () => {
    const id = await pendingCreate('agent/a/tampered-text')
    db.prepare('UPDATE skill_revisions SET content = ? WHERE id = ?').run(PRIVILEGED + 'injected\n', id)
    const result = await decideSkillRevision(id, 'activate', { kind: 'human', id: 'reviewer' })
    expect(result).toEqual({ outcome: 'corrupt_proposal' })
    expect((await getSkill('agent/a/tampered-text'))?.status).toBe('pending_review')
    expect(await listPendingRevisions('agent/a/tampered-text')).toHaveLength(1)
  })

  it('a proposal whose stored companion files no longer match their recorded hash is refused as corrupt and stays pending', async () => {
    const id = await pendingCreate('agent/a/tampered-files')
    // the proposal recorded NO file set (files_sha256 null); a row appearing in skill_revision_files afterwards is a mismatch
    db.prepare('INSERT INTO skill_revision_files (revision_id, rel_path, mode, content) VALUES (?, ?, ?, ?)')
      .run(id, 'scripts/evil.sh', 0o755, Buffer.from('#!/bin/sh\n'))
    const result = await decideSkillRevision(id, 'activate', { kind: 'human', id: 'reviewer' })
    expect(result).toEqual({ outcome: 'corrupt_proposal' })
    expect((await getSkill('agent/a/tampered-files'))?.status).toBe('pending_review')
    expect(await getSkillFile('agent/a/tampered-files', 'scripts/evil.sh')).toBeUndefined()
  })

  it('reject does not run the integrity checks: a tampered proposal can still be withdrawn', async () => {
    const id = await pendingCreate('agent/a/tampered-reject')
    db.prepare('UPDATE skill_revisions SET content = ? WHERE id = ?').run('garbage', id)
    expect((await decideSkillRevision(id, 'reject', { kind: 'human', id: 'reviewer' })).outcome).toBe('rejected')
  })

  it('separation of duties: the author of an agent-proposed change may not activate their own proposal', async () => {
    await createSkill({ id: 'agent/a/self-approve', name: 'x', content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
    const proposed = await updateSkill('agent/a/self-approve', { content: PRIVILEGED }, { kind: 'agent', id: 'same-id' }, {}, { gatePrivilege: true })
    if (proposed.outcome !== 'pending') throw new Error('expected pending')
    const result = await decideSkillRevision(proposed.revision.id, 'activate', { kind: 'human', id: 'same-id' })
    expect(result).toEqual({ outcome: 'self_approval_forbidden' })
    expect((await getSkill('agent/a/self-approve'))?.content).toBe(PLAIN) // untouched, still pending for someone else
    expect(await listPendingRevisions('agent/a/self-approve')).toHaveLength(1)
  })

  // The dashboard admin is the only approver of an import by design, so the person who imports must be able to
  // activate it: without this exemption an import could never go live on a single-admin install.
  it.each(['import', 'human', 'operator'] as const)(
    'a %s submitter MAY activate their own proposal (single-admin install: the importer is the only approver)',
    async (kind) => {
      const id = `agent/a/self-ok-${kind}`
      const created = await createSkill({ id, name: 'x', content: PRIVILEGED, tenant_id: 'fleet' }, { kind, id: 'admin-1' }, {}, { gatePrivilege: true })
      if (created.outcome !== 'pending') throw new Error('fixture did not queue a pending create')
      const result = await decideSkillRevision(created.revision.id, 'activate', { kind: 'human', id: 'admin-1' })
      expect(result).toEqual({ outcome: 'activated', skillId: id })
      expect((await getSkill(id))?.status).toBe('live')
    })

  it('a create proposed by an agent is banned from self-activation too (the exemption keys on the recorded author kind)', async () => {
    const created = await createSkill({ id: 'agent/a/self-bad-kind', name: 'x', content: PRIVILEGED, tenant_id: 'fleet' }, { kind: 'agent', id: 'admin-1' }, {}, { gatePrivilege: true })
    if (created.outcome !== 'pending') throw new Error('fixture did not queue a pending create')
    expect((await decideSkillRevision(created.revision.id, 'activate', { kind: 'human', id: 'admin-1' })).outcome).toBe('self_approval_forbidden')
    expect((await getSkill('agent/a/self-bad-kind'))?.status).toBe('pending_review')
  })

  it('the submitter MAY reject their own proposal (withdrawal is not an approval)', async () => {
    await createSkill({ id: 'agent/a/self-reject', name: 'x', content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
    const proposed = await updateSkill('agent/a/self-reject', { content: PRIVILEGED }, { kind: 'agent', id: 'same-id' }, {}, { gatePrivilege: true })
    if (proposed.outcome !== 'pending') throw new Error('expected pending')
    expect((await decideSkillRevision(proposed.revision.id, 'reject', { kind: 'human', id: 'same-id' })).outcome).toBe('rejected')
  })

  it('of two concurrent decides on the same pending revision, only one wins', async () => {
    const id = await pendingCreate('agent/a/concurrent')
    const [a, b] = await Promise.all([
      decideSkillRevision(id, 'activate', { kind: 'human', id: 'r1' }),
      decideSkillRevision(id, 'reject', { kind: 'human', id: 'r2' }),
    ])
    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toEqual(['activated', 'not_pending'].sort())
  })
})

describe('GET /api/skills/sql/revisions/pending', () => {
  it('admin dashboard session: lists the pending revisions', async () => {
    await pendingCreate('agent/a/p1')
    const out = await call('GET', '/api/skills/sql/revisions/pending', null, SESSION)
    expect(out.status).toBe(200)
    expect(out.body.revisions).toHaveLength(1)
    expect(out.body.revisions[0]).not.toHaveProperty('content') // listPendingRevisions never carries the text
  })
  it('a fleet-agent token is refused', async () => {
    expect((await call('GET', '/api/skills/sql/revisions/pending', null, AGENT_TOKEN)).status).toBe(403)
  })
  it('a non-admin session is refused', async () => {
    expect((await call('GET', '/api/skills/sql/revisions/pending', null, TENANT_SESSION)).status).toBe(403)
  })
})

describe('GET /api/skills/sql/revisions/:id', () => {
  it('admin dashboard session: the proposed content and files, plus the skill current state to diff', async () => {
    const id = await pendingModify('agent/a/detail')
    const out = await call('GET', `/api/skills/sql/revisions/${id}`, null, SESSION)
    expect(out.status).toBe(200)
    expect(out.body.revision.content).toBe(PRIVILEGED)
    expect(out.body.current_content).toBe(PLAIN)
  })
  it('an unknown id is not_found', async () => {
    expect((await call('GET', '/api/skills/sql/revisions/999999', null, SESSION)).status).toBe(404)
  })
  it('a fleet-agent token is refused', async () => {
    const id = await pendingCreate('agent/a/detail2')
    expect((await call('GET', `/api/skills/sql/revisions/${id}`, null, AGENT_TOKEN)).status).toBe(403)
  })
})

describe('POST /api/skills/sql/revisions/:id/decide', () => {
  it('admin session, activate: 200 and the skill is live', async () => {
    const id = await pendingCreate('agent/a/decide1')
    const out = await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, SESSION)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, outcome: 'activated' })
    expect((await getSkill('agent/a/decide1'))?.status).toBe('live')
  })
  it('admin session, reject: 200 and the create-pending skill is gone', async () => {
    const id = await pendingCreate('agent/a/decide2')
    const out = await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'reject' }, SESSION)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, outcome: 'rejected' })
    expect(await getSkill('agent/a/decide2')).toBeUndefined()
  })
  it('a fleet-agent token is refused, the revision stays pending', async () => {
    const id = await pendingCreate('agent/a/decide3')
    expect((await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, AGENT_TOKEN)).status).toBe(403)
    expect(await listPendingRevisions('agent/a/decide3')).toHaveLength(1)
  })
  it('the legacy shared admin token (role admin, no session) is refused on decide, list and detail; the revision stays pending', async () => {
    const id = await pendingCreate('agent/a/decide3b')
    expect((await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, LEGACY_ADMIN_TOKEN)).status).toBe(403)
    expect((await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'reject' }, LEGACY_ADMIN_TOKEN)).status).toBe(403)
    expect((await call('GET', '/api/skills/sql/revisions/pending', null, LEGACY_ADMIN_TOKEN)).status).toBe(403)
    expect((await call('GET', `/api/skills/sql/revisions/${id}`, null, LEGACY_ADMIN_TOKEN)).status).toBe(403)
    expect(await listPendingRevisions('agent/a/decide3b')).toHaveLength(1)
    expect((await getSkill('agent/a/decide3b'))?.status).toBe('pending_review')
  })
  it('a non-admin session is refused', async () => {
    const id = await pendingCreate('agent/a/decide4')
    expect((await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, TENANT_SESSION)).status).toBe(403)
  })
  it('an invalid decision value is a 400, not a crash', async () => {
    const id = await pendingCreate('agent/a/decide5')
    expect((await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'delete' }, SESSION)).status).toBe(400)
  })
  it('an unknown id is 404', async () => {
    expect((await call('POST', '/api/skills/sql/revisions/999999/decide', { decision: 'activate' }, SESSION)).status).toBe(404)
  })
  it('deciding twice is 409 on the second call', async () => {
    const id = await pendingCreate('agent/a/decide6')
    expect((await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, SESSION)).status).toBe(200)
    expect((await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'reject' }, SESSION)).status).toBe(409)
  })
  it('every 409 carries a stable reason next to the hint: not_pending', async () => {
    const id = await pendingCreate('agent/a/reason1')
    await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, SESSION)
    const out = await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'reject' }, SESSION)
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'status_conflict', reason: 'not_pending', current_status: 'activated' })
  })
  it('every 409 carries a stable reason next to the hint: skill_not_decidable', async () => {
    const id = await pendingModify('agent/a/reason2')
    expect((await revokeSkill('agent/a/reason2', { kind: 'human', id: 'admin-1' }, 'withdrawn')).outcome).toBe('revoked')
    const out = await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, SESSION)
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'status_conflict', reason: 'skill_not_decidable' })
  })
  it('every 409 carries a stable reason next to the hint: stale_proposal', async () => {
    await createSkill({ id: 'agent/a/reason3', name: 'x', content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
    const first = await updateSkill('agent/a/reason3', { content: PRIVILEGED }, SYSTEM, {}, { gatePrivilege: true })
    const second = await updateSkill('agent/a/reason3', { content: PRIVILEGED.replace('body', 'body v2') }, SYSTEM, {}, { gatePrivilege: true })
    if (first.outcome !== 'pending' || second.outcome !== 'pending') throw new Error('expected pending')
    expect((await call('POST', `/api/skills/sql/revisions/${second.revision.id}/decide`, { decision: 'activate' }, SESSION)).status).toBe(200)
    const out = await call('POST', `/api/skills/sql/revisions/${first.revision.id}/decide`, { decision: 'activate' }, SESSION)
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'status_conflict', reason: 'stale_proposal' })
  })
  it('a corrupt proposal is a 500 internal_error at the route, and the revision stays pending', async () => {
    const id = await pendingCreate('agent/a/corrupt-route')
    db.prepare('UPDATE skill_revisions SET content = ? WHERE id = ?').run(PRIVILEGED + 'injected\n', id)
    const out = await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate' }, SESSION)
    expect(out.status).toBe(500)
    expect(out.body).toMatchObject({ error: 'internal_error' })
    expect(await listPendingRevisions('agent/a/corrupt-route')).toHaveLength(1)
  })
  it('the decider is the session user, recorded on the revision row', async () => {
    const id = await pendingCreate('agent/a/decide7')
    await call('POST', `/api/skills/sql/revisions/${id}/decide`, { decision: 'activate', reason: 'looks fine' }, SESSION)
    const detail = await getRevisionDetail(id)
    expect(detail).toMatchObject({ status: 'activated', decided_by: 'reviewer', decision_ref: 'looks fine' })
  })
  it('at the route: an agent-authored proposal whose id equals the session user is refused for activation', async () => {
    await createSkill({ id: 'agent/a/decide8', name: 'x', content: PLAIN, tenant_id: 'fleet' }, SYSTEM, {})
    const proposed = await updateSkill('agent/a/decide8', { content: PRIVILEGED }, { kind: 'agent', id: 'reviewer' }, {}, { gatePrivilege: true })
    if (proposed.outcome !== 'pending') throw new Error('expected pending')
    const out = await call('POST', `/api/skills/sql/revisions/${proposed.revision.id}/decide`, { decision: 'activate' }, SESSION)
    expect(out.status).toBe(403)
  })
  it('at the route: the admin session that imported a skill activates its own import (200)', async () => {
    const created = await createSkill({ id: 'agent/a/own-import', name: 'x', content: PRIVILEGED, tenant_id: 'fleet' }, { kind: 'import', id: 'reviewer' }, {}, { gatePrivilege: true })
    if (created.outcome !== 'pending') throw new Error('fixture did not queue a pending create')
    const out = await call('POST', `/api/skills/sql/revisions/${created.revision.id}/decide`, { decision: 'activate' }, SESSION)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, outcome: 'activated' })
    expect((await getSkill('agent/a/own-import'))?.status).toBe('live')
  })
})

describe('RBAC: the decide-queue paths are admin:all, double-protected alongside the route check', () => {
  it.each([
    ['GET', '/api/skills/sql/revisions/pending'],
    ['GET', '/api/skills/sql/revisions/42'],
    ['POST', '/api/skills/sql/revisions/42/decide'],
  ])('%s %s resolves to admin:all', (method, path) => {
    expect(resolveRequiredPermission(method, path)).toBe('admin:all')
  })
})
