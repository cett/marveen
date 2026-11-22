// The artifact search on the full-text index (phase 3, c4), on both engines: one phrase (consecutive words) over the title,
// the meta JSON and the body of the textual kinds; a binary body is not indexed; an invalid UTF-8 text body still lets the
// title match; the count and the list agree for one filter; the agent, tenant and kind filters. The PostgreSQL cap is a
// named divergence: a word after the first 300000 characters of a body is found by SQLite and not by PostgreSQL.
import { describe, expect, it } from 'vitest'
import { countArtifacts, createArtifact, listArtifacts } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'

useTestDb()

const ids = async (q: string, extra: Record<string, unknown> = {}): Promise<string[]> =>
  (await listArtifacts({ q, limit: 50, ...extra })).map((a) => a.id).sort()

describe('the artifact search on the full-text index', () => {
  it('a query is one phrase: consecutive words match, the same words out of order do not', async () => {
    const a = await createArtifact({ agent_id: 'agent-a', title: 'Plan', kind: 'text', content: Buffer.from('alpha beta gamma') })
    expect(await ids('alpha beta')).toEqual([a.id].sort())
    expect(await ids('alpha gamma')).toEqual([])
  })

  it('a binary body is not indexed: its words do not match, its title does', async () => {
    const b = await createArtifact({ agent_id: 'agent-a', title: 'Blob', kind: 'binary', content: Buffer.from('secretword inside') })
    expect(await ids('secretword')).toEqual([])
    expect(await ids('blob')).toEqual([b.id])
  })

  it('the meta JSON is searched: its keys and values are words', async () => {
    const m = await createArtifact({ agent_id: 'agent-a', title: 'Quarterly', kind: 'json', content: Buffer.from('{}'), meta: { owner: 'zebra' } })
    expect(await ids('zebra')).toEqual([m.id])
    expect(await ids('quarterly')).toEqual([m.id])
  })

  it('a phrase does not run across the parts: the end of the title and the start of the body are not one phrase (both engines)', async () => {
    // title ends with "report", body starts with "figures": no column holds both words in a row
    await createArtifact({ agent_id: 'agent-a', title: 'Quarterly report', kind: 'text', content: Buffer.from('figures for the year') })
    expect(await ids('report figures')).toEqual([])
    expect(await ids('quarterly report')).not.toEqual([])
  })

  it('a text artifact whose body is not valid UTF-8 is stored, and its title is still found', async () => {
    const x = await createArtifact({ agent_id: 'agent-a', title: 'brokenfile', kind: 'text', content: Buffer.from([0xff, 0xfe, 0x41]) })
    expect(await ids('brokenfile')).toEqual([x.id])
  })

  it('the count and the list agree for the same filter', async () => {
    await createArtifact({ agent_id: 'agent-a', title: 'Count one', kind: 'text', content: Buffer.from('shared phrase here') })
    await createArtifact({ agent_id: 'agent-a', title: 'Count two', kind: 'markdown', content: Buffer.from('shared phrase there') })
    const filter = { q: 'shared phrase', agent: 'agent-a', kind: 'text' }
    expect(await countArtifacts(filter)).toBe((await listArtifacts({ ...filter, limit: 50 })).length)
    expect(await countArtifacts({ q: 'shared phrase' })).toBe(2)
  })

  it('the agent, tenant and kind filters are in the SQL', async () => {
    const mine = await createArtifact({ agent_id: 'agent-a', title: 'Scope', kind: 'text', content: Buffer.from('scoped words') })
    await createArtifact({ agent_id: 'agent-b', title: 'Scope', kind: 'text', content: Buffer.from('scoped words') })
    await createArtifact({ agent_id: 'agent-a', title: 'Scope', kind: 'text', content: Buffer.from('scoped words'), tenant_id: 'tenant-b' })
    await createArtifact({ agent_id: 'agent-a', title: 'Scope', kind: 'json', content: Buffer.from('{}') })
    expect(await ids('scope', { agent: 'agent-a', tenant_id: 'default', kind: 'text' })).toEqual([mine.id].sort())
  })
})

describe('the body cap (PostgreSQL) and the engine difference', () => {
  const longText = `lead ${'filler '.repeat(50000)} tailword`

  it.runIf(testDbMode() === 'pg')('a word after the first 300000 characters of a body is not found on PostgreSQL (a named divergence)', async () => {
    const a = await createArtifact({ agent_id: 'agent-a', title: 'Long', kind: 'text', content: Buffer.from(longText) })
    expect(await ids('lead')).toEqual([a.id])
    expect(await ids('tailword')).toEqual([])
  })

  it.runIf(testDbMode() === 'sqlite')('the same word after the cap is found by FTS5 (SQLite indexes the whole body)', async () => {
    const a = await createArtifact({ agent_id: 'agent-a', title: 'Long', kind: 'text', content: Buffer.from(longText) })
    expect(await ids('tailword')).toEqual([a.id])
  })
})
