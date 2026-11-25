// The seven ingest functions of the channel coordinator (src/channel-coordinator/ingest.ts) on BOTH backends: the same file runs
// on SQLite in the default suite and on PostgreSQL in the module run (and as the application role in the app-role run). The
// functions are called BARE, the way the coordinator process calls them: no db context of the test, each one opens its own
// system job. What the cells pin: the dedupe, the delivered/failed marks, which events the replay returns, the offset round
// trip, and the tenant the handoff row is written with.
//
// The sender rule is pinned as it is TODAY: the coordinator has no sender filter (mapUpdate passes every update, nothing reads
// an allowlist), so an update from any chat is ingested and handed off under the default tenant. The cell named CURRENT
// BEHAVIOUR below is the one the filter PR flips on purpose; it is not a statement that the behaviour is wanted.
//
// Privacy: neutral fixtures only (no real chat id, user name or agent name).
import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { useAccessFile } from './helpers/coordinator-access.js'
import {
  COORDINATOR_AGENT_ID,
  HANDOFF_TENANT,
  createHandoffMessage,
  getEventsNeedingHandoff,
  getOffset,
  insertIncomingEvent,
  markEventDelivered,
  markEventFailed,
  setOffset,
} from '../channel-coordinator/ingest.js'
import { buildHandoffContent, processBatch, reconcilePending } from '../channel-coordinator-main.js'
import { UNBOUND_SOURCE_TENANT } from '../db/tenant-channel-bindings.js'
import { MAIN_AGENT_ID } from '../config.js'

const { dbx } = useTestDb()
useAccessFile()

const event = (update_id: number, chat_id = 1001) => ({
  update_id,
  kind: 'message',
  chat_id,
  user_id: chat_id,
  username: 'user-a',
  message_id: update_id,
  content: `msg ${update_id}`,
  meta: { k: 'v' },
  tg_date: 1700000000,
})

const rawUpdate = (update_id: number, chatId: number, text: string) => ({
  update_id,
  message: { message_id: update_id, date: 1700000000, text, chat: { id: chatId }, from: { id: chatId, username: 'user-a' } },
})

const count = async (sql: string, ...params: unknown[]): Promise<number> =>
  Number((await dbx.get<{ n: number }>(sql, ...params))?.n)

describe('insertIncomingEvent', () => {
  it('the same (source, update_id) twice is ONE row, the second call reports a duplicate', async () => {
    const first = await insertIncomingEvent('telegram', event(100))
    const second = await insertIncomingEvent('telegram', event(100))
    expect(first.inserted).toBe(true)
    expect(typeof first.eventId).toBe('number')
    expect(second).toEqual({ inserted: false, eventId: null })
    expect(await count("SELECT COUNT(*) AS n FROM incoming_events WHERE update_id = 100")).toBe(1)
  })

  it('the dedupe key is (source, update_id): the same update id from another source is a new row', async () => {
    await insertIncomingEvent('telegram', event(101))
    const other = await insertIncomingEvent('other-source', event(101))
    expect(other.inserted).toBe(true)
    expect(await count('SELECT COUNT(*) AS n FROM incoming_events WHERE update_id = 101')).toBe(2)
  })

  it('stores the fields as given: meta as JSON text, the row starts pending, a null chat id stays null', async () => {
    const ins = await insertIncomingEvent('telegram', { ...event(102), chat_id: null, user_id: null, username: null, tg_date: null })
    const row = await dbx.get<Record<string, unknown>>('SELECT * FROM incoming_events WHERE id = ?', ins.eventId)
    expect(row).toMatchObject({ source: 'telegram', update_id: 102, chat_id: null, user_id: null, username: null, status: 'pending', agent_message_id: null })
    expect(JSON.parse(String(row?.['meta']))).toEqual({ k: 'v' })
    expect(typeof row?.['created_at']).toBe('number')
  })

  it('a large Telegram id (above 32 bit) round-trips as a number', async () => {
    const big = 5_000_000_000
    const ins = await insertIncomingEvent('telegram', event(103, big))
    const row = await dbx.get<{ chat_id: unknown; user_id: unknown }>('SELECT chat_id, user_id FROM incoming_events WHERE id = ?', ins.eventId)
    expect(row?.chat_id).toBe(big)
    expect(row?.user_id).toBe(big)
  })
})

