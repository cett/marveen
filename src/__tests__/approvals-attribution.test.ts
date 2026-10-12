// Kanban 667: Approval attribution for session-auth callers.
//
// When a session-authenticated B2B user resolves an approval via the dashboard,
// resolved_by must be set to ctx.auth.user (the session username), not the
// body-supplied value. Token-auth callers get the identity of their token (the agent it
// names, else the token's registered name, else 'shared-token'), also not the body value.
//
// Mutation proof: removing the `ctx.auth?.kind === 'session' && ctx.auth.user`
// condition causes the session-auth test to pass the body value ('dashboard')
// to resolveApproval instead of the username, failing the argument assertion.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp',
  STORE_DIR: '/tmp/store',
  MAIN_AGENT_ID: 'marveen',
  APPROVAL_HUMAN_ONLY_ENFORCE: false,
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const mockResolveApproval = vi.fn()
const mockGetApproval = vi.fn()
const mockCreateApproval = vi.fn()
const mockListApprovals = vi.fn()
const mockExpireTimedOutApprovals = vi.fn()
const mockCreateAgentMessage = vi.fn()
const mockWriteAgentAuditLog = vi.fn()

vi.mock('../db.js', () => ({
  get writeAgentAuditLog() { return mockWriteAgentAuditLog },
  get createApproval() { return mockCreateApproval },
  get getApproval() { return mockGetApproval },
  get resolveApproval() { return mockResolveApproval },
  get listApprovals() { return mockListApprovals },
  get expireTimedOutApprovals() { return mockExpireTimedOutApprovals },
  get createAgentMessage() { return mockCreateAgentMessage },
  listHumanOnlyCategoryKeys: () => [],
  recordApprovalEvent: () => undefined,
}))

import { tryHandleApprovals } from '../web/routes/approvals.js'

function makeCtx(
  method: string,
  path: string,
  body: object | undefined,
  auth?: RouteContext['auth'],
  extra: Partial<RouteContext> = {},
): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  // session-auth callers in attribution tests are admin-level (no tenant scope restriction).
  const role: RouteContext['role'] = auth?.kind === 'session' ? 'admin' : undefined
  return { ctx: { req, res, path: url.pathname, method, url, auth, role, ...extra } as RouteContext, out }
}

const PENDING_APPROVAL = {
  id: 'appr-001', agent_id: 'agent-d', category: 'file_write',
  action_description: 'Write to /etc', status: 'pending',
  created_at: 0, timeout_at: null, resolved_by: null, resolved_at: null, tenant_id: null,
}
const RESOLVED_APPROVAL = {
  ...PENDING_APPROVAL, status: 'approved', resolved_by: 'alice', resolved_at: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetApproval.mockReturnValue(PENDING_APPROVAL)
  mockResolveApproval.mockReturnValue(RESOLVED_APPROVAL)
  mockListApprovals.mockReturnValue([])
  mockExpireTimedOutApprovals.mockReturnValue(0)
})

describe('PATCH /api/approvals/:id -- session-auth attribution', () => {
  it('uses ctx.auth.user as resolved_by when session-auth, ignoring body value', async () => {
    mockGetApproval
      .mockReturnValueOnce(PENDING_APPROVAL)
      .mockReturnValueOnce({ ...RESOLVED_APPROVAL, resolved_by: 'alice' })

    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved', resolved_by: 'dashboard' },
      { kind: 'session', user: 'alice' },
    )
    await tryHandleApprovals(ctx)

    expect(out.status).toBe(200)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'alice', null, 'dashboard_session')
  })

  it('resolved_by in response reflects the session username, not the body value', async () => {
    mockGetApproval
      .mockReturnValueOnce(PENDING_APPROVAL)
      .mockReturnValueOnce({ ...RESOLVED_APPROVAL, resolved_by: 'alice' })

    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved', resolved_by: 'dashboard' },
      { kind: 'session', user: 'alice' },
    )
    await tryHandleApprovals(ctx)
    expect(out.body.resolved_by).toBe('alice')
  })
})

