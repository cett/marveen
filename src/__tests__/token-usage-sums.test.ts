// The token aggregates of db/observability.ts return NUMBERS on both backends. In PostgreSQL sum() of a bigint column
// is numeric, which the driver hands back as a string: "123" + "456" is "123456" in JavaScript, and a chart or a
// metric that adds two rows silently shows the wrong total. Every aggregate casts its sum in the statement
// (CAST(SUM(x) AS BIGINT)); the cells add the values of two result rows (123 + 456 must be 579, not 123456) and check
// the type. The same file runs on SQLite (the default suite) and in the PG module run (ported list).
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import {
  getTokenSummary, getTokenTimeline, sumTokenUsageByModel, sumTokenUsageWindow, tokenUsageHistogramWindow,
} from '../db/observability.js'

const { dbx } = useTestDb()

// five columns, two rows: the first row holds [a], the second [b]; the sums are 579, 779, 979, 1179, 1379
const COLS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'thinking_tokens'] as const
const A = [123, 223, 323, 423, 523]
const B = [456, 556, 656, 756, 856]
const SUMS = A.map((x, i) => x + B[i])
const T = 1000

async function seed(): Promise<void> {
  const ins = (agent: string, model: string, v: number[]) => dbx.run(
    `INSERT INTO token_usage (agent, session_id, timestamp, ${COLS.join(', ')}, model, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent, `session-${agent}`, T, ...v, model, 'tool-x',
  )
  await ins('agent-a', 'model-a', A)
  await ins('agent-b', 'model-b', B)
}

/** The two rows' values of `key` added the JavaScript way: a string would concatenate. */
function addTwo(rows: Record<string, unknown>[], key: string): unknown {
  expect(rows, `rows for ${key}`).toHaveLength(2)
  for (const r of rows) expect(typeof r[key], `${key} is a number`).toBe('number')
  return (rows[0][key] as number) + (rows[1][key] as number)
}

describe('token aggregates are numbers', () => {
  it('sumTokenUsageWindow (the OTel delta metric)', async () => {
    await seed()
    const rows = await sumTokenUsageWindow(0, 2000)
    COLS.forEach((c, i) => expect(addTwo(rows as unknown as Record<string, unknown>[], c)).toBe(SUMS[i]))
  })

  it('tokenUsageHistogramWindow (the OTel histogram sum)', async () => {
    await seed()
    const rows = await tokenUsageHistogramWindow(0, 2000)
    const input = rows.filter((r) => r.token_type === 'input') as unknown as Record<string, unknown>[]
    const output = rows.filter((r) => r.token_type === 'output') as unknown as Record<string, unknown>[]
    expect(addTwo(input, 'total')).toBe(SUMS[0])
    expect(addTwo(output, 'total')).toBe(SUMS[1])
    for (const r of rows) {
      expect(typeof r.n).toBe('number')
      expect(typeof r.bucket).toBe('number')
    }
  })

  it('getTokenSummary (the token-usage page): per agent and per model', async () => {
    await seed()
    const rows = await getTokenSummary()
    const keys = ['totalInput', 'totalOutput', 'totalCacheRead', 'totalCacheCreation', 'totalThinking']
    keys.forEach((k, i) => expect(addTwo(rows as unknown as Record<string, unknown>[], k)).toBe(SUMS[i]))
    const perModel = rows.flatMap((r) => r.perModel) as unknown as Record<string, unknown>[]
    keys.forEach((k, i) => expect(addTwo(perModel, k)).toBe(SUMS[i]))
  })

  it('sumTokenUsageByModel (the card token usage window), the COALESCE form', async () => {
    await dbx.run(`INSERT INTO token_usage (agent, session_id, timestamp, ${COLS.join(', ')}, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'agent-a', 's1', T, ...A, 'model-a')
    await dbx.run(`INSERT INTO token_usage (agent, session_id, timestamp, ${COLS.join(', ')}, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'agent-a', 's2', T, ...B, 'model-b')
    const rows = await sumTokenUsageByModel('agent-a', 0, 2000) as unknown as Record<string, unknown>[]
    const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']
    keys.forEach((k, i) => expect(addTwo(rows, k)).toBe(SUMS[i]))
    for (const r of rows) expect(typeof r.calls).toBe('number')
  })

  it('getTokenTimeline: the expression inside the sum', async () => {
    await seed()
    const rows = await getTokenTimeline(60, 0, 2000) as unknown as Record<string, unknown>[]
    // inputTokens is input + cache_read + cache_creation of each row
    expect(addTwo(rows, 'inputTokens')).toBe(A[0] + A[2] + A[3] + B[0] + B[2] + B[3])
    expect(addTwo(rows, 'outputTokens')).toBe(SUMS[1])
  })
})
