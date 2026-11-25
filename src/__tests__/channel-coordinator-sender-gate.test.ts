// The sender gate of the channel coordinator (channel-coordinator/sender-gate.ts): default-deny on the access list of the native
// Telegram plugin. Runs on SQLite and, as a useTestDb file on the ported list, on PostgreSQL (also as the app role).
//
// What is pinned: a chat outside the list writes NOTHING and hands NOTHING off, whatever the update kind; the owner chat passes;
// an unreadable, missing or malformed list lets nothing through (one log line per failure, not per batch); a change of the list
// applies without a restart; the stored events of a sender that is no longer allowed are closed, an unreadable list leaves them
// pending; the gate never writes the access file and never answers a sender (no pairing).
//
// Privacy: neutral fixtures only (no real chat id, user name or agent name).
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { useTestDb } from './helpers/with-test-db.js'
import { useAccessFile } from './helpers/coordinator-access.js'
import { insertIncomingEvent, markEventDelivered, createHandoffMessage } from '../channel-coordinator/ingest.js'
import { processBatch, reconcilePending } from '../channel-coordinator-main.js'
import { isSenderAllowed, loadSenderAccess, type SenderAccess } from '../channel-coordinator/sender-gate.js'
import { logger } from '../logger.js'

const { dbx } = useTestDb()
const access = useAccessFile()

/** A raw update of any kind: the body only reads update_id typed, the rest is what Telegram sends. */
const upd = (u: { update_id: number } & Record<string, unknown>): { update_id: number } => u
const message = (update_id: number, chatId: number, userId: number = chatId, text = 'hi') => ({
  update_id, message: { message_id: update_id, date: 1, text, chat: { id: chatId }, from: { id: userId, username: 'user-a' } },
})
const count = async (sql: string, ...p: unknown[]): Promise<number> => Number((await dbx.get<{ n: number }>(sql, ...p))?.n)
const events = (): Promise<number> => count('SELECT COUNT(*) AS n FROM incoming_events')
const handoffs = (): Promise<number> => count("SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = 'telegram-coordinator'")

describe('a sender outside the list is dropped silently', () => {
  it('a DM from a stranger writes no event and no handoff, and the offset still moves past it', async () => {
    expect(await processBatch([message(1, 2002)])).toBe(1)
    expect(await events()).toBe(0)
    expect(await handoffs()).toBe(0)
  })

  it('the owner chat passes in the same batch as a stranger', async () => {
    await processBatch([message(1, 2002), message(2, 1001), message(3, 3003)])
    expect(await dbx.all('SELECT update_id FROM incoming_events')).toEqual([{ update_id: 2 }])
    expect(await handoffs()).toBe(1)
  })

  it('every update kind is gated: an edited message, a channel post (no sender) and a callback query of a stranger', async () => {
    await processBatch([
      upd({ update_id: 1, edited_message: { message_id: 1, date: 1, text: 'x', chat: { id: 2002 }, from: { id: 2002 } } }),
      upd({ update_id: 2, channel_post: { message_id: 2, date: 1, text: 'x', chat: { id: -500 } } }),
      upd({ update_id: 3, callback_query: { id: 'cb', from: { id: 2002 }, data: 'd', message: { message_id: 3, date: 1, chat: { id: 2002 } } } }),
    ])
    expect(await events()).toBe(0)
    expect(await handoffs()).toBe(0)
  })

  it('a callback query of the owner passes', async () => {
    await processBatch([upd({ update_id: 4, callback_query: { id: 'cb', from: { id: 1001 }, data: 'd', message: { message_id: 4, date: 1, chat: { id: 1001 } } } })])
    expect(await events()).toBe(1)
  })

  it('an owner id as the SENDER in someone else\'s DM does not pass (the chat is a stranger\'s)', async () => {
    // a DM has chat id == user id; a positive chat id whose sender is the owner id still only passes when the SENDER is listed,
    // and here the sender is a stranger writing into the owner chat id (not possible on Telegram, the gate still reads the sender)
    await processBatch([message(1, 1001, 2002)])
    expect(await events()).toBe(0)
  })

  it('the count is logged without any id or text of the dropped sender', async () => {
    const warn = vi.spyOn(logger, 'warn')
    try {
      await processBatch([message(1, 2002, 2002, 'secret text'), message(2, 3003, 3003)])
      const call = warn.mock.calls.find((c) => String(c[1] ?? '').includes('outside the access list'))
      expect(call?.[0]).toEqual({ dropped: 2 })
    } finally { warn.mockRestore() }
  })
})

