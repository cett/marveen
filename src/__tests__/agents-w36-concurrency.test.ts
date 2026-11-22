// The agents module on the async facade: the writes whose old synchronous form could not be interleaved.
// Overlapped calls end in exactly one winner, the statements of a transaction body run on the tx handle, a failed
// statement rolls the whole step back, and the boot twin of the tenant resolver agrees with the asynchronous one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  dbx, createTenant, createAgentMessage, claimPendingForAgent, closeMessagesWithoutDelivery,
  getAgentConversationThreads, upsertBlackboard, markBlackboardStale, findBlackboardRowByAgent,
  listBlackboardHistory, setTenantAgentAvailability, resolveAgentOwningTenantId, resolveAgentOwningTenantIdSync,
} from '../db.js'
import { dbxDialect } from '../db/facade.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

useTestDb()

beforeEach(async () => {
  for (const table of ['fleet_blackboard_history', 'fleet_blackboard', 'agent_messages', 'agent_tenant_context', 'tenant_agent_availability']) {
    await dbx.run(`DELETE FROM ${table}`)
  }
})
afterEach(() => { vi.restoreAllMocks() })

// A failure injection is dropped by its own name: PostgreSQL names the table too.
const dropRefuse = (name: string, table: string): Promise<unknown> =>
  dbx.run(dbxDialect() === 'pg' ? `DROP TRIGGER ${name} ON ${table}` : `DROP TRIGGER ${name}`)

function spyFacade(): string[] {
  const seen: string[] = []
  for (const m of ['get', 'run', 'all'] as const) {
    const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => { seen.push(sql.trim().slice(0, 60)); return real(sql, ...a) }) as never)
  }
  return seen
}

const rowCount = async (agent: string): Promise<number> =>
  (await dbx.get<{ n: number }>('SELECT COUNT(*) AS n FROM fleet_blackboard WHERE agent_id = ?', agent))?.n ?? 0

describe('upsertBlackboard: overlapped posts of one agent', () => {
  // Order-free invariants, so the cell holds whatever order the commits take: one row; every call returns its own summary;
  // the history holds each post once; the row shows the summary of the newest history entry (the write and the history
  // entry commit together, under the row lock). The winner is not named: the later commit is not fixed on PostgreSQL.
  it('two first posts end in one row; each call returns its own summary; the row shows the newest history entry', async () => {
    const [a, b] = await Promise.all([
      upsertBlackboard('agent-a', { status: 'active', summary: 'first' }),
      upsertBlackboard('agent-a', { status: 'active', summary: 'second' }),
    ])
    expect(a.summary).toBe('first')
    expect(b.summary).toBe('second')
    expect(b.id).toBe(a.id)
    expect(await rowCount('agent-a')).toBe(1)
    expect((await listBlackboardHistory({ agent_id: 'agent-a' })).map((h) => h.summary).sort()).toEqual(['first', 'second'])
    const newest = await dbx.get<{ summary: string }>('SELECT summary FROM fleet_blackboard_history WHERE agent_id = ? ORDER BY id DESC LIMIT 1', 'agent-a')
    expect((await findBlackboardRowByAgent('agent-a'))?.summary).toBe(newest?.summary)
  })

  it('eight overlapped first posts leave one row; each call returns its own post; one history entry per post; the row shows the newest one', async () => {
    const posts = Array.from({ length: 8 }, (_, i) => `post-${i}`)
    const out = await Promise.all(posts.map((summary) => upsertBlackboard('agent-b', { status: 'active', summary })))
    expect(new Set(out.map((r) => r.id)).size).toBe(1)
    expect(out.map((r) => r.summary).sort()).toEqual([...posts].sort())
    expect(await rowCount('agent-b')).toBe(1)
    expect((await listBlackboardHistory({ agent_id: 'agent-b' })).map((h) => h.summary).sort()).toEqual([...posts].sort())
    const newest = await dbx.get<{ summary: string }>('SELECT summary FROM fleet_blackboard_history WHERE agent_id = ? ORDER BY id DESC LIMIT 1', 'agent-b')
    expect((await findBlackboardRowByAgent('agent-b'))?.summary).toBe(newest?.summary)
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
    await refuseWrite(dbx, { name: 'w36_fail_history', table: 'fleet_blackboard_history', message: 'history refused', when: { column: 'summary', equals: 'boom' } })
    try {
      await expect(upsertBlackboard('agent-e', { status: 'active', summary: 'boom' })).rejects.toThrow('history refused')
    } finally { await dropRefuse('w36_fail_history', 'fleet_blackboard_history') }
    expect((await findBlackboardRowByAgent('agent-e'))?.summary).toBe('before')
  })
})

