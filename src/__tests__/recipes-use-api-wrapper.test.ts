// Guard for the shipped recipes (templates, seeds, skills, scheduled-task mirrors, guides): an API
// call in them goes through scripts/agent-api.sh, which signs with the calling agent's own token and
// hands it to curl on stdin. A recipe that reads a token file into a command line, or writes an
// Authorization header by hand, puts a credential into a transcript and bypasses the per-agent token.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SCAN_DIRS = ['templates', 'seed-skills', 'seed-scheduled-tasks', 'scheduled-tasks', 'skills', 'docs/fork-guide', 'docs/user-guide']
const TEXT_EXT = /\.(md|json|sh|py|template)$/
// Each pattern is a recipe that sends a credential through argv or builds the header by hand.
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'Authorization header written by hand', re: /Authorization: Bearer/i },
  { name: 'token file read into a command', re: /\$\(\s*cat\s+[^)]*(?:dashboard-token|agent-token|operator-token)/ },
  { name: 'token file read into a variable', re: /^\s*TOKEN=\$\(\s*cat\b/m },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '__pycache__' || name.startsWith('.')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (TEXT_EXT.test(name)) out.push(p)
  }
  return out
}

function findViolations(text: string): string[] {
  return FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.name)
}

describe('shipped recipes call the API through scripts/agent-api.sh', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))

  it('scans a real set of files', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it('has no hand-built Authorization header or token read in any of them', () => {
    const bad = files
      .map((f) => ({ f: relative(ROOT, f), v: findViolations(readFileSync(f, 'utf-8')) }))
      .filter((x) => x.v.length > 0)
    expect(bad).toEqual([])
  })

  it('the detector fires on the old recipe shapes', () => {
    expect(findViolations('curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://x/api/a')).toHaveLength(2)
    expect(findViolations('TOKEN=$(cat /opt/x/store/.dashboard-token)\ncurl ...')).toContain('token file read into a variable')
    expect(findViolations('bash scripts/agent-api.sh GET /api/agents')).toEqual([])
  })
})
