// String contract for the scaffold templates: a generated agent CLAUDE.md reads the agent's OWN token
// file (once it has one), not the shared dashboard token, and shows the skill write an own-agent
// token is allowed to make. Same house idiom as autonomy-section.test.ts (source slices).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold-templates.ts'), 'utf-8')

describe('agent-scaffold-templates: per-agent token resolution', () => {
  it('resolves the token file per agent: its own when it exists, the shared one until then', () => {
    expect(SRC).toMatch(/function tokenFileFor\(name: string\): string \{\s*const own = agentTokenPath\(name\)\s*return existsSync\(own\) \? own : tokenPath/)
  })

  it('reads the token through tokenFileFor in the autonomy block and in the CLAUDE.md generator, never the shared path directly', () => {
    expect(SRC).toMatch(/function buildAutonomyBody\(name: string\): string \{\s*const tok = tokenFileFor\(name\)/)
    expect(SRC).toMatch(/export async function generateClaudeMd\([^)]*\): Promise<string> \{\s*const tok = tokenFileFor\(name\)/)
    // tokenPath may only be used by tokenFileFor itself (its declaration and the fallback).
    expect(SRC.match(/tokenPath/g)).toHaveLength(2)
  })

  it('shows the skill write an own-agent token may make (agent/<name>/..., not global/...)', () => {
    expect(SRC).toContain('agent%2FAGENT_NAME%2FSKILL-NEV')
    expect(SRC).not.toContain('global%2FSKILL-NEV')
  })
})
