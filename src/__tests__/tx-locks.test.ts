// Read-then-write transactions that SQLite serialised through the facade's transaction lock and PostgreSQL does not (each
// dbx.tx has its own connection, READ COMMITTED, no global transaction lock): the first statement of the body must take the
// lock of what it reads, or two overlapping transactions lose an update. One describe per site; each cell parks the first
// transaction right before its write (helpers/tx-park.ts), starts the second one, waits until the second is blocked on the
// lock (PostgreSQL) and lets the first one go on. The expected result is exact. SQLite: the second transaction queues in
// the connection lock, the result is the same, so the cell is green there with or without the lock.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { interleave } from './helpers/interleave.js'
import { parkFirstStatementAt, parkFirstTxAt, untilSettledOrBlocked } from './helpers/tx-park.js'
import { saveWorkspaceDoc, patchWorkspaceDoc, getWorkspaceDoc } from '../db/workspace.js'
import { createTenant, getTenant, updateTenant } from '../db/observability.js'
import { updateSystemConfig } from '../db/system-config.js'
import { createSkill, dbx, deleteVaultBindingsForSecret, getSkill, getSkillFile, putSkillFile, setSkillContent, updateSkill, upsertVaultBinding } from '../db.js'

useTestDb()
afterEach(() => { vi.restoreAllMocks() })

describe('patchWorkspaceDoc', () => {
  it('two overlapping patches of different fields both survive (the second waits on the row lock of the first read)', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'notes/one', title: 'T0', content: 'C0',
      content_type: 'text', type: 'notes',
    })
    const il = interleave()
    il.hold('first-patch')
    // the first patch has read the row and stops before its UPDATE; the second patch must not read the row while it is open
    const spy = parkFirstTxAt(il, 'first-patch', /^\s*UPDATE workspace_docs\s+SET /)
    let state: 'settled' | 'blocked' | 'queued'
    try {
      const first = patchWorkspaceDoc(doc.id, { title: 'T1' })
      await il.reached('first-patch')
      const second = patchWorkspaceDoc(doc.id, { content: 'C2' })
      state = await untilSettledOrBlocked(second)
      il.open('first-patch')
      expect((await first)?.title).toBe('T1')
      expect((await second)?.content).toBe('C2')
    } finally {
      il.open('first-patch')
      spy.mockRestore()
    }
    // the second patch must not have run to its end while the first one was open (a stale read would let it)
    expect(state).not.toBe('settled')
    // a stale merge would write the second patch over the title of the first one (T0)
    const after = await getWorkspaceDoc(doc.id)
    expect(after?.title).toBe('T1')
    expect(after?.content).toBe('C2')
  })
})

describe('updateTenant', () => {
  it('the "main agent changed" decision of the second update sees the row the first one wrote (it waits on the row lock)', async () => {
    await createTenant('tenant-x', 'Tenant X')
    await updateTenant('tenant-x', { main_agent_id: 'agent-a' })
    await dbx.run("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('agent-b', 'tenant-x', 'bound')")
    const il = interleave()
    il.hold('first-update')
    // the first update sets the main agent to the value it already has: it read 'agent-a', decides "no change" and stops
    // before its UPDATE. The second update then sets 'agent-b' as the main agent.
    const spy = parkFirstTxAt(il, 'first-update', /^\s*UPDATE tenants\s+SET /)
    let state: 'settled' | 'blocked' | 'queued'
    try {
      const first = updateTenant('tenant-x', { main_agent_id: 'agent-a', display_name: 'Tenant X1' })
      await il.reached('first-update')
      const second = updateTenant('tenant-x', { main_agent_id: 'agent-b' })
      state = await untilSettledOrBlocked(second)
      il.open('first-update')
      await first
      await second
    } finally {
      il.open('first-update')
      spy.mockRestore()
    }
    // the second update must not have run to its end while the first one was open (a stale read would let it)
    expect(state).not.toBe('settled')
    // first, then second: the main agent is 'agent-b', and the second update dropped the context of the old main agent state
    expect((await getTenant('tenant-x'))?.main_agent_id).toBe('agent-b')
    expect((await getTenant('tenant-x'))?.display_name).toBe('Tenant X1')
    expect(await dbx.get("SELECT 1 AS present FROM agent_tenant_context WHERE tenant_id = 'tenant-x'")).toBeUndefined()
  })
})

