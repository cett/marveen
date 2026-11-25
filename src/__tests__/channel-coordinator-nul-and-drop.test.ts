// Two boundary rules of the coordinator, on SQLite and (listed in pg-modules.ts) on PostgreSQL:
//
//   1. A NUL (0x00) byte in anything a sender wrote is removed at mapUpdate, before the gate and the insert. PostgreSQL refuses a
//      NUL in a text value, so a message with one would fail its INSERT every time, a durable poison update that holds the offset
//      (and, after the give-up age, is lost). The text around the NUL is kept; the dedupe key (update_id) is not touched.
//   2. A dropped sender (outside the access list) is SETTLED: the offset moves past its update, also at the tail of a batch and
//      next to an owner update, and the gate runs before the insert, so a stranger never reaches the insert-failure path at all.
//
// Privacy: neutral fixtures only.
import { describe, it, expect, vi } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { useAccessFile } from './helpers/coordinator-access.js'
import { mapUpdate, stripNul } from '../channel-coordinator/telegram-client.js'
import { processBatch } from '../channel-coordinator-main.js'
import * as ingest from '../channel-coordinator/ingest.js'

const { dbx } = useTestDb()
useAccessFile()

const NUL = String.fromCharCode(0)
const msg = (update_id: number, chatId: number, text = 'hi', extra: Record<string, unknown> = {}) => ({
  update_id,
  message: { message_id: update_id, date: 1, text, chat: { id: chatId }, from: { id: chatId, username: 'user-a' }, ...extra },
})
const stored = () => dbx.all<{ update_id: number; content: string; username: string | null; meta: string | null }>(
  'SELECT update_id, content, username, meta FROM incoming_events ORDER BY update_id')

describe('stripNul', () => {
  it('removes every NUL of a string and keeps the rest', () => {
    expect(stripNul(`a${NUL}b${NUL}${NUL}c`)).toBe('abc')
    expect(stripNul('plain')).toBe('plain')
  })

  it('goes through arrays and objects, keys included, and leaves numbers, booleans and null alone', () => {
    expect(stripNul({ [`k${NUL}`]: [`v${NUL}`, 1, true, null, { n: `x${NUL}y` }] })).toEqual({ k: ['v', 1, true, null, { n: 'xy' }] })
  })
})

describe('mapUpdate removes NUL from every string a sender controls', () => {
  it('text, username (display name), caption and the document name of a message', () => {
    const ev = mapUpdate({
      update_id: 1,
      message: {
        message_id: 1, date: 1, text: `he${NUL}llo`, chat: { id: 1001 },
        from: { id: 1001, username: `user${NUL}-a` }, document: { file_id: `f${NUL}1`, file_name: `n${NUL}.txt` },
      },
    } as Parameters<typeof mapUpdate>[0])
    expect(ev?.content).toBe('hello')
    expect(ev?.username).toBe('user-a')
    expect(ev?.meta).toEqual({ document: { file_id: 'f1', file_name: 'n.txt' } })
  })

  it('a caption (no text) and a callback query payload', () => {
    expect(mapUpdate({ update_id: 2, message: { message_id: 2, date: 1, caption: `c${NUL}d`, chat: { id: 1001 } } } as Parameters<typeof mapUpdate>[0])?.content).toBe('cd')
    const cb = mapUpdate({ update_id: 3, callback_query: { id: `i${NUL}d`, data: `x${NUL}y`, from: { id: 1001 } } } as Parameters<typeof mapUpdate>[0])
    expect(cb?.content).toBe('xy')
    expect(cb?.meta).toEqual({ callback_query_id: 'id' })
  })

  it('an unhandled kind is still null', () => {
    expect(mapUpdate({ update_id: 4 } as Parameters<typeof mapUpdate>[0])).toBeNull()
  })

  it('numeric fields are untouched', () => {
    const ev = mapUpdate(msg(7, 1001) as Parameters<typeof mapUpdate>[0])
    expect([ev?.update_id, ev?.chat_id, ev?.user_id, ev?.message_id, ev?.tg_date]).toEqual([7, 1001, 1001, 7, 1])
  })
})

describe('a message with NUL bytes is stored (without them), not a poison update', () => {
  it('stored once, content and username clean, handed off, the offset moves to it', async () => {
    expect(await processBatch([msg(1, 1001, `be${NUL}fore${NUL}`, { from: { id: 1001, username: `u${NUL}-a` }, document: { file_id: 'f', file_name: `a${NUL}b` } })])).toBe(1)
    const rows = await stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe('before')
    expect(rows[0]?.username).toBe('u-a')
    expect(String(rows[0]?.meta)).not.toContain('\\u0000')
    expect(await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = 'telegram-coordinator'")).toEqual({ n: 1 })
  })

  it('a replay of the same update (the dedupe key) stays one row', async () => {
    await processBatch([msg(1, 1001, `a${NUL}b`)])
    await processBatch([msg(1, 1001, `a${NUL}b`)])
    expect(await stored()).toHaveLength(1)
  })

  it('a text that is only NUL bytes becomes an empty content and is still stored', async () => {
    await processBatch([msg(1, 1001, `${NUL}${NUL}`)])
    expect((await stored())[0]?.content).toBe('')
  })
})

describe('a dropped sender is settled', () => {
  it('at the tail of a batch the offset moves PAST the stranger (not only to the owner update before it)', async () => {
    expect(await processBatch([msg(1, 1001), msg(2, 2002)])).toBe(2)
    expect((await stored()).map((r) => r.update_id)).toEqual([1])
  })

  it('in front of an owner update only the owner update is stored and the offset is the highest of both', async () => {
    expect(await processBatch([msg(1, 2002), msg(2, 1001)])).toBe(2)
    expect((await stored()).map((r) => r.update_id)).toEqual([2])
  })

  it('a batch of strangers only: nothing stored, the offset is the highest id', async () => {
    expect(await processBatch([msg(3, 2002), msg(5, 3003), msg(4, 2002)])).toBe(5)
    expect(await stored()).toEqual([])
  })

  it('the gate runs BEFORE the insert: the insert is never called for a stranger, so it cannot fail for one', async () => {
    const spy = vi.spyOn(ingest, 'insertIncomingEvent')
    await processBatch([msg(1, 2002), msg(2, 3003)])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
