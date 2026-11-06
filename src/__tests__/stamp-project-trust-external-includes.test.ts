// stampProjectTrustForDir also pre-approves the "Allow external CLAUDE.md file imports?" dialog. The agents' CLAUDE.md
// imports `@../../personas/<name>.md`, outside the project root, and Claude Code keys that consent on the PROJECT ROOT
// (the git root; for a linked worktree the root of the MAIN repo; with no git root the dir itself), measured on
// claude 2.1.316: a flag on the agent dir below a git root is never looked at. Real temporary file system, no fs mock.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync, statSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeProjectRoot, stampProjectTrustForDir } from '../web/agent-process-config.js'

const made: string[] = []
function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stamp-ext-')))
  made.push(dir)
  return dir
}
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })

const APPROVED = 'hasClaudeMdExternalIncludesApproved'
const WARNED = 'hasClaudeMdExternalIncludesWarningShown'

// <root>/.git (dir), <root>/agents/x as the agent dir
function repoWithAgentDir(): { root: string; agent: string } {
  const root = tmp()
  mkdirSync(join(root, '.git'))
  const agent = join(root, 'agents', 'x')
  mkdirSync(agent, { recursive: true })
  return { root, agent }
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf-8')) as { projects: Record<string, Record<string, unknown>> } & Record<string, unknown>
const cfg = (dir: string) => join(dir, '.claude.json')

describe('the external-includes consent lands on the project root', () => {
  it('a fresh config: the git root gets both flags, the agent dir keeps only the folder-trust stamp', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[root]).toMatchObject({ [APPROVED]: true, [WARNED]: true })
    expect(projects[agent]).toMatchObject({ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true })
    expect(projects[agent][APPROVED]).toBeUndefined()
  })

  it('an existing false becomes true on the root and the other fields of that key stay', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), JSON.stringify({ projects: { [root]: { [APPROVED]: false, [WARNED]: true, hasTrustDialogAccepted: true, allowedTools: ['Read'] } } }))
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    expect(read(cfg(home)).projects[root]).toMatchObject({ [APPROVED]: true, [WARNED]: true, hasTrustDialogAccepted: true, allowedTools: ['Read'] })
  })

  it('a root that is already approved and an agent dir that is already trusted: no write, false, the file is untouched', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    const done = {
      hasCompletedOnboarding: true,
      projects: {
        [root]: { [APPROVED]: true },
        [agent]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 },
      },
    }
    writeFileSync(cfg(home), JSON.stringify(done))
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(cfg(home), old, old)
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(false)
    expect(statSync(cfg(home)).mtimeMs).toBe(old.getTime())
    expect(JSON.parse(readFileSync(cfg(home), 'utf-8'))).toEqual(done)
  })

  it('the second call changes nothing (idempotent)', () => {
    const { agent } = repoWithAgentDir()
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    const first = readFileSync(cfg(home), 'utf-8')
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(false)
    expect(readFileSync(cfg(home), 'utf-8')).toBe(first)
  })

  it('other keys and fields (mcpServers, another project, top-level settings) are untouched', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), JSON.stringify({
      theme: 'dark', mcpServers: { a: { command: 'x' } },
      projects: { '/elsewhere': { [APPROVED]: false, mcpServers: { b: {} } } },
    }))
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    const out = read(cfg(home))
    expect(out.theme).toBe('dark')
    expect(out.mcpServers).toEqual({ a: { command: 'x' } })
    expect(out.projects['/elsewhere']).toEqual({ [APPROVED]: false, mcpServers: { b: {} } })
    expect(out.projects[root][APPROVED]).toBe(true)
  })

  it('a linked worktree resolves to the MAIN repo root (its .git is a file with a commondir behind it)', () => {
    const main = tmp()
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    const wt = tmp()
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    const agent = join(wt, 'agents', 'x')
    mkdirSync(agent, { recursive: true })
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[main]).toMatchObject({ [APPROVED]: true, [WARNED]: true })
    expect(projects[wt]).toBeUndefined()
    expect(projects[agent][APPROVED]).toBeUndefined()
  })

  it('a worktree whose gitdir is relative resolves the same way', () => {
    const base = tmp()
    const main = join(base, 'main')
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..')
    const wt = join(base, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), 'gitdir: ../main/.git/worktrees/wt\n')
    expect(resolveClaudeProjectRoot(wt)).toBe(main)
  })

  it('a submodule (a .git file without a commondir) is its own root', () => {
    const base = tmp()
    const sub = join(base, 'sub')
    mkdirSync(sub)
    mkdirSync(join(base, 'modules', 'sub'), { recursive: true })
    writeFileSync(join(sub, '.git'), 'gitdir: ../modules/sub\n')
    expect(resolveClaudeProjectRoot(sub)).toBe(sub)
  })

  it('a worktree whose gitdir pointer goes through a symlink to the main repo stamps both the pointed path and the real one', () => {
    const base = tmp()
    const main = join(base, 'main')
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..')
    const alias = join(base, 'alias')
    symlinkSync(main, alias)
    const wt = join(base, 'wt')
    mkdirSync(join(wt, 'agents', 'x'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(alias, '.git', 'worktrees', 'wt')}\n`)
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), join(wt, 'agents', 'x'))).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[alias][APPROVED]).toBe(true)
    expect(projects[main][APPROVED]).toBe(true)
  })

  it('a worktree of a bare repository (the common dir is not named .git) keeps the dir that holds the .git file', () => {
    const base = tmp()
    mkdirSync(join(base, 'bare.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(base, 'bare.git', 'worktrees', 'wt', 'commondir'), '../..')
    const wt = join(base, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${join(base, 'bare.git', 'worktrees', 'wt')}\n`)
    expect(resolveClaudeProjectRoot(wt)).toBe(wt)
  })

  it('a .git file that is not a gitdir pointer keeps the dir that holds it', () => {
    const dir = tmp()
    writeFileSync(join(dir, '.git'), 'garbage\n')
    expect(resolveClaudeProjectRoot(dir)).toBe(dir)
  })

  it('with no git root the agent dir itself is the project key', () => {
    const dir = tmp()
    const agent = join(dir, 'a', 'b')
    mkdirSync(agent, { recursive: true })
    const home = tmp()
    expect(resolveClaudeProjectRoot(agent)).toBe(agent)
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    expect(read(cfg(home)).projects[agent]).toMatchObject({ [APPROVED]: true, [WARNED]: true, hasTrustDialogAccepted: true })
    expect(read(cfg(home)).projects[dir]).toBeUndefined()
  })

  it('a symlinked agent dir stamps the real root key too', () => {
    const { root, agent } = repoWithAgentDir()
    const holder = tmp()
    const link = join(holder, 'link')
    symlinkSync(agent, link)
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), link)).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[root]).toMatchObject({ [APPROVED]: true })
    expect(projects[agent]).toMatchObject({ hasTrustDialogAccepted: true })
  })

  it('a symlinked agent dir in a non-git place stamps both the link and the real path', () => {
    const real = tmp()
    const holder = tmp()
    const link = join(holder, 'link')
    symlinkSync(real, link)
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), link)).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[real][APPROVED]).toBe(true)
    expect(projects[link][APPROVED]).toBe(true)
  })

  it('a broken or unreadable config answers false without throwing and is not truncated', () => {
    const { agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), '{ not json')
    expect(() => stampProjectTrustForDir(cfg(home), agent)).not.toThrow()
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(false)
    expect(readFileSync(cfg(home), 'utf-8')).toBe('{ not json')
    const dirAsFile = join(home, 'is-a-dir.json')
    mkdirSync(dirAsFile)
    expect(stampProjectTrustForDir(dirAsFile, agent)).toBe(false)
    expect(existsSync(dirAsFile)).toBe(true)
  })

  it('a projects value that is an array or not an object is replaced by a fresh map, the flags still land', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), JSON.stringify({ projects: [1, 2] }))
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    expect(read(cfg(home)).projects[root][APPROVED]).toBe(true)
  })
})
