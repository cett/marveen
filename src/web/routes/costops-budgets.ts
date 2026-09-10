// Budget CRUD -- lets the dashboard Settings page manage costops-config.json's
// `budgets` array (limit + block_on_hard) through the UI instead of hand-editing
// the file. Global, admin-only: costops is the operator's own cost tracking,
// not tenant data.
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig, saveCostopsConfig, type BudgetEntry } from '../../costops/config.js'
import { evaluateBudgets } from '../../costops/budget-alert.js'
import type { RouteContext } from './types.js'

const VALID_SCOPES = new Set(['global', 'source', 'provider', 'product', 'agent'])
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

type ValidationResult = { value: BudgetEntry } | { error: string; field: string; hint: string }

/**
 * Validate + merge a request body onto a base entry (empty for create, the
 * existing entry for update -- id always comes from elsewhere, never the body).
 */
function normalizeBudgetEntry(id: string, body: Record<string, unknown>, base: Partial<BudgetEntry>): ValidationResult {
  const amount = body.amount !== undefined ? body.amount : base.amount
  if (typeof amount !== 'number' || !isFinite(amount) || amount < 0) {
    return { error: 'invalid_value', field: 'amount', hint: 'amount must be a non-negative number (token count)' }
  }

  const scope = body.scope !== undefined ? body.scope : (base.scope ?? 'global')
  if (typeof scope !== 'string' || !VALID_SCOPES.has(scope)) {
    return { error: 'invalid_value', field: 'scope', hint: `scope must be one of: ${[...VALID_SCOPES].join(', ')}` }
  }

  const scope_ref = body.scope_ref !== undefined ? body.scope_ref : base.scope_ref
  if (scope === 'agent' && (typeof scope_ref !== 'string' || !scope_ref)) {
    return { error: 'required', field: 'scope_ref', hint: 'scope "agent" requires a non-empty scope_ref (agent id)' }
  }
  if (scope_ref !== undefined && typeof scope_ref !== 'string') {
    return { error: 'invalid_value', field: 'scope_ref', hint: 'scope_ref must be a string' }
  }

  for (const field of ['warning_threshold', 'hard_threshold'] as const) {
    const v = body[field] !== undefined ? body[field] : base[field]
    if (v !== undefined && (typeof v !== 'number' || !isFinite(v) || v < 0)) {
      return { error: 'invalid_value', field, hint: `${field} must be a non-negative number (fraction, e.g. 0.8)` }
    }
  }

  const name = body.name !== undefined ? body.name : base.name
  if (name !== undefined && typeof name !== 'string') {
    return { error: 'invalid_value', field: 'name', hint: 'name must be a string' }
  }

  const block_on_hard = body.block_on_hard !== undefined ? body.block_on_hard === true : (base.block_on_hard ?? false)

  return {
    value: {
      id,
      name: (name as string | undefined) ?? id,
      scope: scope as BudgetEntry['scope'],
      scope_ref: scope_ref as string | undefined,
      amount,
      warning_threshold: (body.warning_threshold as number | undefined) ?? base.warning_threshold ?? 0.8,
      hard_threshold: (body.hard_threshold as number | undefined) ?? base.hard_threshold ?? 1.0,
      block_on_hard,
    },
  }
}

export async function tryHandleCostopsBudgets(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (!path.startsWith('/api/costops/budgets')) return false

  if (ctx.role !== 'admin') {
    json(res, { error: 'forbidden', hint: 'CostOps budgets are admin-only' }, 403)
    return true
  }

  if (path === '/api/costops/budgets' && method === 'GET') {
    const { config } = loadCostopsConfig()
    // Enriched with live status (spent/ratio/level/blocked) so this one
    // response serves both the Settings CRUD table and the read-only
    // budget-status widget on the token-usage page -- no separate endpoint.
    const statuses = evaluateBudgets(getDb(), config, Date.now())
    const budgets = statuses.map((s) => ({ ...s.budget, spent: s.spent, ratio: s.ratio, level: s.level, blocked: s.blocked }))
    json(res, { budgets })
    return true
  }

  if (path === '/api/costops/budgets' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
      if (typeof body.id !== 'string' || !ID_PATTERN.test(body.id)) {
        json(res, { error: 'invalid_value', field: 'id', hint: 'id must be lowercase letters/digits/-/_, max 63 chars' }, 400)
        return true
      }
      const { config } = loadCostopsConfig()
      if (config.budgets.some((b) => b.id === body.id)) {
        json(res, { error: 'conflict', hint: `Budget "${body.id}" already exists` }, 409)
        return true
      }
      const result = normalizeBudgetEntry(body.id, body, {})
      if ('error' in result) {
        json(res, result, 400)
        return true
      }
      config.budgets.push(result.value)
      const saved = saveCostopsConfig(config)
      logger.info({ id: result.value.id }, 'CostOps budget created')
      json(res, { ok: true, budget: result.value, errors: saved.errors }, 201)
    } catch (err) {
      logger.error({ err }, 'Failed to create CostOps budget')
      json(res, { error: 'internal_error', hint: 'Failed to create budget' }, 500)
    }
    return true
  }

  const idMatch = path.match(/^\/api\/costops\/budgets\/([^/]+)$/)
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1])
    const { config } = loadCostopsConfig()
    const idx = config.budgets.findIndex((b) => b.id === id)
    if (idx === -1) {
      json(res, { error: 'not_found', hint: `Budget "${id}" not found` }, 404)
      return true
    }

    if (method === 'PUT') {
      try {
        const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
        const result = normalizeBudgetEntry(id, body, config.budgets[idx])
        if ('error' in result) {
          json(res, result, 400)
          return true
        }
        config.budgets[idx] = result.value
        const saved = saveCostopsConfig(config)
        logger.info({ id }, 'CostOps budget updated')
        json(res, { ok: true, budget: result.value, errors: saved.errors })
      } catch (err) {
        logger.error({ err }, 'Failed to update CostOps budget')
        json(res, { error: 'internal_error', hint: 'Failed to update budget' }, 500)
      }
      return true
    }

    if (method === 'DELETE') {
      config.budgets.splice(idx, 1)
      saveCostopsConfig(config)
      logger.info({ id }, 'CostOps budget deleted')
      json(res, { ok: true })
      return true
    }
  }

  return false
}
