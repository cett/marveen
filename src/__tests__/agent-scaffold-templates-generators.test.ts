/**
 * Coverage for the LLM-backed generators in
 * src/web/agent-scaffold-templates.ts that had no direct test coverage:
 * generateClaudeMd, generateSoulMd, generateSkillMd, and their shared
 * noOutputHint/blockedHint error-message builders. runAgent (src/agent.ts) is
 * mocked so the tests exercise only this module's own logic: code-fence
 * stripping, the no-text/blocked-result error branches, and (for
 * generateClaudeMd specifically) the generated-markers appended after the
 * LLM output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRunAgent = vi.hoisted(() => vi.fn())

vi.mock('../agent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent.js')>()
  return { ...actual, runAgent: mockRunAgent }
})

import { generateClaudeMd, generateSoulMd, generateSkillMd } from '../web/agent-scaffold-templates.js'

beforeEach(() => {
  mockRunAgent.mockReset()
})

describe('generateSoulMd', () => {
  it('returns the trimmed LLM text as-is when there are no code fences', async () => {
    mockRunAgent.mockResolvedValue({ text: '  # SOUL.md\nA melancholic assistant.  \n' })
    const out = await generateSoulMd('boni', 'senior backend dev')
    expect(out).toBe('# SOUL.md\nA melancholic assistant.')
  })

  it('strips a wrapping markdown code fence', async () => {
    mockRunAgent.mockResolvedValue({ text: '```markdown\n# SOUL.md\ncontent here\n```' })
    const out = await generateSoulMd('boni', 'senior backend dev')
    expect(out).toBe('# SOUL.md\ncontent here')
  })

  it('throws the no-output hint when the model returns empty text with no error', async () => {
    mockRunAgent.mockResolvedValue({ text: null })
    await expect(generateSoulMd('boni', 'x')).rejects.toThrow(/returned no output/)
    await expect(generateSoulMd('boni', 'x')).rejects.toThrow(/claude --version/)
  })

  it('throws the blocked-result hint when the model returns an error reason', async () => {
    mockRunAgent.mockResolvedValue({ text: null, error: 'usage policy violation' })
    await expect(generateSoulMd('boni', 'x')).rejects.toThrow(/blocked\/errored result/)
    await expect(generateSoulMd('boni', 'x')).rejects.toThrow(/usage policy violation/)
  })
})

describe('generateSkillMd', () => {
  it('returns the trimmed LLM text as-is when there are no code fences', async () => {
    mockRunAgent.mockResolvedValue({ text: '---\nname: foo\n---\nBody' })
    const out = await generateSkillMd('foo', 'does a thing')
    expect(out).toBe('---\nname: foo\n---\nBody')
  })

  it('strips a wrapping code fence', async () => {
    mockRunAgent.mockResolvedValue({ text: '```\n---\nname: foo\n---\nBody\n```' })
    const out = await generateSkillMd('foo', 'does a thing')
    expect(out).toBe('---\nname: foo\n---\nBody')
  })

  it('throws the no-output hint when the model returns empty text', async () => {
    mockRunAgent.mockResolvedValue({ text: '' })
    await expect(generateSkillMd('foo', 'x')).rejects.toThrow(/SKILL\.md.*returned no output/)
  })

  it('throws the blocked-result hint when the model returns an error reason', async () => {
    mockRunAgent.mockResolvedValue({ text: null, error: 'api_error_status 400' })
    await expect(generateSkillMd('foo', 'x')).rejects.toThrow(/SKILL\.md.*blocked\/errored/)
  })
})

describe('generateClaudeMd', () => {
  it('strips code fences and appends the generated fleet-roster and autonomy sections', async () => {
    mockRunAgent.mockResolvedValue({ text: '```markdown\n# CLAUDE.md\nRole description.\n```' })
    const out = await generateClaudeMd('newagent', 'does research', 'sonnet')
    expect(out.startsWith('# CLAUDE.md\nRole description.')).toBe(true)
    expect(out).toContain('<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->')
    expect(out).toContain('<!-- END GENERATED: fleet-roster -->')
    expect(out).toContain('<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->')
    expect(out).toContain('<!-- END GENERATED: autonomy-wiring -->')
  })

  it('places the generated sections after the LLM content, not before', async () => {
    mockRunAgent.mockResolvedValue({ text: 'Plain body, no fences.' })
    const out = await generateClaudeMd('newagent', 'x', 'sonnet')
    const bodyIdx = out.indexOf('Plain body, no fences.')
    const rosterIdx = out.indexOf('BEGIN GENERATED: fleet-roster')
    expect(bodyIdx).toBeGreaterThanOrEqual(0)
    expect(rosterIdx).toBeGreaterThan(bodyIdx)
  })

  it('throws the no-output hint when the model returns empty text with no error', async () => {
    mockRunAgent.mockResolvedValue({ text: null })
    await expect(generateClaudeMd('newagent', 'x', 'sonnet')).rejects.toThrow(/CLAUDE\.md.*returned no output/)
  })

  it('throws the blocked-result hint when the model returns an error reason', async () => {
    mockRunAgent.mockResolvedValue({ text: undefined, error: 'api_error_status 403' })
    await expect(generateClaudeMd('newagent', 'x', 'sonnet')).rejects.toThrow(/CLAUDE\.md.*blocked\/errored/)
    await expect(generateClaudeMd('newagent', 'x', 'sonnet')).rejects.toThrow(/api_error_status 403/)
  })
})
