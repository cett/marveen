// POST /api/hooks/gate-audit on PostgreSQL, as the APP role (marveen_app: DML rights only, row-level security FORCEd), through the
// real request opener (runAsRequest). What the SQLite cells (src/__tests__/hooks-gate-audit-route.test.ts) cannot show:
//   - the NULL tenant of a hook row and the whole of gate_decision_counts are writable by a PRIVILEGED context only (class B and D2): the
//     named system job `hook-gate-audit` does it as the app role, and the ORACLE cells show a tenant-scoped context does NOT, so the
//     system job is needed and the write is not vacuously open
//   - a REAL failure half way (a trigger of the admin role refuses one deny row) rolls the counts and the earlier rows back
//   - the upsert adds on this backend (the column is qualified: `count` is ambiguous in an ON CONFLICT of PostgreSQL)
// Rows are inspected through the admin pool (the oracle that a row exists whatever the policies say). Neutral fixtures only.
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { runAs } from '../../db/context.js'
import { runAsRequest } from '../../db/background-jobs.js'
import { dbx } from '../../db/facade.js'
import { recordGateAudit } from '../../db/hook-gate-audit.js'
import { tryHandleHooksGateAudit } from '../../web/routes/hooks-gate-audit.js'
import type { RouteContext } from '../../web/routes/types.js'

const made: PgTestDb[] = []
afterEach(async () => { await closePgBackend() })
afterAll(async () => { for (const d of made) await d.close() })

/** A backend booted as the app role over two tenants; agent-a is enabled for both (a shared agent). */
async function bootedDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-t1', 'Tenant 1', 1), ('tenant-t2', 'Tenant 2', 1) ON CONFLICT DO NOTHING")
  await db.pool.query("INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES ('tenant-t1', 'agent-a', 1), ('tenant-t2', 'agent-a', 1)")
  await bootPgBackend({ url: db.appUrl })
  return db
}

function routeCtx(body: unknown, tokenAgentId: string | undefined, tenantId: string): { ctx: RouteContext; out: { status: number; body: unknown } } {
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
  const url = new URL('http://localhost:3420/api/hooks/gate-audit')
  return { ctx: { req, res, path: url.pathname, method: 'POST', url, role: 'fleet_agent', tokenAgentId, tenantId } as unknown as RouteContext, out }
}

/** The route as the web server runs it: the request opener gives the agent context of the token's tenant. */
async function ask(body: unknown, agent: string, tenantId: string): Promise<{ status: number; body: unknown }> {
  const { ctx, out } = routeCtx(body, agent, tenantId)
  await runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: agent, tenantId }, () => tryHandleHooksGateAudit(ctx))
  return out
}

const now = () => Math.floor(Date.now() / 1000)
const deny = (gate: string, reason = 'denied') => ({ gate, reason, ts: now() })
const countRows = async (db: PgTestDb) => (await db.pool.query('SELECT gate, decision, reason, count::int AS count FROM gate_decision_counts ORDER BY gate, decision, reason')).rows
const auditRows = async (db: PgTestDb) => (await db.pool.query('SELECT agent_id, verdict, trigger_source, reason, tenant_id FROM hook_audit_log ORDER BY id')).rows

