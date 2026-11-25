// The channel coordinator on PostgreSQL as the APPLICATION role, bare: no context of the test, the way the coordinator process
// calls the seven ingest functions (src/channel-coordinator/ingest.ts). incoming_events and poll_offset are D2 tables (privileged
// only), so the job `channel-coordinator-ingest` is what makes every function work, and the cells below show both sides:
//
//   - the functions work with the job (green), and
//   - the same statements WITHOUT a system context are refused or see nothing (the red a removed wrapper would give), so a
//     cell going green after somebody drops the wrapper is impossible: the function cells go red, and these cells prove why.
//
// The replay read joins agent_messages ACROSS tenants: an in-flight handoff of another tenant is invisible to a tenant context,
// and an invisible agent message reads as "no agent message" (am.id IS NULL), which re-hands the event off a second time. Only
// the privileged read gets the right answer.
//
// The coordinator boot (src/channel-coordinator/boot.ts) never migrates: with the owner URL configured it still runs no DDL
// (the migrate URL is empty on purpose), and a database that is behind is refused with the step named.
//
// Privacy: neutral fixtures only.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend, PgBootError } from '../../db/pg-boot.js'
import { dbx } from '../../db/facade.js'
import { runAs } from '../../db/context.js'
import {
  createHandoffMessage,
  getEventsNeedingHandoff,
  getOffset,
  insertIncomingEvent,
  markEventDelivered,
  markEventFailed,
  setOffset,
} from '../../channel-coordinator/ingest.js'
import { bootCoordinatorDb, closeCoordinatorDb } from '../../channel-coordinator/boot.js'
import { resetPgCredentialCaptureForTests } from '../../db/pg/url.js'

const made: PgTestDb[] = []
afterEach(async () => {
  await closeCoordinatorDb()
  await closePgBackend()
  vi.unstubAllEnvs()
  resetPgCredentialCaptureForTests()
})
afterAll(async () => { for (const d of made) await d.close() })

/** A database booted as the app role (no migrate URL: the schema is current), with a second tenant to prove isolation against. */
async function bootedDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-t1', 'Tenant 1', 1) ON CONFLICT DO NOTHING")
  await bootPgBackend({ url: db.appUrl, migrateUrl: '' })
  return db
}

