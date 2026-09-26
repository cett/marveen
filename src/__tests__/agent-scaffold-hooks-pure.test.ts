// Coverage for the pure/near-pure decision and string-building functions in
// src/web/agent-scaffold-hooks.ts -- previously untested directly (only
// reached transitively through agent-bootstrap integration tests). This file
// deliberately does NOT touch the fs-heavy orchestration functions
// (ensureAgentHooks/ensureAgentStalenessHook/ensureEgressGate/
// ensureDestructiveGate/scaffoldAgentDir/ensureDefaultScheduledTasks), which
// need a fuller agent-dir/template fixture and are left for a follow-up
// batch. Real config.js is used unmocked -- SCRIPTS_DIR/PROJECT_ROOT resolve
// to this actual repo checkout, so the registration guard's existsSync
// checks against the real shipped gate scripts (email-send-gate.mjs,
// self-pace-gate.mjs, hooks/egress-gate.mjs, hooks/destructive-gate.py).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import {
  HOOK_NODE_BIN,
  hookCommand,
  hookCommandWired,
  isUnsafeHookCommand,
  upgradeLegacyHookCommands,
  isPublicFetchHost,
  ownerAllowedDomains,
  renderQuarantineReader,
  destructiveGateCommand,
  agentGetsEmailGate,
  agentGetsGovernanceGates,
  injectEmailSendGate,
  injectSelfPaceGate,
  injectEgressGate,
  injectDestructiveGate,
} from '../web/agent-scaffold-hooks.js'

describe('hookCommand', () => {
  it('builds a fail-closed node preamble that blocks on a missing interpreter', () => {
    const cmd = hookCommand('/some/script.mjs')
    expect(cmd).toBe(
      `test -x "${HOOK_NODE_BIN}" || { echo "governance-kapu: a hook interpretere nem talalhato (${HOOK_NODE_BIN}). A kapu ezert BLOKKOL. Javitas: inditsd ujra a dashboardot, az ujrairja a hook-utakat." >&2; exit 2; }; "${HOOK_NODE_BIN}" "/some/script.mjs"`,
    )
  })
})

describe('destructiveGateCommand', () => {
  it('builds a fail-closed python3 preamble that blocks (DENY) on a missing interpreter', () => {
    const cmd = destructiveGateCommand('/some/script.py')
    expect(cmd).toBe(
      "command -v python3 >/dev/null 2>&1 || { echo 'destructive-gate: python3 not found -- DENY' >&2; exit 2; }; python3 \"/some/script.py\"",
    )
  })
})

describe('hookCommandWired', () => {
  it('matches a command present verbatim in the serialized array', () => {
    const ptu = JSON.stringify([{ hooks: [{ command: 'echo hi' }] }])
    expect(hookCommandWired(ptu, 'echo hi')).toBe(true)
  })

  it('does not match an absent command', () => {
    const ptu = JSON.stringify([{ hooks: [{ command: 'echo hi' }] }])
    expect(hookCommandWired(ptu, 'echo bye')).toBe(false)
  })

  it('matches a Windows-style backslash path via its JSON-escaped form', () => {
    const command = 'C:\\Users\\op\\node.exe "C:\\scripts\\gate.mjs"'
    const ptu = JSON.stringify([{ hooks: [{ command }] }])
    expect(hookCommandWired(ptu, command)).toBe(true)
  })
})

describe('isUnsafeHookCommand', () => {
  it('rejects a command referencing a volatile tmpfs path', () => {
    expect(isUnsafeHookCommand('node "/tmp/some-script.mjs"')).toBe(true)
    expect(isUnsafeHookCommand('node "/private/tmp/some-script.mjs"')).toBe(true)
  })

  it('rejects a command whose referenced script does not exist on disk', () => {
    expect(isUnsafeHookCommand('node "/definitely/not/a/real/path/ghost.mjs"')).toBe(true)
  })

  it('accepts a command referencing a script that exists and is not under a tmpfs prefix', () => {
    const real = join(process.cwd(), 'scripts', 'email-send-gate.mjs')
    expect(isUnsafeHookCommand(`node "${real}"`)).toBe(false)
  })

  it('accepts a command with no recognizable script path at all', () => {
    expect(isUnsafeHookCommand('echo just a plain command')).toBe(false)
  })
})

