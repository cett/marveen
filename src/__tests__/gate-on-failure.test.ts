// Kanban 1235: every PreToolUse gate entry carries onFailure:"block".
//
// The host counts a hook that times out, does not start or ends with a non-zero exit other than 2 as a
// NON-blocking error, so a gate that cannot finish waves the tool call through. onFailure:"block" on the entry
// makes those cases a deny (exit 2 already was). This file walks every place a gate entry is written (the
// tracked project settings, the sub-agent template, every inject* function) against ONE list of gate scripts,
// and requires the sync step for sub-agents already scaffolded.
//
// Evidence basis for the behavior itself: the vendor docs, the claude 2.1.310 binary text ("timed out; blocking
// because onFailure is "block"") and an isolated load probe (the key is in the settings schema, values
// "continue" | "block"). A live DENY on a real timeout has NOT been run (it needs a logged-in session).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GATE_HOOK_SCRIPTS,
  GATE_ON_FAILURE,
  isGateHookCommand,
  syncGateOnFailure,
  ensureGateOnFailure,
  injectEmailSendGate,
  injectSelfPaceGate,
  injectEgressGate,
  injectBashEgressParser,
  injectDestructiveGate,
  injectAuthAdminGate,
  injectTenantHooks,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { pruneStaleHookEntries } from '../web/hook-registration-guard.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

interface Hook { type?: string; command?: string; timeout?: number; onFailure?: string }
interface Entry { matcher?: string; hooks?: Hook[] }
type Hooks = Record<string, Entry[]>

// PreToolUse hooks that are NOT gates: they transform or observe and must not block on failure. A new
// PreToolUse hook that is in neither this list nor GATE_HOOK_SCRIPTS fails the walk below, so it has to be
// classified on purpose.
const NON_GATE_PRE_TOOL_USE = ['channel-image-resize.sh']

function allPreToolUse(hooks: Hooks): Hook[] {
  return (hooks.PreToolUse ?? []).flatMap((e) => e.hooks ?? [])
}

function expectEveryPreToolUseClassified(hooks: Hooks, where: string): void {
  const all = allPreToolUse(hooks)
  expect(all.length, `${where}: has PreToolUse hooks`).toBeGreaterThan(0)
  for (const h of all) {
    const command = h.command ?? ''
    if (isGateHookCommand(command)) {
      expect(h.onFailure, `${where}: gate without onFailure: ${command.slice(0, 90)}`).toBe('block')
    } else {
      const known = NON_GATE_PRE_TOOL_USE.some((s) => command.includes(s))
      expect(known, `${where}: PreToolUse hook is neither a listed gate nor a listed non-gate: ${command.slice(0, 90)}`).toBe(true)
      expect(h.onFailure, `${where}: a non-gate hook must not carry onFailure: ${command.slice(0, 90)}`).toBeUndefined()
    }
  }
}

describe('the gate list', () => {
  it('has the value the host reads and one entry per gate script', () => {
    expect(GATE_ON_FAILURE).toBe('block')
    expect(new Set(GATE_HOOK_SCRIPTS).size).toBe(GATE_HOOK_SCRIPTS.length)
    for (const s of GATE_HOOK_SCRIPTS) expect(existsSync(join(PROJECT_ROOT, 'scripts', s)) || existsSync(join(PROJECT_ROOT, 'scripts', 'hooks', s)), s).toBe(true)
  })

  it('matches a command by script basename and nothing else', () => {
    expect(isGateHookCommand('python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/destructive-gate.py"')).toBe(true)
    expect(isGateHookCommand('node "/x/scripts/email-send-gate.mjs"')).toBe(true)
    expect(isGateHookCommand('bash "/x/scripts/hooks/channel-image-resize.sh"')).toBe(false)
    expect(isGateHookCommand('python3 /x/scripts/hooks/tool-log-capture.py')).toBe(false)
    expect(isGateHookCommand('python3 /x/my-destructive-gate.py.bak')).toBe(false)
  })
})

