// W3-7b: the memory maintenance, read batch, span export mark and token usage calls of src/db/observability.ts
// on the async facade.
//  - every one of them is ONE dbx.tx and every statement of it runs on the tx handle (none through dbx itself),
//  - a failing statement rolls the whole unit back (a delete trigger / a raising trigger forces the failure),
//  - overlapped calls all land.
// Real in-memory database.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  dbx, getDb, initDatabase, saveAgentMemory, runMemoryMaintenance, recordMemoryReadBatch,
  upsertOtelSpan, markOtelSpansExported, recordTokenUsageCalls, getTokenUsageCursor,
} from '../db.js'
import type { TokenUsageCall } from '../db.js'

beforeEach(() => { initDatabase(':memory:') })
afterEach(() => { vi.restoreAllMocks() })

const DAY = 86400
const nowS = () => Math.floor(Date.now() / 1000)

async function mem(content: string, category: string, agentId: string, ageDays = 0): Promise<number> {
  await saveAgentMemory(agentId, content, category, 'kw')
  const row = getDb().prepare('SELECT id FROM memories WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId) as { id: number }
  getDb().prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(nowS() - ageDays * DAY, row.id)
  return row.id
}

function cat(id: number): string {
  return (getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }).category
}

/** Counts the facade entry points used OUTSIDE a transaction handle, and the transactions opened. */
function spyFacade(): { direct: string[]; txs: { n: number } } {
  const direct: string[] = []
  const txs = { n: 0 }
  for (const m of ['get', 'run', 'all', 'exec'] as const) {
    const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => {
      direct.push(sql.replace(/\s+/g, ' ').trim())
      return real(sql, ...a)
    }) as never)
  }
  const realTx = dbx.tx.bind(dbx)
  vi.spyOn(dbx, 'tx').mockImplementation(((fn: never, o: never) => { txs.n++; return realTx(fn, o) }) as never)
  return { direct, txs }
}

function call(over: Partial<TokenUsageCall>): TokenUsageCall {
  return {
    agent: 'a1', sessionId: 's1', timestamp: 1000, inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, model: null, contentPreview: '', toolName: null,
    ...over,
  }
}

