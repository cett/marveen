// The agents module on the async facade: the writes whose old synchronous form could not be interleaved.
// Overlapped calls end in exactly one winner, the statements of a transaction body run on the tx handle, a failed
// statement rolls the whole step back, and the boot twin of the tenant resolver agrees with the asynchronous one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  db, dbx, createTenant, createAgentMessage, claimPendingForAgent, closeMessagesWithoutDelivery,
  getAgentConversationThreads, upsertBlackboard, markBlackboardStale, findBlackboardRowByAgent,
  listBlackboardHistory, setTenantAgentAvailability, resolveAgentOwningTenantId, resolveAgentOwningTenantIdSync,
} from '../db.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

beforeEach(() => {
  db.exec('DELETE FROM fleet_blackboard_history; DELETE FROM fleet_blackboard; DELETE FROM agent_messages; DELETE FROM agent_tenant_context; DELETE FROM tenant_agent_availability')
})
afterEach(() => { vi.restoreAllMocks() })

function spyFacade(): string[] {
  const seen: string[] = []
  for (const m of ['get', 'run', 'all'] as const) {
    const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => { seen.push(sql.trim().slice(0, 60)); return real(sql, ...a) }) as never)
  }
  return seen
}

const rowCount = (agent: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM fleet_blackboard WHERE agent_id = ?').get(agent) as { n: number }).n

describe('upsertBlackboard: overlapped posts of one agent', () => {
  it('two first posts end in one row, the later call wins, and both are in the history', async () => {
    const [a, b] = await Promise.all([
      upsertBlackboard('agent-a', { status: 'active', summary: 'first' }),
      upsertBlackboard('agent-a', { status: 'active', summary: 'second' }),
    ])
    expect(a.summary).toBe('first')
    expect(b.summary).toBe('second')
    expect(b.id).toBe(a.id)
    expect(rowCount('agent-a')).toBe(1)
    expect((await findBlackboardRowByAgent('agent-a'))?.summary).toBe('second')
    const history = (await listBlackboardHistory({ agent_id: 'agent-a' })).map((h) => h.summary).sort()
    expect(history).toEqual(['first', 'second'])
  })

  it('eight overlapped first posts leave exactly one row and one history entry per distinct post', async () => {
    const out = await Promise.all(Array.from({ length: 8 }, (_, i) => upsertBlackboard('agent-b', { status: 'active', summary: `post-${i}` })))
    expect(new Set(out.map((r) => r.id)).size).toBe(1)
    expect(rowCount('agent-b')).toBe(1)
    expect((await findBlackboardRowByAgent('agent-b'))?.summary).toBe('post-7')
    expect(await listBlackboardHistory({ agent_id: 'agent-b' })).toHaveLength(8)
  })

  it('the blocked reason of a blocked row survives a second overlapped blocked post without a reason', async () => {
    await upsertBlackboard('agent-c', { status: 'active', summary: 'x' })
    await Promise.all([
      upsertBlackboard('agent-c', { status: 'blocked', summary: 'x', blocked_by: 'agent-z', blocked_reason: 'waiting' }),
      upsertBlackboard('agent-c', { status: 'blocked', summary: 'x' }),
    ])
    const row = await findBlackboardRowByAgent('agent-c')
    expect(row?.blocked_by).toBe('agent-z')
    expect(row?.blocked_reason).toBe('waiting')
  })

  it('every statement of the transaction body runs on the tx handle, not on the facade', async () => {
    const seen = spyFacade()
    await upsertBlackboard('agent-d', { status: 'active', summary: 'one' })
    await upsertBlackboard('agent-d', { status: 'done', summary: 'one' })
    // the plan-binding drop after a 'done' commit is the only facade call, and it is outside the transaction
    expect(seen.filter((s) => /fleet_blackboard|tenant_agent_availability/.test(s))).toEqual([])
  })

  it('a failing history insert rolls the row back', async () => {
    await upsertBlackboard('agent-e', { status: 'active', summary: 'before' })
    db.exec("CREATE TRIGGER w36_fail_history BEFORE INSERT ON fleet_blackboard_history WHEN NEW.summary = 'boom' BEGIN SELECT RAISE(ABORT, 'history refused'); END")
    try {
      await expect(upsertBlackboard('agent-e', { status: 'active', summary: 'boom' })).rejects.toThrow('history refused')
    } finally { db.exec('DROP TRIGGER w36_fail_history') }
    expect((await findBlackboardRowByAgent('agent-e'))?.summary).toBe('before')
  })
})

describe('markBlackboardStale: compare-and-set on the row it read', () => {
  const OLD = 1_000
  const age = (agent: string): void => { db.prepare('UPDATE fleet_blackboard SET updated_at = ? WHERE agent_id = ?').run(OLD, agent) }

  it('marks an old active row stale and records it', async () => {
    await upsertBlackboard('agent-s', { status: 'active', summary: 'old task' })
    age('agent-s')
    expect(await markBlackboardStale({}, 60, 60, 5_000)).toBe(1)
    expect((await findBlackboardRowByAgent('agent-s'))?.status).toBe('stale')
    expect((await listBlackboardHistory({ agent_id: 'agent-s' })).map((h) => h.status)).toContain('stale')
  })

  it('a post the agent makes between the sweep read and its update is kept', async () => {
    await upsertBlackboard('agent-s', { status: 'active', summary: 'old task' })
    age('agent-s')
    const real = dbx.all.bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, 'all').mockImplementation((async (sql: string, ...a: unknown[]) => {
      const rows = await real(sql, ...a)
      if (/FROM fleet_blackboard WHERE status IN/.test(sql)) {
        vi.mocked(dbx.all).mockRestore()
        await upsertBlackboard('agent-s', { status: 'active', summary: 'fresh post' })
      }
      return rows
    }) as never)
    expect(await markBlackboardStale({}, 60, 60)).toBe(0)
    const row = await findBlackboardRowByAgent('agent-s')
    expect(row?.status).toBe('active')
    expect(row?.summary).toBe('fresh post')
    expect((await listBlackboardHistory({ agent_id: 'agent-s' })).map((h) => h.status)).not.toContain('stale')
  })

  it('a row the agent closed between the sweep read and its update stays done', async () => {
    await upsertBlackboard('agent-s', { status: 'active', summary: 'old task' })
    age('agent-s')
    const real = dbx.all.bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, 'all').mockImplementation((async (sql: string, ...a: unknown[]) => {
      const rows = await real(sql, ...a)
      if (/FROM fleet_blackboard WHERE status IN/.test(sql)) {
        vi.mocked(dbx.all).mockRestore()
        await upsertBlackboard('agent-s', { status: 'done', summary: 'old task' })
      }
      return rows
    }) as never)
    expect(await markBlackboardStale({}, 60, 60)).toBe(0)
    expect((await findBlackboardRowByAgent('agent-s'))?.status).toBe('done')
  })
})

