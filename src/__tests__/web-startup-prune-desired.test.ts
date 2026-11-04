// STRUCTURAL test -- not BEHAVIORAL.
//
// pruneMainAgentFromDesired() (agent-desired-state.ts) removes a stored main-agent entry from the desired run-state.
// It only helps if startWebServer() calls it at startup, on the live instance (not a WEB_ONLY staging copy), BEFORE
// reconcileAgentsOnStartup() reads the set. The function itself is covered by agent-desired-state-main-agent.test.ts;
// nothing else notices the call going missing from web.ts. A behavioral test would mean mocking the http server and
// every other start in startWebServer(), so the call site is pinned by source inspection, like
// mcp-list-no-boot-warmup.test.ts does for its invariant.
//
// Mental-revert evidence: delete the call, move it below reconcileAgentsOnStartup(), or take it out of the
// `if (!webOnly)` block, and an assertion below fails (checked with those three edits). Comment the call out with
// `/* ... */` (one line or several) or a trailing `//`, and the call-site count fails: comments are blanked first.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')
const lines = readFileSync(join(projectRoot, 'src', 'web.ts'), 'utf-8').split('\n')

// The source with every comment blanked out, line by line (same line count, so an index into it is an index into
// `lines`). A call that sits inside a block comment, on one line (`/* await prune() */`) or over several, or after
// a `//` on a code line, is not a call site. A `//` counts as a comment only at the start of the line or after
// whitespace, so the `//` of a URL in a string does not hide the rest of its line.
const uncommented = lines
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  .split('\n')
  .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))

// Call sites only: not the import line, not a comment.
function callLines(name: string): number[] {
  const out: number[] = []
  uncommented.forEach((l, i) => {
    if (l.trimStart().startsWith('import ')) return
    if (new RegExp('\\b' + name + '\\s*\\(').test(l)) out.push(i)
  })
  return out
}

describe('web.ts startup: pruneMainAgentFromDesired()', () => {
  const prune = callLines('pruneMainAgentFromDesired')
  const reconcile = callLines('reconcileAgentsOnStartup')

  it('is called exactly once', () => {
    expect(prune.length).toBe(1)
  })

  it('is called before reconcileAgentsOnStartup() reads the desired set', () => {
    expect(reconcile.length).toBe(1)
    expect(prune[0]).toBeLessThan(reconcile[0])
  })

  it('is awaited (the prune is an asynchronous system_config write that must finish before the reconcile reads the set)', () => {
    expect(lines[prune[0]]).toMatch(/\bawait pruneMainAgentFromDesired\(\)/)
    expect(lines[reconcile[0]]).toMatch(/\bawait reconcileAgentsOnStartup\(\)/)
  })

  it('runs in the same boot-sequence task as reconcileAgentsOnStartup(), inside the `if (!webOnly)` block', () => {
    const indent = (l: string): number => l.length - l.trimStart().length
    // The enclosing block of a line is the nearest line above it with a smaller indent.
    const enclosing = (at: number): number => {
      let i = at - 1
      while (i >= 0 && (lines[i].trim() === '' || indent(lines[i]) >= indent(lines[at]))) i--
      return i
    }
    const task = enclosing(prune[0])
    expect(task).toBeGreaterThanOrEqual(0)
    // Same task: one `await` after the other, so the order above is the execution order.
    expect(enclosing(reconcile[0])).toBe(task)
    expect(lines[task].trim()).toMatch(/^runAs\.system\('boot-sequence', async \(\) => \{$/)
    expect(lines[enclosing(task)]).toBe('  if (!webOnly) {')
  })
})
