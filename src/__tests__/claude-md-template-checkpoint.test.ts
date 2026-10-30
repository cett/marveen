import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { substituteTemplatePlaceholders } from '../web/agent-scaffold.js'

// Guards the "long background work checkpoint" section of the generated main-agent CLAUDE.md
// (templates/CLAUDE.md.template). The section tells an agent to save partial results about every
// ten minutes and to resume from them after a restart. Unlike the upstream wording, the checkpoint
// lives in workspace_docs (SQL), never in a loose file, so the recipe must stay in line with what
// scripts/workspace-put.py actually accepts: a doc_key the script rejects would make every
// checkpoint save fail silently for a model that follows the template to the letter.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKSPACE_PUT = join(REPO_ROOT, 'scripts', 'workspace-put.py')
const HEADING = '## Checkpoint hosszú háttérmunkánál'

const rendered = substituteTemplatePlaceholders(
  readFileSync(join(REPO_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8'),
  { projectRoot: '/test-root', mainAgentId: 'agent-a', botName: 'Agent A', ownerName: 'Owner', webPort: 3499 },
)

/** The checkpoint section: from its heading to the next level-2 heading. */
function section(): string {
  const start = rendered.indexOf(HEADING)
  expect(start, 'the checkpoint section heading is missing from the template').toBeGreaterThan(-1)
  const rest = rendered.slice(start + HEADING.length)
  const next = rest.search(/\n## /)
  return HEADING + (next === -1 ? rest : rest.slice(0, next))
}

describe('CLAUDE.md.template: long background work checkpoint section', () => {
  it('appears exactly once', () => {
    expect(rendered.split(HEADING).length - 1).toBe(1)
  })

  it('asks for a save about every ten minutes and after each logical unit', () => {
    const s = section()
    expect(s).toMatch(/10 percenként/)
    expect(s).toMatch(/restart/i)
  })

  it('keeps the checkpoint in workspace_docs, not in a loose file', () => {
    const s = section()
    expect(s).toContain('workspace_docs')
    expect(s).toContain('workspace-put.py')
    expect(s).toContain('--delete-source')
    expect(s, 'the section must say NOT a file').toMatch(/NEM fájlba/)
  })

  it('tells the agent to read the checkpoint back before restarting the work, scoped to its own agent id', () => {
    const s = section()
    expect(s).toContain('/api/v1/workspace?doc_key=notes/checkpoint-<feladat>&agent=agent-a')
  })

  it('forbids secrets and private data in the checkpoint body', () => {
    expect(section()).toMatch(/Titok, token, jelszó és privát adat nem kerül bele/)
  })

  it('resolves every placeholder (port, install dir, agent id) with no leftovers', () => {
    const s = section()
    expect(s).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(s).toContain('localhost:3499')
    expect(s).toContain('/test-root/scripts/workspace-put.py')
    expect(s).toContain('--agent agent-a')
  })

  it('carries no deployment identity: no home path, chat id or email', () => {
    const s = section()
    expect(s).not.toMatch(/\/(Users|home)\//)
    expect(s).not.toMatch(/\d{8,}/)
    expect(s).not.toMatch(/\S+@\S+\.\S+/)
  })

  it('uses no em dash (house style)', () => {
    expect(section()).not.toContain(String.fromCharCode(0x2014))
  })
})

describe('CLAUDE.md.template: the checkpoint doc_key is one workspace-put.py accepts', () => {
  let tmp: string
  let body: string
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ckpt-tpl-'))
    body = join(tmp, 'body.md')
    writeFileSync(body, '# checkpoint\n\ngoal / done / next\n')
  })
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

  // The API wrapper is pointed at a path that does not exist. Validation of the doc_key runs BEFORE any
  // API call (exit 2 = usage/validation error); a key that passes validation then fails at the missing
  // wrapper (exit 1 = runtime failure). So "exit !== 2" means "the script accepted this doc_key", and
  // the dashboard is never contacted.
  function put(docKey: string) {
    return spawnSync('python3', [WORKSPACE_PUT, '--file', body, '--doc-key', docKey, '--type', 'notes', '--agent', 'agent-a'], {
      encoding: 'utf-8',
      env: { ...process.env, WORKSPACE_PUT_API_CMD: join(tmp, 'no-such-wrapper') },
    })
  }

  it('the key the template teaches (with the placeholder filled in) passes the script validation', () => {
    const m = section().match(/--doc-key (\S*<feladat>\S*)/)
    expect(m, 'the template must show the workspace-put.py call with its doc_key').not.toBeNull()
    const key = m![1].replace('<feladat>', 'c607faf3')
    const r = put(key)
    expect(r.status, `workspace-put.py rejected the template doc_key ${key}: ${r.stderr}`).not.toBe(2)
  })

  it('control: a key outside the allowed prefixes IS rejected with exit 2 (so the check above can fail)', () => {
    const r = put('checkpoint/c607faf3')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/doc_key/)
  })
})
