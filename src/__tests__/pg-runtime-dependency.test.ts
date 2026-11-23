// The PostgreSQL driver is loaded by the production boot (db/pg-boot.ts) when MARVEEN_PG_URL is set, so it must be
// installed by a production install (`npm ci --omit=dev`), not only for the test suite. A `devDependencies` entry
// would pass every test and then fail the first real PostgreSQL boot with "Cannot find package 'pg'".
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
type Lock = { packages: Record<string, Pkg & { dev?: boolean }> }

// the driver and everything it needs at run time (npm marks a package `dev` when only dev dependencies reach it)
const DRIVER_CLOSURE = ['pg', 'pg-pool', 'pg-protocol', 'pg-types', 'pg-connection-string', 'pgpass', 'pg-int8', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'xtend']

describe('the pg driver is a runtime dependency', () => {
  const pkg = readJson('../../package.json') as Pkg
  const lock = readJson('../../package-lock.json') as Lock

  it('package.json lists pg under dependencies, and not under devDependencies', () => {
    expect(pkg.dependencies?.['pg']).toMatch(/^\^?\d+\./)
    expect(pkg.devDependencies?.['pg']).toBeUndefined()
  })

  it('the lock file root says the same', () => {
    const root = lock.packages['']!
    expect(root.dependencies?.['pg']).toBe(pkg.dependencies?.['pg'])
    expect(root.devDependencies?.['pg']).toBeUndefined()
  })

  it('no package of the driver closure is marked dev-only in the lock file (a production install would skip it)', () => {
    for (const name of DRIVER_CLOSURE) {
      const entry = lock.packages[`node_modules/${name}`]
      expect(entry, name).toBeDefined()
      expect(entry!.dev, name).toBeUndefined()
    }
  })
})
