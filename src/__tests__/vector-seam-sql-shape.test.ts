// The SQL shape of the vector seams (memory and document search, the artifact search, the hybrid document search) on a
// recording stub of the database backend: the bind order, the scope clause, the undefined tenant branch, the bad query
// vector, and the scope on both legs of the hybrid search. No PostgreSQL and no pgvector needed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dbx, useDbxBackend, type Dbx } from '../db/facade.js'
import { EMBEDDING_DIM, floatsToBlob, vectorSearch, pgVectorArtifacts } from '../db/vector.js'
import { hybridSearchDocs, pgVectorDocs } from '../db/workspace.js'

type Call = { sql: string; params: unknown[] }
let calls: Call[] = []
let canned: (sql: string) => unknown[] = () => []

function stub(): Dbx {
  // a canned throw is a rejected promise, as a real statement failure would be
  const settle = <T,>(f: () => T): Promise<T> => { try { return Promise.resolve(f()) } catch (err) { return Promise.reject(err) } }
  const ops = {
    get: (sql: string, ...params: unknown[]) => { calls.push({ sql, params }); return settle(() => canned(sql)[0]) },
    all: (sql: string, ...params: unknown[]) => { calls.push({ sql, params }); return settle(() => canned(sql)) },
    run: (sql: string, ...params: unknown[]) => { calls.push({ sql, params }); return Promise.resolve({ changes: 0, lastInsertRowid: 0 }) },
    exec: (sql: string) => { calls.push({ sql, params: [] }); return Promise.resolve() },
  }
  const tx = { ...ops, tx: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
  return { ...ops, tx: async (fn: (t: never) => Promise<unknown>) => fn(tx as never) } as unknown as Dbx
}

const vec = (seed: number): number[] => Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed * 1000 + i) * 0.5)
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
const vecCalls = (): Call[] => calls.filter((c) => /<->/.test(c.sql))

beforeEach(() => { calls = []; canned = () => []; useDbxBackend(stub(), 'pg') })
afterEach(() => { useDbxBackend(null); vi.restoreAllMocks() })

describe('Q1 memory search: the scope clause and the bind order', () => {
  it('tenant given: (agent OR shared) AND tenant, params = literal, agent, tenant, limit*factor', async () => {
    await vectorSearch('agent-a', vec(1), 3, false, 'tenant-a')
    const c = vecCalls()[0]!
    expect(norm(c.sql)).toContain("WHERE (m.agent_id = ? OR m.category = 'shared') AND m.tenant_id = ?")
    expect(c.params.length).toBe(4)
    expect(String(c.params[0]).startsWith('[')).toBe(true)
    expect(c.params.slice(1, 3)).toEqual(['agent-a', 'tenant-a'])
    expect(typeof c.params[3]).toBe('number')
  })
  it('tenant undefined: no tenant clause at all (the shared memories of every tenant are visible) - documented branch', async () => {
    await vectorSearch('agent-a', vec(1), 3, false, undefined)
    const c = vecCalls()[0]!
    expect(norm(c.sql)).not.toContain('tenant_id')
    expect(c.params.length).toBe(3)
  })
  it('crossAgent stays on the blob scan: no pgvector statement, no scope (the link-building path)', async () => {
    await vectorSearch('agent-a', vec(1), 3, true, 'tenant-a')
    expect(vecCalls().length).toBe(0)
    expect(norm(calls[0]!.sql)).not.toContain('tenant_id')
  })
})

describe('Q2 memory search: a bad QUERY vector', () => {
  const mem = (id: number, tenant: string) => ({ id, agent_id: 'agent-a', tenant_id: tenant, category: 'warm', created_at: 1, embedding_blob: floatsToBlob(vec(id)), embedding: null })
  it('NaN component: no pgvector statement is sent, the blob fallback runs with the tenant clause, nothing throws', async () => {
    canned = (sql) => (/FROM memories WHERE/.test(sql) ? [mem(1, 'tenant-a')] : [])
    const q = vec(1); q[5] = Number.NaN
    const r = await vectorSearch('agent-a', q, 3, false, 'tenant-a')
    expect(vecCalls().length).toBe(0)
    const fb = calls.find((c) => /FROM memories WHERE/.test(c.sql))!
    expect(norm(fb.sql)).toContain('AND tenant_id = ?')
    expect(fb.params).toEqual(['agent-a', 'tenant-a'])
    // the observation for the report: the fallback is not an empty result
    expect(r.length).toBe(1)
  })
  it('wrong length: same, no pgvector statement', async () => {
    canned = (sql) => (/FROM memories WHERE/.test(sql) ? [mem(1, 'tenant-a')] : [])
    const r = await vectorSearch('agent-a', new Array<number>(EMBEDDING_DIM - 1).fill(0.5), 3, false, 'tenant-a')
    expect(vecCalls().length).toBe(0)
    expect(r.length).toBe(1)
  })
  it('pgvector statement fails (dimension error from the server): falls back, the scope stays in the fallback', async () => {
    canned = (sql) => { if (/<->/.test(sql)) throw new Error('different vector dimensions 768 and 3'); return [mem(2, 'tenant-a')] }
    const r = await vectorSearch('agent-a', vec(2), 3, false, 'tenant-a')
    const fb = calls.filter((c) => /FROM memories WHERE/.test(c.sql)).pop()!
    expect(fb.params).toEqual(['agent-a', 'tenant-a'])
    expect(r.map((m) => m.id)).toEqual([2])
  })
})

