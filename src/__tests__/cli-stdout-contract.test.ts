// A command-line tool that opens the database logs at startup (every migration it applies, the schema
// report). Those lines belong on stderr: shell scripts and tests read the tool's stdout. doctor.sh splits
// `agent-tokens check` into tab-separated fields, verify-restore.sh takes the last line of
// `agent-tokens archive-shared-age` as its verdict, and `dashboard-user list` is read by a person or a script.
// scripts/lib/log-to-stderr.ts is the switch; this test pins that every such tool imports it first, and
// that the two stdout formats a script depends on stay clean.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

/** Every non-test TypeScript file under scripts/ (not scripts/lib) that opens the database. */
function dbOpeningTools(dir = join(ROOT, 'scripts')): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'lib' || name === 'node_modules') continue
      found.push(...dbOpeningTools(path))
    } else if (name.endsWith('.ts') && /\binitDatabase\(/.test(readFileSync(path, 'utf-8'))) {
      found.push(path)
    }
  }
  return found
}

describe('tools that open the database import the stderr switch first', () => {
  const tools = dbOpeningTools()

  it('finds the known tools (the scan is not empty)', () => {
    const names = tools.map(t => relative(ROOT, t))
    for (const known of ['scripts/dashboard-user.ts', 'scripts/agent-tokens.ts']) expect(names).toContain(known)
  })

  it.each(tools.map(t => [relative(ROOT, t), t]))('%s', (_name, path) => {
    const firstImport = readFileSync(path, 'utf-8').split('\n').find(l => /^import\s/.test(l))
    expect(firstImport).toMatch(/^import '(\.\/|\.\.\/)lib\/log-to-stderr\.js'$/)
  })
})

describe('agent-tokens stdout is only its result', () => {
  let storeDir: string
  beforeEach(() => { storeDir = mkdtempSync(join(tmpdir(), 'at-stdout-')) })
  afterEach(() => { rmSync(storeDir, { recursive: true, force: true }) })

  function cli(args: string[]) {
    return spawnSync(TSX, ['scripts/agent-tokens.ts', ...args], {
      cwd: ROOT, encoding: 'utf-8', env: { ...process.env, MARVEEN_STORE_DIR: storeDir },
    })
  }

  it('archive-shared-age prints exactly one word (verify-restore.sh reads the last line)', () => {
    const r = cli(['archive-shared-age', join(storeDir, 'no-such-archive.db')])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('unknown\n')
    expect(r.stderr).toContain('schema: db')
  })

  it('check prints only subject, status, role and path, tab separated (doctor.sh splits on tabs)', () => {
    const r = cli(['check'])
    expect(r.status, r.stderr).toBe(1)
    const lines = r.stdout.trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.split('\t'), line).toHaveLength(4)
    expect(r.stdout).not.toContain('Migration applied')
    expect(r.stdout).not.toContain('schema:')
  })

  it('list prints nothing on an empty store', () => {
    const r = cli(['list'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('')
  })
})
