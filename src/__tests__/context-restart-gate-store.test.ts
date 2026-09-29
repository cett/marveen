// Config half is DB-backed since migration 0058 (#985 group 3/8) -- see
// context-guard-store.test.ts's header comment for the shared-:memory:-DB
// rationale. The run-state half (readGateRunState/writeGateRunState) is
// still file-based (group 4/8), so it keeps the original tmpdir + vi.mock
// setup for STORE_DIR.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { unlinkSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'context-restart-gate-store-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))

import { initDatabase, getDb } from '../db.js'
import {
  readGateConfig,
  writeGateConfig,
  readGateRunState,
  writeGateRunState,
  type GateRunState,
} from '../web/context-restart-gate-store.js'
import { DEFAULT_GATE_CONFIG } from '../context-restart-gate.js'

const STATE_FILE = join(TMP_ROOT, 'store', 'context-restart-gate-state.json')

beforeAll(() => {
  // Real in-memory DB for the config half. The STORE_DIR mock above points
  // at an empty tmpdir, so the boot importer (migrateAgentSettingsFromFiles)
  // finds no context-restart-gate.json to carry over -- unlike
  // context-guard-store.test.ts/auto-restart-store.test.ts, which run
  // against the real worktree store/ and can see real fleet rows.
  initDatabase(':memory:')
})

function cleanStateFile(): void {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE)
}

beforeEach(cleanStateFile)
afterEach(() => {
  getDb().exec("DELETE FROM agent_settings WHERE setting_key = 'context_restart_gate'")
})
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('readGateConfig / writeGateConfig', () => {
  it('returns defaults when no row exists', () => {
    expect(readGateConfig('agent-a')).toEqual(DEFAULT_GATE_CONFIG)
  })

  it('returns defaults for an agent with no entry', () => {
    writeGateConfig('other', { enabled: true })
    expect(readGateConfig('agent-a')).toEqual(DEFAULT_GATE_CONFIG)
  })

  it('normalizes and persists a written config', () => {
    const saved = writeGateConfig('agent-a', { enabled: true, thresholdTokens: 123456 })
    expect(saved.enabled).toBe(true)
    expect(saved.thresholdTokens).toBe(123456)
    expect(readGateConfig('agent-a')).toEqual(saved)
  })

  it('overwrites an existing entry without affecting others', () => {
    writeGateConfig('agent-a', { enabled: true })
    writeGateConfig('agent-d', { enabled: false })
    writeGateConfig('agent-a', { enabled: false })
    expect(readGateConfig('agent-a').enabled).toBe(false)
    expect(readGateConfig('agent-d').enabled).toBe(false)
  })

  it('survives a row whose setting_value is not valid JSON', () => {
    getDb().prepare(
      `INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id) VALUES (?, 'context_restart_gate', '{not json', 'default')`,
    ).run('agent-a')
    expect(readGateConfig('agent-a')).toEqual(DEFAULT_GATE_CONFIG)
  })
})

describe('readGateRunState / writeGateRunState', () => {
  const EMPTY_STATE: GateRunState = { firstBlockedAt: null, lastAlertAt: null, lastClearAt: null }

  it('returns empty state when no file exists', () => {
    expect(readGateRunState('agent-a')).toEqual(EMPTY_STATE)
  })

  it('returns empty state for an agent with no entry', () => {
    writeGateRunState('other', { firstBlockedAt: 1000, lastAlertAt: null, lastClearAt: null })
    expect(readGateRunState('agent-a')).toEqual(EMPTY_STATE)
  })

  it('persists and reads back a written state', () => {
    const state: GateRunState = { firstBlockedAt: 1000, lastAlertAt: 2000, lastClearAt: 3000 }
    writeGateRunState('agent-a', state)
    expect(readGateRunState('agent-a')).toEqual(state)
  })

  it('normalizes non-positive / non-finite fields to null on read', () => {
    require('node:fs').writeFileSync(
      STATE_FILE,
      JSON.stringify({ 'agent-a': { firstBlockedAt: -5, lastAlertAt: Infinity, lastClearAt: 'nope' } }),
    )
    expect(readGateRunState('agent-a')).toEqual(EMPTY_STATE)
  })

  it('floors fractional timestamps on read', () => {
    require('node:fs').writeFileSync(
      STATE_FILE,
      JSON.stringify({ 'agent-a': { firstBlockedAt: 1000.7, lastAlertAt: null, lastClearAt: null } }),
    )
    expect(readGateRunState('agent-a').firstBlockedAt).toBe(1000)
  })

  it('survives a corrupted state file', () => {
    require('node:fs').writeFileSync(STATE_FILE, 'INVALID')
    expect(readGateRunState('agent-a')).toEqual(EMPTY_STATE)
  })

  it('overwrites an existing entry without affecting others', () => {
    writeGateRunState('agent-a', { firstBlockedAt: 1, lastAlertAt: null, lastClearAt: null })
    writeGateRunState('agent-d', { firstBlockedAt: 2, lastAlertAt: null, lastClearAt: null })
    writeGateRunState('agent-a', EMPTY_STATE)
    expect(readGateRunState('agent-a')).toEqual(EMPTY_STATE)
    expect(readGateRunState('agent-d').firstBlockedAt).toBe(2)
  })
})
