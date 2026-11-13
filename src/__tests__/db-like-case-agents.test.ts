// failPendingFederatedMessages (db/agents.ts) scopes the purge to one peer with a LIKE on '<peer>/%'. The system ids are
// case-insensitive, so a row an old build wrote with an upper-case prefix must be purged with its peer: SQLite's LIKE
// folds ASCII case, PostgreSQL's does not, so the statement goes through likeNoCase (it used lower() on the column
// before, which folds non-ASCII on PostgreSQL only). Runs on both engines (useTestDb).
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, createAgentMessage, markMessageDelivered, failPendingFederatedMessages, getAgentMessage } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

beforeEach(async () => {
  await dbx.run('DELETE FROM agent_messages')
})

const status = async (id: number): Promise<string | undefined> => (await getAgentMessage(id))?.status

describe('failPendingFederatedMessages: the peer prefix ignores ASCII case', () => {
  it('purges the peer in any case, and only that peer', async () => {
    const lower = await createAgentMessage('agent-a', 'peer-a/x', 'm1')
    const upper = await createAgentMessage('agent-a', 'PEER-A/y', 'm2')
    const mixed = await createAgentMessage('agent-a', 'Peer-A/z', 'm3')
    const other = await createAgentMessage('agent-a', 'peer-b/x', 'm4')
    const longer = await createAgentMessage('agent-a', 'peer-ab/x', 'm5')
    const local = await createAgentMessage('agent-a', 'agent-b', 'm6')
    expect((await failPendingFederatedMessages('peer-a', 'gone')).sort()).toEqual([lower.id, upper.id, mixed.id].sort())
    expect(await status(other.id)).toBe('pending')
    expect(await status(longer.id)).toBe('pending')
    expect(await status(local.id)).toBe('pending')
  })

  it('works the other way round: an upper-case peer id purges lower-case rows', async () => {
    const lower = await createAgentMessage('agent-a', 'peer-a/x', 'm1')
    expect(await failPendingFederatedMessages('PEER-A', 'gone')).toEqual([lower.id])
  })

  it('a % or _ in the peer id is a literal, not a wildcard', async () => {
    const plain = await createAgentMessage('agent-a', 'peerxa/x', 'm1')
    const under = await createAgentMessage('agent-a', 'Peer_A/x', 'm2')
    expect(await failPendingFederatedMessages('peer_a', 'gone')).toEqual([under.id])
    expect(await failPendingFederatedMessages('%', 'gone')).toEqual([])
    expect(await status(plain.id)).toBe('pending')
  })

  it('does not fold non-ASCII (the two engines agree), and leaves delivered rows alone', async () => {
    const acute = await createAgentMessage('agent-a', 'Őra/x', 'm1')
    const delivered = await createAgentMessage('agent-a', 'peer-a/y', 'm2')
    await markMessageDelivered(delivered.id)
    expect(await failPendingFederatedMessages('őra', 'gone')).toEqual([])
    expect(await status(acute.id)).toBe('pending')
    expect(await failPendingFederatedMessages('Őra', 'gone')).toEqual([acute.id])
    expect(await failPendingFederatedMessages('peer-a', 'gone')).toEqual([])
    expect(await status(delivered.id)).toBe('delivered')
  })

  it('no peer id: every pending qualified row, in any case, and no local row', async () => {
    const a = await createAgentMessage('agent-a', 'peer-a/x', 'm1')
    const b = await createAgentMessage('agent-a', 'PEER-B/x', 'm2')
    const local = await createAgentMessage('agent-a', 'agent-b', 'm3')
    expect((await failPendingFederatedMessages(undefined, 'gone')).sort()).toEqual([a.id, b.id].sort())
    expect(await status(local.id)).toBe('pending')
  })
})