describe('the tracked project settings and the sub-agent template', () => {
  it('the tracked project settings: every PreToolUse gate has onFailure:block, nothing else is unclassified', () => {
    const settings = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8')) as { hooks: Hooks }
    expectEveryPreToolUseClassified(settings.hooks, '.claude/settings.json')
  })

  it('the template: every PreToolUse gate has onFailure:block, nothing else is unclassified', () => {
    const raw = readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8').replace(/\{\{SCRIPTS_DIR\}\}/g, PROJECT_ROOT)
    const tpl = JSON.parse(raw) as { hooks: Hooks }
    expectEveryPreToolUseClassified(tpl.hooks, 'templates/settings.json.template')
  })

  it('logging and capture hooks (PostToolUse, UserPromptSubmit, Stop, SessionStart) carry no onFailure', () => {
    const settings = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8')) as { hooks: Hooks }
    const raw = readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8').replace(/\{\{SCRIPTS_DIR\}\}/g, PROJECT_ROOT)
    const tpl = JSON.parse(raw) as { hooks: Hooks }
    for (const [where, hooks] of [['settings', settings.hooks], ['template', tpl.hooks]] as const) {
      for (const [event, entries] of Object.entries(hooks)) {
        if (event === 'PreToolUse') continue
        for (const h of entries.flatMap((e) => e.hooks ?? [])) {
          expect(h.onFailure, `${where} ${event}: ${(h.command ?? '').slice(0, 80)}`).toBeUndefined()
        }
      }
    }
  })
})

describe('every injector writes the gate entry with onFailure:block', () => {
  const injectors: Array<[string, (s: Record<string, unknown>) => void, string]> = [
    ['injectEmailSendGate', injectEmailSendGate, 'email-send-gate.mjs'],
    ['injectSelfPaceGate', injectSelfPaceGate, 'self-pace-gate.mjs'],
    ['injectEgressGate', injectEgressGate, 'egress-gate.mjs'],
    ['injectBashEgressParser', injectBashEgressParser, 'bash-egress-parser.mjs'],
    ['injectDestructiveGate', injectDestructiveGate, 'destructive-gate.py'],
    ['injectAuthAdminGate', injectAuthAdminGate, 'auth-admin-gate.py'],
    ['injectTenantHooks', injectTenantHooks, 'tenant-skill-gate.py'],
  ]
  for (const [name, inject, script] of injectors) {
    it(`${name}: the ${script} entry carries it, and a second run keeps one entry`, () => {
      const settings: Record<string, unknown> = {}
      inject(settings)
      inject(settings)
      const gates = allPreToolUse(settings.hooks as Hooks).filter((h) => (h.command ?? '').includes(script))
      expect(gates, 'one entry after two runs').toHaveLength(1)
      expect(gates[0].onFailure).toBe('block')
      expect(gates[0].timeout).toBe(10)
    })
  }

  it('injectTenantHooks: the UserPromptSubmit context hook has none (the policy leaves prompt hooks alone)', () => {
    const settings: Record<string, unknown> = {}
    injectTenantHooks(settings)
    const ups = ((settings.hooks as Hooks).UserPromptSubmit ?? []).flatMap((e) => e.hooks ?? [])
    expect(ups.length).toBeGreaterThan(0)
    for (const h of ups) expect(h.onFailure).toBeUndefined()
  })

  it('every gate script has an injector or is listed with the file that wires it', () => {
    // email-approval-gate, secret-read-gate and outgoing-copy-gate are not written by an injector: the first two
    // ship in the tracked project settings (walked above), the last runs inside email-send-gate.
    const injected = injectors.map(([, , s]) => s)
    const elsewhere = ['secret-read-gate.py', 'email-approval-gate.py', 'outgoing-copy-gate.py']
    expect([...injected, ...elsewhere].sort()).toEqual([...GATE_HOOK_SCRIPTS].sort())
  })
})