describe('markBlackboardStale: compare-and-set on the row it read', () => {
  const OLD = 1_000
  const age = async (agent: string): Promise<void> => { await dbx.run('UPDATE fleet_blackboard SET updated_at = ? WHERE agent_id = ?', OLD, agent) }

  it('marks an old active row stale and records it', async () => {
    await upsertBlackboard('agent-s', { status: 'active', summary: 'old task' })
    await age('agent-s')
    expect(await markBlackboardStale({}, 60, 60, 5_000)).toBe(1)
    expect((await findBlackboardRowByAgent('agent-s'))?.status).toBe('stale')
    expect((await listBlackboardHistory({ agent_id: 'agent-s' })).map((h) => h.status)).toContain('stale')
  })

  it('a post the agent makes between the sweep read and its update is kept', async () => {
    await upsertBlackboard('agent-s', { status: 'active', summary: 'old task' })
    await age('agent-s')
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
    await age('agent-s')
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
    await dbx.run('UPDATE fleet_blackboard SET updated_at = 1000 WHERE agent_id = ?', 'agent-s')
    const real = dbx.all.bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, 'all').mockImplementation((async (sql: string, ...a: unknown[]) => {
      const rows = await real(sql, ...a)
      if (/FROM fleet_blackboard WHERE status IN/.test(sql)) {
        vi.mocked(dbx.all).mockRestore()
        // a writer in the same second as the row's last write: the timestamp is unchanged, the status is not
        await dbx.run("UPDATE fleet_blackboard SET status = 'done' WHERE agent_id = ?", 'agent-s')
      }
      return rows
    }) as never)
    expect(await markBlackboardStale({}, 60, 60)).toBe(0)
    expect((await findBlackboardRowByAgent('agent-s'))?.status).toBe('done')
  })
})

