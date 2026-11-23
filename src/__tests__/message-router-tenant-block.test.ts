import { describe, it, expect, vi, beforeEach } from 'vitest'

// The message router reads its queue in its own `system` context, across tenants. The status writes that belong to ONE
// message run in a block of that message's tenant (runAsItemTenant), so that under row-level security a wrong stamp fails
// instead of writing into another tenant. These cells record the db context every writer runs in.
//
// Fixtures are neutral: tenants `tenant-a` / `tenant-b`, agents `agent-a` / `agent-b`.

type Seen = { fn: string; id?: number; role?: string; tenantId?: string; name?: string; traceId?: string; args: unknown[] }
const seen: Seen[] = []
const note = (fn: string, args: unknown[], id?: number): void => {
  const ctx = currentDbContextRef()
  seen.push({ fn, id, role: ctx?.role, tenantId: ctx?.tenantId, name: ctx?.name, traceId: ctx?.traceId, args })
}
let currentDbContextRef: () => { role: string; tenantId?: string; name?: string; traceId?: string } | undefined = () => undefined

const mockGetPending = vi.fn()
const mockSendPrompt = vi.fn((..._a: unknown[]): unknown => 'sent')
const mockWarn = vi.fn()
const sessionState = { exists: true, readyThrows: false }
const classifyState = { reject: false }
const fedState: { result: { kind: string; error?: string; remoteId?: string } } = { result: { kind: 'delivered', remoteId: 'r1' } }
const fedSent: number[] = []

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => mockWarn(...a), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'agent-main',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))
vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    note('getPendingMessages', [toAgent])
    return toAgent ? Promise.resolve([]) : Promise.resolve(mockGetPending())
  },
  markMessageDelivered: (id: number) => { note('markMessageDelivered', [id], id); return Promise.resolve(true) },
  markMessageFailed: (id: number, ...r: unknown[]) => { note('markMessageFailed', [id, ...r], id); return Promise.resolve(true) },
  markMessageDone: (id: number, ...r: unknown[]) => { note('markMessageDone', [id, ...r], id); return Promise.resolve(true) },
  markMessageNoSession: (id: number) => { note('markMessageNoSession', [id], id); return Promise.resolve(true) },
  markPendingFederatedFailed: (id: number, ...r: unknown[]) => { note('markPendingFederatedFailed', [id, ...r], id); return Promise.resolve(true) },
  setMessageResult: (id: number, ...r: unknown[]) => { note('setMessageResult', [id, ...r], id); return Promise.resolve(true) },
  createAgentMessage: (...a: unknown[]) => { note('createAgentMessage', a); return Promise.resolve({ id: 999 }) },
  stampMessageTrace: (id: number, ...r: unknown[]) => { note('stampMessageTrace', [id, ...r], id); return Promise.resolve(true) },
  upsertOtelSpan: () => Promise.resolve(),
  closeOtelSpan: () => false,
}))
vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/nonexistent-dir' }))
vi.mock('../web/agent-config.js', () => ({ readAgentRemoteHost: () => null, readAgentVoiceConfig: () => ({ responseMode: 'text' }) }))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => { if (sessionState.readyThrows) throw new Error('pane gone'); return true }),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: vi.fn(() => sessionState.exists),
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'agent-main-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => (classifyState.reject ? null : { category: 'trusted-peer', safeFrom: 'agent-a' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))
vi.mock('../web/delivery-intent.js', () => ({ recordDelivery: vi.fn() }))
vi.mock('../web/federation/bridge.js', () => ({
  sendFederatedMessage: (msg: { id: number }) => { fedSent.push(msg.id); return Promise.resolve(fedState.result) },
}))
vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: () => ({}),
  abandonWindowMsForPeer: () => 60 * 60 * 1000,
}))

import { runMessageRouterTick, batchDeliverBacklog, deliverFederatedBatch } from '../web/message-router.js'
import { runAs, currentDbContext, getDbContextStats, resetDbContextForTest } from '../db/context.js'

