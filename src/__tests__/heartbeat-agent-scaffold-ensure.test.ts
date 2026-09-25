// Coverage for ensureHeartbeatAgent (src/web/heartbeat-agent-scaffold.ts),
// previously untested. renderHeartbeatClaudeMd and shouldBootHeartbeatAgent
// already have their own coverage in heartbeat-agent-scaffold.test.ts; this
// covers the filesystem side: directory bootstrap, always-rewrite files,
// sentinel-once files, and fail-soft error handling. PROJECT_ROOT is
// redirected to a temp dir (module-level const, so resetModules + dynamic
// re-import is required) -- everything else in the module reads real config.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

let projectRoot: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'heartbeat-scaffold-'))
  vi.resetModules()
  vi.doMock('../config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config.js')>()
    return { ...actual, PROJECT_ROOT: projectRoot }
  })
})

afterEach(() => {
  vi.doUnmock('../config.js')
  rmSync(projectRoot, { recursive: true, force: true })
})

async function load() {
  return import('../web/heartbeat-agent-scaffold.js')
}

function agentDir() {
  return join(projectRoot, 'agents', 'heartbeat')
}

describe('ensureHeartbeatAgent', () => {
  it('creates the directory tree and every scaffold file from scratch', async () => {
    const { ensureHeartbeatAgent } = await load()
    ensureHeartbeatAgent()
    const dir = agentDir()
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(dir, 'agent-config.json'))).toBe(true)
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true)
    expect(existsSync(join(dir, '.hidden-from-dashboard'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8')).model).toBe('claude-haiku-4-5')
  })

  it('always rewrites CLAUDE.md / agent-config.json / settings.json, overwriting hand edits', async () => {
    const { ensureHeartbeatAgent } = await load()
    ensureHeartbeatAgent()
    const dir = agentDir()
    writeFileSync(join(dir, 'CLAUDE.md'), 'operator hand-edited this')
    ensureHeartbeatAgent()
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).not.toBe('operator hand-edited this')
  })

  it('never rewrites an existing sentinel file once created', async () => {
    const { ensureHeartbeatAgent } = await load()
    ensureHeartbeatAgent()
    const sentinel = join(agentDir(), '.hidden-from-dashboard')
    writeFileSync(sentinel, 'marker-set-by-a-previous-boot')
    ensureHeartbeatAgent()
    expect(readFileSync(sentinel, 'utf-8')).toBe('marker-set-by-a-previous-boot')
  })

  it('is a no-op-safe re-run when the directory tree already exists', async () => {
    const { ensureHeartbeatAgent } = await load()
    mkdirSync(join(agentDir(), '.claude'), { recursive: true })
    expect(() => ensureHeartbeatAgent()).not.toThrow()
    expect(existsSync(join(agentDir(), 'CLAUDE.md'))).toBe(true)
  })

  it('fails soft (catches + logs) when the agents dir cannot be created', async () => {
    // Make 'agents' a FILE instead of a directory, so mkdirSync(HEARTBEAT_AGENT_DIR)
    // throws ENOTDIR -- ensureHeartbeatAgent must swallow it, not throw.
    writeFileSync(join(projectRoot, 'agents'), 'not a directory')
    const { ensureHeartbeatAgent } = await load()
    expect(() => ensureHeartbeatAgent()).not.toThrow()
    const { logger } = await import('../logger.js')
    expect(logger.error).toHaveBeenCalled()
  })
})
