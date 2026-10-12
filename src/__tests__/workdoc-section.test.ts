// Functional test for ensureWorkDocSection() -- mirrors no-reader-section.test.ts.
// The work-document rule block must reach an EXISTING CLAUDE.md (sub-agent and main agent),
// exactly once, without touching the hand-written text around it.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-workdoc-test-'))

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

const { ensureWorkDocSection } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: workdoc-rule (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: workdoc-rule -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('ensureWorkDocSection', () => {
  it('adds the block to an existing CLAUDE.md and keeps the manual text intact', () => {
    const manual = '# Agent B\n\n## Saját szabályok\n\nKézzel írt rész, $S és $& marad.\n'
    setup('agent-b', manual)
    ensureWorkDocSection('agent-b')
    const result = read('agent-b')
    expect(result.startsWith(manual.trimEnd())).toBe(true)
    expect(count(result, BEGIN)).toBe(1)
    expect(count(result, END)).toBe(1)
  })

  it('states the rule: SQL only, binary exception, scratchpad staging, doc_key in delegation', () => {
    setup('agent-b', '# Agent B\n')
    ensureWorkDocSection('agent-b')
    const result = read('agent-b')
    expect(result).toContain('CSAK a workspace_docs táblába kerül (POST /api/v1/workspace)')
    expect(result).toContain('lokális fájlba soha')
    expect(result).toContain('bináris fájl')
    expect(result).toContain('workspace-doc-write')
    expect(result).toContain(`${join(tmpRoot, 'scripts', 'workspace-put.py')} --file <út> --doc-key <típus>/<kártya>`)
    expect(result).toContain('--agent agent-b --delete-source')
    expect(result).toContain('SOSE nevezz meg helyi fájlútvonalat')
    expect(result).toContain('add meg a doc_key-t')
  })

  it('stays a short block with no em dash', () => {
    setup('agent-b', '# Agent B\n')
    ensureWorkDocSection('agent-b')
    const result = read('agent-b')
    const block = result.slice(result.indexOf(BEGIN), result.indexOf(END))
    expect(block).not.toContain(String.fromCharCode(8212))
    expect(block.split('\n').filter(l => l.startsWith('- ')).length).toBeLessThanOrEqual(6)
  })

  it('does not duplicate on the second call and does not rewrite the file', () => {
    setup('agent-b', '# Agent B\n\nPersona.\n')
    ensureWorkDocSection('agent-b')
    const first = read('agent-b')
    const mtime = statSync(join(tmpRoot, 'agents', 'agent-b', 'CLAUDE.md')).mtimeMs
    ensureWorkDocSection('agent-b')
    expect(read('agent-b')).toBe(first)
    expect(count(read('agent-b'), BEGIN)).toBe(1)
    expect(statSync(join(tmpRoot, 'agents', 'agent-b', 'CLAUDE.md')).mtimeMs).toBe(mtime)
  })

  it('replaces only a stale block, leaving the text before and after it alone', () => {
    setup('agent-b', `# Agent B\n\nElőtte.\n\n${BEGIN}\nrégi szöveg\n${END}\n\n## Utána\n\nUtána rész.\n`)
    ensureWorkDocSection('agent-b')
    const result = read('agent-b')
    expect(result).not.toContain('régi szöveg')
    expect(result).toContain('Előtte.')
    expect(result).toContain('## Utána\n\nUtána rész.')
    expect(count(result, BEGIN)).toBe(1)
  })

  it('leaves the other generated blocks alone', () => {
    const other = '<!-- BEGIN GENERATED: no-reader-rules (auto-generated, do not edit by hand) -->\nx\n<!-- END GENERATED: no-reader-rules -->'
    setup('agent-b', `# Agent B\n\n${other}\n`)
    ensureWorkDocSection('agent-b')
    expect(read('agent-b')).toContain(other)
  })

  it('skips an agent without a CLAUDE.md', () => {
    ensureWorkDocSection('agent-missing')
    expect(existsSync(join(tmpRoot, 'agents', 'agent-missing'))).toBe(false)
  })

  it('writes the main agent block to PROJECT_ROOT/CLAUDE.md, not to agents/<main>/', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n\nPersona.\n', 'utf-8')
    setup('agent-a', '# Main in agents dir\n')
    ensureWorkDocSection('agent-a') // agent-a is the mocked MAIN_AGENT_ID
    const main = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(count(main, BEGIN)).toBe(1)
    expect(main).toContain('--agent agent-a --delete-source')
    expect(main).toContain('Persona.')
    expect(read('agent-a')).toBe('# Main in agents dir\n')
  })
})