describe('upgradeLegacyHookCommands', () => {
  it('replaces a legacy bare command with the template form when the script basename matches', () => {
    const real = join(process.cwd(), 'scripts', 'hooks', 'staleness-guard.py')
    const existing = { UserPromptSubmit: [{ hooks: [{ command: `python3 ${real}` } as { command: string; timeout?: number }] }] }
    const tpl = { UserPromptSubmit: [{ hooks: [{ command: `bash -c "python3 ${real}"`, timeout: 15 }] }] }
    const changed = upgradeLegacyHookCommands(existing, tpl)
    expect(changed).toBe(true)
    expect(existing.UserPromptSubmit[0].hooks[0].command).toBe(`bash -c "python3 ${real}"`)
    expect(existing.UserPromptSubmit[0].hooks[0].timeout).toBe(15)
  })

  it('is a no-op when the existing command already matches the template exactly', () => {
    const existing = { UserPromptSubmit: [{ hooks: [{ command: 'same-command.py' }] }] }
    const tpl = { UserPromptSubmit: [{ hooks: [{ command: 'same-command.py' }] }] }
    expect(upgradeLegacyHookCommands(existing, tpl)).toBe(false)
  })

  it('skips an event entirely missing from the existing hooks', () => {
    const existing = {}
    const tpl = { PreToolUse: [{ hooks: [{ command: '/x/gate.mjs' }] }] }
    expect(upgradeLegacyHookCommands(existing, tpl)).toBe(false)
  })

  it('never applies a template command flagged unsafe by the registration guard', () => {
    const existing = { UserPromptSubmit: [{ hooks: [{ command: 'python3 /old/path/staleness-guard.py' }] }] }
    const tpl = { UserPromptSubmit: [{ hooks: [{ command: '/tmp/staleness-guard.py' }] }] }
    expect(upgradeLegacyHookCommands(existing, tpl)).toBe(false)
    expect(existing.UserPromptSubmit[0].hooks[0].command).toBe('python3 /old/path/staleness-guard.py')
  })
})

describe('isPublicFetchHost', () => {
  it('accepts an ordinary public domain', () => {
    expect(isPublicFetchHost('api.example.com')).toBe(true)
  })

  it('rejects an IPv4 literal', () => {
    expect(isPublicFetchHost('93.184.216.34')).toBe(false)
  })

  it('rejects a single-label name (localhost and friends)', () => {
    expect(isPublicFetchHost('localhost')).toBe(false)
  })

  it('rejects internal TLD-like suffixes', () => {
    for (const suffix of ['local', 'internal', 'lan', 'test', 'invalid']) {
      expect(isPublicFetchHost(`box.${suffix}`)).toBe(false)
    }
  })

  it('rejects a value containing a scheme, port, path, or space', () => {
    expect(isPublicFetchHost('https://example.com')).toBe(false)
    expect(isPublicFetchHost('example.com:8080')).toBe(false)
    expect(isPublicFetchHost('example.com/path')).toBe(false)
    expect(isPublicFetchHost('exa mple.com')).toBe(false)
  })

  it('rejects a wildcard-DNS dash-quad label that encodes a loopback address', () => {
    expect(isPublicFetchHost('127-0-0-1.sslip.io')).toBe(false)
  })

  it('rejects a wildcard-DNS dotted-quad embedded across labels that encodes RFC1918', () => {
    expect(isPublicFetchHost('192.168.1.50.nip.io')).toBe(false)
  })

  it('accepts a public dash-quad-shaped label that does not decode to an inward address', () => {
    expect(isPublicFetchHost('8-8-8-8.sslip.io')).toBe(true)
  })

  it('rejects an empty value, an over-length host, and leading/trailing dot or dash', () => {
    expect(isPublicFetchHost('')).toBe(false)
    expect(isPublicFetchHost('a'.repeat(254))).toBe(false)
    expect(isPublicFetchHost('.example.com')).toBe(false)
    expect(isPublicFetchHost('example.com.')).toBe(false)
    expect(isPublicFetchHost('-example.com')).toBe(false)
  })

  it('rejects a label longer than 63 characters', () => {
    expect(isPublicFetchHost(`${'a'.repeat(64)}.com`)).toBe(false)
  })
})

describe('ownerAllowedDomains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-allowed-domains-'))

  it('returns [] when the allowlist file does not exist', () => {
    expect(ownerAllowedDomains(join(dir, 'does-not-exist'))).toEqual([])
  })

  it('returns [] when the file is malformed JSON', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'owner-allowed-domains-bad-'))
    writeFileSync(join(badDir, 'egress-allowlist.json'), '{ not json')
    expect(ownerAllowedDomains(badDir)).toEqual([])
    rmSync(badDir, { recursive: true, force: true })
  })

  it('filters to public-fetch-safe string domains only, trimmed', () => {
    const goodDir = mkdtempSync(join(tmpdir(), 'owner-allowed-domains-good-'))
    writeFileSync(join(goodDir, 'egress-allowlist.json'), JSON.stringify({
      domains: [' api.example.com ', 'localhost', '127.0.0.1', 42, null, 'partner.example.org'],
    }))
    expect(ownerAllowedDomains(goodDir)).toEqual(['api.example.com', 'partner.example.org'])
    rmSync(goodDir, { recursive: true, force: true })
  })

  rmSync(dir, { recursive: true, force: true })
})

