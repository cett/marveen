// correlateWithKanban labels the unlabelled token usage of an agent with the kanban card that was being worked on: a card
// covers the usage from its updated_at to the updated_at of the next card (or the last usage). The same cells run in the
// default suite (SQLite) and in the PG module run (ported list). The statement reads the window of every agent as
// minTs/maxTs aliases: PostgreSQL folds an unquoted alias to lower case, so before the aliases were quoted no card matched
// there (no error, an empty result): every cell below that expects a label is the guard for that.
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { createKanbanCard } from '../db/kanban.js'
import { correlateWithKanban } from '../db/observability.js'

const { dbx } = useTestDb()

async function usage(agent: string, ts: number, title: string | null = null): Promise<void> {
  await dbx.run(
    'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, task_title) VALUES (?, ?, ?, 1, 1, ?)',
    agent, `session-${agent}-${ts}`, ts, title,
  )
}

async function card(id: string, assignee: string, title: string, updatedAt: number, project?: string): Promise<void> {
  await createKanbanCard({ id, title, assignee, project })
  await dbx.run('UPDATE kanban_cards SET updated_at = ? WHERE id = ?', updatedAt, id)
}

/** agent:timestamp -> task_title (null = unlabelled), the whole table. */
async function labels(): Promise<Record<string, string | null>> {
  const rows = await dbx.all<{ agent: string; timestamp: number; task_title: string | null }>(
    'SELECT agent, timestamp, task_title FROM token_usage ORDER BY agent, timestamp',
  )
  return Object.fromEntries(rows.map((r) => [`${r.agent}:${r.timestamp}`, r.task_title]))
}

describe('correlateWithKanban: the window of a card', () => {
  it('a card covers the usage from its own time to the next card; the usage before the first card stays unlabelled', async () => {
    for (const ts of [1000, 2000, 3000, 4000]) await usage('agent-a', ts)
    await card('card0001', 'agent-a', 'first', 1500)
    await card('card0002', 'agent-a', 'second', 2500)
    await card('card0003', 'agent-a', 'third', 3500)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:1000': null, 'agent-a:2000': 'first', 'agent-a:3000': 'second', 'agent-a:4000': 'third' })
  })

  it('both ends of the usage window are inclusive: a card at the first and one at the last usage time', async () => {
    await usage('agent-a', 1000)
    await usage('agent-a', 3000)
    await card('card0001', 'agent-a', 'at-min', 1000)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:1000': 'at-min', 'agent-a:3000': 'at-min' })

    await dbx.run('UPDATE token_usage SET task_title = NULL')
    await dbx.run('UPDATE kanban_cards SET updated_at = 3000')
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:1000': null, 'agent-a:3000': 'at-min' })
  })

  it('a card updated before the first usage or after the last one labels nothing', async () => {
    await usage('agent-a', 1000)
    await usage('agent-a', 3000)
    await card('card0001', 'agent-a', 'too-early', 999)
    await card('card0002', 'agent-a', 'too-late', 3001)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:1000': null, 'agent-a:3000': null })
  })

  it('the cards are taken in time order: a usage exactly at the time of the second card goes to the first card, the one after it to the second', async () => {
    await usage('agent-a', 1000)
    await usage('agent-a', 2000)
    await usage('agent-a', 2001)
    await card('card0001', 'agent-a', 'early', 1000)
    await card('card0002', 'agent-a', 'late', 2000)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:1000': 'early', 'agent-a:2000': 'early', 'agent-a:2001': 'late' })
  })

  it('a row that already has a title is not overwritten, and does not widen the window of the unlabelled ones', async () => {
    await usage('agent-a', 1000)
    await usage('agent-a', 2000, 'preset')
    await usage('agent-a', 3000)
    await card('card0001', 'agent-a', 'new', 1500)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:1000': null, 'agent-a:2000': 'preset', 'agent-a:3000': 'new' })
  })
})

describe('correlateWithKanban: the window comes from the unlabelled rows only', () => {
  it('a labelled row before the unlabelled ones does not pull an earlier card into the window', async () => {
    await usage('agent-a', 400, 'preset')
    await usage('agent-a', 1000)
    await card('card0001', 'agent-a', 'before-the-window', 500)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:400': 'preset', 'agent-a:1000': null })
  })
})

describe('correlateWithKanban: agents and projects', () => {
  it('each agent has its own window and only its own cards', async () => {
    await usage('agent-a', 1000)
    await usage('agent-b', 1000)
    await card('card0001', 'agent-b', 'for-b', 1000)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent-a:1000': null, 'agent-b:1000': 'for-b' })
  })

  it('the project of the card is copied, and a card without one gives NULL', async () => {
    await usage('agent-a', 1000)
    await usage('agent-b', 1000)
    await card('card0001', 'agent-a', 'with-project', 1000, 'project-x')
    await card('card0002', 'agent-b', 'no-project', 1000)
    await correlateWithKanban()
    const rows = await dbx.all<{ agent: string; project: string | null }>('SELECT agent, project FROM token_usage ORDER BY agent')
    expect(rows).toEqual([{ agent: 'agent-a', project: 'project-x' }, { agent: 'agent-b', project: null }])
  })

  it('an assignee list that contains the agent name labels the usage, an assignee that differs only where "_" would match does not', async () => {
    await usage('agent_a', 1000)
    await card('card0001', 'agent-b,agent_a', 'in-list', 1000)
    await card('card0002', 'agentXa', 'decoy', 1000)
    await correlateWithKanban()
    expect(await labels()).toEqual({ 'agent_a:1000': 'in-list' })
  })

  it('does nothing, and does not fail, on an empty table', async () => {
    await correlateWithKanban()
    expect(await labels()).toEqual({})
  })
})