describe('recordMemoryReadBatch', () => {
  it('writes the whole batch in one transaction, every insert on the tx handle', async () => {
    const ids = [await mem('m1', 'warm', 'ag'), await mem('m2', 'warm', 'ag'), await mem('m3', 'warm', 'ag')]
    const spy = spyFacade()
    await recordMemoryReadBatch('ag', ids, 'search')
    expect(spy.txs.n).toBe(1)
    expect(spy.direct).toEqual([])
    expect(getDb().prepare("SELECT COUNT(*) c FROM span_reads WHERE agent_id = 'ag' AND context = 'search'").get()).toEqual({ c: 3 })
  })

  it('an empty batch opens no transaction', async () => {
    const spy = spyFacade()
    await recordMemoryReadBatch('ag', [], 'search')
    expect(spy.txs.n).toBe(0)
    expect(spy.direct).toEqual([])
  })

  it('a failing insert in the middle rolls the whole batch back', async () => {
    const ids = [await mem('m1', 'warm', 'ag'), await mem('m2', 'warm', 'ag'), await mem('m3', 'warm', 'ag')]
    getDb().exec(`CREATE TRIGGER fail_read BEFORE INSERT ON span_reads WHEN NEW.memory_id = ${ids[1]}
      BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    await expect(recordMemoryReadBatch('ag', ids, 'direct')).rejects.toThrow('forced')
    expect(getDb().prepare('SELECT COUNT(*) c FROM span_reads').get()).toEqual({ c: 0 })
  })

  it('overlapped batches all land', async () => {
    const a = await mem('m1', 'warm', 'ag')
    const b = await mem('m2', 'warm', 'ag')
    await Promise.all([
      recordMemoryReadBatch('ag', [a, b], 'search'),
      recordMemoryReadBatch('ag', [a, b], 'heartbeat'),
      recordMemoryReadBatch('ag2', [a], 'direct'),
    ])
    expect(getDb().prepare('SELECT COUNT(*) c FROM span_reads').get()).toEqual({ c: 5 })
  })
})

describe('markOtelSpansExported', () => {
  async function spans(n: number): Promise<{ trace_id: string; span_id: string }[]> {
    const out: { trace_id: string; span_id: string }[] = []
    for (let i = 0; i < n; i++) {
      await upsertOtelSpan({ trace_id: 't1', span_id: `s${i}`, agent_id: 'ag', operation: 'op', start_ms: 1, end_ms: 2, status: 'ok', parent_span_id: null, attributes: null })
      out.push({ trace_id: 't1', span_id: `s${i}` })
    }
    return out
  }
  const exported = () => (getDb().prepare('SELECT COUNT(*) c FROM otel_spans WHERE exported_at IS NOT NULL').get() as { c: number }).c

  it('marks the batch in one transaction on the tx handle', async () => {
    const pairs = await spans(3)
    const spy = spyFacade()
    await markOtelSpansExported(pairs, 777)
    expect(spy.txs.n).toBe(1)
    expect(spy.direct).toEqual([])
    expect(exported()).toBe(3)
    expect(getDb().prepare('SELECT DISTINCT exported_at e FROM otel_spans').all()).toEqual([{ e: 777 }])
  })

  it('an empty batch is a no-op without a transaction', async () => {
    const spy = spyFacade()
    await markOtelSpansExported([], 1)
    expect(spy.txs.n).toBe(0)
  })

  it('a failing update rolls the marks already set back', async () => {
    const pairs = await spans(3)
    getDb().exec(`CREATE TRIGGER fail_mark BEFORE UPDATE OF exported_at ON otel_spans WHEN NEW.span_id = 's2'
      BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    await expect(markOtelSpansExported(pairs, 5)).rejects.toThrow('forced')
    expect(exported()).toBe(0)
  })
})

describe('recordTokenUsageCalls', () => {
  const rows = () => (getDb().prepare('SELECT COUNT(*) c FROM token_usage').get() as { c: number }).c

  it('upserts the calls and moves the cursor in one transaction on the tx handle', async () => {
    const spy = spyFacade()
    await recordTokenUsageCalls([call({ timestamp: 1 }), call({ timestamp: 2 })], 'tenant-x', '/f.jsonl', 7, 99)
    expect(spy.txs.n).toBe(1)
    expect(spy.direct).toEqual([])
    expect(rows()).toBe(2)
    expect(getDb().prepare('SELECT DISTINCT tenant_id t FROM token_usage').all()).toEqual([{ t: 'tenant-x' }])
    expect(await getTokenUsageCursor('/f.jsonl')).toEqual({ last_line: 7, last_size: 99 })
  })

  it('a cursor write that fails takes the inserted calls with it', async () => {
    getDb().exec(`CREATE TRIGGER fail_cursor BEFORE INSERT ON token_usage_cursors
      BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    await expect(recordTokenUsageCalls([call({ timestamp: 1 })], 'default', '/f.jsonl', 1, 1)).rejects.toThrow('forced')
    expect(rows()).toBe(0)
    expect(await getTokenUsageCursor('/f.jsonl')).toBeUndefined()
  })

  it('a failing call insert leaves the cursor where it was', async () => {
    getDb().prepare('INSERT INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)').run('/f.jsonl', 1, 1)
    getDb().exec(`CREATE TRIGGER fail_call BEFORE INSERT ON token_usage WHEN NEW.timestamp = 2
      BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    await expect(recordTokenUsageCalls([call({ timestamp: 1 }), call({ timestamp: 2 })], 'default', '/f.jsonl', 9, 9)).rejects.toThrow('forced')
    expect(rows()).toBe(0)
    expect(await getTokenUsageCursor('/f.jsonl')).toEqual({ last_line: 1, last_size: 1 })
  })

  it('a repeated call fills a missing model instead of duplicating the row', async () => {
    await recordTokenUsageCalls([call({ model: null })], 'default', '/f.jsonl', 1, 1)
    await recordTokenUsageCalls([call({ model: 'm-1' })], 'default', '/f.jsonl', 2, 2)
    expect(rows()).toBe(1)
    expect(getDb().prepare('SELECT model FROM token_usage').get()).toEqual({ model: 'm-1' })
  })
})

describe('runMemoryMaintenance', () => {
  async function seed(): Promise<{ warm: number; cold: number }> {
    const warm = await mem('old warm', 'warm', 'ag', 40)
    const cold = await mem('cold read by two', 'cold', 'ag', 40)
    const t = nowS() - DAY
    for (const agent of ['x', 'y']) {
      getDb().prepare('INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)').run(agent, cold, t, 'direct')
    }
    return { warm, cold }
  }
  const versions = () => getDb().prepare("SELECT memory_id, category FROM memory_versions WHERE changed_by = 'system:maintenance' ORDER BY id").all()

  it('runs both tier moves, their version log and the prune as ONE transaction on the tx handle', async () => {
    const { warm, cold } = await seed()
    getDb().prepare('INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?,?,?,?,?,?,?)')
      .run(warm, 'ancient', 'warm', null, 1, 'old', 'update')
    const spy = spyFacade()
    const res = await runMemoryMaintenance()
    expect(spy.txs.n).toBe(1)
    expect(spy.direct).toEqual([])
    expect(res).toEqual({ warmToCold: 1, coldToWarm: 1, prunedVersions: 1 })
    expect(cat(warm)).toBe('cold')
    expect(cat(cold)).toBe('warm')
    expect(versions()).toEqual([{ memory_id: warm, category: 'cold' }, { memory_id: cold, category: 'warm' }])
  })

  it('a failure in the cold -> warm step rolls the warm -> cold move and its version rows back', async () => {
    const { warm, cold } = await seed()
    getDb().exec(`CREATE TRIGGER fail_up BEFORE UPDATE OF category ON memories WHEN NEW.category = 'warm'
      BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    await expect(runMemoryMaintenance()).rejects.toThrow('forced')
    expect(cat(warm)).toBe('warm')
    expect(cat(cold)).toBe('cold')
    expect(versions()).toEqual([])
  })

  it('a failing version log insert leaves the category untouched', async () => {
    const { warm } = await seed()
    getDb().exec(`CREATE TRIGGER fail_log BEFORE INSERT ON memory_versions WHEN NEW.changed_by = 'system:maintenance'
      BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    await expect(runMemoryMaintenance()).rejects.toThrow('forced')
    expect(cat(warm)).toBe('warm')
  })

  it('a log row is written for exactly the memories that move (the candidate list matches the update)', async () => {
    const { warm } = await seed()
    await mem('young warm', 'warm', 'ag', 1)
    await mem('hot stays', 'hot', 'ag', 400)
    await runMemoryMaintenance()
    expect((versions() as { memory_id: number; category: string }[]).filter((v) => v.category === 'cold')).toEqual([{ memory_id: warm, category: 'cold' }])
  })

  it('overlapped runs do not double-move or double-log', async () => {
    const { warm, cold } = await seed()
    const [a, b] = await Promise.all([runMemoryMaintenance(), runMemoryMaintenance()])
    expect(a.warmToCold + b.warmToCold).toBe(1)
    expect(a.coldToWarm + b.coldToWarm).toBe(1)
    expect(cat(warm)).toBe('cold')
    expect(cat(cold)).toBe('warm')
    expect(versions()).toHaveLength(2)
  })
})
