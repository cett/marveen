// Per-agent credential inventory (T4-7 W6): reads the live config of every agent and the main agent and
// runs it through the pure classifiers in agent-auth-source.ts. Read-only: it exports no credential,
// writes no file and provisions no config dir. The output carries booleans and a source name, never a
// secret value or a token path.

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { channelStateDir, readChannelToken } from '../channel-provider.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir, listAgentNames, readAgentAuthMode, readAgentModel } from './agent-config.js'
import { hasFleetOauthToken, resolveAgentProvider, resolveMainAgentConfigDir, resolveMainAgentRotatedConfigDir } from './agent-process-config.js'
import { classifyMainAgentAuth, classifySubAgentAuth, type AuthSourceResult } from './agent-auth-source.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { resolveOpenRouterModel } from './openrouter-models.js'
import { parseTelegramToken } from './telegram.js'
import { getSecret } from './vault.js'
import { getEffectiveSettingValue } from '../settings-store.js'

export interface AgentAuthRow extends AuthSourceResult {
  agent: string
  main: boolean
  model: string
  authMode: string
}

function envFileHas(key: string): boolean {
  try {
    const envPath = join(PROJECT_ROOT, '.env')
    if (!existsSync(envPath)) return false
    return new RegExp(`^${key}=.+`, 'm').test(readFileSync(envPath, 'utf-8'))
  } catch {
    return false
  }
}

function subAgentHasChannel(name: string): boolean {
  const providerId = resolveAgentProvider(name)
  const token = readChannelToken(providerId, join(channelStateDir(providerId, agentDir(name)), '.env'))
  if (token) return true
  return providerId === 'telegram' ? !!parseTelegramToken(name) : false
}

export function mainAgentAuthRow(): AgentAuthRow {
  let isolationOn = false
  try { isolationOn = String(getEffectiveSettingValue('MAIN_AGENT_ISOLATED_CONFIG')) === '1' } catch { isolationOn = false }
  const hasFleetToken = hasFleetOauthToken()
  const cfgMode = resolveMainAgentConfigDir() ? 'explicit' as const
    : resolveMainAgentRotatedConfigDir() ? 'rotated' as const
    : isolationOn && hasFleetToken ? 'isolated' as const
    : null
  const result = classifyMainAgentAuth({
    envFileApiKey: envFileHas('ANTHROPIC_API_KEY'),
    envFileOauth: envFileHas('CLAUDE_CODE_OAUTH_TOKEN'),
    hasFleetToken,
    cfgMode,
  })
  return { agent: MAIN_AGENT_ID, main: true, model: '-', authMode: '-', ...result }
}

export function agentAuthRow(name: string): AgentAuthRow {
  const model = resolveOpenRouterModel(readAgentModel(name))
  const authMode = readAgentAuthMode(name)
  const result = classifySubAgentAuth({
    isClaude: model.startsWith('claude-'),
    authMode,
    hasAgentApiKey: !!getSecret(`agent-${name}-api-key`),
    configDir: resolveAgentConfigDir(name).configDir,
    hasFleetToken: hasFleetOauthToken(),
    hasChannel: subAgentHasChannel(name),
  })
  return { agent: name, main: false, model, authMode, ...result }
}

export function inventoryAgentAuth(): AgentAuthRow[] {
  return [mainAgentAuthRow(), ...listAgentNames().filter((n) => n !== MAIN_AGENT_ID).sort().map(agentAuthRow)]
}

export function renderAgentAuthInventory(rows: AgentAuthRow[]): string {
  const lines = ['| agent | model | authMode | winner | config dir | shadowed |', '|---|---|---|---|---|---|']
  for (const r of rows) {
    lines.push(`| ${r.agent}${r.main ? ' (main)' : ''} | ${r.model} | ${r.authMode} | ${r.winner} | ${r.configDir} | ${r.shadowed.join(', ') || '-'} |`)
  }
  return lines.join('\n')
}
