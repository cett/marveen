// Coverage for the branches of voice-directive.ts not already exercised by
// voice-inbound-audio.test.ts (inboundIsAudio) and voice-error-shapes.test.ts
// (which stubs the whole module out). This file covers:
//   - resolveAgentChannelStateDir: all 3 candidate-match branches + fallback
//   - buildTtsDirective: missing token, happy path, quote-escaping, exception
//   - inboundIsAudio: a couple of extra edge cases (null/undefined/mixed case)
//     for completeness, kept small since the bulk already lives elsewhere.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}))

vi.mock('../config.js', () => ({
  STORE_DIR: '/mock/store',
  WEB_PORT: 4242,
}))

vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
}))

import { existsSync, readFileSync } from 'node:fs'
import {
  resolveAgentChannelStateDir,
  buildTtsDirective,
  inboundIsAudio,
} from '../web/voice-directive.js'

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

beforeEach(() => {
  vi.clearAllMocks()
})

// ── resolveAgentChannelStateDir ──────────────────────────────────────────────

describe('resolveAgentChannelStateDir', () => {
  const CANDIDATE_1 = '/mock/agents/zack/.claude/channels/telegram'
  const CANDIDATE_2 = '/mock/home/.claude/channels/telegram-zack'
  const CANDIDATE_3 = '/mock/home/.claude/channels/telegram'

  it('matches candidate 1 (sub-agent own channel) when its .env exists', () => {
    mockExistsSync.mockImplementation((p) => p === `${CANDIDATE_1}/.env`)
    expect(resolveAgentChannelStateDir('zack', 'telegram')).toBe(CANDIDATE_1)
  })

  it('matches candidate 2 (alternative naming) when its .env exists', () => {
    mockExistsSync.mockImplementation((p) => p === `${CANDIDATE_2}/.env`)
    expect(resolveAgentChannelStateDir('zack', 'telegram')).toBe(CANDIDATE_2)
  })

  it('matches candidate 3 (global fallback / main agent) when its .env exists', () => {
    mockExistsSync.mockImplementation((p) => p === `${CANDIDATE_3}/.env`)
    expect(resolveAgentChannelStateDir('zack', 'telegram')).toBe(CANDIDATE_3)
  })

  it('falls back to the last candidate when none of the .env files exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(resolveAgentChannelStateDir('zack', 'telegram')).toBe(CANDIDATE_3)
  })
})

// ── buildTtsDirective ─────────────────────────────────────────────────────────

describe('buildTtsDirective', () => {
  const BASE_OPTS = { chatId: '123456', stateDir: '/mock/state/dir', voiceModel: 'hu_HU-imre-medium' }

  it('returns null when the dashboard token file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(buildTtsDirective(BASE_OPTS)).toBeNull()
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('builds the directive string with chatId, voiceModel, port and token embedded', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('sekrit-token-abc\n')
    const result = buildTtsDirective(BASE_OPTS)
    expect(result).not.toBeNull()
    expect(result).toContain('"chat_id":"123456"')
    expect(result).toContain('"voice_model":"hu_HU-imre-medium"')
    expect(result).toContain('"state_dir":"/mock/state/dir"')
    expect(result).toContain('localhost:4242')
    expect(result).toContain('Bearer sekrit-token-abc')
    // token must be trimmed (trailing newline from the file stripped)
    expect(result).not.toContain('sekrit-token-abc\n')
  })

  it('escapes a single quote in stateDir for safe embedding in the jq arg', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('tok')
    const dirWithQuote = "/mock/state/it's/here"
    const result = buildTtsDirective({ ...BASE_OPTS, stateDir: dirWithQuote })
    const expectedEscaped = dirWithQuote.replace(/'/g, "'\\''")
    expect(result).toContain(`"state_dir":"${expectedEscaped}"`)
    // sanity: the raw unescaped quote form should NOT appear verbatim
    expect(result).not.toContain(`"state_dir":"${dirWithQuote}"`)
  })

  it('returns null when reading the token throws', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('boom: permission denied')
    })
    expect(buildTtsDirective(BASE_OPTS)).toBeNull()
  })
})

// ── inboundIsAudio (small extra edge-case set; bulk covered elsewhere) ───────

describe('inboundIsAudio (extra edge cases)', () => {
  it('rejects a falsy fileId regardless of kind', () => {
    expect(inboundIsAudio('voice', '')).toBe(false)
    expect(inboundIsAudio('voice', undefined)).toBe(false)
    expect(inboundIsAudio('voice', null)).toBe(false)
  })

  it('accepts all three known audio kinds', () => {
    expect(inboundIsAudio('voice', 'file-1')).toBe(true)
    expect(inboundIsAudio('audio', 'file-1')).toBe(true)
    expect(inboundIsAudio('video_note', 'file-1')).toBe(true)
  })

  it('rejects an unrecognised kind', () => {
    expect(inboundIsAudio('document', 'file-1')).toBe(false)
  })

  it('treats null/undefined kind as not audio', () => {
    expect(inboundIsAudio(null, 'file-1')).toBe(false)
    expect(inboundIsAudio(undefined, 'file-1')).toBe(false)
  })

  it('is case-insensitive on the kind', () => {
    expect(inboundIsAudio('VOICE', 'file-1')).toBe(true)
    expect(inboundIsAudio('Video_Note', 'file-1')).toBe(true)
  })
})