describe('Q3 document search: the scope clause, the bind order and the bad vector', () => {
  it('tenant + agent: binary guard, tenant, agent, in that order; params = literal, tenant, agent, limit*2', async () => {
    await pgVectorDocs(vec(1), { tenantId: 't1', agentId: 'a1', limit: 4 })
    const c = vecCalls()[0]!
    expect(norm(c.sql)).toContain("WHERE d.content_type <> 'binary' AND d.tenant_id = ? AND d.agent_id = ?")
    expect(c.params.slice(1)).toEqual(['t1', 'a1', 8])
  })
  it('tenant empty string still filters (!== undefined): the document search is stricter than the memory search here', async () => {
    await pgVectorDocs(vec(1), { tenantId: '', limit: 4 })
    const c = vecCalls()[0]!
    expect(norm(c.sql)).toContain('d.tenant_id = ?')
    expect(c.params[1]).toBe('')
  })
  it('tenant undefined: no tenant clause (admin without ?tenant=), the binary guard stays', async () => {
    await pgVectorDocs(vec(1), { limit: 4 })
    const c = vecCalls()[0]!
    expect(norm(c.sql)).not.toContain('d.tenant_id = ?')
    expect(norm(c.sql)).toContain("content_type <> 'binary'")
  })
  it('NaN / wrong length / empty query vector: empty result, no statement, no throw', async () => {
    const nan = vec(1); nan[0] = Number.NaN
    expect(await pgVectorDocs(nan, { tenantId: 't', limit: 3 })).toEqual([])
    expect(await pgVectorDocs([1, 2, 3], { tenantId: 't', limit: 3 })).toEqual([])
    expect(await pgVectorDocs([], { tenantId: 't', limit: 3 })).toEqual([])
    expect(await pgVectorDocs(Array.from({ length: EMBEDDING_DIM }, () => Number.POSITIVE_INFINITY), { limit: 3 })).toEqual([])
    expect(vecCalls().length).toBe(0)
  })
  it('a server error is an empty result, not a throw', async () => {
    canned = () => { throw new Error('boom') }
    expect(await pgVectorDocs(vec(1), { tenantId: 't', limit: 3 })).toEqual([])
  })
  it('limit is a bound parameter, not interpolated into the text', async () => {
    await pgVectorDocs(vec(1), { tenantId: 't', limit: 4 })
    expect(vecCalls()[0]!.sql).not.toMatch(/LIMIT\s+\d/)
  })
})

describe('Q4 hybrid document search: both legs carry the scope', () => {
  it('the tenant and the agent reach the full-text leg and the vector leg', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ embedding: vec(1) })) as never)
    await hybridSearchDocs('alpha beta', { tenantId: 'tenant-x', agentId: 'agent-x', limit: 3 })
    const v = vecCalls()
    expect(v.length).toBe(1)
    expect(v[0]!.params).toContain('tenant-x')
    expect(v[0]!.params).toContain('agent-x')
    const fts = calls.filter((c) => /fts/.test(c.sql) && !/<->/.test(c.sql))
    expect(fts.length).toBeGreaterThan(0)
    for (const c of fts) {
      expect(c.params).toContain('tenant-x')
      expect(c.params).toContain('agent-x')
    }
  })
})

describe('Q5 artifacts (c6, in the head, not in the c4+c5 scope): scope', () => {
  it('no scope: no tenant clause (no caller in src; the doc comment says the argument becomes required)', async () => {
    await pgVectorArtifacts(vec(1), 3)
    expect(norm(vecCalls()[0]!.sql)).not.toContain('tenant_id')
  })
  it('scope.tenantId: filtered, bound', async () => {
    await pgVectorArtifacts(vec(1), 3, { tenantId: 'tenant-z' })
    expect(norm(vecCalls()[0]!.sql)).toContain('a.tenant_id = ?')
    expect(vecCalls()[0]!.params).toContain('tenant-z')
  })
})

describe('Q6 a stub sanity check: the probe sees what it claims to see', () => {
  it('dbx points at the stub', async () => {
    await dbx.all('SELECT 1')
    expect(calls.length).toBe(1)
  })
})
