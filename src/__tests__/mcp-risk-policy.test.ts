import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir } from '../web/agent-config.js'
import {
  isHighRiskMcpServer,
  getAgentMcpServers,
  getHighRiskMcpServersForAgent,
} from '../web/mcp-risk-policy.js'

const TEST_AGENT = 'zz-mcp-risk-test-tmp'

function writeMcpJson(mcpServers: Record<string, unknown>): void {
  mkdirSync(agentDir(TEST_AGENT), { recursive: true })
  writeFileSync(join(agentDir(TEST_AGENT), '.mcp.json'), JSON.stringify({ mcpServers }), 'utf-8')
}

afterEach(() => {
  rmSync(agentDir(TEST_AGENT), { recursive: true, force: true })
})

describe('isHighRiskMcpServer', () => {
  it('flags the known high-risk servers', () => {
    expect(isHighRiskMcpServer('hetzner')).toBe(true)
    expect(isHighRiskMcpServer('github')).toBe(true)
    expect(isHighRiskMcpServer('gitlab')).toBe(true)
    expect(isHighRiskMcpServer('filesystem')).toBe(true)
  })

  it('flags the whole ga4 family, not just the exact "ga4" name', () => {
    expect(isHighRiskMcpServer('ga4')).toBe(true)
    expect(isHighRiskMcpServer('ga4-aimit')).toBe(true)
    expect(isHighRiskMcpServer('ga4-some-future-tenant-property')).toBe(true)
  })

  it('does not flag a name that merely contains "ga4" without the family prefix/separator', () => {
    expect(isHighRiskMcpServer('mega4x')).toBe(false)
  })

  it('does not flag low-risk servers', () => {
    expect(isHighRiskMcpServer('perplexity')).toBe(false)
    expect(isHighRiskMcpServer('playwright')).toBe(false)
    expect(isHighRiskMcpServer('duckduckgo')).toBe(false)
    expect(isHighRiskMcpServer('garmin')).toBe(false)
  })
})

describe('getAgentMcpServers', () => {
  it('returns the mcpServers keys from the agent .mcp.json', () => {
    writeMcpJson({ playwright: { command: 'npx' }, github: { command: 'npx' } })
    expect(getAgentMcpServers(TEST_AGENT)).toEqual(['playwright', 'github'])
  })

  it('returns [] when the agent has no .mcp.json', () => {
    mkdirSync(agentDir(TEST_AGENT), { recursive: true })
    expect(getAgentMcpServers(TEST_AGENT)).toEqual([])
  })

  it('returns [] for malformed JSON rather than throwing', () => {
    mkdirSync(agentDir(TEST_AGENT), { recursive: true })
    writeFileSync(join(agentDir(TEST_AGENT), '.mcp.json'), '{ not valid json', 'utf-8')
    expect(getAgentMcpServers(TEST_AGENT)).toEqual([])
  })

  it('returns [] when mcpServers is missing from an otherwise-valid JSON file', () => {
    mkdirSync(agentDir(TEST_AGENT), { recursive: true })
    writeFileSync(join(agentDir(TEST_AGENT), '.mcp.json'), '{}', 'utf-8')
    expect(getAgentMcpServers(TEST_AGENT)).toEqual([])
  })
})

describe('getHighRiskMcpServersForAgent', () => {
  it('returns only the high-risk subset of the agent\'s configured servers', () => {
    writeMcpJson({ playwright: {}, github: {}, duckduckgo: {}, hetzner: {} })
    expect(getHighRiskMcpServersForAgent(TEST_AGENT).sort()).toEqual(['github', 'hetzner'])
  })

  it('returns [] for an agent with only low-risk servers', () => {
    writeMcpJson({ playwright: {}, duckduckgo: {} })
    expect(getHighRiskMcpServersForAgent(TEST_AGENT)).toEqual([])
  })

  it('returns [] for an agent with no .mcp.json at all', () => {
    expect(getHighRiskMcpServersForAgent(TEST_AGENT)).toEqual([])
  })
})
