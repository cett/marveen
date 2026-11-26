// Two writes that a tenant or agent request reaches on PostgreSQL and that the row-level policy refused (42501) on the live
// cutover: the conversation ledger turn (conversation_log, WITH CHECK tenant_id = app.tenant()) and the desired run-state of the
// sub-agents (system_config, a D2 table: privileged only). Each cell runs the caller bare, in the context a request gives it, on a
// backend booted as the app role, and reads the result back through the admin pool (the oracle that the row exists).
//
// The ledger row carries the tenant of the chat's channel binding (another tenant than the caller's, or NULL for an unbound
// chat), never the caller's: that is why a tenant-context INSERT was refused. The fix opens a narrow named system job for the
// lookup and the one INSERT; the cells below also pin that nothing the caller sends reaches the stamp and that the policy still
// hides a foreign row from a tenant read.
//
// Privacy: neutral fixtures only.
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { runAs } from '../../db/context.js'
import { runAsRequest } from '../../db/background-jobs.js'
import { logLedgerTurn, recentLedgerTurns } from '../../db/conversation-ledger.js'
import { tryHandleConversationLedger } from '../../web/routes/conversation-ledger.js'
import { addDesiredAgent, getDesiredAgents, removeDesiredAgent } from '../../web/agent-desired-state.js'
import { getSystemConfig } from '../../db/system-config.js'
import { MAIN_AGENT_ID } from '../../config.js'
import type { RouteContext } from '../../web/routes/types.js'

// `agent-a` is the registered agent of the cells; any other id is refused by the route as unregistered.
vi.mock('../../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/agent-config.js')>()),
  listAgentNames: () => ['agent-a', 'agent-b'],
}))

const made: PgTestDb[] = []
afterEach(async () => { await closePgBackend() })
afterAll(async () => { for (const d of made) await d.close() })

/** A booted backend as the app role over two tenants. `agent-a` is served by tenant-t1 only. */
async function bootedDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-t1', 'Tenant 1', 1), ('tenant-t2', 'Tenant 2', 1) ON CONFLICT DO NOTHING")
  await bootPgBackend({ url: db.appUrl })
  return db
}
const bind = (db: PgTestDb, agent: string, chat: string, tenant: string): Promise<unknown> =>
  db.pool.query("INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at) VALUES ($1, 'telegram', $2, $3, 'test', 1, 1)", [agent, chat, tenant])
const rows = async (db: PgTestDb): Promise<{ message_id: string; tenant_id: string | null }[]> =>
  (await db.pool.query('SELECT message_id, tenant_id FROM conversation_log ORDER BY id')).rows
const turn = (over: Record<string, unknown> = {}): Parameters<typeof logLedgerTurn>[0] =>
  ({ agent_id: 'agent-a', chat_id: '1001', direction: 'in', message_id: 'm1', text: 't', created_at: 1000, ...over }) as Parameters<typeof logLedgerTurn>[0]
/** The context a fleet agent token gets from the web server: the agent, in its tenant. */
const asAgent = <T>(tenant: string, fn: () => Promise<T>): Promise<T> =>
  runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: tenant }, fn)

