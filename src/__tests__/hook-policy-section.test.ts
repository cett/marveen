// Functional test for ensureHookPolicySection() (kanban 1235), same shape as checkpoint-section.test.ts.
// The hook policy used to say every hook is fail-closed on a timeout, a crash or any non-zero exit and that
// this cannot be configured. The host does not do that: the rule is exit 2 OR onFailure "block" on the entry.
// The corrected section must reach an EXISTING sub-agent CLAUDE.md, replacing the known old wording, leaving a
// hand-edited one alone (and reporting it), and stay in line with templates/CLAUDE.md.template.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-hook-policy-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: tmpRoot,
  SCRIPTS_DIR: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureHookPolicySection, substituteTemplatePlaceholders } = await import('../web/agent-scaffold.js')

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HEADING = '## Hook fail-closed policy'
const BEGIN = '<!-- BEGIN GENERATED: hook-policy (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: hook-policy -->'
// The earlier wording, as hand-copied into agent CLAUDE.md files (heading, blank line, one paragraph).
const OLD_SECTION = "## Hook fail-closed policy\n\nMinden hook (PreToolUse, PostToolUse, PreCompact, Stop) fail-closed: ha a hook script nem elérhető, crashel, timeout-ol (>10s), vagy nem-nulla exitCode-dal tér vissza, az eredmény DENY -- a művelet nem hajtódik végre. Fail-open kizárva. Ez nem konfigurálható. Logging hook (tool-log-capture) kivétel: az csak logol, crash/timeout esetén silent pass."

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')
const count = (hay: string, needle: string) => hay.split(needle).length - 1
const blockOf = (text: string) => text.slice(text.indexOf(BEGIN) + BEGIN.length, text.indexOf(END)).trim()

