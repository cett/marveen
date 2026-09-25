// coverage batch-50: destructive-gate command assembly/injection/migration
// and the quarantine-reader deploy migration (all 0% covered before this file).
//
// Same real-filesystem sandbox pattern as hook-scope-main-refusal.test.ts:
// HOME is redirected to a temp dir (so a broken main-agent guard can never
// touch the operator's real ~/.claude), and a throwaway probe agent directory
// under PROJECT_ROOT/agents/ stands in for a sub-agent. No mocking of
// config.js -- agentSettingsPath()/agentDir() resolve for real, and the real
// scripts/hooks/destructive-gate.py + templates/sub-agents/quarantine-reader.md
// files in this repo are what isUnsafeHookCommand()/ensureQuarantineReader()
// read, exactly as they do at runtime.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  destructiveGateCommand,
  injectDestructiveGate,
  ensureDestructiveGate,
  ensureQuarantineReader,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

const PROBE = 'destructive-gate-probe'
const probeDir = join(PROJECT_ROOT, 'agents', PROBE)

let fakeHome: string
let realHome: string | undefined
let mainSettings: string

const MARKER = '{"hooks":{"marker":"untouched-by-batch50-gate"}}'

beforeEach(() => {
  realHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), 'destructive-gate-'))
  process.env.HOME = fakeHome
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  mainSettings = agentSettingsPath(MAIN_AGENT_ID)
  expect(mainSettings).toBe(join(fakeHome, '.claude', 'settings.json'))
  writeFileSync(mainSettings, MARKER)

  if (existsSync(join(probeDir, 'HANDOFF.md'))) {
    throw new Error(`refusing: agents/${PROBE} looks like a live agent`)
  }
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(join(probeDir, '.claude'), { recursive: true })
})

afterEach(() => {
  process.env.HOME = realHome
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(probeDir, { recursive: true, force: true })
})

function probeSettingsPath(): string {
  return agentSettingsPath(PROBE)
}

function probePreToolUse(): unknown[] {
  const p = probeSettingsPath()
  if (!existsSync(p)) return []
  const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { hooks?: { PreToolUse?: unknown[] } }
  return parsed.hooks?.PreToolUse ?? []
}

describe('destructiveGateCommand', () => {
  it('builds a fail-closed python3 lookup guard around the quoted script path', () => {
    const cmd = destructiveGateCommand('/some/path/destructive-gate.py')
    expect(cmd).toContain('command -v python3')
    expect(cmd).toContain('exit 2')
    expect(cmd).toContain('python3 "/some/path/destructive-gate.py"')
  })

  it('quotes a script path containing spaces as a single shell argument', () => {
    const cmd = destructiveGateCommand('/some path/with space/destructive-gate.py')
    expect(cmd).toContain('python3 "/some path/with space/destructive-gate.py"')
  })
})

describe('injectDestructiveGate', () => {
  it('adds a Bash-matched PreToolUse entry to an object with no hooks yet', () => {
    const existing: Record<string, unknown> = {}
    injectDestructiveGate(existing)
    const hooks = existing.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    expect(hooks.PreToolUse).toHaveLength(1)
    expect(hooks.PreToolUse[0].matcher).toBe('Bash')
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('destructive-gate.py')
  })

  it('preserves unrelated existing PreToolUse entries', () => {
    const existing: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ command: 'echo unrelated' }] }] },
    }
    injectDestructiveGate(existing)
    const ptu = (existing.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse
    expect(ptu).toHaveLength(2)
    expect(ptu.some((e) => e.matcher === 'WebFetch')).toBe(true)
    expect(ptu.some((e) => e.matcher === 'Bash')).toBe(true)
  })

  it('is idempotent: re-injecting replaces the prior destructive-gate entry instead of stacking it', () => {
    const existing: Record<string, unknown> = {}
    injectDestructiveGate(existing)
    injectDestructiveGate(existing)
    const ptu = (existing.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse
    expect(ptu.filter((e) => e.matcher === 'Bash')).toHaveLength(1)
  })
})

describe('ensureDestructiveGate', () => {
  it('refuses the main agent and leaves its settings file untouched', () => {
    expect(ensureDestructiveGate(MAIN_AGENT_ID)).toBe(false)
    expect(readFileSync(mainSettings, 'utf-8')).toBe(MARKER)
  })

  it('wires the gate into a sub-agent with no settings.json yet', () => {
    expect(existsSync(probeSettingsPath())).toBe(false)
    expect(ensureDestructiveGate(PROBE)).toBe(true)
    expect(existsSync(probeSettingsPath())).toBe(true)
    const ptu = probePreToolUse() as Array<{ matcher: string; hooks: Array<{ command: string }> }>
    expect(ptu.some((e) => e.matcher === 'Bash' && e.hooks[0].command.includes('destructive-gate.py'))).toBe(true)
  })

  it('is a no-op on a second call once already wired', () => {
    expect(ensureDestructiveGate(PROBE)).toBe(true)
    expect(ensureDestructiveGate(PROBE)).toBe(false)
  })

  it('replaces a stale destructive-gate entry that does not match the current command form', () => {
    writeFileSync(probeSettingsPath(), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'python3 /old/path/destructive-gate.py' }] }] },
    }))
    expect(ensureDestructiveGate(PROBE)).toBe(true)
    const ptu = probePreToolUse() as Array<{ matcher: string; hooks: Array<{ command: string }> }>
    const bashEntries = ptu.filter((e) => e.matcher === 'Bash')
    expect(bashEntries).toHaveLength(1)
    expect(bashEntries[0].hooks[0].command).toContain('command -v python3')
  })

  it('returns false when the existing settings.json is malformed', () => {
    writeFileSync(probeSettingsPath(), '{ not valid json')
    expect(ensureDestructiveGate(PROBE)).toBe(false)
  })
})

describe('ensureQuarantineReader', () => {
  it('deploys the rendered template to a sub-agent .claude/agents dir', () => {
    const dest = join(probeDir, '.claude', 'agents', 'quarantine-reader.md')
    expect(existsSync(dest)).toBe(false)
    expect(ensureQuarantineReader(PROBE)).toBe(true)
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8').length).toBeGreaterThan(0)
  })

  it('is a no-op once the deployed content already matches the render', () => {
    expect(ensureQuarantineReader(PROBE)).toBe(true)
    expect(ensureQuarantineReader(PROBE)).toBe(false)
  })

  it('re-writes when the deployed file has drifted from the current render', () => {
    ensureQuarantineReader(PROBE)
    const dest = join(probeDir, '.claude', 'agents', 'quarantine-reader.md')
    writeFileSync(dest, 'hand-edited, stale content')
    expect(ensureQuarantineReader(PROBE)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).not.toBe('hand-edited, stale content')
  })

  it('deploys to the user-global agents dir for the main agent', () => {
    const dest = join(fakeHome, '.claude', 'agents', 'quarantine-reader.md')
    expect(ensureQuarantineReader(MAIN_AGENT_ID)).toBe(true)
    expect(existsSync(dest)).toBe(true)
  })
})
