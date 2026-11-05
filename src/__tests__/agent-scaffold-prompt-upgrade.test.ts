// An agent whose PreCompact memory-save prompt is an UNEDITED copy of an earlier template version is moved to the
// current template prompt (PREVIOUS_TEMPLATE_PROMPT_HASHES in agent-scaffold-hooks.ts), on every install: the hash is
// taken over the PLACEHOLDER form ({{BOT_NAME}}, {{PROJECT_ROOT}}, {{WEB_PORT}}), so it does not depend on the values
// the install resolved them with. An operator's edit (any difference at all) stays. The marker branch is unchanged.
//
// The earlier versions are a fixture (ASCII JSON with \u escapes): the real text of each template commit in its
// placeholder form. Neutral identities only (two invented installs); no real names, paths or ports of this fleet.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// A throw-away project root and home for the full-path tests: ensureAgentHooks writes under PROJECT_ROOT/agents and
// (for the main agent, which it must refuse) would target ~/.claude/settings.json. Both are redirected to a temp dir
// so no test touches the real agents folders or the real user settings.
const env = await vi.hoisted(async () => {
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  const root = mk(j(tmpdir(), 'precompact-upgrade-'))
  return { root, project: j(root, 'project'), home: j(root, 'home'), bot: 'Beta-Bot', port: 4100 }
})
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: env.project,
  BOT_NAME: env.bot,
  WEB_PORT: env.port,
}))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => env.home }))

import {
  LEGACY_PROMPT_MARKERS, upgradeLegacyAgentPrompts, isPreviousTemplatePrompt, normalizePromptPlaceholders, ensureAgentHooks,
  type PromptIdentity,
} from '../web/agent-scaffold-hooks.js'
import { substituteTemplatePlaceholders } from '../web/agent-scaffold-templates.js'
import { MAIN_AGENT_ID } from '../config.js'

type Version = { commit: string; label: string; timeout: number | null; prompt: string }
const VERSIONS = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'precompact-prompt-versions.json'), 'utf-8')) as Version[]
const ver = (label: string) => {
  const v = VERSIONS.find((x) => x.label === label)
  if (!v) throw new Error(`no fixture version ${label}`)
  return v
}
// the earlier versions without a legacy marker (the ones this change adds), and the ones with (the old branch)
const UNMARKED = ['first', 'agent-id-from-claude-md', 'skill-steps', 'wrapper', 'port-named']
const MARKED = ['marker-token-file', 'marker-token-file-port-chain']

const TEMPLATE_PATH = join(process.cwd(), 'templates', 'settings.json.template')
const currentHook = (() => {
  const data = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf-8')) as { hooks: { PreCompact: Array<{ hooks: Array<{ type: string; prompt?: string; timeout?: number }> }> } }
  const hooks = data.hooks.PreCompact.flatMap((e) => e.hooks).filter((h) => h.type === 'agent')
  if (hooks.length !== 1) throw new Error('expected one PreCompact agent hook in the template')
  return hooks[0] as { type: string; prompt: string; timeout: number }
})()

// Two invented installs, with different values for all three placeholders.
const ID_A: PromptIdentity = { projectRoot: '/srv/install-a/app', botName: 'Alpha', webPort: 3000 }
const ID_B: PromptIdentity = { projectRoot: '/opt/other/b-install', botName: 'Beta-Bot', webPort: 4100 }

const resolve = (text: string, id: PromptIdentity) =>
  substituteTemplatePlaceholders(text, { projectRoot: id.projectRoot, mainAgentId: 'agent-main', botName: id.botName, ownerName: 'owner', webPort: id.webPort })
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')

type Hook = { type: string; prompt?: unknown; command?: string; timeout?: number }
const pre = (...hooks: Hook[]) => ({ PreCompact: [{ matcher: 'auto', hooks }] })
const tplFor = (id: PromptIdentity) => pre({ type: 'agent', prompt: resolve(currentHook.prompt, id), timeout: currentHook.timeout })
const promptOf = (h: ReturnType<typeof pre>, i = 0) => h.PreCompact[0].hooks[i].prompt

describe('the fixture: earlier template versions', () => {
  it('holds the five marker-free versions and two marker versions, each distinct from the current prompt', () => {
    expect(VERSIONS.map((v) => v.label).sort()).toEqual([...UNMARKED, ...MARKED].sort())
    for (const v of VERSIONS) expect(v.prompt, v.commit).not.toBe(currentHook.prompt)
  })

  it('the marker-free versions carry no marker, the marker versions do', () => {
    for (const l of UNMARKED) expect(LEGACY_PROMPT_MARKERS.some((m) => ver(l).prompt.includes(m)), l).toBe(false)
    for (const l of MARKED) expect(LEGACY_PROMPT_MARKERS.some((m) => ver(l).prompt.includes(m)), l).toBe(true)
  })

  it('the current template prompt carries no legacy marker', () => {
    expect(LEGACY_PROMPT_MARKERS.some((m) => currentHook.prompt.includes(m))).toBe(false)
  })
})

