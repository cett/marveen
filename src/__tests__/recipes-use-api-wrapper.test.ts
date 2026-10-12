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

// ── No code reads the shared dashboard token file ─────────────────────────────
// The shared token file belongs to the dashboard (src/web/dashboard-auth.ts) and to the three
// token resolvers (scripts/agent-api.sh, scripts/hooks/agent_token.py, scripts/lib/agent-api.mjs),
// which hand it out only as a visible fallback. Everything else calls the API through them. A
// script that opens the file itself bypasses the per-agent token and cannot be moved when the
// fallback goes: this fails on any such line in the repository, with no per-file allowance.
// Scope: every text file outside tests and fixtures (`__tests__`, `*.test.*`, `test_*.py`), the
// changelog and the build/vendor directories. The one carve-out is the pair of installers, which
// print the human's dashboard login URL (see INSTALLER_LOGIN_URL).
const REPO_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'store', 'coverage', '__tests__', '__pycache__', 'test-results', 'playwright-report', 'agents', 'backups'])
const REPO_TEXT_EXT = /\.(ts|mjs|js|py|sh|md|json|ya?ml|template|ps1)$/
const TEST_FILE = /(\.test\.[a-z]+$|\/test_[^/]*\.py$)/
const REPO_SKIP_FILES = new Set(['CHANGELOG.md', 'package-lock.json'])
const INSTALLER_LOGIN_URL = new Set(['install-linux.sh', 'install-macos.sh'])
const SHARED_FILE = String.raw`\.dashboard-token`
const DIRECT_READS: Array<{ name: string; re: RegExp }> = [
  { name: 'cat of the shared token file', re: new RegExp(String.raw`\bcat\s+["']?[^\s"'|;)]*` + SHARED_FILE) },
  { name: 'shell redirect from the shared token file', re: new RegExp(String.raw`<\s*["']?[^\s"'<>]*` + SHARED_FILE) },
  { name: 'file-read call on the shared token file', re: new RegExp(String.raw`\b(?:readFileSync|readFile|readTextFile|read_text|read_bytes|open)\s*\([^)]*` + SHARED_FILE) },
  { name: 'Path(...) of the shared token file, read', re: new RegExp(String.raw`\bPath\s*\([^)]*` + SHARED_FILE + String.raw`[^)]*\)\s*\.read`) },
]

function walkRepo(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (REPO_SKIP_DIRS.has(name)) continue
    const st = statSync(p)
    if (st.isDirectory()) walkRepo(p, out)
    else if (REPO_TEXT_EXT.test(name) && !REPO_SKIP_FILES.has(name) && !TEST_FILE.test(p)) out.push(p)
  }
  return out
}

function directReads(text: string): Array<{ line: number; what: string }> {
  const hits: Array<{ line: number; what: string }> = []
  text.split('\n').forEach((l, i) => {
    for (const d of DIRECT_READS) if (d.re.test(l)) hits.push({ line: i + 1, what: d.name })
  })
  return hits
}

describe('nothing reads the shared dashboard token file directly', () => {
  const files = walkRepo(ROOT)

  it('scans the whole repository, not a sample', () => {
    expect(files.length).toBeGreaterThan(300)
    const rel = files.map((f) => relative(ROOT, f))
    for (const must of ['scripts/watchdog.sh', 'scripts/remote-access-enroll.ts', 'scripts/status.ts', 'src/web/federation/capabilities.ts', 'seed-skills/fleet-helper/scripts/fleet.py', 'tests/smoke/dashboard.spec.ts']) {
      expect(rel).toContain(must)
    }
  })

  it('has no direct read outside the installers', () => {
    const bad = files
      .filter((f) => !INSTALLER_LOGIN_URL.has(relative(ROOT, f)))
      .flatMap((f) => directReads(readFileSync(f, 'utf-8')).map((h) => `${relative(ROOT, f)}:${h.line} ${h.what}`))
    expect(bad).toEqual([])
  })

  it('the installers are the only files left with a direct read, and only that one line each', () => {
    const left = [...INSTALLER_LOGIN_URL].map((f) => [f, directReads(readFileSync(join(ROOT, f), 'utf-8')).length])
    expect(left).toEqual([['install-linux.sh', 1], ['install-macos.sh', 1]])
  })

  it('the detector fires on the shapes the scripts used, and not on the resolvers', () => {
    const fires = (t: string) => directReads(t).length > 0
    expect(fires('  TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")')).toBe(true)
    expect(fires("const t = readFileSync(join(root, 'store', '.dashboard-token'), 'utf8')")).toBe(true)
    expect(fires('with open(os.path.join(root, "store", ".dashboard-token")) as f:')).toBe(true)
    expect(fires("token = Path('store/.dashboard-token').read_text()")).toBe(true)
    expect(fires('TOKEN=$(tr -d " " < store/.dashboard-token)')).toBe(true)
    expect(fires('read_shared() { TOKEN="$(read_token "$STORE/.dashboard-token")"; }')).toBe(false)
    expect(fires("const shared = () => readTrim(join(store, '.dashboard-token'))")).toBe(false)
    expect(fires('SHARED_TOKEN_FILENAME = ".dashboard-token"')).toBe(false)
    expect(fires('the dashboard-token keeps working')).toBe(false)
  })
})