describe('PATCH /api/approvals/:id -- token-auth attribution comes from the token', () => {
  const patch = (body: object, auth: RouteContext['auth'], extra: Partial<RouteContext> = {}) =>
    makeCtx('PATCH', '/api/approvals/appr-001', body, auth, { role: 'admin', ...extra })

  it('stores the name of the registered token, not the resolved_by the body claims', async () => {
    const { ctx, out } = patch({ status: 'approved', resolved_by: 'someone-else' }, { kind: 'token', tokenName: 'ops-token' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'ops-token', null, 'bearer')
  })

  it('prefers the agent the token names over the token name', async () => {
    const { ctx } = patch({ status: 'approved', resolved_by: 'someone-else' }, { kind: 'token', tokenName: 'ops-token' }, { tokenAgentId: 'main-agent' })
    await tryHandleApprovals(ctx)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'main-agent', null, 'bearer')
  })

  it('records the legacy shared token as shared-token, and needs no resolved_by from it', async () => {
    const { ctx, out } = patch({ status: 'approved' }, { kind: 'token' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'shared-token', null, 'bearer')
  })

  it('runs the self-approval guard on the authenticated identity, so a body naming someone else does not slip past', async () => {
    // the requester of PENDING_APPROVAL is agent-d; a token that names agent-d cannot resolve it
    const { ctx, out } = patch({ status: 'approved', resolved_by: 'somebody-else' }, { kind: 'token', tokenName: 'x' }, { tokenAgentId: 'agent-d' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(mockResolveApproval).not.toHaveBeenCalled()
  })

  it('does not let the body claim the requester\'s identity to be refused or to hide behind', async () => {
    // a body saying resolved_by = the requester no longer decides anything for a token caller
    const { ctx, out } = patch({ status: 'approved', resolved_by: 'agent-d' }, { kind: 'token', tokenName: 'ops-token' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'ops-token', null, 'bearer')
  })
})

describe('PATCH /api/approvals/:id -- the body\'s resolved_by is kept as a declared label in the audit detail', () => {
  const patch = (body: object, auth: RouteContext['auth'], extra: Partial<RouteContext> = {}) =>
    makeCtx('PATCH', '/api/approvals/appr-001', body, auth, { role: 'admin', ...extra })
  const auditDetail = () => {
    expect(mockWriteAgentAuditLog).toHaveBeenCalledTimes(1)
    return mockWriteAgentAuditLog.mock.calls[0]![0] as { agent_id: string; action: string; detail: Record<string, unknown> }
  }

  it('records a body resolved_by that differs from the authenticated resolver as declared_resolved_by', async () => {
    const { ctx } = patch({ status: 'approved', resolved_by: 'telegram_text' }, { kind: 'token', tokenName: 'ops-token' })
    await tryHandleApprovals(ctx)
    const entry = auditDetail()
    expect(entry.agent_id).toBe('ops-token')
    expect(entry.detail).toEqual({ status: 'approved', requested_by: 'agent-d', declared_resolved_by: 'telegram_text' })
  })

  it('trims the declared label', async () => {
    const { ctx } = patch({ status: 'approved', resolved_by: '  telegram_text  ' }, { kind: 'token', tokenName: 'ops-token' })
    await tryHandleApprovals(ctx)
    expect(auditDetail().detail.declared_resolved_by).toBe('telegram_text')
  })

  it('leaves declared_resolved_by out when the body names the authenticated resolver itself', async () => {
    const { ctx } = patch({ status: 'approved', resolved_by: 'alice' }, { kind: 'session', user: 'alice' })
    await tryHandleApprovals(ctx)
    expect(auditDetail().detail).not.toHaveProperty('declared_resolved_by')
  })

  it('leaves declared_resolved_by out when the body names nobody, or only whitespace', async () => {
    await tryHandleApprovals(patch({ status: 'approved' }, { kind: 'token', tokenName: 'ops-token' }).ctx)
    expect(auditDetail().detail).not.toHaveProperty('declared_resolved_by')
    mockWriteAgentAuditLog.mockClear()
    await tryHandleApprovals(patch({ status: 'approved', resolved_by: '   ' }, { kind: 'token', tokenName: 'ops-token' }).ctx)
    expect(auditDetail().detail).not.toHaveProperty('declared_resolved_by')
  })

  it('a legacy call with no auth stores the body label as the resolver, so there is nothing separate to declare', async () => {
    const { ctx } = makeCtx('PATCH', '/api/approvals/appr-001', { status: 'approved', resolved_by: 'dashboard' }, undefined)
    await tryHandleApprovals(ctx)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'dashboard', null, null)
    expect(auditDetail().detail).not.toHaveProperty('declared_resolved_by')
  })
})

describe('PATCH /api/approvals/:id -- no auth (legacy fleet call)', () => {
  it('returns 400 when resolved_by missing and no auth context', async () => {
    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved' },
      undefined,
    )
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('resolved_by')
  })
})
