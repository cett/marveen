// Tenant handling of the conversation ledger: the 0075 backfill, the server-side tenant stamp from the
// chat binding, the shared-agent read rules and the registered-agent check. Real in-memory SQLite.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../db-migrations.js'
import {
  initDatabase, db, createTenant, updateTenant, setTenantAgentAvailability, setChannelBinding,
  logLedgerTurn, recentLedgerTurns, openLedgerQuestion, isSharedLedgerAgent,
} from '../db.js'
import { tryHandleConversationLedger } from '../web/routes/conversation-ledger.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['solo', 'shared'],
}))

const tenantOf = (messageId: string) =>
  (db.prepare('SELECT tenant_id FROM conversation_log WHERE message_id = ?').get(messageId) as { tenant_id: string | null }).tenant_id

beforeEach(async () => {
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  createTenant('beta', 'Beta')
  await setTenantAgentAvailability('acme', 'shared', true)
  await setTenantAgentAvailability('beta', 'shared', true)
  await setTenantAgentAvailability('acme', 'solo', true)
})

function turn(over: Record<string, unknown>) {
  return { agent_id: 'solo', chat_id: '1', direction: 'in', message_id: 'm', text: 't', created_at: 1000, ...over } as Parameters<typeof logLedgerTurn>[0]
}

describe('migration 0075 backfill (Q3b)', () => {
  it('marks the rows of a shared agent _multi_ and every other row default', () => {
    const src = join(__dirname, '..', 'migrations')
    const dir = mkdtempSync(join(tmpdir(), 'convlog-migr-'))
    try {
      const files = readdirSync(src).filter(f => f.endsWith('.sql')).sort()
      for (const f of files.filter(f => f < '0075')) copyFileSync(join(src, f), join(dir, f))
      const old = new Database(':memory:')
      applyMigrations(old, dir)
      old.pragma('foreign_keys = OFF')
      old.exec(`
        INSERT INTO tenants (id, display_name, created_at) VALUES ('t1', 'T1', 0), ('t2', 'T2', 0);
        INSERT INTO tenants (id, display_name, created_at) VALUES ('t3', 'T3', 0);
        UPDATE tenants SET main_agent_id = 'coord' WHERE id = 't1';
        UPDATE tenants SET main_agent_id = 'dup' WHERE id = 't3';
        UPDATE tenants SET main_agent_id = 'boss' WHERE id = 't2';
        INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES
          ('t1', 'multi', 1), ('t2', 'multi', 1), ('t1', 'single', 1), ('t1', 'half', 1), ('t2', 'half', 0),
          ('t2', 'coord', 1), ('t2', 'boss', 1), ('t3', 'dup', 1);
        INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, created_at) VALUES
          ('multi', '1', 'in', 'a', 'x', 1), ('single', '1', 'in', 'b', 'x', 1),
          ('half', '1', 'in', 'c', 'x', 1), ('nobody', '1', 'in', 'd', 'x', 1),
          ('coord', '1', 'in', 'e', 'x', 1), ('boss', '1', 'in', 'f', 'x', 1), ('dup', '1', 'in', 'g', 'x', 1);
      `)
      copyFileSync(join(src, files.find(f => f.startsWith('0075'))!), join(dir, files.find(f => f.startsWith('0075'))!))
      applyMigrations(old, dir)
      const rows = old.prepare('SELECT message_id, tenant_id FROM conversation_log ORDER BY message_id').all()
      expect(rows).toEqual([
        { message_id: 'a', tenant_id: '_multi_' },   // two enabled tenants
        { message_id: 'b', tenant_id: 'default' },   // one tenant
        { message_id: 'c', tenant_id: 'default' },   // the second availability row is disabled
        { message_id: 'd', tenant_id: 'default' },   // not in the matrix at all
        { message_id: 'e', tenant_id: '_multi_' },   // coordinates t1 and is enabled for t2
        { message_id: 'f', tenant_id: 'default' },   // coordinates t2 and is enabled for t2: ONE tenant
        { message_id: 'g', tenant_id: 'default' },   // coordinates t3 and is enabled for t3: ONE tenant
      ])
      old.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('server-side tenant stamp from the chat binding', () => {
  it('stamps the tenant bound to the chat, for inbound and outbound alike', async () => {
    await setChannelBinding('shared', 'telegram', '555', 'acme', 'test')
    await setChannelBinding('shared', 'telegram', '666', 'beta', 'test')
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: '555', message_id: 'in1' }))
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: '666', direction: 'out', message_id: 'out1' }))
    expect(tenantOf('in1')).toBe('acme')
    expect(tenantOf('out1')).toBe('beta')
  })

  it('leaves an unbound chat NULL (unknown), not default', async () => {
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: '777', message_id: 'unbound' }))
    expect(tenantOf('unbound')).toBeNull()
  })

  it('ignores a stale agent_tenant_context: the binding of THIS chat decides', async () => {
    await setChannelBinding('shared', 'telegram', '555', 'acme', 'test')
    db.prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('shared', 'beta', 'bound')").run()
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: '555', message_id: 'x' }))
    expect(tenantOf('x')).toBe('acme')
  })

  it('does not take the binding of another agent for the same chat id', async () => {
    await setChannelBinding('solo', 'telegram', '555', 'acme', 'test')
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: '555', message_id: 'y' }))
    expect(tenantOf('y')).toBeNull()
  })
})