describe('LEGACY_PROMPT_MARKERS is not extended', () => {
  it('stays the two markers of the token-file recipe', () => {
    expect([...LEGACY_PROMPT_MARKERS]).toEqual(['/store/.dashboard-token', '/Documents/marveen'])
  })
})

describe.each([['install A', ID_A], ['install B', ID_B]] as Array<[string, PromptIdentity]>)('an earlier template version resolved by %s', (_n, id) => {
  it.each(UNMARKED)('%s: replaced by the current template prompt, the timeout follows the template', (label) => {
    const existing = pre({ type: 'agent', prompt: resolve(ver(label).prompt, id), timeout: ver(label).timeout ?? 60 })
    const tpl = tplFor(id)
    expect(upgradeLegacyAgentPrompts(existing, tpl, id)).toBe(true)
    expect(existing.PreCompact[0].hooks[0]).toEqual({ type: 'agent', prompt: resolve(currentHook.prompt, id), timeout: currentHook.timeout })
    // idempotent: the second pass changes nothing
    expect(upgradeLegacyAgentPrompts(existing, tpl, id)).toBe(false)
    expect(existing.PreCompact[0].hooks).toHaveLength(1)
  })

  it.each(MARKED)('%s (a marker version): still replaced, by the marker branch', (label) => {
    const existing = pre({ type: 'agent', prompt: resolve(ver(label).prompt, id) })
    expect(upgradeLegacyAgentPrompts(existing, tplFor(id), id)).toBe(true)
    expect(promptOf(existing)).toBe(resolve(currentHook.prompt, id))
  })

  it('the current prompt is a no-op', () => {
    const existing = pre({ type: 'agent', prompt: resolve(currentHook.prompt, id), timeout: currentHook.timeout })
    expect(upgradeLegacyAgentPrompts(existing, tplFor(id), id)).toBe(false)
  })
})

describe('an install-dependent value is judged by the install that resolved it', () => {
  it('a version resolved by install A is NOT recognised under the identity of install B (the values do not match)', () => {
    // the wrapper and port-named versions carry the checkout path, so a path of another install is a different text
    for (const l of ['wrapper', 'port-named']) {
      const existing = pre({ type: 'agent', prompt: resolve(ver(l).prompt, ID_A) })
      expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_B), ID_B), l).toBe(false)
    }
  })

  it('the oldest versions carry no placeholder and are recognised under any identity', () => {
    for (const l of ['first', 'agent-id-from-claude-md', 'skill-steps']) {
      for (const id of [ID_A, ID_B]) expect(isPreviousTemplatePrompt(ver(l).prompt, id), `${l} ${id.botName}`).toBe(true)
    }
  })
})

describe('an operator edit stays', () => {
  const EDITED_FROM = ['wrapper', 'port-named', 'first']
  const edits: Array<[string, (p: string) => string]> = [
    ['one character appended', (p) => `${p}.`],
    ['one character prepended', (p) => `x${p}`],
    ['a trailing newline', (p) => `${p}\n`],
    ['one line removed', (p) => p.split('\n').filter((_l, i) => i !== 2).join('\n')],
    ['the same text with CRLF line ends', (p) => p.replaceAll('\n', '\r\n')],
    ['one word changed', (p) => p.replace('agent_id', 'agent_name')],
    ['an extra line at the end', (p) => `${p}\nSAJAT_SOR`],
  ]
  for (const label of EDITED_FROM) {
    it.each(edits)(`${label} version, %s`, (_n, edit) => {
      const original = resolve(ver(label).prompt, ID_A)
      const edited = edit(original)
      expect(edited).not.toBe(original)
      const existing = pre({ type: 'agent', prompt: edited, timeout: 77 })
      expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A)).toBe(false)
      expect(promptOf(existing)).toBe(edited)
      expect(existing.PreCompact[0].hooks[0].timeout).toBe(77)
    })
  }

  it('a text that merely contains an earlier version is not an earlier version (no substring, no prefix match)', () => {
    const original = resolve(ver('port-named').prompt, ID_A)
    for (const text of [`${original}\n\nmy own notes`, `my own notes\n\n${original}`, original.slice(0, original.length - 20), original.slice(20)]) {
      const existing = pre({ type: 'agent', prompt: text })
      expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A)).toBe(false)
      expect(promptOf(existing)).toBe(text)
    }
  })

  it('a hand-written prompt, and one that only mentions a localhost port or an old checkout, stays', () => {
    for (const text of ['my own compaction notes', 'save to http://localhost:3000/api/memories', 'see ~/ClaudeClaw/scripts and agent-api.sh']) {
      const existing = pre({ type: 'agent', prompt: text })
      expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A), text).toBe(false)
    }
  })
})

