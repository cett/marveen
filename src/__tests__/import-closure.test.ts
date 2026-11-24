// Completeness by test, not by review (phase F1): which separately started files reach src/config.ts, and whether each one
// is classified on purpose. The closure is computed from the sources (type-only imports dropped; relative static imports,
// and dynamic import() with a literal path, followed). Three rules:
//  1. BOOTSTRAPPED entries (launched by a path that is not the body): config.ts is NOT in the static closure of the
//     bootstrap file itself. Only the body, imported dynamically after the snapshot is set, may reach it.
//  2. LEAF entries (the vault and the helpers that load it): config.ts is in NO closure, static or dynamic.
//  3. Every other script or *-cli file that reaches config.ts is classified: a script run by the runner (scripts/with-config.ts)
//     or a library of scripts. A new file that reaches config.ts and is on neither list fails with its path.
// Mutants this pins: a static config import in a bootstrap; a new scripts file that reaches config with no list entry;
// the vault importing config again.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CONFIG = 'src/config.ts'

const BOOTSTRAPPED = [
  'src/index.ts',
  'src/channel-coordinator.ts',
  'src/web/reconnect-cli.ts',
  'scripts/with-config.ts',
]

// the runner's scripts: they reach config.ts, and the runner imports them only after the snapshot step
const RUNNER_SCRIPTS = [
  'scripts/setup.ts', 'scripts/status.ts', 'scripts/remote-access-enroll.ts', 'scripts/dashboard-url.ts',
  'scripts/agent-tokens.ts', 'scripts/install-seed-tenant.ts',
  'scripts/budget-alert-check.ts', 'scripts/claude-plan-rotate-check.ts', 'scripts/materialize-skills.ts',
  'scripts/migrate-legacy-store-docs.ts', 'scripts/migrate-schedules-to-db.ts', 'scripts/migrate-sqlite-to-pg.ts',
  'scripts/regen-skills.ts',
  'scripts/eval/recall-eval.ts', 'scripts/eval/recall-eval-run.ts', 'scripts/eval/recall-eval-pg.ts',
]

// libraries under scripts/ and the ones that are not entries: they reach config.ts through a runner script or a caller
const LIBRARIES = [
  'scripts/eval/recall-eval-pg-io.ts', 'scripts/eval/recall-eval-lib.ts', 'scripts/eval/recall-eval-fts-stage.ts',
  'scripts/lib/dashboard-user-format.ts',
]

// run directly on purpose (an admin command the auth-admin gate matches by its command line); it refuses on a PostgreSQL
// install until the cutover. Never routed through the runner, and package.json calls it directly.
const DIRECT_SCRIPTS = ['scripts/dashboard-user.ts']

// the vault and the helpers that load it: no config.ts anywhere in their closure
const LEAVES = [
  'src/web/vault.ts',
  'src/web/http-mcp-header-helper.ts',
  'src/paths.ts',
  'scripts/vault-http-header-helper.mjs',
  'scripts/vault-materialize.mjs',
  'scripts/vault-resolve.mjs',
  'scripts/vault-inject-http-mcp.mjs',
]

const SPEC = /(?:from\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g
const DYN = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s[^;]*?['"][^'"]+['"]\s*;?/gm

function resolveRel(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = join(dirname(from), spec).split(sep).join('/')
  const stem = base.replace(/\.(js|mjs|ts)$/, '')
  for (const cand of [stem + '.ts', base, stem + '.mjs', stem + '.js', stem + '/index.ts']) {
    if (existsSync(join(ROOT, cand)) && statSync(join(ROOT, cand)).isFile()) return cand
  }
  return undefined
}

function edgesOf(rel: string): { target: string; dynamic: boolean }[] {
  const txt = readFileSync(join(ROOT, rel), 'utf8').replace(TYPE_ONLY, '')
  const out: { target: string; dynamic: boolean }[] = []
  for (const m of txt.matchAll(SPEC)) {
    const t = resolveRel(rel, m[1]!)
    if (t) out.push({ target: t, dynamic: false })
  }
  for (const m of txt.matchAll(DYN)) {
    const t = resolveRel(rel, m[1]!)
    if (t) out.push({ target: t, dynamic: true })
  }
  return out
}

/** The files reachable from entry, as a map to the chain that first reached each one. */
function closure(entry: string, withDynamic: boolean): Map<string, string[]> {
  const chain = new Map<string, string[]>([[entry, [entry]]])
  const queue = [entry]
  while (queue.length) {
    const cur = queue.shift()!
    for (const e of edgesOf(cur)) {
      if (e.dynamic && !withDynamic) continue
      if (chain.has(e.target)) continue
      chain.set(e.target, [...chain.get(cur)!, e.target])
      queue.push(e.target)
    }
  }
  return chain
}

function reachesConfig(entry: string, withDynamic: boolean): string[] | undefined {
  if (entry === CONFIG) return [entry]
  return closure(entry, withDynamic).get(CONFIG)
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === '__tests__' || name === 'node_modules') continue
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...listFiles(rel))
    else if (/\.(ts|mjs)$/.test(name)) out.push(rel)
  }
  return out
}