currentDbContextRef = currentDbContext

const nowSec = () => Math.floor(Date.now() / 1000)
let msgId = 9000
const row = (tenantId: string | null | undefined, extra: Record<string, unknown> = {}) => ({
  id: (msgId += 1), from_agent: 'agent-a', to_agent: 'agent-b', content: 'ping', tenant_id: tenantId,
  created_at: nowSec(), trace_id: null, span_id: null, ...extra,
})
const tick = () => runAs.system('message-router', () => runMessageRouterTick(), { inheritTrace: false })
const writers = (fn: string) => seen.filter((s) => s.fn === fn)
const where = (s: Seen) => `${s.role}:${s.tenantId ?? '-'}`

beforeEach(() => {
  vi.clearAllMocks()
  resetDbContextForTest()
  seen.length = 0
  fedSent.length = 0
  sessionState.exists = true
  sessionState.readyThrows = false
  classifyState.reject = false
  fedState.result = { kind: 'delivered', remoteId: 'r1' }
  mockSendPrompt.mockReset()
  mockSendPrompt.mockReturnValue('sent')
})

describe('message router: the status writes of a message run in the tenant of that message', () => {
  it('two messages of two tenants: each delivered mark runs as a tenant block of its own tenant, the queue read is system, no escalation', async () => {
    const a = row('tenant-a')
    const b = row('tenant-b')
    mockGetPending.mockReturnValue([a, b])
    await tick()

    const delivered = writers('markMessageDelivered')
    expect(delivered.map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a'], [b.id, 'tenant:tenant-b']])
    // the block carries no job name and no trace of the tick
    for (const s of delivered) expect(s.name).toBeUndefined()
    const queue = writers('getPendingMessages')[0]
    expect(queue.role).toBe('system')
    expect(queue.name).toBe('message-router')
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('the trace stamp of an unstamped message runs in its tenant block as well', async () => {
    const a = row('tenant-a')
    const b = row('tenant-b')
    mockGetPending.mockReturnValue([a, b])
    await tick()
    expect(writers('stampMessageTrace').map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a'], [b.id, 'tenant:tenant-b']])
  })

  it('a target session that is not running: the no_session stamp runs in the tenant of the message', async () => {
    sessionState.exists = false
    const a = row('tenant-a')
    const b = row('tenant-b')
    mockGetPending.mockReturnValue([a, b])
    await tick()
    expect(writers('markMessageNoSession').map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a'], [b.id, 'tenant:tenant-b']])
  })

  it('an abandoned message: the failed mark runs in its tenant, the notice to the orchestrator stays outside the block (system)', async () => {
    sessionState.exists = false
    const old = row('tenant-b', { created_at: nowSec() - 2 * 60 * 60 })
    mockGetPending.mockReturnValue([old])
    await tick()
    const failed = writers('markMessageFailed')
    expect(failed.map((s) => [s.id, where(s)])).toEqual([[old.id, 'tenant:tenant-b']])
    expect(String(failed[0].args[1])).toMatch(/Abandoned/)
    // notifyOrchestratorOfFailedHandoff writes a message: a global notice, not a write of this tenant's item
    const notices = writers('createAgentMessage')
    expect(notices.length).toBeGreaterThan(0)
    for (const n of notices) expect(n.role).toBe('system')
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('an invalid sender: the failed mark runs in the tenant of the message, and inside it the trace of the row', async () => {
    classifyState.reject = true
    const a = row('tenant-a', { trace_id: 'trace-a', span_id: 'span-a' })
    mockGetPending.mockReturnValue([a])
    await tick()
    const failed = writers('markMessageFailed')
    expect(failed.map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a']])
    // the block carries no trace of its own: the trace of the row is applied INSIDE it, so the write keeps it
    expect(failed[0].traceId).toBe('trace-a')
  })

  it('three refused sends: the final failed mark runs in the tenant of the message with the trace of the row', async () => {
    mockSendPrompt.mockReturnValue('aborted-busy')
    const a = row('tenant-a', { trace_id: 'trace-a', span_id: 'span-a' })
    mockGetPending.mockReturnValue([a])
    for (let i = 0; i < 3; i++) await tick()
    const failed = writers('markMessageFailed')
    expect(failed.map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a']])
    expect(failed[0].traceId).toBe('trace-a')
    expect(writers('markMessageDelivered')).toEqual([])
  })

  it('a message whose processing throws: the failed mark of the outer catch runs in its tenant', async () => {
    sessionState.readyThrows = true
    const b = row('tenant-b')
    mockGetPending.mockReturnValue([b])
    await tick()
    const failed = writers('markMessageFailed')
    expect(failed.map((s) => [s.id, where(s)])).toEqual([[b.id, 'tenant:tenant-b']])
    expect(String(failed[0].args[1])).toMatch(/Delivery error/)
  })

  it('a message without a tenant ("", null, missing) is skipped and counted, and does not stop the next message', async () => {
    const empty = row('')
    const nul = row(null)
    const missing = row(undefined)
    const ok = row('tenant-a')
    mockGetPending.mockReturnValue([empty, nul, missing, ok])
    await tick()

    // no send, no write for the three; the fourth is delivered in its own tenant
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const touched = new Set(seen.filter((s) => s.id !== undefined).map((s) => s.id))
    expect(touched).toEqual(new Set([ok.id]))
    expect(writers('markMessageDelivered').map(where)).toEqual(['tenant:tenant-a'])
    expect(getDbContextStats().tenantUnresolved['message-router']).toBe(3)
    // never run as the default tenant
    expect(seen.some((s) => s.tenantId === 'default')).toBe(false)
  })

  it('the warning of a message without a tenant is logged once per id, the counter rises on every tick', async () => {
    const empty = row('')
    mockGetPending.mockReturnValue([empty])
    await tick()
    await tick()
    await tick()
    const warned = mockWarn.mock.calls.filter((c) => c[0]?.id === empty.id)
    expect(warned).toHaveLength(1)
    expect(getDbContextStats().tenantUnresolved['message-router']).toBe(3)
    expect(seen.filter((s) => s.id === empty.id)).toEqual([])
  })
})

describe('message router: the log of tenant-less messages is bounded', () => {
  it('warns for at most 200 distinct ids (the set is shared with the earlier cells), and still counts every tick', async () => {
    let ticks = 0
    for (let i = 0; i < 12; i++) {
      // 25 new tenant-less ids per tick (the per-tick budget), 300 ids in all
      mockGetPending.mockReturnValue(Array.from({ length: 25 }, () => row('')))
      await tick()
      ticks += 1
    }
    const warned = mockWarn.mock.calls.filter((c) => String(c[1] ?? '').includes('has no tenant'))
    // 300 distinct ids met: without the cap every one would warn
    expect(warned.length).toBeGreaterThan(150)
    expect(warned.length).toBeLessThanOrEqual(200)
    expect(getDbContextStats().tenantUnresolved['message-router']).toBe(ticks * 25)
  })
})

describe('message router: the reconnect backlog summary is written per tenant', () => {
  const old = (tenantId: string | null, content: string) => row(tenantId, { content, created_at: nowSec() - 3 * 60 * 60 })

  it('two tenants: each tenant has its own done marks and its own summary, in its own block, stamped with that tenant', async () => {
    const a1 = old('tenant-a', 'secret-of-a one')
    const a2 = old('tenant-a', 'secret-of-a two')
    const b1 = old('tenant-b', 'secret-of-b one')
    await batchDeliverBacklog('agent-b', [a1, b1, a2] as never, Date.now())

    expect(writers('markMessageDone').map((s) => [s.id, where(s)])).toEqual([
      [a1.id, 'tenant:tenant-a'], [a2.id, 'tenant:tenant-a'], [b1.id, 'tenant:tenant-b'],
    ])
    const created = writers('createAgentMessage')
    expect(created.map(where)).toEqual(['tenant:tenant-a', 'tenant:tenant-b'])
    // (from, to, content, originNote, traceCtx, tenantId, envelope, pinTenant)
    expect(created.map((c) => [c.args[0], c.args[1], c.args[5], c.args[7]])).toEqual([
      ['system', 'agent-b', 'tenant-a', true], ['system', 'agent-b', 'tenant-b', true],
    ])
    // a summary never quotes another tenant's message
    const summaryA = String(created[0].args[2])
    const summaryB = String(created[1].args[2])
    expect(summaryA).toContain('secret-of-a one')
    expect(summaryA).toContain('secret-of-a two')
    expect(summaryA).not.toContain('secret-of-b')
    expect(summaryB).toContain('secret-of-b one')
    expect(summaryB).not.toContain('secret-of-a')
    expect(summaryA).toContain('2 inter-agent message(s)')
    expect(summaryB).toContain('1 inter-agent message(s)')
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('a message without a tenant is neither batched nor summarised, and is counted', async () => {
    const a1 = old('tenant-a', 'one')
    const none = old('', 'no tenant')
    await batchDeliverBacklog('agent-b', [a1, none] as never, Date.now())
    expect(writers('markMessageDone').map((s) => s.id)).toEqual([a1.id])
    expect(writers('createAgentMessage')).toHaveLength(1)
    expect(String(writers('createAgentMessage')[0].args[2])).not.toContain('no tenant')
    expect(getDbContextStats().tenantUnresolved['message-router']).toBe(1)
  })

  it('only messages without a tenant: nothing is written', async () => {
    await batchDeliverBacklog('agent-b', [old('', 'x'), old(null, 'y')] as never, Date.now())
    expect(seen).toEqual([])
  })
})

describe('message router: the federated batch writes each message under its tenant', () => {
  const fed = (tenantId: string | null, extra: Record<string, unknown> = {}) => row(tenantId, { to_agent: 'peer-x/agent-b', ...extra })

  it('delivered: the delivered mark and the remote id result run in the tenant of the message', async () => {
    const a = fed('tenant-a')
    const b = fed('tenant-b')
    await deliverFederatedBatch([a, b] as never, Date.now())
    expect(writers('markMessageDelivered').map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a'], [b.id, 'tenant:tenant-b']])
    expect(writers('setMessageResult').map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a'], [b.id, 'tenant:tenant-b']])
    expect(String(writers('setMessageResult')[0].args[1])).toBe('fed:peer-x:r1')
  })

  it('terminal failure: the guarded failed mark runs in the tenant of the message', async () => {
    fedState.result = { kind: 'failed', error: 'peer said no' }
    const b = fed('tenant-b')
    await deliverFederatedBatch([b] as never, Date.now())
    expect(writers('markPendingFederatedFailed').map((s) => [s.id, where(s)])).toEqual([[b.id, 'tenant:tenant-b']])
  })

  it('abandoned after the window: the guarded failed mark runs in the tenant of the message', async () => {
    const a = fed('tenant-a', { created_at: nowSec() - 3 * 60 * 60 })
    await deliverFederatedBatch([a] as never, Date.now())
    expect(writers('markPendingFederatedFailed').map((s) => [s.id, where(s)])).toEqual([[a.id, 'tenant:tenant-a']])
    expect(fedSent).toEqual([])
  })

  it('a federated message without a tenant is not sent, not written, and counted', async () => {
    const none = fed('')
    const ok = fed('tenant-a')
    await deliverFederatedBatch([none, ok] as never, Date.now())
    expect(fedSent).toEqual([ok.id])
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set([ok.id]))
    expect(getDbContextStats().tenantUnresolved['message-router']).toBe(1)
  })
})
