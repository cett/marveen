// Phase-4 sub-agent extension: ensureContextWatchdogHook wires the
// context-watchdog PostToolUse hook into a persistent named sub-agent's own
// settings.json. Same real-directory-under-agents/ pattern as
// hook-command-quoting.test.ts (agentSettingsPath/agentDir have no test-env
// override, unlike SCRIPTS_DIR).

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureContextWatchdogHook } from '../web/agent-scaffold.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'

const TEST_AGENT = 'ctxwatchdog-test-agent'
const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)
const settingsPath = join(testAgentDir, '.claude', 'settings.json')

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true })
})

function ptuCommands(settings: Record<string, unknown>): string[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  const ptu = (hooks.PostToolUse ?? []) as { hooks: { command: string }[] }[]
  return ptu.flatMap((e) => e.hooks.map((h) => h.command))
}

describe('ensureContextWatchdogHook', () => {
  it('skips MAIN_AGENT_ID entirely (already covered by the project-tracked settings.json)', () => {
    expect(ensureContextWatchdogHook(MAIN_AGENT_ID)).toBe(false)
  })

  it('wires the hook into a fresh sub-agent dir and creates .claude/', () => {
    mkdirSync(testAgentDir, { recursive: true })
    expect(existsSync(settingsPath)).toBe(false)

    const changed = ensureContextWatchdogHook(TEST_AGENT)
    expect(changed).toBe(true)
    expect(existsSync(settingsPath)).toBe(true)

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const commands = ptuCommands(written)
    expect(commands.some((c) => c.includes('context-watchdog.py'))).toBe(true)
  })

  it('is idempotent: a second call is a no-op and does not duplicate the entry', () => {
    mkdirSync(testAgentDir, { recursive: true })
    expect(ensureContextWatchdogHook(TEST_AGENT)).toBe(true)
    expect(ensureContextWatchdogHook(TEST_AGENT)).toBe(false)

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const commands = ptuCommands(written)
    expect(commands.filter((c) => c.includes('context-watchdog.py'))).toHaveLength(1)
  })

  it('merges into an agent that already has other PostToolUse hooks, without disturbing them', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    const existing = {
      hooks: {
        PostToolUse: [
          { hooks: [{ type: 'command', command: 'python3 /some/other/hook.py', timeout: 5 }] },
        ],
      },
    }
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2))

    expect(ensureContextWatchdogHook(TEST_AGENT)).toBe(true)

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const commands = ptuCommands(written)
    expect(commands.some((c) => c.includes('/some/other/hook.py'))).toBe(true)
    expect(commands.some((c) => c.includes('context-watchdog.py'))).toBe(true)
  })

  it('uses the fail-open bash wrapper form (tolerates a missing script without blocking the tool call)', () => {
    mkdirSync(testAgentDir, { recursive: true })
    ensureContextWatchdogHook(TEST_AGENT)
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const cmd = ptuCommands(written).find((c) => c.includes('context-watchdog.py'))!
    expect(cmd).toMatch(/^bash -c '/)
    expect(cmd).toContain('exit 0')
  })
})
