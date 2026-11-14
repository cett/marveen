// getModelDistribution and getToolStats (db/observability.ts): the two token aggregates behind the model and tool
// panels, on both engines. Fixed rows with a distinct multiplier per token column, so a swapped or dropped column
// shows in the sums, and the filters (from, to, agent), the excluded models, the grouping and the distinct agent list
// are each pinned by an exact expectation.
//
// Privacy: neutral fixtures only (agent-a, agent-b, model-a, model-b, tool-x).

import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, getModelDistribution, getToolStats } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

let seq = 0

/** One token_usage row; n scales the five token columns by 1, 10, 100, 1000 and 10000 (so every column has its own digit). */
async function usage(agent: string, timestamp: number, model: string | null, tool: string | null, n: number): Promise<void> {
  await dbx.run(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model, tool_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent, `session-${++seq}`, timestamp, n, n * 10, n * 100, n * 1000, n * 10000, model, tool)
}

const COLUMNS = ['totalInput', 'totalOutput', 'totalCacheRead', 'totalCacheCreation', 'totalThinking'] as const

/** Two rows whose `column` is 2 000 000 000 (the other token columns 1): that sum is 4 000 000 000, past 2^31. */
const BIG = 2_000_000_000
async function bigRows(column: (typeof COLUMNS)[number], model: string, tool: string | null): Promise<void> {
  const v = (c: (typeof COLUMNS)[number]): number => (c === column ? BIG : 1)
  for (let i = 0; i < 2; i++) {
    await dbx.run(
      `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model, tool_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'agent-a', `big-${++seq}`, 1000, v('totalInput'), v('totalOutput'), v('totalCacheRead'), v('totalCacheCreation'), v('totalThinking'), model, tool)
  }
}

/** The five sums of rows whose scale factors add up to n. */
const totals = (n: number) => ({ totalInput: n, totalOutput: n * 10, totalCacheRead: n * 100, totalCacheCreation: n * 1000, totalThinking: n * 10000 })

beforeEach(async () => {
  seq = 0
  await usage('agent-a', 100, 'model-a', 'tool-x', 1)
  await usage('agent-a', 200, 'model-a', 'tool-x', 2)
  await usage('agent-b', 300, 'model-a', 'tool-y', 4)
  await usage('agent-b', 400, 'model-b', 'tool-x', 3)
  await usage('agent-a', 500, 'model-b', null, 5)
  await usage('agent-a', 600, null, 'tool-z', 7)
  await usage('agent-a', 700, '', null, 11)
  await usage('agent-b', 800, '<synthetic>', null, 13)
  await usage('agent-b', 900, 'model-a', 'tool-x', 1)
})

const byModel = <T extends { model: string }>(rows: T[]): T[] => [...rows].sort((x, y) => x.model.localeCompare(y.model))
const byTool = <T extends { tool_name: string; model: string | null }>(rows: T[]): T[] =>
  [...rows].sort((x, y) => x.tool_name.localeCompare(y.tool_name) || String(x.model).localeCompare(String(y.model)))
const agentsOf = (agents: string): string[] => agents.split(',').sort()

describe('getModelDistribution', () => {
  it('counts the calls and sums the five token columns per model, most calls first', async () => {
    expect(await getModelDistribution()).toEqual([
      { model: 'model-a', count: 4, ...totals(8) },
      { model: 'model-b', count: 2, ...totals(8) },
    ])
  })

  it('leaves out the rows whose model is NULL, empty or <synthetic>', async () => {
    const models = (await getModelDistribution()).map((r) => r.model)
    expect(models).toEqual(['model-a', 'model-b'])
  })

  it('from and to are inclusive bounds on the timestamp', async () => {
    expect(byModel(await getModelDistribution(200, 400))).toEqual([
      { model: 'model-a', count: 2, ...totals(6) },
      { model: 'model-b', count: 1, ...totals(3) },
    ])
    expect(await getModelDistribution(201, 399)).toEqual([{ model: 'model-a', count: 1, ...totals(4) }])
    expect(await getModelDistribution(undefined, 100)).toEqual([{ model: 'model-a', count: 1, ...totals(1) }])
    expect(await getModelDistribution(900, undefined)).toEqual([{ model: 'model-a', count: 1, ...totals(1) }])
  })

  it('the agent filter keeps that agent only', async () => {
    expect(await getModelDistribution(undefined, undefined, 'agent-a')).toEqual([
      { model: 'model-a', count: 2, ...totals(3) },
      { model: 'model-b', count: 1, ...totals(5) },
    ])
    expect(byModel(await getModelDistribution(undefined, undefined, 'agent-b'))).toEqual([
      { model: 'model-a', count: 2, ...totals(5) },
      { model: 'model-b', count: 1, ...totals(3) },
    ])
    expect(await getModelDistribution(undefined, undefined, 'agent-none')).toEqual([])
  })

  it('every number comes back as a JS number, not as text (PostgreSQL sums are numeric until cast)', async () => {
    for (const row of await getModelDistribution()) {
      for (const key of ['count', 'totalInput', 'totalOutput', 'totalCacheRead', 'totalCacheCreation', 'totalThinking'] as const) {
        expect(typeof row[key], `${row.model}.${key}`).toBe('number')
      }
    }
  })

  it('an empty table is an empty list', async () => {
    await dbx.run('DELETE FROM token_usage')
    expect(await getModelDistribution()).toEqual([])
  })

  it('a token_usage that has no model column (an install that predates it) answers an empty list instead of failing', async () => {
    expect((await getModelDistribution()).length).toBeGreaterThan(0)
    await dbx.exec('ALTER TABLE token_usage DROP COLUMN model')
    expect(await getModelDistribution()).toEqual([])
  })

  // The sums are CAST to BIGINT on PostgreSQL (a SUM there is numeric or bigint, and an INTEGER cast would overflow past 2^31).
  // SQLite integers are 64-bit, so SQLite cannot tell the two casts apart: these cells are the PostgreSQL pin.
  it.each(COLUMNS)('a sum past 2^31 comes back exact, %s', async (column) => {
    await bigRows(column, 'model-big', null)
    const row = (await getModelDistribution()).find((r) => r.model === 'model-big')
    expect(row?.count).toBe(2)
    expect(row?.[column]).toBe(2 * BIG)
  })
})

describe('getToolStats', () => {
  it('groups by tool and model, counts, sums the five columns, lists the distinct agents, most calls first', async () => {
    const rows = await getToolStats()
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ tool_name: 'tool-x', model: 'model-a', count: 3, ...totals(4) })
    expect(agentsOf(rows[0]!.agents)).toEqual(['agent-a', 'agent-b'])
    expect(byTool(rows.slice(1)).map((r) => [r.tool_name, r.model, r.count, r.totalInput, agentsOf(r.agents)])).toEqual([
      ['tool-x', 'model-b', 1, 3, ['agent-b']],
      ['tool-y', 'model-a', 1, 4, ['agent-b']],
      ['tool-z', null, 1, 7, ['agent-a']],
    ])
  })

  it('the same tool on another model is its own row, and rows without a tool are left out', async () => {
    const rows = await getToolStats()
    expect(rows.map((r) => `${r.tool_name}/${r.model}`).sort()).toEqual(['tool-x/model-a', 'tool-x/model-b', 'tool-y/model-a', 'tool-z/null'])
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(6) // 9 rows, 3 without a tool
  })

  it('from and to are inclusive bounds on the timestamp', async () => {
    const rows = await getToolStats(100, 200)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool_name: 'tool-x', model: 'model-a', count: 2, ...totals(3) })
    expect(agentsOf(rows[0]!.agents)).toEqual(['agent-a'])
    expect((await getToolStats(201, 299))).toEqual([])
  })

  it('the agent filter keeps that agent only, and the agent list is that agent alone', async () => {
    const rows = await getToolStats(undefined, undefined, 'agent-b')
    expect(byTool(rows).map((r) => [r.tool_name, r.model, r.count, agentsOf(r.agents)])).toEqual([
      ['tool-x', 'model-a', 1, ['agent-b']],
      ['tool-x', 'model-b', 1, ['agent-b']],
      ['tool-y', 'model-a', 1, ['agent-b']],
    ])
  })

  it('every number comes back as a JS number and the agent list as text', async () => {
    for (const row of await getToolStats()) {
      for (const key of ['count', 'totalInput', 'totalOutput', 'totalCacheRead', 'totalCacheCreation', 'totalThinking'] as const) {
        expect(typeof row[key], `${row.tool_name}.${key}`).toBe('number')
      }
      expect(typeof row.agents).toBe('string')
    }
  })

  it('an empty table is an empty list', async () => {
    await dbx.run('DELETE FROM token_usage')
    expect(await getToolStats()).toEqual([])
  })

  // the same PostgreSQL pin as the model distribution: the five sums are CAST to BIGINT, past 2^31 they come back exact
  it.each(COLUMNS)('a sum past 2^31 comes back exact, %s', async (column) => {
    await bigRows(column, 'model-big', 'tool-big')
    const row = (await getToolStats()).find((r) => r.tool_name === 'tool-big')
    expect(row?.count).toBe(2)
    expect(row?.[column]).toBe(2 * BIG)
  })
})
