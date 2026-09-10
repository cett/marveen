// Budget-plafon riasztás -- scheduled check entry point.
//
// Loads the local costops config, evaluates every budget against the current
// month's token spend, and notifies the configured channel once per cooldown
// window when a budget is at warning/hard level. Cooldown state lives in a
// gitignored runtime file (store/), not the DB, to match the design's "rare
// write, easy to debug by hand" choice.
//
// NOTE on block_on_hard: a 'hard' level with budget.block_on_hard === true is
// surfaced as BudgetStatus.blocked and called out in the notification text,
// but no enforcement action is taken here. What "blocking" concretely means
// (pause which scheduled tasks, for which scope, reversible how) is an open
// design question, tracked separately from this change.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'
import { loadCostopsConfig } from './config.js'
import { evaluateBudgets, type BudgetStatus } from './budget-alert.js'

const STATE_PATH = join(STORE_DIR, 'budget-alert-state.json')

const COOLDOWN_MS: Record<'warning' | 'hard', number> = {
  warning: 24 * 60 * 60 * 1000,
  hard: 6 * 60 * 60 * 1000,
}

interface CooldownEntry {
  warn_last_sent: number | null
  hard_last_sent: number | null
}

type CooldownState = Record<string, CooldownEntry>

function loadState(): CooldownState {
  if (!existsSync(STATE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as CooldownState
  } catch (err) {
    logger.warn({ err }, 'budget-alert-state.json is not valid JSON, resetting')
    return {}
  }
}

function saveState(state: CooldownState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

function formatMessage(status: BudgetStatus): string {
  const name = status.budget.name ?? status.budget.id
  const pct = Math.round(status.ratio * 100)
  const spentFmt = status.spent.toLocaleString('hu-HU')
  const amountFmt = status.budget.amount.toLocaleString('hu-HU')
  if (status.level === 'hard') {
    const blockedNote = status.blocked
      ? '\nblock_on_hard aktív -- de a tényleges blokkolási akció még nincs implementálva (nyitott design-kérdés).'
      : ''
    return `🚨 Budget plafon elérve: "${name}" ${pct}%-on van (${spentFmt} / ${amountFmt} token).\nHavi tokenfogyasztás meghaladta a beállított limitet.${blockedNote}`
  }
  return `⚠️ Budget riasztás: "${name}" elérte a ${pct}%-ot (${spentFmt} / ${amountFmt} token).`
}

/**
 * Run one budget-alert check: evaluate all budgets, notify for any at
 * warning/hard level whose cooldown has elapsed, persist updated cooldowns.
 */
export async function runBudgetAlertCheck(db: Database.Database, nowMs: number = Date.now()): Promise<void> {
  const { config } = loadCostopsConfig()
  if (config.budgets.length === 0) return

  const statuses = evaluateBudgets(db, config, nowMs)
  const state = loadState()
  let stateChanged = false

  for (const status of statuses) {
    if (status.level === 'ok') continue
    const entry = state[status.budget.id] ?? { warn_last_sent: null, hard_last_sent: null }
    const lastSentField = status.level === 'hard' ? 'hard_last_sent' : 'warn_last_sent'
    const lastSent = entry[lastSentField]
    const cooldownElapsed = lastSent === null || nowMs - lastSent >= COOLDOWN_MS[status.level]
    if (!cooldownElapsed) continue

    await notifyChannel(formatMessage(status))
    entry[lastSentField] = nowMs
    state[status.budget.id] = entry
    stateChanged = true
  }

  if (stateChanged) saveState(state)
}
