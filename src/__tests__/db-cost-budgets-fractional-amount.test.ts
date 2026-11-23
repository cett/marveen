// A budget amount that is not a whole number (1000.5) is valid input on both engines: the route accepts any finite non-negative
// number, the config file holds one, and the SQLite column is INTEGER affinity, which keeps a REAL value as it is. PostgreSQL
// needs the column to be double precision (migration 0008), so this cell runs on both engines (useTestDb): the value goes in
// through the route and through the file importer, and it comes back the same from the database.
//
// Privacy: neutral fixtures only (fractional-budget, file-budget).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const { ROOT, STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk, mkdirSync: mkd } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  const root = mk(j(tmp(), 'carl-cost-budgets-fractional-'))
  mkd(j(root, 'store'), { recursive: true })
  return { ROOT: root, STORE: j(root, 'store') }
})

vi.mock('../paths.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../paths.js')>()), STORE_DIR: STORE }))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), PROJECT_ROOT: ROOT, STORE_DIR: STORE }))

import { useTestDb } from './helpers/with-test-db.js'
import { listCostBudgets, migrateCostBudgetsFromFileAsync } from '../db/cost-budgets.js'
import { tryHandleCostopsBudgets } from '../web/routes/costops-budgets.js'

useTestDb()

function postBudget(body: object): { ctx: RouteContext; status: () => number; body: () => any } {
  const raw = JSON.stringify(body)
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = { writeHead: (c: number) => { code = c }, end: (d?: string) => { resBody = d ?? '' } }
  const url = new URL('http://localhost/api/costops/budgets')
  return {
    ctx: {
      req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: 'POST', url,
      auth: { kind: 'session', user: 'owner' }, role: 'admin',
    } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

beforeAll(() => { mkdirSync(STORE, { recursive: true }) })
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })
beforeEach(async () => {
  const { dbx } = await import('../db.js')
  await dbx.run('DELETE FROM cost_budgets')
})

describe('a fractional budget amount', () => {
  it('the route accepts 1000.5 and the database returns 1000.5', async () => {
    const { ctx, status, body } = postBudget({ id: 'fractional-route', name: 'Fractional', amount: 1000.5, warning_threshold: 0.8, hard_threshold: 1.0 })
    await tryHandleCostopsBudgets(ctx)
    expect(status()).toBe(201)
    expect(body().budget).toMatchObject({ id: 'fractional-route', amount: 1000.5 })
    const rows = await listCostBudgets('default')
    expect(rows.find((r) => r.id === 'fractional-route')?.amount).toBe(1000.5)
  })

  it('the file importer takes 1000.5 from costops-config.json and the database returns 1000.5', async () => {
    writeFileSync(join(STORE, 'costops-config.json'), JSON.stringify({ version: 1, currency: 'HUF', budgets: [{ id: 'fractional-file', amount: 1000.5 }] }))
    expect(await migrateCostBudgetsFromFileAsync()).toBe(1)
    const rows = await listCostBudgets('default')
    expect(rows.find((r) => r.id === 'fractional-file')?.amount).toBe(1000.5)
  })
})