describe('updateSystemConfig', () => {
  // Two read-modify-write calls of one key: each appends its token to the list it read. The first one is parked right before
  // its write, the second one is started. A lost update leaves only one token.
  const appendTwo = async (key: string): Promise<'settled' | 'blocked' | 'queued'> => {
    const il = interleave()
    il.hold('first-write')
    const spy = parkFirstTxAt(il, 'first-write', /^\s*INSERT INTO system_config/)
    let state: 'settled' | 'blocked' | 'queued'
    try {
      const first = updateSystemConfig(key, (cur) => (cur ? `${cur},x` : 'x'))
      await il.reached('first-write')
      const second = updateSystemConfig(key, (cur) => (cur ? `${cur},y` : 'y'))
      state = await untilSettledOrBlocked(second)
      il.open('first-write')
      expect(await first).toBe(true)
      expect(await second).toBe(true)
    } finally {
      il.open('first-write')
      spy.mockRestore()
    }
    return state
  }

  it('two overlapping calls on a key that has no row yet both land (a row lock cannot serialise them: the advisory lock does)', async () => {
    const state = await appendTwo('sweep.absent')
    expect(state).not.toBe('settled')
    expect(await dbx.get<{ value: string }>("SELECT value FROM system_config WHERE key = 'sweep.absent'")).toEqual({ value: 'x,y' })
  })

  it('two overlapping calls on a key that has a row both land, and the second one sees what the first wrote', async () => {
    await dbx.run("INSERT INTO system_config (key, value, updated_at, source) VALUES ('sweep.present', 'a', 1, 'db')")
    const state = await appendTwo('sweep.present')
    expect(state).not.toBe('settled')
    expect(await dbx.get<{ value: string }>("SELECT value FROM system_config WHERE key = 'sweep.present'")).toEqual({ value: 'a,x,y' })
  })
})

// The privilege gate of the skill writers decides from the skill row it read. A skill whose privilege block (allowed-tools)
// an admin has just removed must not get it back from a concurrent gated write that was judged against the OLD row:
// "same privilege as the live row" was true of the snapshot, not of the row it overwrites. The first transaction (gated,
// privilege equal to the old row) is parked right before its write, the second one (ungated, privilege removed) is started;
// with the row lock taken first the second one waits, so the end state is first-then-second: the privilege stays removed.
const HUMAN = { kind: 'human', id: 'user-a' } as const
const PRIVILEGED = '---\nname: a\ndescription: d\nallowed-tools: Bash\n---\nbody'
const UNPRIVILEGED = '---\nname: a\ndescription: d\n---\nbody'

describe('setSkillContent', () => {
  it('a gated write judged against the old row cannot bring a removed privilege back (the second writer waits on the skill row lock)', async () => {
    await createSkill({ id: 'global/a', name: 'global/a', description: 'd', content: PRIVILEGED, tenant_id: 'fleet', is_global: true }, HUMAN)
    const il = interleave()
    il.hold('first-write')
    const spy = parkFirstTxAt(il, 'first-write', /^\s*UPDATE skills SET content = /)
    let state: 'settled' | 'blocked' | 'queued'
    try {
      // same privilege block as the live row: not privileged, written straight through (after it has been parked)
      const first = setSkillContent('global/a', `${PRIVILEGED} one`, 1, HUMAN, {}, { gatePrivilege: true })
      await il.reached('first-write')
      const second = setSkillContent('global/a', UNPRIVILEGED, 2, HUMAN, {}, {})
      state = await untilSettledOrBlocked(second)
      il.open('first-write')
      expect((await first).outcome).toBe('updated')
      expect((await second).outcome).toBe('updated')
    } finally {
      il.open('first-write')
      spy.mockRestore()
    }
    expect(state).not.toBe('settled')
    expect((await getSkill('global/a'))?.content).toBe(UNPRIVILEGED)
  })
})

