import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { getAgentSetting, setAgentSetting } from '../db/agent-settings.js'
import {
  normalizeGateConfig,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
} from '../context-restart-gate.js'

const STATE_PATH  = join(STORE_DIR, 'context-restart-gate-state.json')

// ---- Config (per-agent, DB-backed) -------------------------------------------
//
// Migration 0058, agent_settings table, setting_key='context_restart_gate'
// (#985 group 3/8) -- replaces the former store/context-restart-gate.json
// single-file map keyed by agent name. No HTTP route currently reads or
// writes this config (only context-restart-gate-runner.ts calls
// readGateConfig/writeGateConfig internally), so there is no RBAC question
// here -- see agents-process.ts for the context-guard/auto-restart routes
// that do have one.

export function readGateConfig(name: string): GateConfig {
  const row = getAgentSetting(name, 'context_restart_gate')
  if (!row) return { ...DEFAULT_GATE_CONFIG }
  try {
    return normalizeGateConfig(JSON.parse(row.setting_value))
  } catch {
    return { ...DEFAULT_GATE_CONFIG }
  }
}

export function writeGateConfig(name: string, cfg: unknown, tenantId = 'default'): GateConfig {
  const normalized = normalizeGateConfig(cfg)
  setAgentSetting(name, 'context_restart_gate', normalized, tenantId)
  return normalized
}

// ---- State (per-agent run-state: blocking streak tracking, still
//      file-based -- group 4/8) --------------------------------------------

export interface GateRunState {
  /** Epoch ms when continuous blocking started; null when not blocked. */
  firstBlockedAt: number | null
  /** Epoch ms of the last persistent-block alert sent to bigme. */
  lastAlertAt: number | null
  /** Epoch ms when the last /clear was successfully sent. */
  lastClearAt: number | null
}

const EMPTY_STATE: GateRunState = {
  firstBlockedAt: null,
  lastAlertAt: null,
  lastClearAt: null,
}

function readStateRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function normalizeState(raw: unknown): GateRunState {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const msOrNull = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : null
  return {
    firstBlockedAt: msOrNull(o.firstBlockedAt),
    lastAlertAt:    msOrNull(o.lastAlertAt),
    lastClearAt:    msOrNull(o.lastClearAt),
  }
}

export function readGateRunState(name: string): GateRunState {
  const raw = readStateRaw()
  return name in raw ? normalizeState(raw[name]) : { ...EMPTY_STATE }
}

export function writeGateRunState(name: string, state: GateRunState): void {
  const raw = readStateRaw()
  raw[name] = state
  atomicWriteFileSync(STATE_PATH, JSON.stringify(raw, null, 2))
}