describe('the list is the plugin access file, read on every batch', () => {
  it('a change of allowFrom applies to the next batch without a restart', async () => {
    await processBatch([message(1, 2002)])
    expect(await events()).toBe(0)
    access.write({ dmPolicy: 'allowlist', allowFrom: ['1001', '2002'] })
    await processBatch([message(2, 2002)])
    expect(await events()).toBe(1)
    access.write({ dmPolicy: 'allowlist', allowFrom: ['1001'] })
    await processBatch([message(3, 2002)])
    expect(await events()).toBe(1)
  })

  it('numeric ids in the list work as strings do', async () => {
    access.write({ dmPolicy: 'allowlist', allowFrom: [2002] })
    await processBatch([message(1, 2002)])
    expect(await events()).toBe(1)
  })

  it('dmPolicy disabled lets nothing through, the owner included', async () => {
    access.write({ dmPolicy: 'disabled', allowFrom: ['1001'] })
    await processBatch([message(1, 1001)])
    expect(await events()).toBe(0)
  })

  it('pairing mode behaves as allowlist: a stranger is dropped and nothing is sent or written', async () => {
    access.write({ dmPolicy: 'pairing', allowFrom: ['1001'], pending: {} })
    const before = readFileSync(access.path, 'utf8')
    const mtime = statSync(access.path).mtimeMs
    await processBatch([message(1, 2002)])
    expect(await events()).toBe(0)
    expect(readFileSync(access.path, 'utf8')).toBe(before) // no pending entry, no pairing code
    expect(statSync(access.path).mtimeMs).toBe(mtime)
  })
})

describe('FAIL CLOSED: a list that cannot be trusted lets nothing through', () => {
  const cases: [string, object | string | null][] = [
    ['a missing file', null],
    ['an empty file', ''],
    ['invalid JSON', '{not json'],
    ['a JSON list instead of an object', '[]'],
    ['allowFrom that is not a list', { allowFrom: '1001' }],
    ['allowFrom with a non-id entry', { allowFrom: ['1001', { id: 1 }] }],
    ['groups that is not an object', { allowFrom: ['1001'], groups: [] }],
    ['an allowFrom key that is absent (nobody is listed)', { dmPolicy: 'allowlist' }],
  ]
  for (const [name, content] of cases) {
    it(`${name}: the owner chat is dropped too`, async () => {
      access.write(content)
      await processBatch([message(1, 1001)])
      expect(await events()).toBe(0)
      expect(await handoffs()).toBe(0)
    })
  }

  it('one log line per distinct failure, not one per batch, and one line when the list is good again', async () => {
    const error = vi.spyOn(logger, 'error')
    const info = vi.spyOn(logger, 'info')
    try {
      access.write('{not json')
      await processBatch([message(1, 1001)])
      await processBatch([message(2, 1001)])
      await processBatch([message(3, 1001)])
      expect(error.mock.calls.filter((c) => String(c[1] ?? '').includes('sender gate'))).toHaveLength(1)
      access.write({ dmPolicy: 'allowlist', allowFrom: ['1001'] })
      await processBatch([message(4, 1001)])
      expect(info.mock.calls.filter((c) => String(c[0] ?? '').includes('sender gate reads the access list again'))).toHaveLength(1)
      expect(await events()).toBe(1)
    } finally { error.mockRestore(); info.mockRestore() }
  })

  it('the log line carries no value from the file', async () => {
    const error = vi.spyOn(logger, 'error')
    try {
      access.write('{"allowFrom": "secret-looking-value-77"')
      await processBatch([message(1, 1001)])
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-looking-value-77')
    } finally { error.mockRestore() }
  })
})

describe('groups', () => {
  const groupMsg = (id: number, chatId: number, userId: number) => ({
    update_id: id, message: { message_id: id, date: 1, text: 'g', chat: { id: chatId }, from: { id: userId } },
  })

  it('a group that is not configured is dropped', async () => {
    await processBatch([groupMsg(1, -500, 1001)])
    expect(await events()).toBe(0)
  })

  it('a configured group with an empty own list passes, one with a list passes only its members', async () => {
    access.write({ dmPolicy: 'allowlist', allowFrom: ['1001'], groups: { '-500': {}, '-600': { allowFrom: ['2002'] } } })
    await processBatch([groupMsg(1, -500, 3003), groupMsg(2, -600, 3003), groupMsg(3, -600, 2002)])
    expect(await dbx.all('SELECT update_id FROM incoming_events ORDER BY update_id')).toEqual([{ update_id: 1 }, { update_id: 3 }])
  })

  it('being in the DM list does not open a group that is not configured', async () => {
    await processBatch([groupMsg(1, -700, 1001)])
    expect(await events()).toBe(0)
  })
})