describe('claimPendingForAgent: two claimers', () => {
  // Order- and overlap-independent. Two overlapping claims of limit 4 may split the six messages 4 + 2, or give 4 + 0 when the
  // second one waits on the first one's rows and finds them delivered (a claim returns fewer rows than its limit; the rest
  // stay pending for the next tick). Whatever the split: no id twice, no claim above its limit, the pair takes at least four,
  // and a third, serial claim takes the rest: together exactly the six messages, none pending.
  it('six messages across two overlapped claimers and a third claim: each delivered once, none pending', async () => {
    for (let i = 0; i < 6; i++) await createAgentMessage('agent-a', 'agent-x', `m${i}`)
    const [one, two] = await Promise.all([claimPendingForAgent('agent-x', 4), claimPendingForAgent('agent-x', 4)])
    const overlapped = [...one, ...two].map((m) => m.id)
    expect(new Set(overlapped).size).toBe(overlapped.length)
    expect(one.length).toBeLessThanOrEqual(4)
    expect(two.length).toBeLessThanOrEqual(4)
    expect(overlapped.length).toBeGreaterThanOrEqual(4)
    const rest = (await claimPendingForAgent('agent-x', 4)).map((m) => m.id)
    const all = [...overlapped, ...rest]
    expect(new Set(all).size).toBe(6)
    expect(all).toHaveLength(6)
    expect((await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'"))?.n).toBe(0)
  })

  it('eight claimers of one message: one gets it', async () => {
    await createAgentMessage('agent-a', 'agent-y', 'only one')
    const out = await Promise.all(Array.from({ length: 8 }, () => claimPendingForAgent('agent-y', 5)))
    expect(out.flat()).toHaveLength(1)
  })
})

// The race of the two-claimer cells above is a READ COMMITTED one: the second claim takes its snapshot while the first claim
// is still uncommitted, waits on the row, and must not deliver that row again once the first claim commits. The holder
// below writes the first claim's effect on the row (status delivered) and parks before its commit; the production claim
// runs on another connection and waits on the row (waitBlockedOnLock). A Promise.all of two calls would not hold the row.
describe('claimPendingForAgent: a claim that waited on the row of a claim in flight', () => {
  it.runIf(testDbMode() === 'pg')('does not deliver the message the first claim delivered (two real connections)', async () => {
    const first = await createAgentMessage('agent-a', 'agent-h', 'h1')
    const second = await createAgentMessage('agent-a', 'agent-h', 'h2')
    const il = interleave()
    il.hold('first-claim-parked')
    const holder = dbx.tx(async (tx) => {
      await tx.run("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ?", Math.floor(Date.now() / 1000), first.id)
      await il.pass('first-claim-parked')
    })
    await il.reached('first-claim-parked')
    const waiting = claimPendingForAgent('agent-h', 2)
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('first-claim-parked')
      await holder
    }
    const got = (await waiting).map((m) => m.id)
    expect(got).not.toContain(first.id)
    expect(got).toEqual([second.id])
  })

  // Weak (end state only, on both engines): a message that is already delivered is not claimed again. It does not test the race.
  it('a message delivered before the claim is not claimed again', async () => {
    const first = await createAgentMessage('agent-a', 'agent-w', 'w1')
    const second = await createAgentMessage('agent-a', 'agent-w', 'w2')
    await dbx.run("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ?", Math.floor(Date.now() / 1000), first.id)
    expect((await claimPendingForAgent('agent-w', 2)).map((m) => m.id)).toEqual([second.id])
  })
})

describe('closeMessagesWithoutDelivery: one transaction', () => {
  it('a failing update leaves every row of the batch pending', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push((await createAgentMessage('agent-a', 'agent-z', `c${i}`)).id)
    await refuseWrite(dbx, { name: 'w36_fail_close', table: 'agent_messages', message: 'close refused', event: 'UPDATE', when: { column: 'id', equals: String(ids[2]) } })
    try {
      await expect(closeMessagesWithoutDelivery(ids, 'stale')).rejects.toThrow('close refused')
    } finally { await dropRefuse('w36_fail_close', 'agent_messages') }
    expect((await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'"))?.n).toBe(3)
  })

  it('closes the batch, counts only rows that were pending, and runs on the tx handle', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push((await createAgentMessage('agent-a', 'agent-z', `c${i}`)).id)
    await dbx.run("UPDATE agent_messages SET status = 'done' WHERE id = ?", ids[0])
    const seen = spyFacade()
    expect(await closeMessagesWithoutDelivery(ids, 'stale')).toBe(2)
    expect(seen.filter((s) => /agent_messages/.test(s))).toEqual([])
    expect((await dbx.get<{ result: string }>('SELECT result FROM agent_messages WHERE id = ?', ids[1]))?.result).toBe('closed-without-delivery: stale')
  })
})

describe('getAgentConversationThreads: tenant scope', () => {
  it('a tenant sees only its own peers and counts only its own messages', async () => {
    await createTenant('acme', 'Acme')
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
  const context = async (): Promise<number> =>
    (await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tenant_context WHERE agent_id = 'agent-t' AND tenant_id = 'acme'"))?.n ?? 0

  it('disabling the agent deletes its context for that tenant', async () => {
    await createTenant('acme', 'Acme')
    await setTenantAgentAvailability('acme', 'agent-t', true)
    await dbx.run("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('agent-t', 'acme', 'bound')")
    const row = await setTenantAgentAvailability('acme', 'agent-t', false)
    expect(row.enabled).toBe(0)
    expect(await context()).toBe(0)
  })

  it('a failing context delete keeps the agent enabled', async () => {
    await createTenant('acme', 'Acme')
    await setTenantAgentAvailability('acme', 'agent-t', true)
    await dbx.run("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('agent-t', 'acme', 'bound')")
    await refuseWrite(dbx, { name: 'w36_fail_ctx', table: 'agent_tenant_context', message: 'context refused', event: 'DELETE' })
    try {
      await expect(setTenantAgentAvailability('acme', 'agent-t', false)).rejects.toThrow('context refused')
    } finally { await dropRefuse('w36_fail_ctx', 'agent_tenant_context') }
    const row = await dbx.get<{ enabled: number }>("SELECT enabled FROM tenant_agent_availability WHERE tenant_id = 'acme' AND agent_id = 'agent-t'")
    expect(row?.enabled).toBe(1)
    expect(await context()).toBe(1)
  })

  it('runs on the tx handle', async () => {
    await createTenant('acme', 'Acme')
    const seen = spyFacade()
    await setTenantAgentAvailability('acme', 'agent-t', false)
    expect(seen.filter((s) => /tenant_agent_availability|agent_tenant_context/.test(s))).toEqual([])
  })
})

describe('resolveAgentOwningTenantIdSync: the boot twin agrees with the asynchronous resolver', () => {
  // SQLite-only by design (boot-twin): the synchronous resolver reads the SQLite handle at start-up, before the async
  // facade is in use. On PostgreSQL it is never called, so there is nothing to agree with; the cell skips there by name.
  it.runIf(testDbMode() === 'sqlite')('main agent of a tenant, agent enabled for a tenant, enabled for two, disabled, unknown', async () => {
    await createTenant('acme', 'Acme')
    await createTenant('beta', 'Beta')
    await dbx.run("UPDATE tenants SET main_agent_id = 'coordinator' WHERE id = 'beta'")
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
