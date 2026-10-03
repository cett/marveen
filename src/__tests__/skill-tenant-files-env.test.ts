import { describe, it, expect, vi, afterEach } from 'vitest'

// TENANT_SKILL_FILES reaches config.ts from process.env first and from the dotenv file second.
// A set process.env value wins (even a blank one: blank means single, it never falls through to the
// file), the file only applies when process.env does not set it.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('../env.js')
  vi.resetModules()
})

async function modeWith(dotEnv: string | undefined, processEnv: string | undefined): Promise<string> {
  vi.doMock('../env.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../env.js')>()
    return { ...actual, readEnvFile: () => (dotEnv === undefined ? {} : { TENANT_SKILL_FILES: dotEnv }) }
  })
  vi.stubEnv('TENANT_SKILL_FILES', processEnv)
  vi.resetModules()
  return (await import('../config.js')).TENANT_SKILL_FILES
}

describe('TENANT_SKILL_FILES precedence', () => {
  it('the dotenv value applies when process.env does not set it', async () => {
    expect(await modeWith('off', undefined)).toBe('off')
    expect(await modeWith('single', undefined)).toBe('single')
  })

  it('process.env=off beats the dotenv value single', async () => {
    expect(await modeWith('single', 'off')).toBe('off')
  })

  it('process.env=single beats the dotenv value off', async () => {
    expect(await modeWith('off', 'single')).toBe('single')
  })

  it('the removed all value is single wherever it comes from, and warns at startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await modeWith('all', undefined)).toBe('single')
      expect(await modeWith('off', 'all')).toBe('single')   // process.env wins, and it says all
      const text = warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(text).toContain('TENANT_SKILL_FILES=all is no longer supported')
      warn.mockClear()
      expect(await modeWith('single', undefined)).toBe('single')
      expect(warn.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('TENANT_SKILL_FILES')
    } finally { warn.mockRestore() }
  })

  it('a blank process.env beats the dotenv value (blank means single, never falls through)', async () => {
    expect(await modeWith('off', '')).toBe('single')
    expect(await modeWith('single', '')).toBe('single')
  })

  it('defaults to single with neither set', async () => {
    expect(await modeWith(undefined, undefined)).toBe('single')
  })
})
