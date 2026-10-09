// The per-agent and operator token files are credentials like the shared dashboard token: the import
// crawler must not read them, not even inside an agent's own directory, and the store watcher must
// treat them as sensitive.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { collectLocalFiles, isAllowedFile } from '../web/import-crawler.js'
import { BLOCKED_BASENAMES } from '../web/import-config.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('token file names are protected', () => {
  it('blocks every token file name by basename', () => {
    for (const n of ['.dashboard-token', '.agent-token', '.operator-token']) expect(BLOCKED_BASENAMES.has(n), n).toBe(true)
  })

  it('refuses a token file, even as a text file inside an agent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'token-crawl-'))
    dirs.push(root)
    mkdirSync(join(root, 'agents', 'agent-a'), { recursive: true })
    const secret = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'
    const names = ['.agent-token', '.agent-token.txt', '.agent-token.md', '.operator-token.md', '.dashboard-token.txt']
    for (const n of names) writeFileSync(join(root, 'agents', 'agent-a', n), secret)
    writeFileSync(join(root, 'agents', 'agent-a', 'notes.md'), '# a harmless note')
    const results: string[] = []
    collectLocalFiles(root, results, { depth: 0, dirsSkipped: { count: 0 } })
    const verdict = (n: string) => isAllowedFile(results.find((p) => basename(p) === n)!)
    expect(results.map((p) => basename(p)).sort()).toEqual([...names, 'notes.md'].sort())
    expect(verdict('notes.md').ok).toBe(true)
    for (const n of names) expect(verdict(n).ok, n).toBe(false)
  })
})
