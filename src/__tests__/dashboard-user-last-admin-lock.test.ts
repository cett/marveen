// The last-admin guard under concurrency (sessions.ts deleteDashboardUserKeepingLastAdmin, observability.ts
// adminPatchDashboardUser): two guarded writes on the active admins must not both pass. A holder transaction takes the
// admin rows FOR UPDATE first and waits on the interleave gate, so the two guarded writes queue behind it on PostgreSQL
// (waitBlockedOnLock sees them) and behind the connection lock on SQLite. Then the holder ends and they run in turn.
// No timing: the order is the lock's.
//
// Privacy: neutral fixtures only (user-a, user-b, user-c).

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { forUpdate } from '../db/dialect.js'
import { adminPatchDashboardUser } from '../db/observability.js'
import { deleteDashboardUserKeepingLastAdmin, lockAdminRows } from '../db/sessions.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

async function seed(): Promise<{ a: number; b: number; c: number }> {
  await dbx.run(
    "INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES ('user-a', 'h', 'admin', NULL, 1, 1), ('user-b', 'h', 'admin', NULL, 1, 1), ('user-c', 'h', 'viewer', NULL, 1, 1)",
  )
  const id = async (name: string): Promise<number> => ((await dbx.get('SELECT id FROM dashboard_users WHERE username = ?', name)) as { id: number }).id
  return { a: await id('user-a'), b: await id('user-b'), c: await id('user-c') }
}

const activeAdmins = async (): Promise<number> =>
  ((await dbx.get("SELECT COUNT(*) AS c FROM dashboard_users WHERE role = 'admin' AND disabled = 0")) as { c: number }).c

/** Takes the active admin rows in the same order as the guarded writes, and holds them until the gate opens. */
function holdAdmins(il: ReturnType<typeof interleave>, point: string): Promise<void> {
  return dbx.tx(async (tx) => {
    await tx.all(`SELECT id FROM dashboard_users WHERE role = 'admin' AND disabled = 0 ORDER BY id ${forUpdate()}`)
    await il.pass(point)
  })
}

describe('last admin: two deletions of the two admins', () => {
  it('one goes through, the other is refused, and one admin is left', async () => {
    await seed()
    const il = interleave()
    il.hold('admins-locked')
    const holder = holdAdmins(il, 'admins-locked')
    await il.reached('admins-locked')
    const d1 = deleteDashboardUserKeepingLastAdmin('user-a')
    const d2 = deleteDashboardUserKeepingLastAdmin('user-b')
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('admins-locked')
    }
    const [r1, r2] = await Promise.all([d1, d2])
    await holder
    expect([r1, r2].sort()).toEqual(['deleted', 'last_admin'])
    expect(await activeAdmins()).toBe(1)
  })
})

describe('last admin: a demotion and a deletion of the two admins', () => {
  it('exactly one of the two writes goes through, and one admin is left', async () => {
    const { b } = await seed()
    const il = interleave()
    il.hold('admins-locked-2')
    const holder = holdAdmins(il, 'admins-locked-2')
    await il.reached('admins-locked-2')
    const del = deleteDashboardUserKeepingLastAdmin('user-a')
    const demote = adminPatchDashboardUser(b, { role: 'viewer' })
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('admins-locked-2')
    }
    const [r1, r2] = await Promise.all([del, demote, holder])
    const passed = (r1 === 'deleted' ? 1 : 0) + ((r2 as { status: string }).status === 'updated' ? 1 : 0)
    expect(passed).toBe(1)
    expect(await activeAdmins()).toBe(1)
  })
})

// not_found: an unknown user, and a user that another transaction deletes after the lookup (PostgreSQL: the guarded
// delete waits on that transaction's row lock, then finds no row, so the answer comes from the final read).
describe('last admin: the not_found answers', () => {
  it('an unknown user answers not_found, and no row is deleted or changed', async () => {
    await seed()
    const rows = () => dbx.all('SELECT id, username, role, disabled, updated_at FROM dashboard_users ORDER BY id')
    const before = await rows()
    expect(await deleteDashboardUserKeepingLastAdmin('user-zz')).toBe('not_found')
    expect(await rows()).toEqual(before)
  })

  it('a user removed between the lookup and the guarded delete answers not_found (both engines)', async () => {
    const { c } = await seed()
    // The lookup (outside any transaction) finds user-c. The seam removes that row right before the transaction callback
    // runs, so the guarded DELETE changes no row and the answer comes from the final read. Same on both engines.
    const realTx = dbx.tx.bind(dbx) as unknown as (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>
    vi.spyOn(dbx, 'tx').mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
      dbx.run('DELETE FROM dashboard_users WHERE id = ?', c).then(() => realTx(fn, opts))) as never)
    try {
      expect(await deleteDashboardUserKeepingLastAdmin('user-c')).toBe('not_found')
    } finally {
      vi.restoreAllMocks()
    }
    expect(await activeAdmins()).toBe(2)
  })

  it('the only active admin is refused: last_admin, and the row stays (both engines)', async () => {
    await dbx.run("INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES ('user-a', 'h', 'admin', NULL, 1, 1)")
    expect(await deleteDashboardUserKeepingLastAdmin('user-a')).toBe('last_admin')
    expect(await activeAdmins()).toBe(1)
  })
})

