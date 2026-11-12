// The PostgreSQL tests (src/**/*.pg.test.ts) need a server, so they must run through vitest.pg.config.ts (`npm run
// test:pg`, the pg-parity CI job) and NOT through the default suite, where they would fail or skip. Both halves are
// pinned here: the default config excludes them, the PG config picks them up, and no PG test hides under a name that
// only one of the two configs treats right (a misnamed file would run in the default suite, or nowhere).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(__dirname, '..', '..')
const PG_GLOB = 'src/**/*.pg.test.ts'

interface TestConfig { test: { include?: string[]; exclude?: string[]; globalSetup?: string[] } }

async function loadConfig(file: string): Promise<TestConfig> {
  const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, file)).href) as { default: TestConfig }
  return mod.default
}

/** The glob subset the configs use: `**` (any depth, also none), `*` (within one segment), literals. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
const matchesAny = (globs: string[], file: string): boolean => globs.some((g) => globToRegExp(g).test(file))

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel, out) } else out.push(rel)
  }
  return out
}

describe('globToRegExp (the matcher this test uses)', () => {
  const re = globToRegExp(PG_GLOB)
  it.each([
    ['src/a.pg.test.ts', true],
    ['src/__tests__/pg/x.pg.test.ts', true],
    ['src/deep/er/x.pg.test.ts', true],
    ['src/__tests__/x.test.ts', false],
    ['src/__tests__/x.pg.test.tsx', false],
    ['src/__tests__/xpg.test.ts', false],
    ['tools/x.pg.test.ts', false],
    ['src/__tests__/x.pg.test.ts.bak', false],
  ])('%s -> %s', (file, expected) => { expect(re.test(file)).toBe(expected) })
})

describe('the PG test files and the two vitest configs', () => {
  const pgFiles = walk('src').filter((f) => f.endsWith('.pg.test.ts'))

  it('there is at least one PG test file (the checks below are not vacuous)', () => {
    expect(pgFiles.length).toBeGreaterThan(0)
  })

  it('the default config excludes every PG test file with ONE explicit glob, and no ordinary test file', async () => {
    const { test } = await loadConfig('vitest.config.ts')
    const exclude = test.exclude ?? []
    expect(exclude.filter((g) => g.includes('.pg.test.'))).toEqual([PG_GLOB])
    for (const f of pgFiles) expect(matchesAny(exclude, f), f).toBe(true)
    for (const f of walk('src/__tests__').filter((x) => x.endsWith('.test.ts') && !x.endsWith('.pg.test.ts'))) {
      expect(globToRegExp(PG_GLOB).test(f), f).toBe(false)
    }
  })

  it('the PG config includes every PG test file and nothing else, and names the server check as its global setup', async () => {
    const { test } = await loadConfig('vitest.pg.config.ts')
    expect(test.include).toEqual([PG_GLOB])
    for (const f of pgFiles) expect(matchesAny(test.include ?? [], f), f).toBe(true)
    expect(test.globalSetup).toHaveLength(1)
    expect(existsSync(path.join(ROOT, test.globalSetup![0]))).toBe(true)
  })

  it('no test file under src/__tests__/pg/ escapes the .pg.test.ts naming (it would run in the default suite)', () => {
    const misnamed = walk('src/__tests__/pg').filter((f) => /\.(test|spec)\.[cm]?[tj]sx?$/.test(f) && !f.endsWith('.pg.test.ts'))
    expect(misnamed).toEqual([])
  })

  it('npm run test:pg runs the PG config', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:pg']).toBe('vitest run --config vitest.pg.config.ts')
    expect(pkg.scripts.test).toBe('vitest run')
  })
})
