// stampProjectTrustForDir also pre-approves the "Allow external CLAUDE.md file imports?" dialog. The agents' CLAUDE.md
// imports `@../../personas/<name>.md`, outside the project root, and Claude Code keys that consent on the REAL path of
// the PROJECT ROOT (the git root; for a linked worktree the root of the MAIN repo; with no git root the dir itself),
// measured on claude 2.1.316: a flag on the agent dir below a git root is never looked at, and neither is a
// symlink-shaped key. An explicit No (approved:false with warned:true) is the operator's answer and is never
// overwritten. Real temporary file system, no fs mock.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync, statSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { resolveClaudeProjectRoot, stampProjectTrustForDir } from '../web/agent-process-config.js'

const made: string[] = []
function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stamp-ext-')))
  made.push(dir)
  return dir
}
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })

const APPROVED = 'hasClaudeMdExternalIncludesApproved'
const WARNED = 'hasClaudeMdExternalIncludesWarningShown'
const TRUSTED = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 }

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

describe('the external-includes consent lands on the real project root', () => {
  it('a fresh config: the git root gets the approval (only that flag), the agent dir keeps only the folder-trust stamp', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[root][APPROVED]).toBe(true)
    expect(projects[root][WARNED]).toBeUndefined()
    expect(projects[agent]).toMatchObject({ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true })
    expect(projects[agent][APPROVED]).toBeUndefined()
  })

  it('the shape the dialog itself leaves with a Yes (trust + approved on the root only) is already done: the root key is not rewritten', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), JSON.stringify({ hasCompletedOnboarding: true, projects: { [root]: { hasTrustDialogAccepted: true, [APPROVED]: true }, [agent]: TRUSTED } }))
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(cfg(home), old, old)
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(false)
    expect(statSync(cfg(home)).mtimeMs).toBe(old.getTime())
    expect(read(cfg(home)).projects[root]).toEqual({ hasTrustDialogAccepted: true, [APPROVED]: true })
  })

  it('a flag only on the agent dir (the shape that does NOT satisfy the dialog) still gets the root approved', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), JSON.stringify({ hasCompletedOnboarding: true, projects: { [agent]: { ...TRUSTED, [APPROVED]: true } } }))
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    expect(read(cfg(home)).projects[root][APPROVED]).toBe(true)
  })

  it('the four states of the root key: approved true / missing / false without the warning / false WITH the warning (a No)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const states: Array<[string, Record<string, unknown>, boolean, boolean]> = [
      // name, the root entry, written?, warned?
      ['approved true: no write', { [APPROVED]: true }, false, false],
      ['approved missing: approved', { hasTrustDialogAccepted: true }, true, false],
      ['approved false, no warning shown: approved', { [APPROVED]: false }, true, false],
      ['approved false with the warning shown (a No): left alone, warned once', { [APPROVED]: false, [WARNED]: true }, false, true],
    ]
    for (const [name, entry, written, warned] of states) {
      const { root, agent } = repoWithAgentDir()
      const home = tmp()
      writeFileSync(cfg(home), JSON.stringify({ hasCompletedOnboarding: true, projects: { [root]: entry, [agent]: TRUSTED } }))
      const old = new Date('2020-01-01T00:00:00Z')
      utimesSync(cfg(home), old, old)
      warn.mockClear()
      expect(stampProjectTrustForDir(cfg(home), agent), name).toBe(written)
      expect(statSync(cfg(home)).mtimeMs === old.getTime(), name).toBe(!written)
      expect(read(cfg(home)).projects[root][APPROVED], name).toBe(written ? true : entry[APPROVED])
      expect(read(cfg(home)).projects[root][WARNED], name).toBe(entry[WARNED])
      expect(warn, name).toHaveBeenCalledTimes(warned ? 1 : 0)
    }
  })

  it('the other fields of the root key stay when the approval is added', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), JSON.stringify({ projects: { [root]: { [APPROVED]: false, hasTrustDialogAccepted: true, allowedTools: ['Read'] } } }))
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    expect(read(cfg(home)).projects[root]).toMatchObject({ [APPROVED]: true, hasTrustDialogAccepted: true, allowedTools: ['Read'] })
  })

  it('an agent dir that is already trusted and a root that is approved: no write, false, the file is untouched; the second call is a no-op too', () => {
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
    expect(projects[main][APPROVED]).toBe(true)
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

  it('a worktree whose gitdir pointer goes through a symlink to the main repo: the key is the REAL main root, no symlink-shaped key', () => {
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
    expect(projects[main][APPROVED]).toBe(true)
    expect(projects[alias]).toBeUndefined()
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
    expect(read(cfg(home)).projects[agent]).toMatchObject({ [APPROVED]: true, hasTrustDialogAccepted: true })
    expect(read(cfg(home)).projects[dir]).toBeUndefined()
  })

  it('a symlinked agent dir inside a git repo: the approval is on the real root, the link-shaped key gets none', () => {
    const { root, agent } = repoWithAgentDir()
    const holder = tmp()
    const link = join(holder, 'link')
    symlinkSync(agent, link)
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), link)).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[root][APPROVED]).toBe(true)
    expect(projects[agent]).toMatchObject({ hasTrustDialogAccepted: true })
    expect(projects[link][APPROVED]).toBeUndefined()
    expect(projects[holder]).toBeUndefined()
  })

  it('a symlinked agent dir with no git root: the approval is on the real path only', () => {
    const real = tmp()
    const holder = tmp()
    const link = join(holder, 'link')
    symlinkSync(real, link)
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), link)).toBe(true)
    const projects = read(cfg(home)).projects
    expect(projects[real][APPROVED]).toBe(true)
    expect(projects[link][APPROVED]).toBeUndefined()
  })

  it('an agent dir that does not exist yet still resolves its root (a realpath failure keeps the original path)', () => {
    const { root } = repoWithAgentDir()
    const home = tmp()
    expect(stampProjectTrustForDir(cfg(home), join(root, 'agents', 'not-created-yet'))).toBe(true)
    expect(read(cfg(home)).projects[root][APPROVED]).toBe(true)
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

  it('a projects value that is an array is replaced by a fresh map, the flag still lands', () => {
    const { root, agent } = repoWithAgentDir()
    const home = tmp()
    writeFileSync(cfg(home), JSON.stringify({ projects: [1, 2] }))
    expect(stampProjectTrustForDir(cfg(home), agent)).toBe(true)
    expect(read(cfg(home)).projects[root][APPROVED]).toBe(true)
  })
})
