// RBAC_MODE parsing in config.ts. The gate must be on unless somebody asks, by name, for
// shadow mode: an unset, empty or misspelled value is enforce, never a silently open gate.
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

async function loadMode(): Promise<string> {
  vi.resetModules()
  const cfg = await import('../config.js')
  return cfg.RBAC_MODE
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

describe('RBAC_MODE from the process environment', () => {
  it('is enforce when nothing is set', async () => {
    expect(await loadMode()).toBe('enforce')
  })

  it('is enforce when set to enforce', async () => {
    process.env['RBAC_MODE'] = 'enforce'
    expect(await loadMode()).toBe('enforce')
  })

  it.each(['shadow', 'SHADOW', ' SHADOW ', ' Shadow'])('is shadow for %j (asked for by name)', async (v) => {
    process.env['RBAC_MODE'] = v
    expect(await loadMode()).toBe('shadow')
  })

  it.each(['', '   ', 'shadw', 'off', 'false', '0', 'disabled'])('is enforce for %j (a typo never opens the gate)', async (v) => {
    process.env['RBAC_MODE'] = v
    expect(await loadMode()).toBe('enforce')
  })
})

describe('RBAC_MODE from the .env file', () => {
  it('is enforce when the .env has no RBAC_MODE line', async () => {
    writeFileSync(join(envDir, '.env'), 'WEB_PORT=3420\n')
    expect(await loadMode()).toBe('enforce')
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

describe('RBAC_MODE source literals', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.ts'), 'utf-8')
  const decl = src.slice(src.indexOf('export const RBAC_MODE'), src.indexOf('export const RBAC_MODE') + 400)

  it("defaults to the literal 'enforce'", () => {
    expect(decl).toContain("?? 'enforce')")
    expect(decl).not.toContain("?? 'shadow')")
  })

  it("needs the literal 'shadow' to select shadow mode", () => {
    expect(decl).toContain("=== 'shadow'")
    expect(decl).not.toContain("=== 'enforce'")
  })
})