describe('syncGateOnFailure', () => {
  const gate = 'python3 "/x/scripts/hooks/destructive-gate.py"'
  const logger = 'python3 "/x/scripts/hooks/tool-log-capture.py"'

  it('adds the field to gate entries only, keeps every other field, and a second run changes nothing', () => {
    const settings: Record<string, unknown> = {
      permissions: { deny: ['X'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: gate, timeout: 10 }] },
          { matcher: '*', hooks: [{ type: 'command', command: logger, timeout: 5 }] },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: gate, timeout: 10 }] }],
      },
    }
    expect(syncGateOnFailure(settings)).toBe(true)
    const hooks = settings.hooks as Hooks
    expect(hooks.PreToolUse[0].hooks![0]).toEqual({ type: 'command', command: gate, timeout: 10, onFailure: 'block' })
    expect(hooks.PreToolUse[1].hooks![0]).toEqual({ type: 'command', command: logger, timeout: 5 })
    expect(hooks.PostToolUse[0].hooks![0].onFailure, 'only PreToolUse is touched').toBeUndefined()
    expect(settings.permissions).toEqual({ deny: ['X'] })
    const once = JSON.stringify(settings)
    expect(syncGateOnFailure(settings)).toBe(false)
    expect(JSON.stringify(settings)).toBe(once)
  })

  it('corrects a wrong value and ignores a settings object without hooks', () => {
    const settings: Record<string, unknown> = {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: gate, onFailure: 'continue' }] }] },
    }
    expect(syncGateOnFailure(settings)).toBe(true)
    expect((settings.hooks as Hooks).PreToolUse[0].hooks![0].onFailure).toBe('block')
    expect(syncGateOnFailure({})).toBe(false)
    expect(syncGateOnFailure({ hooks: 'nope' })).toBe(false)
    expect(syncGateOnFailure({ hooks: { PreToolUse: 'nope' } })).toBe(false)
  })
})

describe('ensureGateOnFailure (startup migration of the existing sub-agents)', () => {
  const PROBE = 'gate-on-failure-probe'
  const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
  let fakeHome: string
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), 'gate-on-failure-'))
    process.env.HOME = fakeHome
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    if (existsSync(join(probeDir, 'HANDOFF.md'))) throw new Error(`refusing: agents/${PROBE} looks like a live agent`)
    rmSync(probeDir, { recursive: true, force: true })
    mkdirSync(join(probeDir, '.claude'), { recursive: true })
  })
  afterEach(() => {
    process.env.HOME = realHome
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(probeDir, { recursive: true, force: true })
  })

  const legacy = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/destructive-gate.py"', timeout: 10 }] },
        { matcher: 'Bash|send_email', hooks: [{ type: 'command', command: 'node "/x/scripts/email-send-gate.mjs"', timeout: 10 }] },
      ],
    },
  }

  it('rewrites the gate entries of a sub-agent once and is a no-op the second time', () => {
    writeFileSync(agentSettingsPath(PROBE), JSON.stringify(legacy))
    expect(ensureGateOnFailure(PROBE)).toBe(true)
    const after = JSON.parse(readFileSync(agentSettingsPath(PROBE), 'utf-8')) as { hooks: Hooks }
    for (const h of allPreToolUse(after.hooks)) expect(h.onFailure).toBe('block')
    const text = readFileSync(agentSettingsPath(PROBE), 'utf-8')
    expect(ensureGateOnFailure(PROBE)).toBe(false)
    expect(readFileSync(agentSettingsPath(PROBE), 'utf-8')).toBe(text)
  })

  it('leaves a missing or unparseable file alone', () => {
    expect(ensureGateOnFailure(PROBE)).toBe(false)
    expect(existsSync(agentSettingsPath(PROBE))).toBe(false)
    writeFileSync(agentSettingsPath(PROBE), '{ not json')
    expect(ensureGateOnFailure(PROBE)).toBe(false)
    expect(readFileSync(agentSettingsPath(PROBE), 'utf-8')).toBe('{ not json')
  })

  it('never writes the main agent settings (they ship in the tracked project settings)', () => {
    const main = agentSettingsPath(MAIN_AGENT_ID)
    writeFileSync(main, JSON.stringify(legacy))
    const before = readFileSync(main, 'utf-8')
    expect(ensureGateOnFailure(MAIN_AGENT_ID)).toBe(false)
    expect(readFileSync(main, 'utf-8')).toBe(before)
  })
})

describe('the hook registration guard', () => {
  it('does not treat the new field as a difference: a gate entry with onFailure survives the prune byte-identically, a stale one is still dropped', () => {
    const live = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/destructive-gate.py"', timeout: 10, onFailure: 'block' }] }
    const stale = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/gone/scripts/hooks/auth-admin-gate.py"', timeout: 10, onFailure: 'block' }] }
    const settings: Record<string, unknown> = { hooks: { PreToolUse: [live, stale] } }
    const liveBefore = JSON.stringify(live)
    const res = pruneStaleHookEntries(settings, { fileExists: (path) => !path.startsWith('/gone/') })
    expect(res.removed).toEqual([stale.hooks[0].command])
    const kept = (settings.hooks as Hooks).PreToolUse
    expect(kept).toHaveLength(1)
    expect(JSON.stringify(kept[0])).toBe(liveBefore)
  })
})