describe('the import closure of the separately started files', () => {
  it('rule 1: a bootstrap does not statically reach config.ts (the body may, after the snapshot)', () => {
    for (const entry of BOOTSTRAPPED) {
      const chain = reachesConfig(entry, false)
      expect(chain, `${entry} reaches config.ts statically: ${chain?.join(' > ')}`).toBeUndefined()
    }
  })

  it('rule 2: the leaves reach config.ts through no edge at all (static or dynamic)', () => {
    for (const entry of LEAVES) {
      const chain = reachesConfig(entry, true)
      expect(chain, `${entry} reaches config.ts: ${chain?.join(' > ')}`).toBeUndefined()
    }
  })

  it('rule 3: every script or *-cli that reaches config.ts is classified on purpose', () => {
    const classified = new Set([...BOOTSTRAPPED, ...LEAVES, ...RUNNER_SCRIPTS, ...DIRECT_SCRIPTS, ...LIBRARIES])
    const candidates = [...listFiles('scripts'), ...listFiles('src/web').filter((f) => /-cli\.ts$/.test(f))]
    const unclassified: string[] = []
    for (const f of candidates) {
      if (classified.has(f)) continue
      const chain = reachesConfig(f, true)
      if (chain) unclassified.push(`${f} (${chain.join(' > ')})`)
    }
    expect(unclassified, `reach config.ts and are not classified: ${unclassified.join('; ')}`).toEqual([])
  })

  it('the RUNNER_SCRIPTS list is the runner\'s own SCRIPTS list (read from scripts/with-config.ts)', () => {
    const src = readFileSync(join(ROOT, 'scripts/with-config.ts'), 'utf8')
    const block = src.slice(src.indexOf('const SCRIPTS = ['), src.indexOf('] as const'))
    const names = [...block.matchAll(/'([^']+)'/g)].map((m) => `scripts/${m[1]}.ts`)
    expect([...names].sort()).toEqual([...RUNNER_SCRIPTS].sort())
  })

  it('package.json never calls a runner script directly (the runner is the one way in)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const direct = Object.entries(pkg.scripts).filter(([, cmd]) => {
      const m = /tsx (scripts\/[^\s]+\.ts)/.exec(cmd)
      return m !== null && RUNNER_SCRIPTS.includes(m[1]!)
    })
    expect(direct, `direct calls of runner scripts: ${direct.map(([k]) => k).join(', ')}`).toEqual([])
  })

  it('the walker sees the config edge where one exists (a sanity cell: the rules above are not vacuous)', () => {
    expect(reachesConfig('scripts/status.ts', true)).toBeDefined()
    expect(reachesConfig('src/main.ts', false)).toBeDefined()
    expect(reachesConfig('src/index.ts', true)).toBeDefined() // dynamic import of the body reaches it
    expect(reachesConfig('src/index.ts', false)).toBeUndefined()
  })

  it('the runner-classified scripts exist (the list cannot name a file that is gone)', () => {
    for (const f of [...BOOTSTRAPPED, ...LEAVES, ...RUNNER_SCRIPTS, ...LIBRARIES]) {
      expect(existsSync(join(ROOT, f)), `${f} is listed but missing`).toBe(true)
    }
  })
})