describe('createHandoffMessage', () => {
  it('writes a pending row from the coordinator to the main agent with the owner (default) tenant as an explicit value', async () => {
    const id = await createHandoffMessage('body')
    const row = await dbx.get<Record<string, unknown>>('SELECT * FROM agent_messages WHERE id = ?', id)
    expect(row).toMatchObject({
      from_agent: COORDINATOR_AGENT_ID, to_agent: MAIN_AGENT_ID, content: 'body', status: 'pending', tenant_id: HANDOFF_TENANT,
    })
  })

  it('the tenant is the named default-tenant constant: one definition, the owner is the default tenant', () => {
    expect(HANDOFF_TENANT).toBe(UNBOUND_SOURCE_TENANT)
    expect(HANDOFF_TENANT).toBe('default')
  })
})

describe('markEventDelivered / markEventFailed', () => {
  it('delivered links the agent message and stamps the time', async () => {
    const ins = await insertIncomingEvent('telegram', event(200))
    const am = await createHandoffMessage(buildHandoffContent(event(200)))
    await markEventDelivered(ins.eventId!, am)
    const row = await dbx.get<Record<string, unknown>>('SELECT * FROM incoming_events WHERE id = ?', ins.eventId)
    expect(row).toMatchObject({ status: 'delivered', agent_message_id: am, error: null })
    expect(typeof row?.['delivered_at']).toBe('number')
  })

  it('failed records the error text and leaves the link empty', async () => {
    const ins = await insertIncomingEvent('telegram', event(201))
    await markEventFailed(ins.eventId!, 'boom')
    expect(await dbx.get('SELECT status, error, agent_message_id FROM incoming_events WHERE id = ?', ins.eventId))
      .toEqual({ status: 'failed', error: 'boom', agent_message_id: null })
  })

  it('a mark of an event that does not exist changes nothing and does not throw', async () => {
    await expect(markEventDelivered(987654, 1)).resolves.toBeUndefined()
    await expect(markEventFailed(987654, 'x')).resolves.toBeUndefined()
    expect(await count('SELECT COUNT(*) AS n FROM incoming_events')).toBe(0)
  })
})

describe('getEventsNeedingHandoff', () => {
  const setAmStatus = (id: number, status: string) => dbx.run('UPDATE agent_messages SET status = ? WHERE id = ?', status, id)

  it('returns an event that was inserted but never handed off', async () => {
    const ins = await insertIncomingEvent('telegram', event(300))
    expect((await getEventsNeedingHandoff('telegram')).map((e) => e.id)).toEqual([ins.eventId])
  })

  it('does NOT return an event whose handoff is still in flight (pending / delivered / done)', async () => {
    for (const [i, status] of ['pending', 'delivered', 'done'].entries()) {
      const ins = await insertIncomingEvent('telegram', event(310 + i))
      const am = await createHandoffMessage('x')
      await markEventDelivered(ins.eventId!, am)
      await setAmStatus(am, status)
    }
    expect(await getEventsNeedingHandoff('telegram')).toEqual([])
  })

  it('returns an event whose handoff the router abandoned (agent message failed), oldest first', async () => {
    const a = await insertIncomingEvent('telegram', event(320))
    const b = await insertIncomingEvent('telegram', event(321))
    for (const ins of [a, b]) {
      const am = await createHandoffMessage('x')
      await markEventDelivered(ins.eventId!, am)
      await setAmStatus(am, 'failed')
    }
    expect((await getEventsNeedingHandoff('telegram')).map((e) => e.id)).toEqual([a.eventId, b.eventId])
  })

  it('does NOT return a failed event, an event of another source, and respects the limit', async () => {
    const failed = await insertIncomingEvent('telegram', event(330))
    await markEventFailed(failed.eventId!, 'x')
    await insertIncomingEvent('other-source', event(331))
    for (let i = 0; i < 5; i++) await insertIncomingEvent('telegram', event(340 + i))
    expect(await getEventsNeedingHandoff('telegram', 3)).toHaveLength(3)
    expect((await getEventsNeedingHandoff('telegram')).every((e) => e.source === 'telegram' && e.status !== 'failed')).toBe(true)
  })

  it('an event whose agent message row is gone is returned (a dangling link is a stranded message)', async () => {
    const ins = await insertIncomingEvent('telegram', event(350))
    await markEventDelivered(ins.eventId!, 999999)
    expect((await getEventsNeedingHandoff('telegram')).map((e) => e.id)).toEqual([ins.eventId])
  })
})