describe('the write as the app role under row-level security', () => {
  it('counts add up and a deny row lands with the token agent and a NULL tenant, from a request in ANY tenant context', async () => {
    const db = await bootedDb()
    const body = { counts: [{ gate: 'tenant-skill-gate', decision: 'deny', reason: 'denied', n: 2 }, { gate: 'destructive-gate', decision: 'allow', reason: '', n: 5 }], denies: [deny('tenant-skill-gate')] }
    expect((await ask(body, 'agent-a', 'tenant-t1')).status).toBe(200)
    expect((await ask({ counts: [{ gate: 'destructive-gate', decision: 'allow', reason: '', n: 4 }] }, 'agent-a', 'tenant-t2')).status).toBe(200)
    expect(await countRows(db)).toEqual([
      { gate: 'destructive-gate', decision: 'allow', reason: '', count: 9 },
      { gate: 'tenant-skill-gate', decision: 'deny', reason: 'denied', count: 2 },
    ])
    expect(await auditRows(db)).toEqual([{ agent_id: 'agent-a', verdict: 'deny', trigger_source: 'tenant-skill-gate', reason: 'denied', tenant_id: null }])
  })

  it('a shared agent whose tenant context is the OTHER tenant files the same unresolved-tenant row (no tenant stamp leaks in)', async () => {
    const db = await bootedDb()
    await ask({ denies: [deny('secret-read-gate')] }, 'agent-a', 'tenant-t2')
    expect((await auditRows(db)).map((r) => r.tenant_id)).toEqual([null])
  })

  it('a shared agent WITH a fresh context: a deny decided at or after the context row is stamped with its tenant, one decided before it is NULL (the stamp is written as the app role by the job)', async () => {
    const db = await bootedDb()
    const since = now() - 600
    await db.pool.query("INSERT INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES ('agent-a', 'tenant-t2', 'bound', $1)", [since])
    await ask({ denies: [
      { gate: 'secret-read-gate', reason: 'denied', ts: since - 1 },
      { gate: 'secret-read-gate', reason: 'denied', ts: since },
      { gate: 'secret-read-gate', reason: 'denied', ts: since + 100 },
    ] }, 'agent-a', 'tenant-t1')
    expect((await auditRows(db)).map((r) => r.tenant_id)).toEqual([null, 'tenant-t2', 'tenant-t2'])
  })

  it('the ORACLE: a tenant-scoped context cannot write these rows (the NULL tenant and the D2 counts), so the system job is what makes the write work', async () => {
    await bootedDb()
    const scoped = runAs.tenant('tenant-t1', () => dbx.run(
      "INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, trigger_source, tenant_id) VALUES (1, 'agent-a', 'PreToolUse', 'deny', 'destructive-gate', NULL)"))
    await expect(scoped).rejects.toThrow()
    const scopedCount = runAs.tenant('tenant-t1', () => dbx.run(
      "INSERT INTO gate_decision_counts (gate, decision, reason, count, first_at, updated_at) VALUES ('destructive-gate', 'allow', '', 1, 1, 1)"))
    await expect(scopedCount).rejects.toThrow()
    // and the job itself, called with no request at all, does write
    await expect(recordGateAudit('agent-a', [{ gate: 'destructive-gate', decision: 'allow', reason: '', n: 1 }], [])).resolves.toEqual({ counts: 1, denies: 0 })
  })
})

describe('one transaction on this backend: a real failure half way', () => {
  it('a trigger refuses the second deny row: the first row and the counts are rolled back, the request is not acknowledged', async () => {
    const db = await bootedDb()
    await db.pool.query(`CREATE FUNCTION refuse_input_too_large() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.reason = 'input_too_large' THEN RAISE EXCEPTION 'refused by the test trigger'; END IF; RETURN NEW; END $$`)
    await db.pool.query('CREATE TRIGGER refuse_second BEFORE INSERT ON hook_audit_log FOR EACH ROW EXECUTE FUNCTION refuse_input_too_large()')
    const { ctx, out } = routeCtx({
      counts: [{ gate: 'destructive-gate', decision: 'deny', reason: 'denied', n: 3 }],
      denies: [deny('destructive-gate', 'denied'), deny('destructive-gate', 'input_too_large')],
    }, 'agent-a', 'tenant-t1')
    await expect(runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: 'tenant-t1' }, () => tryHandleHooksGateAudit(ctx))).rejects.toThrow()
    expect(out.body).toBeUndefined() // never ok:true
    expect(await countRows(db)).toEqual([])
    expect(await auditRows(db)).toEqual([])
  })
})