describe('a coordinator enabled for a second tenant is shared (main agent + availability)', () => {
  beforeEach(async () => {
    updateTenant('acme', { main_agent_id: 'coord' })      // coord coordinates acme ...
    await setTenantAgentAvailability('beta', 'coord', true)       // ... and is enabled for beta: ONE availability row
    await setChannelBinding('coord', 'telegram', 'A', 'acme', 'test')
    await setChannelBinding('coord', 'telegram', 'B', 'beta', 'test')
    await logLedgerTurn(turn({ agent_id: 'coord', chat_id: 'A', message_id: 'a1', text: 'acme question', created_at: 1000 }))
    await logLedgerTurn(turn({ agent_id: 'coord', chat_id: 'B', message_id: 'b1', text: 'beta question', created_at: 1010 }))
  })
  const ctxFor = (tenant: string) =>
    db.prepare("INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES ('coord', ?, 'bound', unixepoch())").run(tenant)

  it('is shared although it has a single availability row', async () => {
    expect(await isSharedLedgerAgent('coord')).toBe(true)
    expect(await isSharedLedgerAgent('solo')).toBe(false)
  })

  it('replay is empty: the acme coordinator never replays beta turns (and vice versa)', async () => {
    expect(await recentLedgerTurns('coord')).toEqual([])
  })

  it('open question comes only from the serving tenant, null without a context', async () => {
    expect(await openLedgerQuestion('coord')).toBeNull()
    ctxFor('acme')
    expect((await openLedgerQuestion('coord'))?.text).toBe('acme question')
    ctxFor('beta')
    expect((await openLedgerQuestion('coord'))?.text).toBe('beta question')
  })

  it('a coordinator of one tenant with no other tenant is not shared', async () => {
    updateTenant('acme', { main_agent_id: 'lonely' })
    expect(await isSharedLedgerAgent('lonely')).toBe(false)
  })
})

