// String contract for the scaffold templates: a generated agent CLAUDE.md reaches the API through the
// wrapper (which resolves the agent's OWN token), never through a token file path or a Bearer header,
// and shows the skill write an own-agent token is allowed to make. Same house idiom as
// autonomy-section.test.ts (source slices).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold-templates.ts'), 'utf-8')

describe('agent-scaffold-templates: per-agent token resolution', () => {
  it('builds every recipe prefix with apiCmd: the absolute wrapper path plus the agent', () => {
    expect(SRC).toContain("const apiWrapperPath = join(PROJECT_ROOT, 'scripts', 'agent-api.sh')")
    expect(SRC).toMatch(/function apiCmd\(name: string\): string \{/)
  })

  it('uses apiCmd in the autonomy block and in the CLAUDE.md generator', () => {
    expect(SRC).toMatch(/function buildAutonomyBody\(name: string\): string \{\s*const api = apiCmd\(name\)/)
    expect(SRC).toMatch(/export async function generateClaudeMd\([^)]*\): Promise<string> \{\s*const api = apiCmd\(name\)/)
  })

  it('has no token file path or Bearer header left in the templates', () => {
    expect(SRC).not.toMatch(/Authorization: Bearer|\.dashboard-token|tokenFileFor|agentTokenPath|\$\{tok\}/)
  })

  it('shows the skill write an own-agent token may make (agent/<name>/..., not global/...)', () => {
    expect(SRC).toContain('agent%2FAGENT_NAME%2FSKILL-NEV')
    expect(SRC).not.toContain('global%2FSKILL-NEV')
  })
})
