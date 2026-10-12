// The human-only approval flow is described in several places an agent or an operator reads: the fork
// guide (F02), the user guide's recovery chapter, the OpenAPI description of the create call, and the
// kanban-audit seed skill. Each of them names markers, a switch and error codes that live in code; this
// reads the names from the code and requires every text to carry them, so a rename leaves a red test
// instead of a stale doc. String contracts, the house idiom for text with no behaviour to run.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { humanOnlyRequestLine, ownerUnreachedLine, approvalResolvedLine } from '../web/approval-owner-notice.js'
import type { Approval } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf-8')

const F02_EN = read('docs/fork-guide/en/F02-configuration.md')
const F02_HU = read('docs/fork-guide/hu/F02-konfiguracio.md')
const PROFILE_EN = read('docs/user-guide/en/18-profile.md')
const PROFILE_HU = read('docs/user-guide/hu/18-profil.md')
const OPENAPI = read('docs/openapi.yaml')
const KANBAN_AUDIT = read('seed-scheduled-tasks/kanban-audit/SKILL.md')
const CONFIG = read('src/config.ts')
const APPROVALS_ROUTE = read('src/web/routes/approvals.ts')

const approval: Approval = {
  id: 'appr-1', agent_id: 'agent-b', category: 'email_send', action_description: 'x', action_payload: null,
  status: 'approved', timeout_at: 1_800_000_000, telegram_message_id: null, requested_at: 0, resolved_at: null,
  resolved_by: null, tenant_id: 'default', human_only: 1, resolved_via: 'dashboard_session',
}
const MARKERS = [humanOnlyRequestLine(approval), ownerUnreachedLine(approval), approvalResolvedLine(approval)]
  .map(line => line.split(' ')[0])

describe('the names the docs rely on exist in code', () => {
  it('the switch is read by the config under that exact name', () => {
    expect(CONFIG).toContain("'APPROVAL_HUMAN_ONLY_ENFORCE'")
  })

  it('the refusal code is the one the route answers with', () => {
    expect(APPROVALS_ROUTE).toContain("code: 'human_only_category'")
  })

  it('the session-only code is the one the guard answers with', () => {
    expect(read('src/web/session-only-guard.ts')).toContain('human_session_required')
  })

  it('the markers are the ones the server builds', () => {
    expect(MARKERS).toEqual(['[APPROVAL_REQUEST][HUMAN_ONLY]', '[OWNER_UNREACHED]', '[APPROVAL_RESOLVED]'])
  })
})

describe.each([
  ['F02 (en)', F02_EN],
  ['F02 (hu)', F02_HU],
])('fork guide %s', (_name, doc) => {
  const section = doc.slice(doc.search(/^## (Human-only approvals|Csak-ember jóváhagyások)$/m))

  it('has the section, placed before the next chapter', () => {
    expect(section.length).toBeGreaterThan(200)
    expect(section).toMatch(/\n## (Model profile map|Modell-profil térkép)/)
  })

  it('names the switch, the built-in categories, the refusal code and every marker', () => {
    const body = section.slice(0, section.search(/\n## (Model profile map|Modell-profil térkép)/))
    for (const word of ['APPROVAL_HUMAN_ONLY_ENFORCE', 'email_send', 'email_standing_recipient', 'human_only_category', 'human_session_required', '#approvals', 'owner_unreached', ...MARKERS]) {
      expect(body, word).toContain(word)
    }
  })

  it('says the link opens only on the machine the dashboard runs on and carries no token', () => {
    const body = section.slice(0, 4000)
    expect(body).toMatch(/Europe\/Budapest/)
    expect(body).toMatch(/token/)
  })

  it('names the way back in: the CLI reset, and the switch as the emergency brake', () => {
    expect(section).toContain('dashboard-user -- reset-password')
    expect(section).toMatch(/restart|újraindít/)
  })
})

describe('user guide recovery chapter', () => {
  it.each([['en', PROFILE_EN], ['hu', PROFILE_HU]])('(%s) closes the HTTP break-glass route when enforced and explains the login', (_l, doc) => {
    expect(doc).toContain('APPROVAL_HUMAN_ONLY_ENFORCE=1')
    expect(doc).toContain('human_session_required')
    expect(doc).toContain('/api/auth/status')
    expect(doc).toMatch(/"role":"admin"/)
    expect(doc).toMatch(/"tenant_id":null/)
  })
})

describe('OpenAPI create-approval description', () => {
  const create = OPENAPI.slice(OPENAPI.indexOf('operationId: createApproval'), OPENAPI.indexOf('operationId: createApproval') + 3500)

  it('describes the owner message and the agent lines, with the switch', () => {
    expect(create).toContain('APPROVAL_HUMAN_ONLY_ENFORCE=1')
    for (const marker of MARKERS) expect(create).toContain(marker)
    expect(create).toMatch(/cannot decide anything/)
  })

  it('says the old behaviour stays without the flag', () => {
    expect(create).toMatch(/Without the flag \(the default\)/)
  })
})

describe('kanban-audit seed skill', () => {
  it('tells the agent not to PATCH a human-only request and to act only on approved', () => {
    expect(KANBAN_AUDIT).toContain('humanOnly')
    expect(KANBAN_AUDIT).toMatch(/SOHA ne PATCH-eld \(403 `human_only_category`\)/)
    expect(KANBAN_AUDIT).toContain('[APPROVAL_RESOLVED]')
    // The notice is only a hint: the decision is what the server answers on GET.
    expect(KANBAN_AUDIT).toMatch(/az `\[APPROVAL_RESOLVED\]` üzenet csak jelzés/)
    expect(KANBAN_AUDIT).toMatch(/csak akkor cselekedj, ha a szerver válasza `status=approved` és `resolved_via=dashboard_session`/)
  })

  it('keeps its own approval flow for the ordinary case', () => {
    expect(KANBAN_AUDIT).toContain('POST /api/approvals')
    expect(KANBAN_AUDIT).toContain('approved → archiválj')
  })
})
