// RBAC_MODE_ENV parsing in config.ts: the mode the process environment or .env asks for. It is not the
// live mode (that is the system_config row, see rbac-mode.test.ts); it seeds the row once and can only
// tighten afterwards. Nothing set (or a blank value) asks for nothing; the exact word shadow loosens;
// any other value, a misspelling included, is enforce, so a typo never asks for an open gate.
//
// config.ts reads process.env first and then the project .env through readEnvFile(), which
// honours CLAUDECLAW_ENV_DIR. Every case points that at an empty temp dir, so a developer's
// real .env cannot change the outcome.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let envDir: string
const saved: Record<string, string | undefined> = {}
const KEYS = ['RBAC_MODE', 'CLAUDECLAW_ENV_DIR']

async function loadMode(): Promise<string | undefined> {
  vi.resetModules()
  const cfg = await import('../config.js')
  return cfg.RBAC_MODE_ENV
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  envDir = mkdtempSync(join(tmpdir(), 'rbac-mode-default-'))
  process.env['CLAUDECLAW_ENV_DIR'] = envDir
  delete process.env['RBAC_MODE']
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(envDir, { recursive: true, force: true })
})

describe('RBAC_MODE_ENV from the process environment', () => {
  it('asks for nothing when nothing is set', async () => {
    expect(await loadMode()).toBeUndefined()
  })

  it('is enforce when set to enforce', async () => {
    process.env['RBAC_MODE'] = 'enforce'
    expect(await loadMode()).toBe('enforce')
  })

  it.each(['shadow', 'SHADOW', ' SHADOW ', ' Shadow'])('is shadow for %j (asked for by name)', async (v) => {
    process.env['RBAC_MODE'] = v
    expect(await loadMode()).toBe('shadow')
  })

  it.each(['', '   '])('asks for nothing for the blank value %j', async (v) => {
    process.env['RBAC_MODE'] = v
    expect(await loadMode()).toBeUndefined()
  })

  it.each(['shadw', 'off', 'false', '0', 'disabled'])('is enforce for %j (a typo never opens the gate)', async (v) => {
    process.env['RBAC_MODE'] = v
    expect(await loadMode()).toBe('enforce')
  })
})

describe('RBAC_MODE_ENV from the .env file', () => {
  it('asks for nothing when the .env has no RBAC_MODE line', async () => {
    writeFileSync(join(envDir, '.env'), 'WEB_PORT=3420\n')
    expect(await loadMode()).toBeUndefined()
  })

  it('is shadow when the .env says RBAC_MODE=shadow', async () => {
    writeFileSync(join(envDir, '.env'), 'RBAC_MODE=shadow\n')
    expect(await loadMode()).toBe('shadow')
  })

  it('is enforce when the .env value is misspelled', async () => {
    writeFileSync(join(envDir, '.env'), 'RBAC_MODE=shadw\n')
    expect(await loadMode()).toBe('enforce')
  })

  it('lets the process environment win over the .env', async () => {
    writeFileSync(join(envDir, '.env'), 'RBAC_MODE=shadow\n')
    process.env['RBAC_MODE'] = 'enforce'
    expect(await loadMode()).toBe('enforce')
  })
})

describe('RBAC_MODE_ENV source literals', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.ts'), 'utf-8')
  const decl = src.slice(src.indexOf('export const RBAC_MODE_ENV'), src.indexOf('export const RBAC_MODE_ENV') + 500)

  it("needs the literal 'shadow' to select shadow mode", () => {
    expect(decl).toContain("=== 'shadow'")
    expect(decl).not.toContain("=== 'enforce'")
  })

  it("falls back to the literal 'enforce' for any other non-blank value", () => {
    expect(decl).toContain("? 'shadow' : 'enforce'")
    expect(decl).not.toContain("? 'enforce' : 'shadow'")
  })
})
