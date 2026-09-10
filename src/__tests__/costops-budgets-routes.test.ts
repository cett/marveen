import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'costops-budgets-routes-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))

import { initDatabase, getDb } from '../db.js'
import { tryHandleCostopsBudgets } from '../web/routes/costops-budgets.js'

const COSTOPS_CONFIG_PATH = join(STORE_DIR, 'costops-config.json')

function makeCtx(opts: { method: string; path: string; body?: object; role?: RouteContext['role'] }): {
  ctx: RouteContext; status: () => number; body: () => any
} {
  const raw = opts.body ? JSON.stringify(opts.body) : ''
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: {
      req: em as http.IncomingMessage,
      res: res as unknown as http.ServerResponse,
      path: url.pathname,
      method: opts.method,
      url,
      auth: { kind: 'session', user: 'owner' },
      role: opts.role,
    } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  try { rmSync(COSTOPS_CONFIG_PATH) } catch { /* fine */ }
})

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('costops budgets route -- auth gate', () => {
  it('rejects a non-admin caller with 403 on every method', async () => {
    for (const method of ['GET', 'POST']) {
      const { ctx, status, body } = makeCtx({ method, path: '/api/costops/budgets', role: 'viewer' as any })
      await tryHandleCostopsBudgets(ctx)
      expect(status()).toBe(403)
      expect(body().error).toBe('forbidden')
    }
  })
})

describe('costops budgets route -- CRUD', () => {
  it('GET returns an empty list when no config exists yet', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/costops/budgets', role: 'admin' })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(200)
    expect(body().budgets).toEqual([])
  })

  it('POST creates a budget and persists it to costops-config.json', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/costops/budgets',
      role: 'admin',
      body: { id: 'global-monthly', name: 'Global monthly', amount: 5_000_000, warning_threshold: 0.8, hard_threshold: 1.0 },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(201)
    expect(body().budget).toMatchObject({ id: 'global-monthly', amount: 5_000_000, block_on_hard: false })

    expect(existsSync(COSTOPS_CONFIG_PATH)).toBe(true)
    const onDisk = JSON.parse(readFileSync(COSTOPS_CONFIG_PATH, 'utf-8'))
    expect(onDisk.budgets).toHaveLength(1)
    expect(onDisk.budgets[0].id).toBe('global-monthly')
  })

  it('GET enriches each budget with live status (spent/ratio/level/blocked)', async () => {
    await tryHandleCostopsBudgets(makeCtx({
      method: 'POST', path: '/api/costops/budgets', role: 'admin',
      body: { id: 'status-check', amount: 1000, hard_threshold: 1.0 },
    }).ctx)

    const nowSec = Math.floor(Date.now() / 1000)
    getDb().prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, tenant_id)
      VALUES ('agent-a', 'sess-1', ?, 900, 100, 'default')
    `).run(nowSec)

    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/costops/budgets', role: 'admin' })
    await tryHandleCostopsBudgets(ctx)
    expect(body().budgets[0]).toMatchObject({ id: 'status-check', spent: 1000, ratio: 1, level: 'hard', blocked: false })
  })

  it('rejects an id that fails the slug pattern', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/costops/budgets',
      role: 'admin',
      body: { id: 'Not A Slug!', amount: 1000 },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(400)
    expect(body().field).toBe('id')
  })

  it('rejects a negative amount', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/costops/budgets',
      role: 'admin',
      body: { id: 'bad-amount', amount: -5 },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(400)
    expect(body().field).toBe('amount')
  })

  it('requires scope_ref when scope is "agent"', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/costops/budgets',
      role: 'admin',
      body: { id: 'agent-budget', amount: 1000, scope: 'agent' },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(400)
    expect(body().field).toBe('scope_ref')
  })

  it('requires scope_ref when scope is "tenant"', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/costops/budgets',
      role: 'admin',
      body: { id: 'tenant-budget', amount: 1000, scope: 'tenant' },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(400)
    expect(body().field).toBe('scope_ref')
  })

  it('accepts a tenant-scoped budget with scope_ref set', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/costops/budgets',
      role: 'admin',
      body: { id: 'acme-monthly', amount: 1000, scope: 'tenant', scope_ref: 'acme' },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(201)
    expect(body().budget).toMatchObject({ scope: 'tenant', scope_ref: 'acme' })
  })

  it('409s on a duplicate id', async () => {
    await tryHandleCostopsBudgets(makeCtx({
      method: 'POST', path: '/api/costops/budgets', role: 'admin', body: { id: 'dup', amount: 1000 },
    }).ctx)
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/costops/budgets', role: 'admin', body: { id: 'dup', amount: 2000 },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(409)
    expect(body().error).toBe('conflict')
  })

  it('PUT updates an existing budget (partial merge, id immutable)', async () => {
    await tryHandleCostopsBudgets(makeCtx({
      method: 'POST', path: '/api/costops/budgets', role: 'admin',
      body: { id: 'global-monthly', name: 'Global', amount: 1000, block_on_hard: false },
    }).ctx)

    const { ctx, status, body } = makeCtx({
      method: 'PUT', path: '/api/costops/budgets/global-monthly', role: 'admin',
      body: { amount: 2000, block_on_hard: true },
    })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(200)
    expect(body().budget).toMatchObject({ id: 'global-monthly', name: 'Global', amount: 2000, block_on_hard: true })
  })

  it('PUT 404s on an unknown id', async () => {
    const { ctx, status } = makeCtx({ method: 'PUT', path: '/api/costops/budgets/missing', role: 'admin', body: { amount: 1 } })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(404)
  })

  it('DELETE removes a budget', async () => {
    await tryHandleCostopsBudgets(makeCtx({
      method: 'POST', path: '/api/costops/budgets', role: 'admin', body: { id: 'to-delete', amount: 1000 },
    }).ctx)

    const del = makeCtx({ method: 'DELETE', path: '/api/costops/budgets/to-delete', role: 'admin' })
    await tryHandleCostopsBudgets(del.ctx)
    expect(del.status()).toBe(200)

    const list = makeCtx({ method: 'GET', path: '/api/costops/budgets', role: 'admin' })
    await tryHandleCostopsBudgets(list.ctx)
    expect(list.body().budgets).toEqual([])
  })

  it('DELETE 404s on an unknown id', async () => {
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/costops/budgets/missing', role: 'admin' })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(404)
  })
})
