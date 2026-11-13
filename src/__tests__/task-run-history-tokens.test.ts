// listTaskRunHistory estimates the tokens of a run as the sum of the agent's token rows in the run's window. In
// PostgreSQL sum() of a bigint is numeric, which the driver hands back as a string: the estimate would be a string
// ("456" + "123" is "456123"), and `total > 0 ? total : null` would hide it. The statement casts the sum, so
// tokens_est is a number on both backends. Same file on SQLite and in the PG module run (ported list).
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { listTaskRunHistory } from '../db/tasks.js'

const { dbx } = useTestDb()

const run = (ts: number) => dbx.run("INSERT INTO task_runs (name, agent, ts, status, tenant_id) VALUES ('task-a', 'agent-a', ?, 'fired', 'default')", ts)
const tokens = (agent: string, ts: number, i: number, o: number, c: number, session: string) => dbx.run(
  'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?)', agent, session, ts, i, o, c)

describe('listTaskRunHistory token estimate', () => {
  it('is a number per run (window [ts, next newer run)), null for a run without tokens', async () => {
    // runs at 1000 s, 2000 s and 9000 s (ms in the table); the first window ends where the second run starts
    await run(1_000_000)
    await run(2_000_000)
    await run(9_000_000)
    await tokens('agent-a', 1500, 100, 20, 3, 's1') // run 1: 123
    await tokens('agent-a', 2500, 400, 50, 6, 's2') // run 2: 456
    await tokens('agent-b', 1500, 999, 999, 999, 's3') // another agent: not counted
    const history = await listTaskRunHistory('task-a', 10)
    expect(history.map((h) => h.ts)).toEqual([9_000_000, 2_000_000, 1_000_000])
    expect(history.map((h) => h.tokens_est)).toEqual([null, 456, 123])
    expect(typeof history[1].tokens_est).toBe('number')
    expect((history[1].tokens_est as number) + (history[2].tokens_est as number)).toBe(579)
  })

  it('adds several rows of one window (the sum is over rows, not a single value)', async () => {
    await run(1_000_000)
    await tokens('agent-a', 1100, 100, 0, 0, 's1')
    await tokens('agent-a', 1200, 20, 3, 0, 's2')
    await tokens('agent-a', 4_600, 777, 0, 0, 's3') // the first second after the window (1000 s + one hour): not counted
    const [only] = await listTaskRunHistory('task-a', 10)
    expect(only.tokens_est).toBe(123)
  })
})