describe('getOffset / setOffset', () => {
  it('a fresh source is 0, a set value is read back, a later set advances it (one row per source)', async () => {
    expect(await getOffset('telegram')).toBe(0)
    await setOffset('telegram', 500)
    expect(await getOffset('telegram')).toBe(500)
    await setOffset('telegram', 512)
    expect(await getOffset('telegram')).toBe(512)
    await setOffset('other-source', 7)
    expect(await getOffset('telegram')).toBe(512)
    expect(await count('SELECT COUNT(*) AS n FROM poll_offset')).toBe(2)
  })

  it('an offset above 32 bit round-trips as a number', async () => {
    await setOffset('telegram', 6_000_000_000)
    expect(await getOffset('telegram')).toBe(6_000_000_000)
  })
})

describe('the coordinator body on the facade (processBatch / reconcilePending)', () => {
  it('a batch is ingested, handed off with the default tenant, and the highest update id comes back', async () => {
    const max = await processBatch([rawUpdate(410, 1001, 'a'), { update_id: 405 }, rawUpdate(408, 1001, 'b')])
    expect(max).toBe(410)
    expect(await count("SELECT COUNT(*) AS n FROM incoming_events WHERE status = 'delivered'")).toBe(2)
    expect(await count(`SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = ? AND tenant_id = ?`, COORDINATOR_AGENT_ID, 'default')).toBe(2)
  })

  it('the same update twice is handed off once', async () => {
    await processBatch([rawUpdate(420, 1001, 'first')])
    await processBatch([rawUpdate(420, 1001, 'first')])
    expect(await count('SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = ?', COORDINATOR_AGENT_ID)).toBe(1)
  })

  it('SENDER GATE (flipped from the port\'s CURRENT BEHAVIOUR cell): an update from a chat OUTSIDE the access list is dropped, the owner chat is ingested under the default tenant', async () => {
    const max = await processBatch([rawUpdate(430, 1001, 'from the owner chat'), rawUpdate(431, 2002, 'from a stranger chat')])
    expect(max).toBe(431) // the offset still moves past the dropped update
    const rows = await dbx.all<{ chat_id: number; status: string }>('SELECT chat_id, status FROM incoming_events ORDER BY update_id')
    expect(rows).toEqual([{ chat_id: 1001, status: 'delivered' }])
    expect(await count('SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = ? AND tenant_id = ?', COORDINATOR_AGENT_ID, 'default')).toBe(1)
  })

  it('the replay re-queues a stranded event as a NEW handoff row with the default tenant, once', async () => {
    const ins = await insertIncomingEvent('telegram', event(440))
    await reconcilePending()
    await reconcilePending() // the second pass: the new handoff is in flight, nothing more
    const row = await dbx.get<{ status: string; agent_message_id: number }>('SELECT status, agent_message_id FROM incoming_events WHERE id = ?', ins.eventId)
    expect(row?.status).toBe('delivered')
    expect(await count('SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = ? AND tenant_id = ?', COORDINATOR_AGENT_ID, 'default')).toBe(1)
  })

  it('a malformed stored meta text does not stop the replay (it falls back to an empty meta)', async () => {
    await dbx.run(
      "INSERT INTO incoming_events (source, update_id, chat_id, user_id, kind, content, meta, created_at) VALUES ('telegram', 450, 1001, 1001, 'message', 'x', 'not-json{{', ?)",
      Math.floor(Date.now() / 1000),
    )
    await expect(reconcilePending()).resolves.toBeUndefined()
    expect((await dbx.get<{ status: string }>('SELECT status FROM incoming_events WHERE update_id = 450'))?.status).toBe('delivered')
  })
})
