import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FULL_BOOT_SANDBOX_ENV, LIVE_DASHBOARD_PORT, fullBootSandboxRefusals, fullBootSandboxRequested } from '../full-boot-sandbox.js'

// FULL-BOOT-SANDBOX: the opt-in switch that runs the whole boot inside an isolated instance. The decision is a pure
// function over facts that main.ts reads from its environment; these cells pin the refusals (each one alone is enough
// to refuse) and the wiring in main.ts (refusal before any side effect, WEB_ONLY only on the non-sandbox branch).

const SAFE_FACTS = { isolated: true, webPort: 4421, projectRootIsTemporary: true }

describe('FULL-BOOT-SANDBOX: the switch is on only for the exact value', () => {
  it('is on for MARVEEN_SANDBOX_FULL_BOOT=true and off for anything else, including unset', () => {
    expect(FULL_BOOT_SANDBOX_ENV).toBe('MARVEEN_SANDBOX_FULL_BOOT')
    expect(fullBootSandboxRequested({ [FULL_BOOT_SANDBOX_ENV]: 'true' })).toBe(true)
    expect(fullBootSandboxRequested({ [FULL_BOOT_SANDBOX_ENV]: '1' })).toBe(false)
    expect(fullBootSandboxRequested({ [FULL_BOOT_SANDBOX_ENV]: 'TRUE' })).toBe(false)
    expect(fullBootSandboxRequested({})).toBe(false)
  })
})

describe('FULL-BOOT-SANDBOX: refusals', () => {
  it('an isolated instance on a free port inside a temporary checkout is allowed', () => {
    expect(fullBootSandboxRefusals(SAFE_FACTS)).toEqual([])
  })

  it('refuses without an isolated store, even when everything else is right (production is never a sandbox)', () => {
    const reasons = fullBootSandboxRefusals({ ...SAFE_FACTS, isolated: false })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('MARVEEN_STORE_DIR')
  })

  it('refuses on the live dashboard port, even when isolated', () => {
    const reasons = fullBootSandboxRefusals({ ...SAFE_FACTS, webPort: LIVE_DASHBOARD_PORT })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(String(LIVE_DASHBOARD_PORT))
  })

  it('refuses when PROJECT_ROOT is the live checkout (not a worktree, not a temp dir): the boot would write agent files in place', () => {
    const reasons = fullBootSandboxRefusals({ ...SAFE_FACTS, projectRootIsTemporary: false })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('PROJECT_ROOT')
  })

  it('lists every refusal together, so one start shows all the wrong settings', () => {
    const reasons = fullBootSandboxRefusals({ isolated: false, webPort: LIVE_DASHBOARD_PORT, projectRootIsTemporary: false })
    expect(reasons).toHaveLength(3)
  })
})

describe('FULL-BOOT-SANDBOX: main.ts wiring', () => {
  const MAIN_SRC = readFileSync(join(__dirname, '..', 'main.ts'), 'utf-8')

  it('the refusal throws before the lock and before any database boot', () => {
    const refusalAt = MAIN_SRC.indexOf('fullBootSandboxRefusals({')
    const lockAt = MAIN_SRC.indexOf('await acquireLock()')
    const dbBootAt = MAIN_SRC.indexOf('await bootProcessDatabase()')
    expect(refusalAt).toBeGreaterThan(-1)
    expect(refusalAt).toBeLessThan(lockAt)
    expect(refusalAt).toBeLessThan(dbBootAt)
    expect(MAIN_SRC.slice(refusalAt, lockAt)).toContain('throw new Error(')
  })

  it('WEB_ONLY is set only inside the non-sandbox isolated branch', () => {
    const webOnlyAt = MAIN_SRC.indexOf("process.env['WEB_ONLY'] = 'true'")
    const guardAt = MAIN_SRC.indexOf('if (!fullBootSandbox) {')
    expect(webOnlyAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(webOnlyAt)
    // The only WEB_ONLY assignment in main.ts is that one.
    expect(MAIN_SRC.split("process.env['WEB_ONLY'] = 'true'").length - 1).toBe(1)
  })

  it('the sandbox path does not return early: the normal boot runs after the isolated block', () => {
    const block = MAIN_SRC.slice(MAIN_SRC.indexOf('if (IS_ISOLATED_MODE) {'), MAIN_SRC.indexOf('// Backfill embeddings for memories'))
    expect(block).toContain('FULL BOOT SANDBOX')
    // Only the non-sandbox branch returns.
    expect(block.split('return').length - 1).toBe(1)
  })
})