describe('read rules', () => {
  async function seedBothTenants() {
    await setChannelBinding('shared', 'telegram', 'A', 'acme', 'test')
    await setChannelBinding('shared', 'telegram', 'B', 'beta', 'test')
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: 'A', message_id: 'a1', text: 'acme question', created_at: 1000 }))
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: 'B', message_id: 'b1', text: 'beta question', created_at: 1010 }))
  }
  const setContext = (tenant: string, status = 'bound', ageSeconds = 0) =>
    db.prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, unixepoch() - ?)')
      .run('shared', tenant, status, ageSeconds)

  it('replay of a shared agent is EMPTY: the tenant B session never gets tenant A turns', async () => {
    await seedBothTenants()
    expect(await recentLedgerTurns('shared')).toEqual([])
  })

  it('replay of a not-shared agent is unchanged', async () => {
    await logLedgerTurn(turn({ agent_id: 'solo', message_id: 's1', text: 'one', created_at: 1000 }))
    await logLedgerTurn(turn({ agent_id: 'solo', message_id: 's2', text: 'two', created_at: 1001 }))
    expect((await recentLedgerTurns('solo')).map(t => t.text)).toEqual(['one', 'two'])
  })

  it('open question of a shared agent comes only from the tenant it is serving now', async () => {
    await seedBothTenants()
    setContext('acme')
    expect((await openLedgerQuestion('shared'))?.text).toBe('acme question')
    setContext('beta')
    expect((await openLedgerQuestion('shared'))?.text).toBe('beta question')
  })

  it('an answer in the OTHER tenant does not close this tenant\'s question', async () => {
    await seedBothTenants()
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: 'B', direction: 'out', message_id: 'o1', text: 'beta answer', created_at: 1020 }))
    setContext('acme')
    expect((await openLedgerQuestion('shared'))?.text).toBe('acme question')
    setContext('beta')
    expect(await openLedgerQuestion('shared')).toBeNull()
  })

  it('no context, a stale one, an unknown/conflict one, or a tenant the agent no longer serves: null', async () => {
    await seedBothTenants()
    expect(await openLedgerQuestion('shared')).toBeNull()                 // no row
    setContext('acme', 'bound', 50 * 3600)
    expect(await openLedgerQuestion('shared')).toBeNull()                 // stale
    setContext('acme', 'unknown')
    expect(await openLedgerQuestion('shared')).toBeNull()
    setContext('acme', 'conflict')
    expect(await openLedgerQuestion('shared')).toBeNull()
    createTenant('gamma', 'Gamma')
    await setTenantAgentAvailability('gamma', 'shared', true)
    await setTenantAgentAvailability('acme', 'shared', false)             // still shared (beta + gamma), acme dropped
    setContext('acme')
    expect(await openLedgerQuestion('shared')).toBeNull()                 // a context for a tenant it no longer serves
  })

  it('NULL-tenant rows are invisible to a shared agent', async () => {
    await logLedgerTurn(turn({ agent_id: 'shared', chat_id: 'nobound', message_id: 'n1', text: 'unresolved' }))
    setContext('acme')
    expect(await openLedgerQuestion('shared')).toBeNull()
  })

  it('open question of a not-shared agent is unchanged (no context needed)', async () => {
    await logLedgerTurn(turn({ agent_id: 'solo', message_id: 's1', text: 'open one' }))
    expect((await openLedgerQuestion('solo'))?.text).toBe('open one')
  })
})

describe('registered agents only', () => {
  async function call(method: string, path: string, body?: unknown) {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
    const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
    req.method = method
    req.headers = {}
    setImmediate(() => { ;(req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
    const out = { status: 200, body: null as any }
    const res = {
      writeHead(s: number) { out.status = s },
      setHeader() {},
      end(b?: string | Buffer) { if (b) out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString() : b) },
    }
    const url = new URL(`http://localhost:3420${path}`)
    await tryHandleConversationLedger({ req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext)
    return out
  }
  const entry = (agent: string) => ({ agent_id: agent, chat_id: '1', direction: 'in', message_id: 'z', text: 't' })

  it('rejects an unknown agent_id on write, recent and open-question', async () => {
    expect((await call('POST', '/api/conversation-ledger', entry('scripts'))).status).toBe(400)
    expect((await call('GET', '/api/conversation-ledger/scripts/recent')).status).toBe(400)
    expect((await call('GET', '/api/conversation-ledger/pg-prep-handoff/open-question')).status).toBe(400)
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversation_log').get() as { n: number }).n).toBe(0)
  })

  it('rejects a whole batch when one entry names an unknown agent', async () => {
    const res = await call('POST', '/api/conversation-ledger', { entries: [entry('solo'), entry('verify-716')] })
    expect(res.status).toBe(400)
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversation_log').get() as { n: number }).n).toBe(0)
  })

  it('accepts a registered agent', async () => {
    expect((await call('POST', '/api/conversation-ledger', entry('solo'))).status).toBe(200)
  })
})