describe('ledger write by a fleet agent token (conversation_log)', () => {
  it('a chat with no binding is stored with a NULL tenant (the unknown stamp), not refused', async () => {
    const db = await bootedDb()
    expect(await asAgent('tenant-t1', () => logLedgerTurn(turn()))).toBe(true)
    expect(await rows(db)).toEqual([{ message_id: 'm1', tenant_id: null }])
  })
  it('a chat bound to ANOTHER tenant than the caller is stored with the tenant of the binding', async () => {
    const db = await bootedDb()
    await bind(db, 'agent-a', '1001', 'tenant-t2')
    expect(await asAgent('tenant-t1', () => logLedgerTurn(turn()))).toBe(true)
    expect(await rows(db)).toEqual([{ message_id: 'm1', tenant_id: 'tenant-t2' }])
  })
  it('a chat bound to the caller tenant keeps working (the path that never failed)', async () => {
    const db = await bootedDb()
    await bind(db, 'agent-a', '1001', 'tenant-t1')
    expect(await asAgent('tenant-t1', () => logLedgerTurn(turn()))).toBe(true)
    expect(await rows(db)).toEqual([{ message_id: 'm1', tenant_id: 'tenant-t1' }])
  })
  it('stays idempotent: the same (agent, chat, direction, message) a second time stores nothing and answers false', async () => {
    const db = await bootedDb()
    await bind(db, 'agent-a', '1001', 'tenant-t2')
    expect(await asAgent('tenant-t1', () => logLedgerTurn(turn()))).toBe(true)
    expect(await asAgent('tenant-t1', () => logLedgerTurn(turn()))).toBe(false)
    expect(await rows(db)).toHaveLength(1)
  })
  it('the stamp is the binding, never the caller: a tenant context cannot make a row land in its own tenant for a foreign chat', async () => {
    const db = await bootedDb()
    await bind(db, 'agent-a', '1001', 'tenant-t2')
    // the same chat id and agent, the caller claims tenant-t1: the row is still the tenant of the binding
    await asAgent('tenant-t1', () => logLedgerTurn(turn()))
    await asAgent('tenant-t2', () => logLedgerTurn(turn({ message_id: 'm2' })))
    expect((await rows(db)).map((r) => r.tenant_id)).toEqual(['tenant-t2', 'tenant-t2'])
  })
  it('the policy is untouched: a tenant context still reads only the rows of its own tenant (the other tenant and the NULL row stay hidden)', async () => {
    const db = await bootedDb()
    await bind(db, 'agent-a', '2002', 'tenant-t1')
    await bind(db, 'agent-a', '3003', 'tenant-t2')
    await asAgent('tenant-t1', () => logLedgerTurn(turn({ chat_id: '2002', message_id: 'own' })))
    await asAgent('tenant-t1', () => logLedgerTurn(turn({ chat_id: '3003', message_id: 'foreign' })))
    await asAgent('tenant-t1', () => logLedgerTurn(turn({ chat_id: '4004', message_id: 'unbound' })))
    expect(await rows(db)).toHaveLength(3)
    const seen = await asAgent('tenant-t1', () => recentLedgerTurns('agent-a'))
    expect(seen.map((t) => t.chat_id)).toEqual(['2002'])
  })
  it('the lookup is not widened either: a direct INSERT of a foreign tenant row from a tenant context is still refused by the policy', async () => {
    const db = await bootedDb()
    const failure = await runAs.agent('agent-a', 'tenant-t1', async () => {
      const { dbx } = await import('../../db/facade.js')
      return dbx.run("INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, created_at, tenant_id) VALUES ('agent-a', '9', 'in', 'x', 't', 1, 'tenant-t2')")
    }).then(() => undefined, (e: unknown) => e)
    expect((failure as { code?: string } | undefined)?.code).toBe('42501')
    expect(await rows(db)).toEqual([])
  })

  /** The route context of the POST the capture hook sends: the agent token, its own agent id in the body. */
  function post(body: unknown, tokenAgentId: string, tenantId: string): { ctx: RouteContext; out: { status: number; body: unknown } } {
    const req = new EventEmitter() as unknown as RouteContext['req']
    Object.assign(req, { method: 'POST', headers: {}, destroy: () => {} })
    setImmediate(() => { (req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body))); (req as unknown as EventEmitter).emit('end') })
    const out: { status: number; body: unknown } = { status: 200, body: undefined }
    const res = {
      writeHead(s: number) { out.status = s },
      setHeader() {},
      end(b?: string | Buffer) {
        if (!b) return
        try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not json */ }
      },
    } as unknown as RouteContext['res']
    const url = new URL('http://localhost:3420/api/conversation-ledger')
    return { ctx: { req, res, path: url.pathname, method: 'POST', url, role: 'fleet_agent', tokenAgentId, tenantId, auth: { kind: 'token' } } as unknown as RouteContext, out }
  }
  it('POST /api/conversation-ledger as the fleet token: 200, the turn is stored (end to end, a spool flush of two entries)', async () => {
    const db = await bootedDb()
    await bind(db, 'agent-a', '1001', 'tenant-t2')
    const entries = [turn({ message_id: 'm1' }), turn({ message_id: 'm2', direction: 'out' })]
    const { ctx, out } = post({ entries }, 'agent-a', 'tenant-t1')
    expect(await runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: 'tenant-t1' }, () => tryHandleConversationLedger(ctx))).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, received: 2, inserted: 2 })
    expect((await rows(db)).map((r) => r.tenant_id)).toEqual(['tenant-t2', 'tenant-t2'])
  })
  it('POST as the fleet token of ANOTHER agent stays a 403 and nothing is stored (the identity check runs before the system job)', async () => {
    const db = await bootedDb()
    const { ctx, out } = post(turn(), 'agent-b', 'tenant-t1')
    expect(await runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'agent-b', tenantId: 'tenant-t1' }, () => tryHandleConversationLedger(ctx))).toBe(true)
    expect(out.status).toBe(403)
    expect(await rows(db)).toEqual([])
  })
})