describe('markBlackboardStale: the status condition', () => {
  it('a row whose status changed without a newer timestamp is not marked stale', async () => {
    await upsertBlackboard('agent-s', { status: 'active', summary: 'old task' })
    db.prepare('UPDATE fleet_blackboard SET updated_at = 1000 WHERE agent_id = ?').run('agent-s')
    const real = dbx.all.bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, 'all').mockImplementation((async (sql: string, ...a: unknown[]) => {
      const rows = await real(sql, ...a)
      if (/FROM fleet_blackboard WHERE status IN/.test(sql)) {
        vi.mocked(dbx.all).mockRestore()
        // a writer in the same second as the row's last write: the timestamp is unchanged, the status is not
        db.prepare("UPDATE fleet_blackboard SET status = 'done' WHERE agent_id = ?").run('agent-s')
      }
      return rows
    }) as never)
    expect(await markBlackboardStale({}, 60, 60)).toBe(0)
    expect((await findBlackboardRowByAgent('agent-s'))?.status).toBe('done')
  })
})

describe('claimPendingForAgent: two claimers', () => {
  it('every pending message is claimed by exactly one of two overlapped claimers', async () => {
    for (let i = 0; i < 6; i++) await createAgentMessage('agent-a', 'agent-x', `m${i}`)
    const [one, two] = await Promise.all([claimPendingForAgent('agent-x', 4), claimPendingForAgent('agent-x', 4)])
    const ids = [...one, ...two].map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(6)
    expect(one).toHaveLength(4)
    expect(two).toHaveLength(2)
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'").get() as { n: number }).n).toBe(0)
  })

  it('eight claimers of one message: one gets it', async () => {
    await createAgentMessage('agent-a', 'agent-y', 'only one')
    const out = await Promise.all(Array.from({ length: 8 }, () => claimPendingForAgent('agent-y', 5)))
    expect(out.flat()).toHaveLength(1)
  })
})

describe('closeMessagesWithoutDelivery: one transaction', () => {
  it('a failing update leaves every row of the batch pending', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push((await createAgentMessage('agent-a', 'agent-z', `c${i}`)).id)
    db.exec(`CREATE TRIGGER w36_fail_close BEFORE UPDATE ON agent_messages WHEN NEW.id = ${ids[2]} BEGIN SELECT RAISE(ABORT, 'close refused'); END`)
    try {
      await expect(closeMessagesWithoutDelivery(ids, 'stale')).rejects.toThrow('close refused')
    } finally { db.exec('DROP TRIGGER w36_fail_close') }
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'").get() as { n: number }).n).toBe(3)
  })

  it('closes the batch, counts only rows that were pending, and runs on the tx handle', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push((await createAgentMessage('agent-a', 'agent-z', `c${i}`)).id)
    db.prepare("UPDATE agent_messages SET status = 'done' WHERE id = ?").run(ids[0])
    const seen = spyFacade()
    expect(await closeMessagesWithoutDelivery(ids, 'stale')).toBe(2)
    expect(seen.filter((s) => /agent_messages/.test(s))).toEqual([])
    expect((db.prepare('SELECT result FROM agent_messages WHERE id = ?').get(ids[1]) as { result: string }).result).toBe('closed-without-delivery: stale')
  })
})