describe('what is not an agent prompt is not touched', () => {
  it('a command hook whose command is an earlier prompt text', () => {
    const text = resolve(ver('port-named').prompt, ID_A)
    const existing = pre({ type: 'command', command: text })
    expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A)).toBe(false)
    expect(existing.PreCompact[0].hooks[0].command).toBe(text)
  })

  it('a command hook that carries an earlier prompt text in a prompt field (only type agent counts)', () => {
    const text = resolve(ver('port-named').prompt, ID_A)
    const existing = pre({ type: 'command', command: 'echo ok', prompt: text })
    expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A)).toBe(false)
    expect(existing.PreCompact[0].hooks[0].prompt).toBe(text)
  })

  it('a template hook that is not an agent hook is not a replacement source', () => {
    const existing = pre({ type: 'agent', prompt: resolve(ver('port-named').prompt, ID_A) })
    const tpl = pre({ type: 'command', command: 'x', prompt: resolve(currentHook.prompt, ID_A) })
    expect(upgradeLegacyAgentPrompts(existing, tpl, ID_A)).toBe(false)
  })

  it('a template that is itself an earlier text (a revert) reports no change, now or on the second pass', () => {
    const text = resolve(ver('port-named').prompt, ID_A)
    const existing = pre({ type: 'agent', prompt: text })
    const tpl = pre({ type: 'agent', prompt: text })
    expect(upgradeLegacyAgentPrompts(existing, tpl, ID_A)).toBe(false)
    expect(upgradeLegacyAgentPrompts(existing, tpl, ID_A)).toBe(false)
    expect(promptOf(existing)).toBe(text)
  })

  it('an agent hook whose prompt is not a string (number, null, missing, an array of the text)', () => {
    const text = resolve(ver('port-named').prompt, ID_A)
    for (const prompt of [5, null, undefined, [text], { text }]) {
      const existing = pre({ type: 'agent', prompt })
      expect(() => upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A)).not.toThrow()
      expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A)).toBe(false)
      expect(existing.PreCompact[0].hooks[0].prompt).toEqual(prompt)
    }
  })

  it('an earlier prompt under another event is not replaced by the PreCompact prompt', () => {
    const text = resolve(ver('port-named').prompt, ID_A)
    const existing = { Stop: [{ hooks: [{ type: 'agent', prompt: text }] }] }
    expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_A), ID_A)).toBe(false)
  })

  it('an event the agent does not have at all', () => {
    expect(upgradeLegacyAgentPrompts({}, tplFor(ID_A), ID_A)).toBe(false)
  })
})

describe('the hash Set', () => {
  it('holds every marker-free earlier version (placeholder form) and not the current prompt', () => {
    for (const l of UNMARKED) expect(isPreviousTemplatePrompt(ver(l).prompt, ID_A), l).toBe(true)
    for (const id of [ID_A, ID_B]) expect(isPreviousTemplatePrompt(resolve(currentHook.prompt, id), id), id.botName).toBe(false)
    expect(isPreviousTemplatePrompt(currentHook.prompt, ID_A)).toBe(false)
  })

  it('a text is recognised through its placeholder form: the hash of the normalised text is the hash of the version', () => {
    for (const l of ['wrapper', 'port-named']) {
      const resolved = resolve(ver(l).prompt, ID_B)
      expect(sha(normalizePromptPlaceholders(resolved, ID_B)), l).toBe(sha(ver(l).prompt))
    }
  })
})

