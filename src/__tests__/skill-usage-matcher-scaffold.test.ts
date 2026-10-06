// ensureSkillUsageMatcher widens an older `Skill|Read` skill-usage-capture matcher to `Skill|Read|Bash`.
// Same real-directory-under-agents/ pattern as context-watchdog-hook-scaffold.test.ts
// (agentSettingsPath / agentDir have no test-env override).

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSkillUsageMatcher, ensureAgentHooks } from '../web/agent-scaffold.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'

const TEST_AGENT = 'skillusage-matcher-test-agent'
const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)
const settingsPath = join(testAgentDir, '.claude', 'settings.json')

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true })
})

const CAPTURE_CMD = "bash -c '[ -f /x/scripts/hooks/skill-usage-capture.py ] && exec python3 /x/scripts/hooks/skill-usage-capture.py; exit 0'"
const OTHER_CMD = 'python3 /x/scripts/hooks/other-hook.py'

type Entry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }

function write(ptu: Entry[], extra: Record<string, unknown> = {}) {
  mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PostToolUse: ptu, ...extra } }, null, 2))
}
function read(): { hooks: { PostToolUse: Entry[]; [k: string]: unknown } } {
  return JSON.parse(readFileSync(settingsPath, 'utf-8'))
}
const cap = (matcher?: string): Entry => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: CAPTURE_CMD, timeout: 10 }] })

describe('ensureSkillUsageMatcher', () => {
  it('skips the main agent (its entry lives in the tracked project settings)', () => {
    expect(ensureSkillUsageMatcher(MAIN_AGENT_ID)).toBe(false)
  })

  it('does nothing for an agent with no settings file, and does not create one', () => {
    mkdirSync(testAgentDir, { recursive: true })
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('does nothing for an unparseable settings file', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeFileSync(settingsPath, '{not json')
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{not json')
  })

  it('does nothing when there is no PostToolUse event', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [] } }))
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
  })

  it('widens the older Skill|Read matcher in place', () => {
    write([cap('Skill|Read')])
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(true)
    const ptu = read().hooks.PostToolUse
    expect(ptu).toHaveLength(1)
    expect(ptu[0].matcher).toBe('Skill|Read|Bash')
    expect(ptu[0].hooks[0].command).toBe(CAPTURE_CMD)
  })

  it('is idempotent: a second run changes nothing and adds no entry', () => {
    write([cap('Skill|Read')])
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(true)
    const once = readFileSync(settingsPath, 'utf-8')
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
    expect(readFileSync(settingsPath, 'utf-8')).toBe(once)
  })

  it('leaves an entry that already matches Bash alone', () => {
    write([cap('Skill|Read|Bash')])
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
    expect(read().hooks.PostToolUse[0].matcher).toBe('Skill|Read|Bash')
  })

  it('does not mistake a matcher that merely contains the letters of Bash for Bash', () => {
    write([cap('Skill|Read|BashOutput')])
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(true)
    expect(read().hooks.PostToolUse[0].matcher).toBe('Skill|Read|BashOutput|Bash')
  })

  it('leaves an entry without a matcher alone (it already matches every tool)', () => {
    write([cap()])
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
    expect(read().hooks.PostToolUse[0].matcher).toBeUndefined()
  })

  it('does not touch other PostToolUse entries, or other events', () => {
    const other: Entry = { matcher: 'Skill|Read', hooks: [{ type: 'command', command: OTHER_CMD, timeout: 5 }] }
    write([other, cap('Skill|Read')], { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] })
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(true)
    const s = read()
    expect(s.hooks.PostToolUse[0]).toEqual(other)
    expect(s.hooks.PostToolUse[1].matcher).toBe('Skill|Read|Bash')
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'x' }] }])
  })

  it('splits an entry that shares its matcher with another hook, so that hook does not start firing on Bash', () => {
    write([{ matcher: 'Skill|Read', hooks: [{ type: 'command', command: OTHER_CMD }, { type: 'command', command: CAPTURE_CMD, timeout: 10 }] }])
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(true)
    const ptu = read().hooks.PostToolUse
    expect(ptu).toHaveLength(2)
    expect(ptu[0]).toEqual({ matcher: 'Skill|Read', hooks: [{ type: 'command', command: OTHER_CMD }] })
    expect(ptu[1]).toEqual({ matcher: 'Skill|Read|Bash', hooks: [{ type: 'command', command: CAPTURE_CMD, timeout: 10 }] })
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
  })

  it('never creates a duplicate of the capture hook', () => {
    write([cap('Skill|Read')])
    ensureSkillUsageMatcher(TEST_AGENT)
    ensureSkillUsageMatcher(TEST_AGENT)
    const cmds = read().hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command))
    expect(cmds.filter((c) => c.includes('skill-usage-capture.py'))).toHaveLength(1)
  })
})

describe('the shipped registrations carry the Bash matcher', () => {
  it('a sub-agent seeded from the template gets Skill|Read|Bash, and the ensure pass then has nothing to do', () => {
    mkdirSync(testAgentDir, { recursive: true })
    expect(ensureAgentHooks(TEST_AGENT)).toBe(true)
    const entry = read().hooks.PostToolUse.find((e) => e.hooks.some((h) => h.command.includes('skill-usage-capture.py')))!
    expect(entry).toBeDefined()
    expect(entry.matcher).toBe('Skill|Read|Bash')
    expect(ensureSkillUsageMatcher(TEST_AGENT)).toBe(false)
  })

  it('the template merge does not add a second capture entry next to an older one; the ensure pass widens the old one', () => {
    write([{ matcher: 'Skill|Read', hooks: [{ type: 'command', command: seededCaptureCommand(), timeout: 10 }] }])
    ensureAgentHooks(TEST_AGENT)
    ensureSkillUsageMatcher(TEST_AGENT)
    const entries = read().hooks.PostToolUse.filter((e) => e.hooks.some((h) => h.command.includes('skill-usage-capture.py')))
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('Skill|Read|Bash')
  })
})

// The command the template renders, taken from a seeded agent so the merge test does not hardcode a path.
function seededCaptureCommand(): string {
  const name = `${TEST_AGENT}-seed`
  const seed = join(PROJECT_ROOT, 'agents', name)
  try {
    mkdirSync(seed, { recursive: true })
    ensureAgentHooks(name)
    const s = JSON.parse(readFileSync(join(seed, '.claude', 'settings.json'), 'utf-8')) as { hooks: { PostToolUse: Entry[] } }
    return s.hooks.PostToolUse.flatMap((e) => e.hooks).find((h) => h.command.includes('skill-usage-capture.py'))!.command
  } finally {
    rmSync(seed, { recursive: true, force: true })
  }
}
