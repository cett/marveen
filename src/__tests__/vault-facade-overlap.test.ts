// The vault ssh and the approval storage functions that moved onto the async db facade: what has to hold when two
// calls overlap, and that a failed multi-statement write leaves nothing behind. Real in-memory database, no mocks.
// Each test names the line it protects: take that line out of src/db/vault.ts and the test fails.
import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import {
  db, createVaultSshKey, createVaultSshServer, updateVaultSshServer, deleteVaultSshKey, getVaultSshServer,
  createApproval, getApproval, resolveApproval, expireTimedOutApprovals, recordApprovalEvent, listApprovalEvents,
  createAgentMessage, markMessageDelivered, stampMessageTrace, consumeApproval,
} from '../db.js'

useTestDb()

const KEY = { label: 'k', username: 'root', vault_key_id: 'vk-1', public_key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:x', key_type: 'ed25519', tenant_id: 'default' }
const SERVER = { name: 's', host: 'h', port: 22, username: 'root', description: null, tenant_id: 'default' }
const request = (id: string, extra: Partial<Parameters<typeof createApproval>[0]> = {}) =>
  createApproval({ id, agent_id: 'agent-a', category: 'file_write', action_description: 'x', ...extra })

const HASH = 'a'.repeat(64)

describe('createApproval', () => {
  it('stores every field it returns (payload, hash, human-only flag, deadline, tenant)', async () => {
    const returned = await createApproval({
      id: 'ap-1', agent_id: 'agent-a', category: 'file_write', action_description: 'x',
      action_payload: '{"k":1}', content_hash: HASH, human_only: true, timeout_at: Math.floor(Date.now() / 1000) + 600, tenant_id: 'tenant-b',
    })
    expect(await getApproval('ap-1')).toMatchObject({
      action_payload: '{"k":1}', content_hash: HASH, human_only: 1, tenant_id: 'tenant-b', timeout_at: returned.timeout_at, status: 'pending',
    })
  })
})

describe('deleteVaultSshKey', () => {
  it('unassigns the servers and deletes the key in one transaction: a failing delete leaves the assignment in place', async () => {
    await createVaultSshKey({ id: 'key-1', ...KEY })
    await createVaultSshServer({ id: 'srv-1', ...SERVER })
    await updateVaultSshServer('srv-1', { ssh_key_id: 'key-1' })
    db.exec("CREATE TRIGGER vault_key_delete_blocked BEFORE DELETE ON vault_ssh_keys BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    await expect(deleteVaultSshKey('key-1')).rejects.toThrow(/blocked/)
    expect((await getVaultSshServer('srv-1'))?.ssh_key_id).toBe('key-1')
  })

  it('two overlapping deletes: exactly one deletes the key, and the unassign count belongs to that one', async () => {
    await createVaultSshKey({ id: 'key-1', ...KEY })
    await createVaultSshServer({ id: 'srv-1', ...SERVER })
    await createVaultSshServer({ id: 'srv-2', ...SERVER })
    await updateVaultSshServer('srv-1', { ssh_key_id: 'key-1' })
    await updateVaultSshServer('srv-2', { ssh_key_id: 'key-1' })
    const results = await Promise.all([deleteVaultSshKey('key-1'), deleteVaultSshKey('key-1')])
    expect(results.filter((r) => r.deleted)).toHaveLength(1)
    expect(results.reduce((sum, r) => sum + r.unassigned, 0)).toBe(2)
    expect((await getVaultSshServer('srv-1'))?.ssh_key_id).toBeNull()
    expect((await getVaultSshServer('srv-2'))?.ssh_key_id).toBeNull()
  })
})

describe('resolveApproval', () => {
  it('of two overlapping decisions on one pending request exactly one is applied, and the row keeps that one', async () => {
    await request('ap-1')
    const results = await Promise.all([
      resolveApproval('ap-1', 'approved', 'human:session:owner', null, 'dashboard_session'),
      resolveApproval('ap-1', 'rejected', 'ops-token', null, 'bearer'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const row = await getApproval('ap-1')
    expect(row).toMatchObject(results[0] ? { status: 'approved', resolved_by: 'human:session:owner', resolved_via: 'dashboard_session' } : { status: 'rejected', resolved_by: 'ops-token', resolved_via: 'bearer' })
  })

  it('an approval or rejection after the deadline is refused, recording the timeout itself is allowed', async () => {
    const past = Math.floor(Date.now() / 1000) - 5
    await request('ap-1', { timeout_at: past })
    await request('ap-2', { timeout_at: past })
    expect(await resolveApproval('ap-1', 'approved', 'owner')).toBe(false)
    expect((await getApproval('ap-1'))?.status).toBe('pending')
    expect(await resolveApproval('ap-2', 'timeout', 'system:timeout')).toBe(true)
    expect((await getApproval('ap-2'))?.status).toBe('timeout')
  })

  it('a decided request cannot be decided again', async () => {
    await request('ap-1')
    expect(await resolveApproval('ap-1', 'approved', 'owner')).toBe(true)
    expect(await resolveApproval('ap-1', 'rejected', 'someone-else')).toBe(false)
    expect(await getApproval('ap-1')).toMatchObject({ status: 'approved', resolved_by: 'owner' })
  })
})

describe('expireTimedOutApprovals', () => {
  it('times out the pending requests whose deadline passed and counts exactly those', async () => {
    const now = Math.floor(Date.now() / 1000)
    await request('late', { timeout_at: now - 5 })
    await request('open', { timeout_at: now + 600 })
    await request('no-deadline')
    await request('decided', { timeout_at: now - 5 })
    await resolveApproval('decided', 'timeout', 'system:timeout')
    // the request that already left `pending` is not counted a second time
    expect(await expireTimedOutApprovals()).toBe(1)
    expect((await getApproval('late'))).toMatchObject({ status: 'timeout', resolved_by: 'system:timeout' })
    expect((await getApproval('open'))?.status).toBe('pending')
    expect((await getApproval('no-deadline'))?.status).toBe('pending')
    expect(await expireTimedOutApprovals()).toBe(0)
  })
})

describe('recordApprovalEvent', () => {
  it('appends to the journal in call order and defaults the tenant', async () => {
    await request('ap-1')
    await recordApprovalEvent({ approval_id: 'ap-1', event: 'bearer_denied', actor: 'ops-token' })
    await recordApprovalEvent({ approval_id: 'ap-1', event: 'owner_unreached', tenant_id: 'tenant-b' })
    const events = await listApprovalEvents('ap-1')
    expect(events.map((e) => [e.event, e.tenant_id])).toEqual([['bearer_denied', 'default'], ['owner_unreached', 'tenant-b']])
  })

  it('the journal row of a consume (the synchronous twin) carries the tenant of the approval', async () => {
    await createApproval({ id: 'ap-2', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH, tenant_id: 'tenant-b' })
    expect(await resolveApproval('ap-2', 'approved', 'human:session:owner', null, 'dashboard_session')).toBe(true)
    const out = await consumeApproval({ id: 'ap-2', content_hash: HASH, principal: 'agent-a', tenant_id: 'tenant-b', window_s: 600, ref: 'r1', consumer: 'test' })
    expect(out.ok).toBe(true)
    const events = await listApprovalEvents('ap-2')
    expect(events.map((e) => [e.event, e.tenant_id])).toEqual([['consumed', 'tenant-b']])
  })
})

describe('stampMessageTrace', () => {
  it('leaves a message that is no longer pending alone', async () => {
    const msg = await createAgentMessage('from-a', 'to-b', 'hello')
    expect(await markMessageDelivered(msg.id)).toBe(true)
    expect(await stampMessageTrace(msg.id, 'trace-1', 'span-1', null)).toBe(false)
    const row = db.prepare('SELECT trace_id FROM agent_messages WHERE id = ?').get(msg.id) as { trace_id: string | null }
    expect(row.trace_id).toBeNull()
  })

  it('of two overlapping stamps on one pending message exactly one wins, and the message keeps its trace', async () => {
    const msg = await createAgentMessage('from-a', 'to-b', 'hello')
    const results = await Promise.all([
      stampMessageTrace(msg.id, 'trace-1', 'span-1', null),
      stampMessageTrace(msg.id, 'trace-2', 'span-2', 'root'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const row = db.prepare('SELECT trace_id, span_id FROM agent_messages WHERE id = ?').get(msg.id) as { trace_id: string; span_id: string }
    expect(row).toEqual(results[0] ? { trace_id: 'trace-1', span_id: 'span-1' } : { trace_id: 'trace-2', span_id: 'span-2' })
  })
})
