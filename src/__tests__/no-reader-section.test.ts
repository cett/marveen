// Functional test for ensureNoReaderSection() -- mirrors autonomy-section.test.ts.
// The block must reach an EXISTING agent CLAUDE.md on respawn, exactly once,
// without touching the hand-written text around it.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-noreader-test-'))

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

const { ensureNoReaderSection } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: no-reader-rules (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: no-reader-rules -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('ensureNoReaderSection', () => {
  it('adds the block to an existing CLAUDE.md and keeps the manual text intact', () => {
    const manual = '# Agent B\n\n## Saját szabályok\n\nKézzel írt rész, $S és $& marad.\n'
    setup('agent-b', manual)
    ensureNoReaderSection('agent-b')
    const result = read('agent-b')
    expect(result.startsWith(manual.trimEnd())).toBe(true)
    expect(count(result, BEGIN)).toBe(1)
    expect(count(result, END)).toBe(1)
    expect(result).toContain('A tmux panelt senki nem olvassa')
    expect(result).toContain('/api/messages')
  })

  it('does not duplicate on the second call and does not rewrite the file', () => {
    setup('agent-b', '# Agent B\n\nPersona.\n')
    ensureNoReaderSection('agent-b')
    const first = read('agent-b')
    const mtime = statSync(join(tmpRoot, 'agents', 'agent-b', 'CLAUDE.md')).mtimeMs
    ensureNoReaderSection('agent-b')
    expect(read('agent-b')).toBe(first)
    expect(count(read('agent-b'), BEGIN)).toBe(1)
    expect(statSync(join(tmpRoot, 'agents', 'agent-b', 'CLAUDE.md')).mtimeMs).toBe(mtime)
  })

  it('replaces only a stale block, leaving the text before and after it alone', () => {
    setup('agent-b', `# Agent B\n\nElőtte.\n\n${BEGIN}\nrégi szöveg\n${END}\n\n## Utána\n\nUtána rész.\n`)
    ensureNoReaderSection('agent-b')
    const result = read('agent-b')
    expect(result).not.toContain('régi szöveg')
    expect(result).toContain('Előtte.')
    expect(result).toContain('## Utána\n\nUtána rész.')
    expect(count(result, BEGIN)).toBe(1)
  })

  it('tells the agent to report a tool rejection instead of re-running it', () => {
    setup('agent-b', '# Agent B\n')
    ensureNoReaderSection('agent-b')
    const result = read('agent-b')
    expect(result).toContain('ne futtasd újra')
    expect(result).toContain('csak az ő válasza után ismételd meg')
    expect(result).not.toContain('Futtasd újra')
  })

  it('skips an agent without a CLAUDE.md and never touches the main agent', () => {
    ensureNoReaderSection('agent-missing')
    expect(existsSync(join(tmpRoot, 'agents', 'agent-missing'))).toBe(false)
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    setup('agent-a', '# Main in agents dir\n')
    ensureNoReaderSection('agent-a') // agent-a is the mocked MAIN_AGENT_ID
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toBe('# Main\n')
    expect(read('agent-a')).toBe('# Main in agents dir\n')
  })
})