// --- the base install (port 3420) ---------------------------------------------------------------------------------
// The three oldest versions carry no placeholder and write the default port out (`localhost:3420`). Under an identity
// whose port IS 3420 the normalised read turns that into `localhost:{{WEB_PORT}}`, a different text with a different
// hash, so only the RAW read recognises them there. The identities above (3000, 4100) never see this: their port does
// not occur in those texts, the normalised text equals the raw one, and a mutant that drops the raw read survives.
describe('the base install (port 3420): the oldest versions are recognised by the raw read', () => {
  const ID_BASE: PromptIdentity = { projectRoot: '/srv/install-base/app', botName: 'Marveen', webPort: 3420 }
  const LITERAL = ['first', 'agent-id-from-claude-md', 'skill-steps']
  const PLACEHOLDER = ['wrapper', 'port-named']

  it('precondition: under the base identity the normalised text of each literal version DIFFERS from the raw text', () => {
    for (const l of LITERAL) {
      expect(ver(l).prompt, l).toContain('localhost:3420')
      expect(sha(normalizePromptPlaceholders(ver(l).prompt, ID_BASE)), l).not.toBe(sha(ver(l).prompt))
    }
    // and under the other identities it does not: that is why they could not see the raw read
    for (const l of LITERAL) expect(normalizePromptPlaceholders(ver(l).prompt, ID_A), l).toBe(ver(l).prompt)
  })

  it.each(LITERAL)('%s: recognised, replaced by the current template prompt, idempotent', (label) => {
    expect(isPreviousTemplatePrompt(ver(label).prompt, ID_BASE)).toBe(true)
    const existing = pre({ type: 'agent', prompt: resolve(ver(label).prompt, ID_BASE), timeout: ver(label).timeout ?? 60 })
    const tpl = tplFor(ID_BASE)
    expect(upgradeLegacyAgentPrompts(existing, tpl, ID_BASE)).toBe(true)
    expect(existing.PreCompact[0].hooks[0]).toEqual({ type: 'agent', prompt: resolve(currentHook.prompt, ID_BASE), timeout: currentHook.timeout })
    expect(upgradeLegacyAgentPrompts(existing, tpl, ID_BASE)).toBe(false)
  })

  it.each(PLACEHOLDER)('%s (resolved by the base install): recognised through the normalised read, replaced', (label) => {
    const resolved = resolve(ver(label).prompt, ID_BASE)
    expect(resolved).not.toBe(ver(label).prompt) // the placeholders really were filled with the base values
    expect(isPreviousTemplatePrompt(resolved, ID_BASE)).toBe(true)
    const existing = pre({ type: 'agent', prompt: resolved, timeout: ver(label).timeout ?? 60 })
    expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_BASE), ID_BASE)).toBe(true)
    expect(promptOf(existing)).toBe(resolve(currentHook.prompt, ID_BASE))
  })

  it('positive control: the same literal text is recognised under the other identities (raw and normalised reads agree there)', () => {
    for (const l of LITERAL) for (const id of [ID_A, ID_B]) expect(isPreviousTemplatePrompt(ver(l).prompt, id), `${l} ${id.botName}`).toBe(true)
  })

  it('a text written out by a 3420 install is replaced under ANOTHER identity as well (the raw text is the text)', () => {
    for (const l of LITERAL) {
      for (const id of [ID_A, ID_B]) {
        const existing = pre({ type: 'agent', prompt: resolve(ver(l).prompt, ID_BASE) })
        expect(upgradeLegacyAgentPrompts(existing, tplFor(id), id), `${l} ${id.botName}`).toBe(true)
        expect(promptOf(existing)).toBe(resolve(currentHook.prompt, id))
      }
    }
  })

  it('the current prompt is a no-op and an operator edit stays under the base identity (the raw read does not loosen the match)', () => {
    const current = pre({ type: 'agent', prompt: resolve(currentHook.prompt, ID_BASE), timeout: currentHook.timeout })
    expect(upgradeLegacyAgentPrompts(current, tplFor(ID_BASE), ID_BASE)).toBe(false)
    for (const l of [...LITERAL, ...PLACEHOLDER]) {
      const edited = `${resolve(ver(l).prompt, ID_BASE)}\nSAJAT_SOR`
      const existing = pre({ type: 'agent', prompt: edited, timeout: 77 })
      expect(upgradeLegacyAgentPrompts(existing, tplFor(ID_BASE), ID_BASE), l).toBe(false)
      expect(promptOf(existing), l).toBe(edited)
    }
  })
})