describe('the stored events of the replay pass the same gate', () => {
  const stored = (update_id: number, chat: number | null, user: number | null) =>
    dbx.run("INSERT INTO incoming_events (source, update_id, chat_id, user_id, kind, content, meta, created_at) VALUES ('telegram', ?, ?, ?, 'message', 'x', '{}', 1)", update_id, chat, user)

  it('an event of a sender who is not listed is closed (failed), not handed off; a listed one is handed off', async () => {
    await stored(1, 2002, 2002)
    await stored(2, 1001, 1001)
    await reconcilePending()
    expect(await dbx.all('SELECT update_id, status FROM incoming_events ORDER BY update_id'))
      .toEqual([{ update_id: 1, status: 'failed' }, { update_id: 2, status: 'delivered' }])
    expect(await handoffs()).toBe(1)
    expect((await dbx.get<{ error: string }>('SELECT error FROM incoming_events WHERE update_id = 1'))?.error).toBe('sender not allowed')
  })

  it('an event with no sender (null user or chat) is closed', async () => {
    await stored(1, null, null)
    await reconcilePending()
    expect((await dbx.get<{ status: string }>('SELECT status FROM incoming_events'))?.status).toBe('failed')
  })

  it('an UNREADABLE list leaves the stored events pending: nothing handed off, nothing closed', async () => {
    await stored(1, 1001, 1001)
    await stored(2, 2002, 2002)
    access.write('{not json')
    await reconcilePending()
    expect(await dbx.all('SELECT status FROM incoming_events')).toEqual([{ status: 'pending' }, { status: 'pending' }])
    expect(await handoffs()).toBe(0)
    access.write({ dmPolicy: 'allowlist', allowFrom: ['1001'] })
    await reconcilePending()
    expect(await dbx.all('SELECT update_id, status FROM incoming_events ORDER BY update_id'))
      .toEqual([{ update_id: 1, status: 'delivered' }, { update_id: 2, status: 'failed' }])
  })

  it('an event that is already handed off is not touched by a list that no longer has its sender', async () => {
    const ins = await insertIncomingEvent('telegram', { update_id: 9, kind: 'message', chat_id: 2002, user_id: 2002, username: null, message_id: 9, content: 'x', meta: {}, tg_date: 1 })
    await markEventDelivered(ins.eventId!, await createHandoffMessage('x'))
    await reconcilePending()
    expect((await dbx.get<{ status: string }>('SELECT status FROM incoming_events'))?.status).toBe('delivered')
  })
})

describe('isSenderAllowed (the pure rule)', () => {
  const acc = (over: Partial<SenderAccess> = {}): SenderAccess => ({ dmPolicy: 'allowlist', allowFrom: ['1001'], groups: {}, ...over })
  it('null access, a missing id or a zero chat is a drop', () => {
    expect(isSenderAllowed(null, { chat_id: 1001, user_id: 1001 })).toBe(false)
    expect(isSenderAllowed(acc(), { chat_id: null, user_id: 1001 })).toBe(false)
    expect(isSenderAllowed(acc(), { chat_id: 1001, user_id: null })).toBe(false)
    expect(isSenderAllowed(acc(), { chat_id: 0, user_id: 1001 })).toBe(false)
  })
  it('compares ids as strings, exactly (no prefix or substring match)', () => {
    expect(isSenderAllowed(acc(), { chat_id: 1001, user_id: 1001 })).toBe(true)
    expect(isSenderAllowed(acc(), { chat_id: 100, user_id: 100 })).toBe(false)
    expect(isSenderAllowed(acc(), { chat_id: 10011, user_id: 10011 })).toBe(false)
  })
  it('loadSenderAccess of a path that does not exist is null', () => {
    expect(loadSenderAccess('/nonexistent-dir-for-coordinator-gate/access.json')).toBeNull()
  })
})