const ev = (update_id: number) => ({
  update_id, kind: 'message', chat_id: 1001, user_id: 1001, username: 'user-a', message_id: update_id, content: 'x', meta: {}, tg_date: 1,
})
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e)
const count = async (db: PgTestDb, table: string): Promise<number> =>
  Number((await db.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n)

describe('the seven functions, bare, as the app role', () => {
  it('insert, dedupe, handoff, mark, replay and offset all work, and the rows are where the admin oracle sees them', async () => {
    const db = await bootedDb()
    const first = await insertIncomingEvent('telegram', ev(1))
    const again = await insertIncomingEvent('telegram', ev(1))
    expect(first.inserted).toBe(true)
    expect(again.inserted).toBe(false)
    expect(await count(db, 'incoming_events')).toBe(1)

    const am = await createHandoffMessage('body')
    await markEventDelivered(first.eventId!, am)
    const marked = (await db.pool.query('SELECT status, agent_message_id FROM incoming_events WHERE id = $1', [first.eventId])).rows[0]
    expect(marked.status).toBe('delivered')
    expect(Number(marked.agent_message_id)).toBe(am)
    expect((await db.pool.query('SELECT tenant_id FROM agent_messages WHERE id = $1', [am])).rows[0].tenant_id).toBe('default')

    const second = await insertIncomingEvent('telegram', ev(2))
    await markEventFailed(second.eventId!, 'boom')
    expect((await db.pool.query('SELECT status, error FROM incoming_events WHERE id = $1', [second.eventId])).rows[0]).toEqual({ status: 'failed', error: 'boom' })

    expect(await getEventsNeedingHandoff('telegram')).toEqual([])
    expect(await getOffset('telegram')).toBe(0)
    await setOffset('telegram', 42)
    await setOffset('telegram', 43)
    expect(await getOffset('telegram')).toBe(43)
    expect(await count(db, 'poll_offset')).toBe(1)
  })

  it('the handoff row is stamped with the default tenant even when the call comes from inside another tenant context', async () => {
    const db = await bootedDb()
    const am = await runAs.tenant('tenant-t1', () => createHandoffMessage('body'))
    expect((await db.pool.query('SELECT tenant_id FROM agent_messages WHERE id = $1', [am])).rows[0].tenant_id).toBe('default')
  })
})

describe('without the system job the same statements are refused or see nothing (what a removed wrapper would give)', () => {
  it('an insert into incoming_events with no context is refused by row-level security', async () => {
    await bootedDb()
    const err = await failure(dbx.run("INSERT INTO incoming_events (source, update_id, kind, created_at) VALUES ('telegram', 1, 'message', 1)"))
    expect(String((err as Error | undefined)?.message)).toMatch(/row-level security|permission denied/i)
  })

  it('a tenant context reads ZERO rows of incoming_events and poll_offset although they exist', async () => {
    const db = await bootedDb()
    await insertIncomingEvent('telegram', ev(1))
    await setOffset('telegram', 9)
    expect(await count(db, 'incoming_events')).toBe(1)
    expect(await runAs.tenant('tenant-t1', () => dbx.all('SELECT * FROM incoming_events'))).toEqual([])
    expect(await runAs.tenant('tenant-t1', () => dbx.all('SELECT * FROM poll_offset'))).toEqual([])
  })

  it('a tenant context cannot write the offset either', async () => {
    await bootedDb()
    const err = await failure(runAs.tenant('tenant-t1', () => dbx.run("INSERT INTO poll_offset (source, last_update_id, updated_at) VALUES ('telegram', 1, 1)")))
    expect(String((err as Error | undefined)?.message)).toMatch(/row-level security|permission denied/i)
  })
})

describe('the replay read joins agent_messages across tenants', () => {
  it('an event whose handoff sits in flight in ANOTHER tenant is not re-handed off (the join sees it)', async () => {
    const db = await bootedDb()
    const ins = await insertIncomingEvent('telegram', ev(1))
    // the agent message of this event belongs to another tenant and is still pending (seeded as the data owner)
    const am = (await db.pool.query(
      "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, tenant_id) VALUES ('agent-a', 'agent-b', 'x', 'pending', 1, 'tenant-t1') RETURNING id",
    )).rows[0].id as number
    await markEventDelivered(ins.eventId!, am)
    expect(await getEventsNeedingHandoff('telegram')).toEqual([])
    // the same message turns failed: now the event IS stranded, whichever tenant the message is in
    await db.pool.query("UPDATE agent_messages SET status = 'failed' WHERE id = $1", [am])
    expect((await getEventsNeedingHandoff('telegram')).map((e) => e.id)).toEqual([ins.eventId])
  })

  it('why the read has to be the system\'s: a tenant context does not see the messages of the owner tenant at all', async () => {
    const db = await bootedDb()
    await db.pool.query("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, tenant_id) VALUES ('agent-a', 'agent-b', 'x', 'pending', 1, 'default')")
    expect(await count(db, 'agent_messages')).toBe(1)
    expect(await runAs.tenant('tenant-t1', () => dbx.all('SELECT id FROM agent_messages'))).toEqual([])
  })
})

describe('the coordinator boot never migrates', () => {
  it('with the OWNER url configured as the migrate URL, an empty database is refused at the schema step and no table is created', async () => {
    const db = await createPgTestDb({ migrationsDir: await emptyMigrationsDir() })
    made.push(db)
    vi.stubEnv('MARVEEN_PG_URL', db.appUrl)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', db.ownerUrl)
    const err = await failure(bootCoordinatorDb())
    expect(err).toBeInstanceOf(PgBootError)
    expect((err as PgBootError).step).toBe('schema')
    const tables = (await db.pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n
    expect(Number(tables)).toBe(0)
  })

  it('the refusal never carries the connection URL', async () => {
    const db = await createPgTestDb({ migrationsDir: await emptyMigrationsDir() })
    made.push(db)
    vi.stubEnv('MARVEEN_PG_URL', db.appUrl)
    const err = (await failure(bootCoordinatorDb())) as Error
    expect(err.message).not.toContain(db.appUrl)
  })

  it('on a current schema it boots as PostgreSQL, serves the seven functions and closes cleanly (twice)', async () => {
    const db = await createPgTestDb()
    made.push(db)
    vi.stubEnv('MARVEEN_PG_URL', db.appUrl)
    expect(await bootCoordinatorDb()).toBe('pg')
    const ins = await insertIncomingEvent('telegram', ev(5))
    expect(ins.inserted).toBe(true)
    await closeCoordinatorDb()
    await closeCoordinatorDb()
  })
})

/** An empty directory of migrations: a database cloned from it has no tables at all (the "coordinator started first" state). */
async function emptyMigrationsDir(): Promise<string> {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return mkdtempSync(join(tmpdir(), 'coord-empty-migrations-'))
}