describe('updateSkill', () => {
  it('a gated patch judged against the old row cannot bring a removed privilege back (the second writer waits on the skill row lock)', async () => {
    await createSkill({ id: 'global/b', name: 'global/b', description: 'd', content: PRIVILEGED, tenant_id: 'fleet', is_global: true }, HUMAN)
    const il = interleave()
    il.hold('first-write')
    const spy = parkFirstTxAt(il, 'first-write', /^\s*UPDATE skills SET /)
    let state: 'settled' | 'blocked' | 'queued'
    try {
      const first = updateSkill('global/b', { content: `${PRIVILEGED} one` }, HUMAN, {}, { gatePrivilege: true })
      await il.reached('first-write')
      const second = updateSkill('global/b', { content: UNPRIVILEGED }, HUMAN, {}, {})
      state = await untilSettledOrBlocked(second)
      il.open('first-write')
      expect((await first).outcome).toBe('updated')
      expect((await second).outcome).toBe('updated')
    } finally {
      il.open('first-write')
      spy.mockRestore()
    }
    expect(state).not.toBe('settled')
    expect((await getSkill('global/b'))?.content).toBe(UNPRIVILEGED)
  })
})

describe('putSkillFile', () => {
  it('a gated put of the file as the old row has it cannot bring a replaced runnable file back (the second writer waits on the skill row lock)', async () => {
    await createSkill({ id: 'global/c', name: 'global/c', description: 'd', content: UNPRIVILEGED, tenant_id: 'fleet', is_global: true }, HUMAN)
    await putSkillFile('global/c', 'scripts/run.sh', Buffer.from('v1'), undefined, HUMAN)
    const il = interleave()
    il.hold('first-write')
    const spy = parkFirstTxAt(il, 'first-write', /^\s*INSERT INTO skill_files/)
    let state: 'settled' | 'blocked' | 'queued'
    try {
      // the very same runnable file as the live row has: no change, so no approval, written straight through (parked first)
      const first = putSkillFile('global/c', 'scripts/run.sh', Buffer.from('v1'), undefined, HUMAN, {}, { gatePrivilege: true })
      await il.reached('first-write')
      const second = putSkillFile('global/c', 'scripts/run.sh', Buffer.from('v2'), undefined, HUMAN, {}, {})
      state = await untilSettledOrBlocked(second)
      il.open('first-write')
      expect((await first).outcome).toBe('written')
      expect((await second).outcome).toBe('written')
    } finally {
      il.open('first-write')
      spy.mockRestore()
    }
    expect(state).not.toBe('settled')
    expect((await getSkillFile('global/c', 'scripts/run.sh'))?.content.toString()).toBe('v2')
  })
})

describe('deleteVaultBindingsForSecret', () => {
  it('returns every binding it deleted, also one written while the delete was about to run (DELETE ... RETURNING)', async () => {
    await upsertVaultBinding('default', { vaultSecretId: 'secret-a', envVar: 'KEY_ONE', targets: [] })
    const il = interleave()
    il.hold('before-delete')
    // The delete is parked right before it is sent (a SELECT-then-DELETE shape would be parked between its halves, with the
    // rows already read). A second binding of the same secret is written meanwhile; it is deleted by the same delete, so it
    // has to be among the returned rows: the caller strips the env var from the target file of each returned binding.
    const spy = parkFirstStatementAt(il, 'before-delete', /^\s*DELETE FROM vault_bindings\b/)
    let deleted: Awaited<ReturnType<typeof deleteVaultBindingsForSecret>>
    try {
      const first = deleteVaultBindingsForSecret('default', 'secret-a')
      await il.reached('before-delete')
      await upsertVaultBinding('default', { vaultSecretId: 'secret-a', envVar: 'KEY_TWO', targets: [] })
      il.open('before-delete')
      deleted = await first
    } finally {
      il.open('before-delete')
      spy.mockRestore()
    }
    expect(deleted.map((b) => b.envVar).sort()).toEqual(['KEY_ONE', 'KEY_TWO'])
    expect(await dbx.get("SELECT 1 AS present FROM vault_bindings WHERE vault_secret_id = 'secret-a'")).toBeUndefined()
  })
})
