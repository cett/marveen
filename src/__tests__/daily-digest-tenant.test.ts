// The daily digest belongs to the owner, and the owner is the `default` tenant. Every agent memory is filed under the owner chat
// with the tenant of its agent, so a read of the chat that is not filtered to the tenant summarized the memories of EVERY
// tenant and stored the summary as a `default` memory: a cross-tenant leak. The read and the write now each run in a block of
// the `default` tenant, the read is filtered to it, and the write names its tenant. Real test database, the real digest,
// recorders that note the db context; only the model call is replaced.
//
// Fixtures are neutral: tenants `tenant-a` / `tenant-b`, agents `agent-a` / `agent-b`.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { dbx, saveAgentMemory, saveMemory, getDbContextStats, currentDbContext } from '../db.js'
import { ALLOWED_CHAT_ID } from '../config.js'
import { useTestDb } from './helpers/with-test-db.js'

type Seen = { fn: string; role?: string; tenantId?: string; args: unknown[] }
const seen: Seen[] = []
const note = (fn: string, args: unknown[]): void => {
  const ctx = currentDbContext()
  seen.push({ fn, role: ctx?.role, tenantId: ctx?.tenantId, args })
}
const prompts: string[] = []

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../agent.js', () => ({
  runAgent: vi.fn((prompt: string) => { prompts.push(prompt); return Promise.resolve({ text: 'summary of the day' }) }),
}))
// the digest creates its working directories under the home: a throwaway one, so the test leaves the real home alone
const FAKE_HOME = join(process.env['TMPDIR'] ?? '/tmp', `digest-tenant-home-${process.pid}`)
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => FAKE_HOME }))
vi.mock('../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db.js')>()
  return {
    ...real,
    getMemoriesForChat: (...a: Parameters<typeof real.getMemoriesForChat>) => { note('getMemoriesForChat', a); return real.getMemoriesForChat(...a) },
    saveMemory: (...a: Parameters<typeof real.saveMemory>) => { note('saveMemory', a); return real.saveMemory(...a) },
  }
})

import { runDailyDigest } from '../memory.js'

const calls = (fn: string): Seen[] => seen.filter((s) => s.fn === fn)

describe('daily digest: the owner tenant only, in its own block', () => {
  useTestDb()
  afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

  beforeEach(async () => {
    seen.length = 0
    prompts.length = 0
    await saveAgentMemory('agent-a', 'owner note one about the budget', 'hot', 'k', false, 'default')
    await saveAgentMemory('agent-b', 'owner note two about the roadmap', 'warm', 'k', false, 'default')
    await saveAgentMemory('agent-a', 'secret plan of the first foreign tenant', 'hot', 'k', false, 'tenant-a')
    await saveAgentMemory('agent-b', 'secret plan of the second foreign tenant', 'hot', 'k', false, 'tenant-b')
    // a row whose tenant is empty (the column is NOT NULL, so empty is the closest thing to "none"): never the owner's
    await dbx.run(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, tenant_id) VALUES (?, 'row with no tenant', 'semantic', 1.0, ?, ?, '')`,
      ALLOWED_CHAT_ID, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000),
    )
    seen.length = 0
  })

  it('only the owner tenant reaches the prompt: the memories of other tenants and a row without a tenant do not', async () => {
    expect(await runDailyDigest(ALLOWED_CHAT_ID)).toBe('summary of the day')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('owner note one about the budget')
    expect(prompts[0]).toContain('owner note two about the roadmap')
    expect(prompts[0]).not.toContain('secret plan')
    expect(prompts[0]).not.toContain('row with no tenant')
    expect(calls('getMemoriesForChat').map((s) => s.args[2])).toEqual(['default'])
  })

  it('the read and the write run in a block of the default tenant, and the summary is stored as a default memory', async () => {
    await runDailyDigest(ALLOWED_CHAT_ID)
    const inBlock = { role: 'tenant', tenantId: 'default' }
    expect(calls('getMemoriesForChat').map((s) => ({ role: s.role, tenantId: s.tenantId }))).toEqual([inBlock])
    expect(calls('saveMemory').map((s) => ({ role: s.role, tenantId: s.tenantId }))).toEqual([inBlock])
    expect(calls('saveMemory')[0]!.args[4]).toBe('default') // the stamp is an explicit argument
    const row = await dbx.get<{ tenant_id: string; sector: string }>("SELECT tenant_id, sector FROM memories WHERE content LIKE '[Napi naplo %'")
    expect(row).toEqual({ tenant_id: 'default', sector: 'episodic' })
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('a world where only a foreign tenant has memories today gives no digest: nothing is summarized, nothing is written', async () => {
    await dbx.run("DELETE FROM memories WHERE tenant_id IN ('default', '')")
    seen.length = 0
    expect(await runDailyDigest(ALLOWED_CHAT_ID)).toBeNull()
    expect(prompts).toEqual([])
    expect(calls('saveMemory')).toEqual([])
  })

  it('saveMemory stamps the tenant it is given, and `default` when none is given', async () => {
    await saveMemory('chat-x', 'stamped by argument', 'episodic', undefined, 'tenant-b')
    await saveMemory('chat-x', 'stamped by default', 'episodic')
    const rows = await dbx.all<{ content: string; tenant_id: string }>("SELECT content, tenant_id FROM memories WHERE chat_id = 'chat-x' ORDER BY id")
    expect(rows).toEqual([
      { content: 'stamped by argument', tenant_id: 'tenant-b' },
      { content: 'stamped by default', tenant_id: 'default' },
    ])
  })
})