describe('desired run-state of the sub-agents (system_config key agents_desired)', () => {
  const stored = async (db: PgTestDb): Promise<string[]> => {
    const r = (await db.pool.query("SELECT value FROM system_config WHERE key = 'agents_desired'")).rows[0] as { value: string } | undefined
    return r === undefined ? [] : (JSON.parse(r.value) as string[])
  }
  it('a start from a tenant context lands in system_config and in the cache (refused without the named job: the agent is not remembered across a restart)', async () => {
    const db = await bootedDb()
    await runAs.tenant('tenant-t1', () => addDesiredAgent('agent-a'))
    expect(await stored(db)).toEqual(['agent-a'])
    expect([...getDesiredAgents()]).toEqual(['agent-a'])
  })
  it('the same from an agent context, merging with what is stored (two adds both land, sorted)', async () => {
    const db = await bootedDb()
    await runAs.agent('agent-a', 'tenant-t1', () => addDesiredAgent('agent-b'))
    await runAs.agent('agent-a', 'tenant-t1', () => addDesiredAgent('agent-a'))
    expect(await stored(db)).toEqual(['agent-a', 'agent-b'])
  })
  it('a stop removes only the named agent and a repeated stop is a no-op', async () => {
    const db = await bootedDb()
    await runAs.tenant('tenant-t1', () => addDesiredAgent('agent-a'))
    await runAs.tenant('tenant-t1', () => addDesiredAgent('agent-b'))
    await runAs.tenant('tenant-t1', () => removeDesiredAgent('agent-a'))
    await runAs.tenant('tenant-t1', () => removeDesiredAgent('agent-a'))
    expect(await stored(db)).toEqual(['agent-b'])
  })
  it('the main agent is never stored (its lifecycle is service-managed): the add is a no-op and writes no row', async () => {
    const db = await bootedDb()
    await runAs.tenant('tenant-t1', () => addDesiredAgent(MAIN_AGENT_ID))
    expect((await db.pool.query("SELECT 1 FROM system_config WHERE key = 'agents_desired'")).rowCount).toBe(0)
  })
  it('the policy is untouched: a tenant context still reads NOTHING of system_config and cannot write another key', async () => {
    const db = await bootedDb()
    await runAs.tenant('tenant-t1', () => addDesiredAgent('agent-a'))
    const { dbx } = await import('../../db/facade.js')
    expect(await runAs.tenant('tenant-t1', () => dbx.all('SELECT key FROM system_config'))).toEqual([])
    const refused = await runAs.tenant('tenant-t1', () => dbx.run("INSERT INTO system_config (key, value, updated_at, source) VALUES ('other_key', 'v', 1, 'db')")).then(() => undefined, (e: unknown) => e)
    expect((refused as { code?: string } | undefined)?.code).toBe('42501')
    expect((await db.pool.query("SELECT 1 FROM system_config WHERE key = 'other_key'")).rowCount).toBe(0)
    expect(getSystemConfig('agents_desired')?.value).toBe('["agent-a"]')
  })
})
