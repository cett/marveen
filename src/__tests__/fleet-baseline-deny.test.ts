// Ported from upstream #1679 (DENYARGS925): permissions.deny is rebuilt WHOLESALE from the security
// profile on every spawn, so a rule that lives in ONE profile is not a floor. Two branches are pinned,
// because they are two different mechanisms: (A) sub-agents get the code-level floor in
// writeAgentSettingsFromProfile, (B) the main agent gets the repo's tracked project settings
// (.claude/settings.json), which the scaffold deliberately never writes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAgentSettingsFromProfile, agentSettingsPath, FLEET_BASELINE_DENY } from '../web/agent-scaffold.js'
import { agentDir } from '../web/agent-config.js'
import { listProfileTemplates, loadProfileTemplate, resolveProfilePlaceholders } from '../web/profiles.js'
import { PROJECT_ROOT } from '../config.js'

const NAME = 'fleet-baseline-test-agent'
const DIR = agentDir(NAME)

const readDeny = (): string[] => JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8')).permissions.deny as string[]
const expectedFor = (agent: string): string[] => {
  const ctx = { HOME: homedir(), AGENT_DIR: agentDir(agent) }
  return FLEET_BASELINE_DENY.map(r => resolveProfilePlaceholders(r, ctx))
}

beforeEach(() => {
  // a pre-existing dir means this is not a clean checkout: refuse rather than delete what we did not create
  if (existsSync(DIR)) throw new Error(`refusing: ${DIR} already exists`)
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify({}, null, 2))
})
afterEach(() => { rmSync(DIR, { recursive: true, force: true }) })

describe('(A) the baseline reaches EVERY profile, including ones added later', () => {
  // iterating the directory is the point: a profile added tomorrow is covered the day it lands
  const profiles = listProfileTemplates()

  it('finds the shipped profiles (a silent empty list would pass every case below)', () => {
    expect(profiles.length).toBeGreaterThanOrEqual(7)
  })
  for (const profile of profiles) {
    it(`profile "${profile.id}" carries the full baseline`, () => {
      writeAgentSettingsFromProfile(NAME, loadProfileTemplate(profile.id))
      const deny = readDeny()
      for (const rule of expectedFor(NAME)) expect(deny).toContain(rule)
    })
  }
  it('survives a respawn (second write) on the leanest profile', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    for (const rule of expectedFor(NAME)) expect(readDeny()).toContain(rule)
  })
  it('does not duplicate a rule the profile already declares', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('marketer')) // declares Bash(sudo:*) and Bash(rm:*) itself
    const deny = readDeny()
    for (const rule of ['Bash(sudo:*)', 'Bash(rm:*)']) expect(deny.filter(r => r === rule)).toHaveLength(1)
  })
  it('does NOT carry Bash(curl -X POST:*): a weak guard that would deny the localhost dashboard recipes', () => {
    expect(FLEET_BASELINE_DENY.filter(r => r.includes('curl'))).toEqual([])
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('default'))
    expect(readDeny()).not.toContain('Bash(curl -X POST:*)')
  })
  it('pairs the sudo name rule with its absolute-path form', () => {
    expect(FLEET_BASELINE_DENY).toContain('Bash(sudo:*)')
    expect(FLEET_BASELINE_DENY).toContain('Bash(*/sudo *)')
  })
  it('carries the NARROW rm forms and NOT the broad rm ban', () => {
    expect(FLEET_BASELINE_DENY).toContain('Bash(rm -rf ${HOME}:*)')
    expect(FLEET_BASELINE_DENY).toContain('Bash(rm -rf /:*)')
    expect(FLEET_BASELINE_DENY).not.toContain('Bash(rm:*)')
    expect(FLEET_BASELINE_DENY).not.toContain('Bash(*/rm *)')
    expect(FLEET_BASELINE_DENY.filter(r => /^Bash\(\*\/rm/.test(r))).toEqual([])
  })
  it('does NOT carry Bash(*/git *): it blocks read-only git calls', () => {
    expect(FLEET_BASELINE_DENY).toContain('Bash(git push --force:*)')
    expect(FLEET_BASELINE_DENY).toContain('Bash(git push -f:*)')
    expect(FLEET_BASELINE_DENY.filter(r => /^Bash\(\*\/git\b/.test(r))).toEqual([])
  })
  it('the block comment names the weak rules and the limits, so the list cannot be read as cover', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/web/agent-scaffold-hooks.ts'), 'utf-8')
    const start = src.indexOf('The fleet-wide deny FLOOR')
    const end = src.indexOf('export const FLEET_BASELINE_DENY')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const comment = src.slice(start, end).replace(/\n\/\/\s*/g, ' ') // line breaks and `//` markers must not decide
    for (const phrase of ['curl -X POST:*) is deliberately NOT in the floor', 'FRICTION against a slip', 'git push --quiet --force', 'NO `*/` partner', '/usr/bin/rm -rf /', 'NOT in the floor']) {
      expect(comment).toContain(phrase)
    }
  })
  it('keeps the profile\'s own rules and the self-pace deny alongside the baseline', () => {
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('developer-senior'))
    const deny = readDeny()
    expect(deny.filter(r => r === 'Bash(git push --force:*)')).toHaveLength(1) // declared by the profile AND the floor: once
    expect(deny).toContain('ScheduleWakeup')
  })
})

describe('(B) the main agent gets the baseline from the repo project settings', () => {
  const settings = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
  const deny: string[] = settings.permissions?.deny ?? []

  it('is the constant EXACTLY, in its home-relative (~) form, in both directions', () => {
    // ${HOME} is not expanded when Claude Code reads this file; '~' is the shipped form. A rule added to
    // the file alone would exist nowhere else, a rule missing from it would leave the main agent bare.
    expect(deny).toEqual(FLEET_BASELINE_DENY.map(r => r.replace('${HOME}', '~')))
  })
  it('ships the sudo partner and the narrow rm forms, and neither the broad rm ban, */git nor curl -X POST', () => {
    for (const r of ['Bash(sudo:*)', 'Bash(*/sudo *)', 'Bash(rm -rf ~:*)', 'Bash(rm -rf /:*)']) expect(deny).toContain(r)
    for (const r of ['Bash(rm:*)', 'Bash(*/rm *)', 'Bash(*/git *)', 'Bash(curl -X POST:*)']) expect(deny).not.toContain(r)
  })
  it('never hardcodes a developer machine home', () => {
    for (const rule of deny) expect(rule).not.toMatch(/\/(?:home|Users)\//)
  })
  it('adds permissions ALONGSIDE the existing keys', () => {
    expect(settings.enabledPlugins).toBeTruthy()
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0)
  })
})
