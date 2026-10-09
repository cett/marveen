// Every scheduled task belongs to a tenant, and a sub-agent on the shared token tells the
// server which agent it is with X-Agent-Id (its tenant is derived from that). The generated
// CLAUDE.md's create-task example goes through the API wrapper, which sends that header from
// its --agent argument; an example without --agent would send every new agent into a
// 400 tenant_required on its first schedule.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold-templates.ts'), 'utf-8')

describe('generated CLAUDE.md: schedule-create example', () => {
  const example = SRC.split('\n').filter((l) => l.includes('${api} POST /api/schedules'))

  it('has exactly one create example', () => {
    expect(example).toHaveLength(1)
  })

  it('goes through the wrapper prefix, which names the agent (--agent) and so sends X-Agent-Id', () => {
    expect(example[0]).toMatch(/^\$\{api\} POST \/api\/schedules '/)
    expect(SRC).toMatch(/return `\$\{origin\}bash \$\{wrapper\} --agent \$\{name\}`/)
  })

  it('explains the header and the tenant_required outcome for a shared agent', () => {
    expect(SRC).toContain('Az X-Agent-Id fejléc kötelező')
    expect(SRC).toContain('tenant_required')
  })
})