describe('getAgentConversationThreads: tenant scope', () => {
  it('a tenant sees only its own peers and counts only its own messages', async () => {
    createTenant('acme', 'Acme')
    await createAgentMessage('peer-1', 'marveen', 'default one')
    await createAgentMessage('peer-2', 'marveen', 'acme one', null, null, 'acme')
    await createAgentMessage('marveen', 'peer-2', 'acme two', null, null, 'acme')
    await createAgentMessage('peer-2', 'marveen', 'default again')
    const acme = await getAgentConversationThreads('acme')
    expect(acme.map((t) => t.agent)).toEqual(expect.arrayContaining(['peer-2']))
    expect(acme.map((t) => t.agent)).not.toContain('peer-1')
    expect(acme.find((t) => t.agent === 'peer-2')?.count).toBe(2)
    expect(acme.find((t) => t.agent === 'peer-2')?.lastMessage?.tenant_id).toBe('acme')
    const all = await getAgentConversationThreads()
    expect(all.find((t) => t.agent === 'peer-2')?.count).toBe(3)
  })
})

describe('setTenantAgentAvailability: availability and context in one step', () => {
  const context = (): number => (db.prepare("SELECT COUNT(*) AS n FROM agent_tenant_context WHERE agent_id = 'agent-t' AND tenant_id = 'acme'").get() as { n: number }).n

  it('disabling the agent deletes its context for that tenant', async () => {
    createTenant('acme', 'Acme')
    await setTenantAgentAvailability('acme', 'agent-t', true)
    db.prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('agent-t', 'acme', 'bound')").run()
    const row = await setTenantAgentAvailability('acme', 'agent-t', false)
    expect(row.enabled).toBe(0)
    expect(context()).toBe(0)
  })

  it('a failing context delete keeps the agent enabled', async () => {
    createTenant('acme', 'Acme')
    await setTenantAgentAvailability('acme', 'agent-t', true)
    db.prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('agent-t', 'acme', 'bound')").run()
    db.exec("CREATE TRIGGER w36_fail_ctx BEFORE DELETE ON agent_tenant_context BEGIN SELECT RAISE(ABORT, 'context refused'); END")
    try {
      await expect(setTenantAgentAvailability('acme', 'agent-t', false)).rejects.toThrow('context refused')
    } finally { db.exec('DROP TRIGGER w36_fail_ctx') }
    const row = db.prepare("SELECT enabled FROM tenant_agent_availability WHERE tenant_id = 'acme' AND agent_id = 'agent-t'").get() as { enabled: number }
    expect(row.enabled).toBe(1)
    expect(context()).toBe(1)
  })

  it('runs on the tx handle', async () => {
    createTenant('acme', 'Acme')
    const seen = spyFacade()
    await setTenantAgentAvailability('acme', 'agent-t', false)
    expect(seen.filter((s) => /tenant_agent_availability|agent_tenant_context/.test(s))).toEqual([])
  })
})

describe('resolveAgentOwningTenantIdSync: the boot twin agrees with the asynchronous resolver', () => {
  it('main agent of a tenant, agent enabled for a tenant, enabled for two, disabled, unknown', async () => {
    createTenant('acme', 'Acme')
    createTenant('beta', 'Beta')
    db.prepare("UPDATE tenants SET main_agent_id = 'coordinator' WHERE id = 'beta'").run()
    await setTenantAgentAvailability('acme', 'worker', true)
    await setTenantAgentAvailability('acme', 'shared', true)
    await setTenantAgentAvailability('beta', 'shared', true)
    await setTenantAgentAvailability('acme', 'off', false)
    // a main agent that is also enabled elsewhere resolves to the tenant it coordinates
    await setTenantAgentAvailability('acme', 'coordinator', true)
    for (const agent of ['coordinator', 'worker', 'shared', 'off', 'nobody']) {
      expect(resolveAgentOwningTenantIdSync(agent), agent).toBe(await resolveAgentOwningTenantId(agent))
    }
    expect(resolveAgentOwningTenantIdSync('coordinator')).toBe('beta')
    expect(resolveAgentOwningTenantIdSync('worker')).toBe('acme')
    expect(resolveAgentOwningTenantIdSync('off')).toBe('default')
  })
})

describe('the boot import of the agent settings uses the twin', () => {
  it('db/index.ts stamps the imported rows with the synchronous resolver, never the asynchronous one', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'db', 'index.ts'), 'utf-8')
    expect(text).toMatch(/importAgentSettingsFromFile\(key, raw as Record<string, unknown>, resolveAgentOwningTenantIdSync\)/)
    expect(text).not.toMatch(/\bresolveAgentOwningTenantId\b(?!Sync)/)
  })
})
