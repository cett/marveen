// fix/main-model-single-source: readMainModelRaw() (src/web/agent-config.ts)
// is the ONE place the main agent's model precedence lives now -- .env
// MAIN_AGENT_MODEL > .claude/settings.json .model > '' -- mirroring
// scripts/channels.sh's resolve_main_model() exactly. Both TS readers
// (channel-monitor.ts's readConfiguredMainModel(), model-fallback-runner.ts's
// readMainModel()) delegate to it; this file tests the resolver itself
// against real files so the precedence claim is verified directly, not just
// asserted in a comment.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir: string
let mod: typeof import('../web/agent-config.js')

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'main-model-resolver-test-'))
  mkdirSync(join(tmpDir, '.claude'), { recursive: true })
  process.env['CLAUDECLAW_ENV_DIR'] = tmpDir
  vi.resetModules()
  vi.doMock('../config.js', () => ({
    PROJECT_ROOT: tmpDir,
    MAIN_AGENT_ID: 'main',
    DEFAULT_AGENT_MODEL: 'claude-sonnet-5',
  }))
  mod = await import('../web/agent-config.js')
})

afterEach(() => {
  vi.doUnmock('../config.js')
  delete process.env['CLAUDECLAW_ENV_DIR']
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeSettings(model: string): void {
  writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model }))
}

function writeEnv(content: string): void {
  writeFileSync(join(tmpDir, '.env'), content)
}

describe('readMainModelRaw', () => {
  it('returns "" when neither .env nor settings.json configure a model', () => {
    expect(mod.readMainModelRaw()).toBe('')
  })

  it('falls back to settings.json .model when .env has no MAIN_AGENT_MODEL', () => {
    writeSettings('claude-opus-5')
    expect(mod.readMainModelRaw()).toBe('claude-opus-5')
  })

  it('prefers .env MAIN_AGENT_MODEL over settings.json .model when they differ', () => {
    writeSettings('claude-opus-5')
    writeEnv('MAIN_AGENT_MODEL=claude-sonnet-5\n')
    expect(mod.readMainModelRaw()).toBe('claude-sonnet-5')
  })

  it('falls back to settings.json when the .env key is present but empty', () => {
    writeSettings('claude-opus-5')
    writeEnv('MAIN_AGENT_MODEL=\n')
    expect(mod.readMainModelRaw()).toBe('claude-opus-5')
  })

  it('ignores unrelated .env keys and reads only MAIN_AGENT_MODEL', () => {
    writeEnv('PORT=3420\nDEBUG=1\n')
    expect(mod.readMainModelRaw()).toBe('')
  })

  it('returns "" for a malformed settings.json without throwing', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), 'not valid json')
    expect(() => mod.readMainModelRaw()).not.toThrow()
    expect(mod.readMainModelRaw()).toBe('')
  })

  it('returns "" when settings.json .model is not a string', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 42 }))
    expect(mod.readMainModelRaw()).toBe('')
  })
})