// The runtime cell for the order: the physical order of the admin rows is the reverse of their id order (the UPDATE of
// user-a moves its row to the end of the heap). A holder keeps user-b (id 2). The production lock for user-a (id 1)
// then waits on user-b. With ORDER BY id it already holds user-a, so a NOWAIT lock on user-a fails (55P03). Without
// ORDER BY the sequential scan reaches user-b first, waits there, and user-a is still free: the NOWAIT lock succeeds.
// The planner decides the scan; if it picks an index that returns id order, the mutant survives this cell and the
// source pin below is the only check (a weak cell, stated as such).
describe('last admin: the lock takes user-a before it waits on user-b (PostgreSQL)', () => {
  it.runIf(testDbMode() === 'pg')('a NOWAIT lock on user-a fails while the lock for user-a is waiting on user-b', async () => {
    const { a, b } = await seed()
    await dbx.run('UPDATE dashboard_users SET updated_at = 2 WHERE id = ?', a)
    const il = interleave()
    il.hold('b-held')
    const holder = dbx.tx(async (tx) => {
      await tx.get(`SELECT id FROM dashboard_users WHERE id = ? ${forUpdate()}`, b)
      await il.pass('b-held')
    })
    await il.reached('b-held')
    const locker = dbx.tx((tx) => lockAdminRows(tx, a))
    let outcome: string = 'pending'
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
      outcome = await dbx.tx(async (tx) => tx.get(`SELECT id FROM dashboard_users WHERE id = ? FOR UPDATE NOWAIT`, a)).then(
        () => 'locked',
        (err: { code?: string }) => err.code ?? 'error',
      )
    } finally {
      il.open('b-held')
      await Promise.allSettled([holder, locker])
    }
    expect(outcome).toBe('55P03')
  })
})

// Source pin: two lock statements over the same rows can only deadlock when they take the rows in different orders, and
// which order a statement without ORDER BY takes depends on its plan, which no cell here controls. So the order is pinned
// in the text: every caller goes through lockAdminRows, and that statement sorts by id before it locks.
// This pin checks the SQL TEXT, not the behaviour. A lock statement without ORDER BY, and a lock statement that leaves the
// target row out, are both killed by this text pin on both engines: behaviourally equivalent for the target row (see the
// docblock of lockAdminRows in sessions.ts). Do not read a red from this pin as behavioural evidence.
describe('last admin: the lock order is pinned in the source', () => {
  it('lockAdminRows locks the target and the active admins in id order, FOR UPDATE, and nothing else', () => {
    const src = readFileSync(new URL('../db/sessions.ts', import.meta.url), 'utf8')
    const body = /export async function lockAdminRows[\s\S]*?\n}\n/.exec(src)?.[0]
    expect(body, 'lockAdminRows in sessions.ts').toBeDefined()
    expect(body).toContain("WHERE id = ? OR (role = 'admin' AND disabled = 0) ORDER BY id ${forUpdate()}")
  })
})

describe('last admin: a patch that keeps the role takes no admin lock', () => {
  it.runIf(testDbMode() === 'pg')('goes through while the admin rows are held', async () => {
    const { c } = await seed()
    const il = interleave()
    il.hold('admins-locked-3')
    const holder = holdAdmins(il, 'admins-locked-3')
    await il.reached('admins-locked-3')
    // a password change of a viewer: its UPDATE locks only its own row, so it answers while the admins are held
    const patched = await adminPatchDashboardUser(c, { password_hash: 'h2' })
    il.open('admins-locked-3')
    await holder
    expect(patched.status).toBe('updated')
  })
})
