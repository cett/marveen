// createBackgroundTaskAtomic: the tenant stamp is resolved BEFORE the transaction opens. A facade read inside a
// transaction body would run on another pooled connection in Phase 2 (it would not see the uncommitted writes and can
// exhaust the pool). Real in-memory database.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db, dbx, initDatabase, createBackgroundTaskAtomic } from '../db.js'

beforeEach(() => { initDatabase(':memory:') })
afterEach(() => { vi.restoreAllMocks() })

/** SQL of every facade statement that runs while a transaction is open. */
function spyFacadeInTx(): string[] {
  const seen: string[] = []
  let open = 0
  const realTx = dbx.tx.bind(dbx) as (fn: (tx: never) => Promise<unknown>) => Promise<unknown>
  vi.spyOn(dbx, 'tx').mockImplementation((async (fn: (tx: never) => Promise<unknown>) => {
    open++
    try { return await realTx(fn) } finally { open-- }
  }) as never)
  for (const m of ['get', 'run', 'all'] as const) {
    const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => {
      if (open > 0) seen.push(sql.replace(/\s+/g, ' ').trim().slice(0, 70))
      return real(sql, ...a)
    }) as never)
  }
  return seen
}

describe('createBackgroundTaskAtomic', () => {
  it('runs no facade statement in the transaction body and stamps the resolved tenant', async () => {
    const seen = spyFacadeInTx()
    const task = await createBackgroundTaskAtomic('bg1', 'agent-a', 'do it', 'tmux-1', 3)
    expect(task?.id).toBe('bg1')
    expect(seen).toEqual([])
    expect((db.prepare('SELECT tenant_id FROM background_tasks WHERE id = ?').get('bg1') as { tenant_id: string | null }).tenant_id).toBe('default')
  })

  it('answers null at the limit and writes nothing', async () => {
    await createBackgroundTaskAtomic('bg1', 'agent-a', 'one', 'tmux-1', 1)
    expect(await createBackgroundTaskAtomic('bg2', 'agent-a', 'two', 'tmux-2', 1)).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS c FROM background_tasks').get() as { c: number }).c).toBe(1)
  })
})