describe('normalizePromptPlaceholders', () => {
  it('writes the three values back to their placeholders', () => {
    const text = 'A Beta-Bot via /opt/other/b-install/scripts/x at http://localhost:4100/api'
    expect(normalizePromptPlaceholders(text, ID_B)).toBe('A {{BOT_NAME}} via {{PROJECT_ROOT}}/scripts/x at http://localhost:{{WEB_PORT}}/api')
  })

  it('the longest value first: a bot name that is part of the checkout path does not split the path', () => {
    const id: PromptIdentity = { projectRoot: '/srv/Alpha/app', botName: 'Alpha', webPort: 3000 }
    expect(normalizePromptPlaceholders('Alpha lives in /srv/Alpha/app', id)).toBe('{{BOT_NAME}} lives in {{PROJECT_ROOT}}')
  })

  it('a bare port number is not a port placeholder (only localhost:<port> is)', () => {
    expect(normalizePromptPlaceholders('port 3000 and localhost:3000', ID_A)).toBe('port 3000 and localhost:{{WEB_PORT}}')
  })

  it('an empty value is skipped, not replaced everywhere', () => {
    const id: PromptIdentity = { projectRoot: '', botName: '', webPort: '' }
    expect(normalizePromptPlaceholders('plain text', id)).toBe('plain text')
  })

  it('a bot name that is an ordinary word of the prompt makes the text differ from the template: nothing is replaced (safe side)', () => {
    const id: PromptIdentity = { projectRoot: '/opt/other/b-install', botName: 'agent', webPort: 4100 }
    const existing = pre({ type: 'agent', prompt: resolve(ver('port-named').prompt, id) })
    expect(upgradeLegacyAgentPrompts(existing, tplFor(id), id)).toBe(false)
  })
})

// --- the whole path: ensureAgentHooks on a settings.json in a temp project root ---------------------------------
describe('ensureAgentHooks, whole path (temp project root)', () => {
  const IDENT: PromptIdentity = { projectRoot: env.project, botName: env.bot, webPort: env.port }
  const settingsOf = (agent: string) => join(env.project, 'agents', agent, '.claude', 'settings.json')
  const writeSettings = (agent: string, settings: unknown) => {
    mkdirSync(join(env.project, 'agents', agent, '.claude'), { recursive: true })
    writeFileSync(settingsOf(agent), JSON.stringify(settings, null, 2))
  }
  const readSettings = (agent: string) => JSON.parse(readFileSync(settingsOf(agent), 'utf-8')) as { hooks: { PreCompact: Array<{ hooks: Hook[] }> } }
  const agentPrompts = (agent: string) => readSettings(agent).hooks.PreCompact.flatMap((e) => e.hooks).filter((h) => h.type === 'agent')

  beforeAll(() => {
    mkdirSync(join(env.project, 'templates'), { recursive: true })
    copyFileSync(TEMPLATE_PATH, join(env.project, 'templates', 'settings.json.template'))
  })
  beforeEach(() => { rmSync(join(env.project, 'agents'), { recursive: true, force: true }) })
  afterAll(() => { rmSync(env.root, { recursive: true, force: true }) })

  it('the temp roots are really used (the config mock took effect)', () => {
    expect(env.project.startsWith(env.root)).toBe(true)
    expect(settingsOf('agent-x').startsWith(env.root)).toBe(true)
  })

  it.each(['wrapper', 'port-named'])('an agent carrying the %s version gets the template prompt, exactly one PreCompact agent hook remains', (label) => {
    writeSettings('agent-x', { hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: resolve(ver(label).prompt, IDENT), timeout: 120 }] }] } })
    expect(ensureAgentHooks('agent-x')).toBe(true)
    const hooks = agentPrompts('agent-x')
    expect(hooks).toHaveLength(1)
    expect(hooks[0].prompt).toBe(resolve(currentHook.prompt, IDENT))
    expect(hooks[0].timeout).toBe(currentHook.timeout)
    // a second start changes nothing about the prompt, and still one hook
    ensureAgentHooks('agent-x')
    expect(agentPrompts('agent-x')).toHaveLength(1)
    expect(agentPrompts('agent-x')[0].prompt).toBe(resolve(currentHook.prompt, IDENT))
  })

  it('an operator-edited prompt is kept through ensureAgentHooks, and no second prompt is added', () => {
    const edited = `${resolve(ver('port-named').prompt, IDENT)}\nMy own line`
    writeSettings('agent-y', { hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: edited, timeout: 90 }] }] } })
    ensureAgentHooks('agent-y')
    const hooks = agentPrompts('agent-y')
    expect(hooks).toHaveLength(1)
    expect(hooks[0].prompt).toBe(edited)
  })

  it('the main agent is refused: its (temp) user settings keep the earlier prompt', () => {
    const file = join(env.home, '.claude', 'settings.json')
    mkdirSync(join(env.home, '.claude'), { recursive: true })
    const before = JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: 'agent', prompt: resolve(ver('port-named').prompt, IDENT) }] }] } })
    writeFileSync(file, before)
    expect(ensureAgentHooks(MAIN_AGENT_ID)).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })
})
