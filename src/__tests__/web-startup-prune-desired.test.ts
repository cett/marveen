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
// `if (!webOnly)` block, and an assertion below fails (checked with those three edits).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')
const lines = readFileSync(join(projectRoot, 'src', 'web.ts'), 'utf-8').split('\n')

// Call sites only: not the import line, not a comment.
function callLines(name: string): number[] {
  const out: number[] = []
  lines.forEach((l, i) => {
    const t = l.trimStart()
    if (t.startsWith('import ') || t.startsWith('//') || t.startsWith('*')) return
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

  it('is called inside the `if (!webOnly)` block that also holds reconcileAgentsOnStartup()', () => {
    const indent = (l: string): number => l.length - l.trimStart().length
    // The enclosing block of a line is the nearest line above it with a smaller indent.
    const enclosing = (at: number): number => {
      let i = at - 1
      while (i >= 0 && (lines[i].trim() === '' || indent(lines[i]) >= indent(lines[at]))) i--
      return i
    }
    expect(enclosing(prune[0])).toBeGreaterThanOrEqual(0)
    expect(lines[enclosing(prune[0])]).toBe('  if (!webOnly) {')
    expect(enclosing(reconcile[0])).toBe(enclosing(prune[0]))
  })
})
