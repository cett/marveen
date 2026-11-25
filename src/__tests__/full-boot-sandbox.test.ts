import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FULL_BOOT_SANDBOX_ENV, LIVE_DASHBOARD_PORT, fullBootSandboxRefusals, fullBootSandboxRequested, tmuxDirIsUnderStore } from '../full-boot-sandbox.js'

// FULL-BOOT-SANDBOX: the opt-in switch that runs the whole boot inside an isolated instance. The decision is a pure
// function over facts that main.ts reads from its environment; these cells pin the refusals (each one alone is enough
// to refuse) and the wiring in main.ts (refusal before any side effect, WEB_ONLY only on the non-sandbox branch).

const SAFE_STORE = '/tmp/fbs-fixture/store'
const SAFE_FACTS = {
  isolated: true,
  webPort: 4421,
  projectRootIsTemporary: true,
  respawnExplicitlyOff: true,
  tmuxTmpDir: `${SAFE_STORE}/tmux`,
  storeDir: SAFE_STORE,
}

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

  it('R4: refuses unless RESPAWN_ENABLED is explicitly off in the env file (the default is on)', () => {
    const reasons = fullBootSandboxRefusals({ ...SAFE_FACTS, respawnExplicitlyOff: false })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('RESPAWN_ENABLED')
  })

  it('R5: refuses when TMUX_TMPDIR is unset', () => {
    const reasons = fullBootSandboxRefusals({ ...SAFE_FACTS, tmuxTmpDir: undefined })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('TMUX_TMPDIR')
  })

  it('R5: refuses when TMUX_TMPDIR is outside the store, including a sibling with the same prefix', () => {
    expect(fullBootSandboxRefusals({ ...SAFE_FACTS, tmuxTmpDir: '/tmp/fbt' })).toHaveLength(1)
    expect(fullBootSandboxRefusals({ ...SAFE_FACTS, tmuxTmpDir: `${SAFE_STORE}-other/tmux` })).toHaveLength(1)
  })

  it('R5: accepts TMUX_TMPDIR under the store, and the store root itself', () => {
    expect(tmuxDirIsUnderStore(`${SAFE_STORE}/tmux`, SAFE_STORE)).toBe(true)
    expect(tmuxDirIsUnderStore(SAFE_STORE, SAFE_STORE)).toBe(true)
    expect(tmuxDirIsUnderStore('relative/tmux', SAFE_STORE)).toBe(false)
  })

  it('lists every refusal together, so one start shows all the wrong settings', () => {
    const reasons = fullBootSandboxRefusals({
      isolated: false,
      webPort: LIVE_DASHBOARD_PORT,
      projectRootIsTemporary: false,
      respawnExplicitlyOff: false,
      tmuxTmpDir: undefined,
      storeDir: '',
    })
    expect(reasons).toHaveLength(5)
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

  it('the R4 and R5 inputs come from the env file (RESPAWN_ENABLED) and TMUX_TMPDIR, the store from STORE_DIR', () => {
    const call = MAIN_SRC.slice(MAIN_SRC.indexOf('fullBootSandboxRefusals({'), MAIN_SRC.indexOf('if (refusals.length > 0)'))
    expect(call).toContain("readEnvFile(['RESPAWN_ENABLED'])")
    expect(call).toContain("tmuxTmpDir: process.env['TMUX_TMPDIR']")
    expect(call).toContain('storeDir: STORE_DIR')
  })

  it('the sandbox path does not return early: the normal boot runs after the isolated block', () => {
    const block = MAIN_SRC.slice(MAIN_SRC.indexOf('if (IS_ISOLATED_MODE) {'), MAIN_SRC.indexOf('// Backfill embeddings for memories'))
    expect(block).toContain('FULL BOOT SANDBOX')
    // Only the non-sandbox branch returns.
    expect(block.split('return').length - 1).toBe(1)
  })
})