describe('renderQuarantineReader', () => {
  const template = [
    '# Quarantine Reader',
    '',
    '## Domain restriction',
    '- `feeds.example.com`',
    '',
    '## Other section',
    '- `unrelated-bullet`',
  ].join('\n')

  it('inserts a new per-install block after the last bullet in the Domain restriction section', () => {
    const out = renderQuarantineReader(template, ['partner.example.org'])
    expect(out).toContain('- `feeds.example.com`\n<!-- BEGIN PER-INSTALL DOMAINS (from store/egress-allowlist.json) -->\n- `partner.example.org`\n<!-- END PER-INSTALL DOMAINS -->')
    // The unrelated section's bullet must never be touched or used as anchor.
    expect(out.indexOf('unrelated-bullet')).toBeGreaterThan(out.indexOf('END PER-INSTALL DOMAINS'))
  })

  it('is a no-op (returns the template unchanged) when the domain is already listed', () => {
    const out = renderQuarantineReader(template, ['feeds.example.com', 'FEEDS.EXAMPLE.COM'])
    expect(out).toBe(template)
  })

  it('replaces a previous per-install block instead of stacking a second one', () => {
    const once = renderQuarantineReader(template, ['partner.example.org'])
    const twice = renderQuarantineReader(once, ['second.example.org'])
    expect(twice.match(/BEGIN PER-INSTALL DOMAINS/g)?.length).toBe(1)
    expect(twice).toContain('second.example.org')
    expect(twice).not.toContain('partner.example.org')
  })

  it('returns the template unchanged when the Domain restriction section has no bullets', () => {
    const noBullets = ['# Reader', '', '## Domain restriction', '', '## Next'].join('\n')
    expect(renderQuarantineReader(noBullets, ['x.example.com'])).toBe(noBullets)
  })
})

describe('agentGetsEmailGate / agentGetsGovernanceGates', () => {
  it('exempt only the main agent', () => {
    expect(agentGetsEmailGate(MAIN_AGENT_ID)).toBe(false)
    expect(agentGetsEmailGate('some-sub-agent')).toBe(true)
    expect(agentGetsGovernanceGates(MAIN_AGENT_ID)).toBe(false)
    expect(agentGetsGovernanceGates('some-sub-agent')).toBe(true)
  })
})

describe('inject*Gate helpers (idempotent PreToolUse wiring)', () => {
  it('injectEmailSendGate adds exactly one entry and de-dupes on a second call', () => {
    const existing: Record<string, unknown> = {}
    injectEmailSendGate(existing)
    injectEmailSendGate(existing)
    const ptu = (existing.hooks as any).PreToolUse as unknown[]
    const matches = ptu.filter((e) => JSON.stringify(e).includes('email-send-gate.mjs'))
    expect(matches.length).toBe(1)
    expect((matches[0] as any).matcher).toBe('Bash|send_email')
  })

  it('injectSelfPaceGate adds exactly one entry and de-dupes on a second call', () => {
    const existing: Record<string, unknown> = {}
    injectSelfPaceGate(existing)
    injectSelfPaceGate(existing)
    const ptu = (existing.hooks as any).PreToolUse as unknown[]
    const matches = ptu.filter((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))
    expect(matches.length).toBe(1)
  })

  it('injectEgressGate adds exactly one entry and de-dupes on a second call', () => {
    const existing: Record<string, unknown> = {}
    injectEgressGate(existing)
    injectEgressGate(existing)
    const ptu = (existing.hooks as any).PreToolUse as unknown[]
    const matches = ptu.filter((e) => JSON.stringify(e).includes('egress-gate.mjs'))
    expect(matches.length).toBe(1)
    expect((matches[0] as any).matcher).toBe('WebFetch')
  })

  it('injectDestructiveGate adds exactly one entry and de-dupes on a second call', () => {
    const existing: Record<string, unknown> = {}
    injectDestructiveGate(existing)
    injectDestructiveGate(existing)
    const ptu = (existing.hooks as any).PreToolUse as unknown[]
    const matches = ptu.filter((e) => JSON.stringify(e).includes('destructive-gate.py'))
    expect(matches.length).toBe(1)
    expect((matches[0] as any).matcher).toBe('Bash')
  })

  it('injectors preserve unrelated pre-existing PreToolUse entries', () => {
    const existing: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: 'SomeOtherTool', hooks: [{ command: 'echo keep-me' }] }] } }
    injectEmailSendGate(existing)
    const ptu = (existing.hooks as any).PreToolUse as unknown[]
    expect(ptu.some((e) => JSON.stringify(e).includes('keep-me'))).toBe(true)
    expect(ptu.some((e) => JSON.stringify(e).includes('email-send-gate.mjs'))).toBe(true)
  })
})