describe('ensureHookPolicySection', () => {
  it('adds the block when the heading is absent and keeps the manual text intact', () => {
    const manual = '# Agent B\n\n## Saját szabályok\n\nKézzel írt rész, $S és $& marad.\n'
    setup('agent-b', manual)
    expect(ensureHookPolicySection('agent-b')).toBe('added')
    const result = read('agent-b')
    expect(result.startsWith(manual.trimEnd())).toBe(true)
    expect(count(result, BEGIN)).toBe(1)
    expect(count(result, END)).toBe(1)
    expect(count(result, HEADING)).toBe(1)
  })

  it('replaces the known old section, keeping the text before and after it', () => {
    const before = '# Agent B\n\nElőtte.\n\n'
    const after = '<!-- BEGIN GENERATED: workdoc-rule (auto-generated, do not edit by hand) -->\n## Munkadokumentum\n\nMás szakasz.\n<!-- END GENERATED: workdoc-rule -->\n'
    setup('agent-b', `${before}${OLD_SECTION}\n\n${after}`)
    expect(ensureHookPolicySection('agent-b')).toBe('replaced')
    const result = read('agent-b')
    expect(result).not.toContain('Ez nem konfigurálható')
    expect(count(result, HEADING)).toBe(1)
    expect(result.startsWith(before + BEGIN)).toBe(true)
    expect(result.endsWith(`${END}\n\n${after}`)).toBe(true)
  })

  it('replaces the known old section at the end of the file, and one with CRLF line ends', () => {
    setup('agent-b', `# Agent B\n\n${OLD_SECTION}\n`)
    expect(ensureHookPolicySection('agent-b')).toBe('replaced')
    expect(read('agent-b').endsWith(`${END}\n`)).toBe(true)
    setup('agent-c', `# Agent C\r\n\r\n${OLD_SECTION.replace(/\n/g, '\r\n')}\r\n`)
    expect(ensureHookPolicySection('agent-c')).toBe('replaced')
    expect(count(read('agent-c'), HEADING)).toBe(1)
  })

  it('is idempotent: the second call reports unchanged and does not rewrite the file', () => {
    setup('agent-b', `# Agent B\n\n${OLD_SECTION}\n`)
    expect(ensureHookPolicySection('agent-b')).toBe('replaced')
    const path = join(tmpRoot, 'agents', 'agent-b', 'CLAUDE.md')
    const text = read('agent-b')
    const mtime = statSync(path).mtimeMs
    expect(ensureHookPolicySection('agent-b')).toBe('unchanged')
    expect(read('agent-b')).toBe(text)
    expect(statSync(path).mtimeMs).toBe(mtime)
    setup('agent-d', '# Agent D\n')
    ensureHookPolicySection('agent-d')
    expect(ensureHookPolicySection('agent-d')).toBe('unchanged')
  })

  it('updates a stale generated block and touches nothing outside it', () => {
    const manual = '# Agent B\n\nElőtte.\n\n'
    setup('agent-b', `${manual}${BEGIN}\n${HEADING}\n\nrégi generált szöveg\n${END}\n\nUtána.\n`)
    expect(ensureHookPolicySection('agent-b')).toBe('updated')
    const result = read('agent-b')
    expect(result).not.toContain('régi generált szöveg')
    expect(result.startsWith(manual + BEGIN)).toBe(true)
    expect(result.endsWith(`${END}\n\nUtána.\n`)).toBe(true)
  })

  it('leaves a hand-edited section under the heading untouched and reports it', () => {
    const edited = `# Agent B\n\n${HEADING}\n\nSaját, kézzel átírt szabály: ${'x'.repeat(10)}.\n\n## Következő\n\nszöveg\n`
    setup('agent-b', edited)
    expect(ensureHookPolicySection('agent-b')).toBe('left-manual')
    expect(read('agent-b')).toBe(edited)
    // the old text with one word changed is a hand edit too
    const nearly = `# Agent B\n\n${OLD_SECTION.replace('Fail-open kizárva', 'Fail-open megengedett')}\n`
    setup('agent-c', nearly)
    expect(ensureHookPolicySection('agent-c')).toBe('left-manual')
    expect(read('agent-c')).toBe(nearly)
  })

  it('leaves a file with an unpaired generated marker untouched (BEGIN without END, END without BEGIN, wrong order)', () => {
    const cases: Record<string, string> = {
      // the destructive case: an orphan BEGIN right above the KNOWN old section would otherwise get a second block
      'orphan-begin-old': `# A\n\n${BEGIN}\n${OLD_SECTION}\n\n## Következő\n\nszöveg\n`,
      'orphan-begin-only': `# A\n\n${BEGIN}\n\nSemmi több.\n`,
      'orphan-end': `# A\n\n${HEADING}\n\nszöveg\n${END}\n`,
      'end-before-begin': `# A\n\n${END}\n\n${BEGIN}\n${HEADING}\n\nrégi\n`,
    }
    for (const [name, text] of Object.entries(cases)) {
      setup(name, text)
      expect(ensureHookPolicySection(name), name).toBe('left-manual')
      expect(read(name), name).toBe(text)
    }
  })

  it('the text names the unproven PostToolUse hook and the in-process outgoing-copy gate', () => {
    setup('agent-wording', '# A\n')
    expect(ensureHookPolicySection('agent-wording')).toBe('added')
    const body = read('agent-wording')
    expect(body).toContain('post-tool-injection-gate nincs a kötelező listán')
    expect(body).toContain('outgoing-copy (in-process fut az email-approval bejegyzésén át)')
    // the template carries the same two sentences
    const tpl = readFileSync(join(REPO_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(tpl).toContain('post-tool-injection-gate nincs a kötelező listán')
    expect(tpl).toContain('outgoing-copy (in-process fut az email-approval bejegyzésén át)')
  })

  it('leaves the other generated blocks alone', () => {
    const other = '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nauton\n<!-- END GENERATED: autonomy-wiring -->\n'
    setup('agent-b', `# Agent B\n\n${other}`)
    ensureHookPolicySection('agent-b')
    expect(read('agent-b')).toContain(other)
  })

  it('skips an agent without a CLAUDE.md', () => {
    expect(ensureHookPolicySection('agent-missing')).toBe('skipped')
    expect(existsSync(join(tmpRoot, 'agents', 'agent-missing'))).toBe(false)
  })

  it('skips the main agent: neither PROJECT_ROOT/CLAUDE.md nor agents/<main>/CLAUDE.md changes', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), `# Main\n\n${OLD_SECTION}\n`, 'utf-8')
    setup('agent-a', `# Main in agents dir\n\n${OLD_SECTION}\n`)
    expect(ensureHookPolicySection('agent-a')).toBe('skipped') // agent-a is the mocked MAIN_AGENT_ID
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toBe(`# Main\n\n${OLD_SECTION}\n`)
    expect(read('agent-a')).toBe(`# Main in agents dir\n\n${OLD_SECTION}\n`)
  })

  it('uses no em dash and no double hyphen as a dash (house style)', () => {
    setup('agent-b', '# Agent B\n')
    ensureHookPolicySection('agent-b')
    const block = blockOf(read('agent-b'))
    expect(block).not.toContain(String.fromCharCode(0x2014))
    expect(block).not.toContain(' -- ')
  })

  it('states the real rule: exit 2 OR onFailure block, the failure cases, the exceptions, no fail-open', () => {
    setup('agent-b', '# Agent B\n')
    ensureHookPolicySection('agent-b')
    const block = blockOf(read('agent-b'))
    expect(block).toMatch(/exit 2-vel tér vissza, VAGY ha a bejegyzésén `"onFailure": "block"` áll/)
    expect(block).toMatch(/timeout, nem indul el, vagy az exit 2-től különböző nem-nulla kilépéssel ér véget/)
    expect(block).toMatch(/a harness-timeout, a nem induló hook és az exit 2-től különböző kilépés NEM blokkol/)
    expect(block).toMatch(/logging\/capture hookok \(tool-log-capture\)/)
    expect(block).toMatch(/UserPromptSubmit hookokon alapból nincs/)
    expect(block).toMatch(/A kapunak a harness 10 másodperces timeoutja alatt kell végeznie \(lineáris minták, méretplafon\); az `onFailure` csak a végső védőháló/)
    expect(block).toMatch(/Fail-open nem megengedett: kapu-bejegyzés `onFailure: block` nélkül nem kerülhet be\./)
    // the old claims are gone
    expect(block).not.toMatch(/nem konfigurálható/)
    expect(block).not.toMatch(/Fail-open kizárva/)
    expect(block).not.toMatch(/a hook script nem elérhető, crashel, timeout-ol/)
  })

  it('states the live probe exactly: the timeout branch is proven, the other two are not', () => {
    setup('agent-b', '# Agent B\n')
    ensureHookPolicySection('agent-b')
    const block = blockOf(read('agent-b'))
    expect(block).toContain('Élő próba (2026-11-01, claude 2.1.310): a timeout-ág igazolt')
    expect(block).toContain('a nem induló hook és az exit 2-től különböző kilépés ága élőben nem volt kipróbálva')
    expect(block).not.toMatch(/mindhárom ág igazolt|minden ág igazolt/i)
  })
})

describe('hook policy block vs templates/CLAUDE.md.template', () => {
  it('is the same text as the template section', () => {
    const rendered = substituteTemplatePlaceholders(
      readFileSync(join(REPO_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8'),
      { projectRoot: '/test-root', mainAgentId: 'agent-a', botName: 'Agent A', ownerName: 'Owner', webPort: 3499 },
    )
    const start = rendered.indexOf(HEADING)
    expect(start).toBeGreaterThan(-1)
    expect(rendered.indexOf(HEADING, start + 1)).toBe(-1) // once
    const rest = rendered.slice(start)
    const next = rest.slice(HEADING.length).search(/\n## /)
    const templateSection = next === -1 ? rest : rest.slice(0, HEADING.length + next)

    setup('agent-b', '# Agent B\n')
    ensureHookPolicySection('agent-b')
    expect(blockOf(read('agent-b'))).toBe(templateSection.trim())
  })
})
