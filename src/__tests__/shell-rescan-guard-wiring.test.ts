// Wiring tests for the shell-rescan guard (the unit behaviour of injectShellRescanGuard / ensureShellRescanGuard
// is covered in agent-scaffold-hooks-pure.test.ts and agent-scaffold-destructive-gate.test.ts). What those do not
// notice is the CALL going missing from the two places that actually put the hook in front of an agent:
//
//   1. install/spawn: writeAgentSettingsFromProfile() must write the guard into a fresh agent's settings.json,
//      and again after a respawn (it regenerates the file).      -> BEHAVIORAL, real file written and read back.
//   2. existing agents: the startWebServer() backfill loop must call ensureShellRescanGuard() for every agent
//      whose settings.json lacks the hook.                       -> STRUCTURAL (source inspection), because a
//      behavioral test would have to boot startWebServer() with every other startup side effect mocked; the
//      same approach as web-startup-prune-desired.test.ts. The behavior of the function it calls is pinned by
//      the 'wires the guard into a sub-agent once' test in agent-scaffold-destructive-gate.test.ts.
//
// Mutation evidence (each edit made on its own, test run, edit reverted):
//   - comment out `injectShellRescanGuard(existing)` in writeAgentSettingsFromProfile -> both install tests fail
//   - delete the `if (ensureShellRescanGuard(agentName)) ...` line in web.ts          -> the startup tests fail
//   - move that line out of the for-loop / out of the hook-registration branch        -> the block tests fail

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAgentSettingsFromProfile, agentSettingsPath } from '../web/agent-scaffold.js'
import { agentDir } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')

// --- 1. install / spawn -----------------------------------------------------------------------------------------

const NAME = 'rescan-guard-wiring-test-agent'
const DIR = agentDir(NAME)

type Entry = { matcher?: string; hooks: Array<{ command: string; timeout?: number; onFailure?: string }> }

function guardEntries(): Entry[] {
  const s = JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8'))
  const ptu = (s.hooks?.PreToolUse ?? []) as Entry[]
  return ptu.filter((e) => JSON.stringify(e).includes('shell-rescan-guard.py'))
}

beforeEach(() => {
  // The name is unique to this test; a pre-existing dir means this is not a clean checkout, so refuse
  // rather than delete something this test did not make.
  if (existsSync(DIR)) throw new Error(`refusing: ${DIR} already exists`)
})
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('install: writeAgentSettingsFromProfile() wires the shell-rescan guard', () => {
  it('a fresh agent gets exactly one fail-closed Bash entry for the guard', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    const entries = guardEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('Bash')
    expect(entries[0].hooks[0].onFailure).toBe('block')
    expect(entries[0].hooks[0].timeout).toBe(10)
    expect(entries[0].hooks[0].command).toContain('command -v python3')
  })

  it('a respawn (second write over the existing file) keeps exactly one entry', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    expect(guardEntries()).toHaveLength(1)
  })

  it('the guard sits next to the destructive gate it complements, neither replacing the other', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    const s = JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8'))
    const ptu = JSON.stringify(s.hooks.PreToolUse)
    expect(ptu).toContain('destructive-gate.py')
    expect(ptu).toContain('shell-rescan-guard.py')
  })
})

// --- 2. existing agents: startup backfill -----------------------------------------------------------------------

const lines = readFileSync(join(projectRoot, 'src', 'web.ts'), 'utf-8').split('\n')

// Call sites only: not the import line, not a comment.
function callLines(name: string): number[] {
  const out: number[] = []
  lines.forEach((l, i) => {
    const t = l.trimStart()
    if (t.startsWith('import ') || t.startsWith('//') || t.startsWith('*')) return
    if (new RegExp('\\b' + name + '\\s*\\(').test(l)) out.push(i)
  })
  return out
}

const indent = (l: string): number => l.length - l.trimStart().length
// The enclosing block of a line is the nearest non-blank line above it with a smaller indent.
function enclosing(at: number): number {
  let i = at - 1
  while (i >= 0 && (lines[i].trim() === '' || indent(lines[i]) >= indent(lines[at]))) i--
  return i
}

describe('startup: the backfill loop calls ensureShellRescanGuard() for existing agents', () => {
  const guard = callLines('ensureShellRescanGuard')
  const authAdmin = callLines('ensureAuthAdminGate')
  const destructive = callLines('ensureDestructiveGate')

  it('is called exactly once, and its result is collected for the startup log', () => {
    expect(guard).toHaveLength(1)
    expect(lines[guard[0]].trim()).toBe('if (ensureShellRescanGuard(agentName)) shellRescanPatched.push(agentName)')
    expect(lines.some((l) => l.includes('shell-rescan-guard Bash hook backfilled into agent settings.json'))).toBe(true)
  })

  it('is called inside the same per-agent loop as the destructive and auth-admin gate backfills', () => {
    expect(authAdmin).toHaveLength(1)
    expect(destructive).toHaveLength(1)
    expect(enclosing(guard[0])).toBe(enclosing(authAdmin[0]))
    expect(enclosing(guard[0])).toBe(enclosing(destructive[0]))
    expect(lines[enclosing(guard[0])]).toMatch(/^\s*for \(const agentName of \[MAIN_AGENT_ID, \.\.\.listAgentNames\(\)\]\) \{$/)
  })

  it('that loop lives in the hook-registration branch (the else of `!hookDecision.register`)', () => {
    // loop -> try { -> } else {  : two levels up from the loop is the else branch of the registration guard.
    const loop = enclosing(guard[0])
    const tryLine = enclosing(loop)
    expect(lines[tryLine].trim()).toBe('try {')
    const elseLine = enclosing(tryLine)
    expect(lines[elseLine].trim()).toBe('} else {')
    const decision = lines.findIndex((l) => l.includes('shouldRegisterHooks('))
    expect(decision).toBeGreaterThanOrEqual(0)
    expect(decision).toBeLessThan(elseLine)
    expect(lines.slice(decision, elseLine).some((l) => l.includes('!hookDecision.register'))).toBe(true)
  })
})
