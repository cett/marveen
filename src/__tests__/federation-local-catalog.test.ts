import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  return { TMP_ROOT: mkdtempSync(join(tmpdir(), 'local-catalog-test-')) }
})

const { listAgentNamesMock } = vi.hoisted(() => ({ listAgentNamesMock: vi.fn() }))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(TMP_ROOT, 'agents', name),
  listAgentNames: listAgentNamesMock,
}))
vi.mock('../channel-coordinator/ingest.js', () => ({ COORDINATOR_AGENT_ID: 'telegram-coordinator' }))

import {
  catalogAgentNames,
  readSkillDescription,
  listAgentLocalSkills,
  MANIFEST_EXCLUDED_AGENTS,
} from '../web/federation/local-catalog.js'

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('MANIFEST_EXCLUDED_AGENTS / catalogAgentNames', () => {
  it('excludes plumbing agents (heartbeat, the coordinator, channel-coordinator)', () => {
    expect(MANIFEST_EXCLUDED_AGENTS.has('heartbeat')).toBe(true)
    expect(MANIFEST_EXCLUDED_AGENTS.has('telegram-coordinator')).toBe(true)
    expect(MANIFEST_EXCLUDED_AGENTS.has('channel-coordinator')).toBe(true)
  })

  it('filters the excluded set out of the raw agent list', () => {
    listAgentNamesMock.mockReturnValue(['agent-one', 'heartbeat', 'telegram-coordinator', 'channel-coordinator', 'agent-two'])
    expect(catalogAgentNames()).toEqual(['agent-one', 'agent-two'])
  })

  it('returns an empty list when only plumbing agents exist', () => {
    listAgentNamesMock.mockReturnValue(['heartbeat', 'channel-coordinator'])
    expect(catalogAgentNames()).toEqual([])
  })
})

describe('readSkillDescription', () => {
  function skillDir(name: string): string {
    const dir = join(TMP_ROOT, 'skills-fixtures', name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('extracts the description field from YAML frontmatter', () => {
    const dir = skillDir('with-frontmatter')
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: foo\ndescription: Does a thing well\n---\n\nBody text.')
    expect(readSkillDescription(dir)).toBe('Does a thing well')
  })

  it('strips surrounding quotes from the description', () => {
    const dir = skillDir('quoted')
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: "Quoted description"\n---\n')
    expect(readSkillDescription(dir)).toBe('Quoted description')
  })

  it('returns empty string when there is no description field', () => {
    const dir = skillDir('no-desc')
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: foo\n---\nBody.')
    expect(readSkillDescription(dir)).toBe('')
  })

  it('returns empty string when SKILL.md is missing', () => {
    const dir = skillDir('missing-file')
    expect(readSkillDescription(dir)).toBe('')
  })

  it('caps the description at 300 characters', () => {
    const dir = skillDir('long-desc')
    const long = 'x'.repeat(500)
    writeFileSync(join(dir, 'SKILL.md'), `---\ndescription: ${long}\n---\n`)
    expect(readSkillDescription(dir).length).toBe(300)
  })
})

describe('listAgentLocalSkills', () => {
  it('returns an empty list when the skills directory does not exist', () => {
    expect(listAgentLocalSkills('no-such-agent')).toEqual([])
  })

  it('lists only directories under agents/<name>/.claude/skills, with descriptions', () => {
    const skillsDir = join(TMP_ROOT, 'agents', 'agent-one', '.claude', 'skills')
    mkdirSync(join(skillsDir, 'skill-one'), { recursive: true })
    writeFileSync(join(skillsDir, 'skill-one', 'SKILL.md'), '---\ndescription: First skill\n---\n')
    mkdirSync(join(skillsDir, 'skill-two'), { recursive: true })
    writeFileSync(join(skillsDir, 'skill-two', 'SKILL.md'), '---\ndescription: Second skill\n---\n')
    // A stray file at the skills root must be ignored, not treated as a skill.
    writeFileSync(join(skillsDir, 'README.md'), 'not a skill dir')

    const skills = listAgentLocalSkills('agent-one')
    expect(skills.map((s) => s.name).sort()).toEqual(['skill-one', 'skill-two'])
    expect(skills.every((s) => s.agent === 'agent-one')).toBe(true)
    expect(skills.find((s) => s.name === 'skill-one')?.description).toBe('First skill')
  })
})
