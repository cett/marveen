// tenant use-time hooks (tenant-context.py UserPromptSubmit + tenant-skill-gate.py PreToolUse):
// command assembly, injection, and the idempotent startup migration.
// Same real-filesystem sandbox as agent-scaffold-destructive-gate.test.ts: HOME is redirected so the main
// agent's real ~/.claude can never be touched, a throwaway probe agent stands in for a sub-agent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  tenantHookCommand,
  injectTenantHooks,
  ensureTenantHooks,
  TENANT_SKILL_GATE_MATCHER,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

const PROBE = 'tenant-hooks-probe'
const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
const MARKER = '{"hooks":{"marker":"untouched-by-tenant-hooks"}}'

let fakeHome: string
let realHome: string | undefined
let mainSettings: string

beforeEach(() => {
  realHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), 'tenant-hooks-'))
  process.env.HOME = fakeHome
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  mainSettings = agentSettingsPath(MAIN_AGENT_ID)
  writeFileSync(mainSettings, MARKER)
  if (existsSync(join(probeDir, 'HANDOFF.md'))) throw new Error(`refusing: agents/${PROBE} looks like a live agent`)
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(join(probeDir, '.claude'), { recursive: true })
})

afterEach(() => {
  process.env.HOME = realHome
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(probeDir, { recursive: true, force: true })
})

type Entry = { matcher?: string; hooks: Array<{ command: string; timeout?: number }> }
function probeHooks(): { UserPromptSubmit?: Entry[]; PreToolUse?: Entry[] } {
  const p = agentSettingsPath(PROBE)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as { hooks?: never }).hooks ?? {} : {}
}

describe('tenantHookCommand', () => {
  it('is a fail-closed python3 guard around the quoted script path', () => {
    const cmd = tenantHookCommand('/some path/hooks/tenant-skill-gate.py')
    expect(cmd).toContain('command -v python3')
    expect(cmd).toContain('exit 2')
    expect(cmd).toContain('tenant-skill-gate: python3 not found -- DENY')
    expect(cmd).toContain('python3 "/some path/hooks/tenant-skill-gate.py"')
  })
})

describe('injectTenantHooks', () => {
  it('adds the prompt hook and a gate entry matching the skill-touching tools only', () => {
    const existing: Record<string, unknown> = {}
    injectTenantHooks(existing)
    const hooks = existing.hooks as { UserPromptSubmit: Entry[]; PreToolUse: Entry[] }
    expect(hooks.UserPromptSubmit).toHaveLength(1)
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain('tenant-context.py')
    expect(hooks.PreToolUse).toHaveLength(1)
    expect(hooks.PreToolUse[0].matcher).toBe(TENANT_SKILL_GATE_MATCHER)
    expect(TENANT_SKILL_GATE_MATCHER.split('|').sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Skill', 'Write'])
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('tenant-skill-gate.py')
  })

  it('keeps unrelated entries and does not stack on re-injection', () => {
    const existing: Record<string, unknown> = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ command: 'echo other-prompt-hook' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo other-gate' }] }],
      },
    }
    injectTenantHooks(existing)
    injectTenantHooks(existing)
    const hooks = existing.hooks as { UserPromptSubmit: Entry[]; PreToolUse: Entry[] }
    expect(hooks.UserPromptSubmit).toHaveLength(2)
    expect(hooks.PreToolUse).toHaveLength(2)
    expect(JSON.stringify(hooks)).toContain('other-prompt-hook')
    expect(JSON.stringify(hooks)).toContain('other-gate')
  })
})

describe('ensureTenantHooks', () => {
  it('leaves the main agent alone (its hooks are repo-shipped)', () => {
    expect(ensureTenantHooks(MAIN_AGENT_ID)).toBe(false)
    expect(readFileSync(mainSettings, 'utf-8')).toBe(MARKER)
  })

  it('wires both hooks into a sub-agent without settings.json, then is a no-op', () => {
    expect(ensureTenantHooks(PROBE)).toBe(true)
    const h = probeHooks()
    expect(JSON.stringify(h.UserPromptSubmit)).toContain('tenant-context.py')
    expect(JSON.stringify(h.PreToolUse)).toContain('tenant-skill-gate.py')
    expect(ensureTenantHooks(PROBE)).toBe(false)
  })

  it('repairs a half-wired file: only the prompt hook present, or a stale gate matcher', () => {
    ensureTenantHooks(PROBE)
    const p = agentSettingsPath(PROBE)
    const cfg = JSON.parse(readFileSync(p, 'utf-8'))
    cfg.hooks.PreToolUse[0].matcher = 'Bash'          // stale matcher: the gate would miss Skill/Read/Glob/Grep
    writeFileSync(p, JSON.stringify(cfg))
    expect(ensureTenantHooks(PROBE)).toBe(true)
    expect(probeHooks().PreToolUse?.find(e => JSON.stringify(e).includes('tenant-skill-gate.py'))?.matcher).toBe(TENANT_SKILL_GATE_MATCHER)

    const cfg2 = JSON.parse(readFileSync(p, 'utf-8'))
    cfg2.hooks.UserPromptSubmit = []
    writeFileSync(p, JSON.stringify(cfg2))
    expect(ensureTenantHooks(PROBE)).toBe(true)
    expect(JSON.stringify(probeHooks().UserPromptSubmit)).toContain('tenant-context.py')
  })

  it('does not touch an unparsable settings file', () => {
    writeFileSync(agentSettingsPath(PROBE), '{not json')
    expect(ensureTenantHooks(PROBE)).toBe(false)
    expect(readFileSync(agentSettingsPath(PROBE), 'utf-8')).toBe('{not json')
  })
})

describe('registration guard', () => {
  it('knows both scripts as ours, so a stale entry can be pruned and a foreign one is kept', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('tenant-context.py')
    expect(KNOWN_HOOK_SCRIPTS).toContain('tenant-skill-gate.py')
  })
})
