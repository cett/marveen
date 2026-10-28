// What the sub-agent launch command exports for authentication. The fleet OAuth token overrides an agent's own
// ANTHROPIC_API_KEY, so an agent configured with authMode "api" must never get it. Every other agent type keeps
// its launch command byte for byte: the expectations of the unchanged types are literal strings.
//
// The launcher is driven for real (startAgentProcess); the tmux call, the filesystem helpers and the config
// readers around it are replaced, and the command handed to `new-session` is what is compared.
//
// Privacy: neutral fixtures only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  agentRoot: '',
  model: 'claude-sonnet-5-5',
  authMode: 'shared',
  configDir: null as string | null,
  fleetToken: true,
  hasChannel: false,
  apiKey: '' as string,
  commands: [] as string[],
}))

const logWarn = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: logWarn, debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'main-x', SUBAGENT_INBOX_TEE: false }))
vi.mock('../pane-state.js', () => ({ detectPaneState: vi.fn() }))
vi.mock('../db.js', () => ({ deactivatePlanForAgent: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync: vi.fn(), execFileSync: vi.fn() }))

vi.mock('../channel-provider.js', () => ({
  channelStateDir: (_provider: string, dir: string) => join(dir, 'channel'),
  getProvider: () => ({ type: 'telegram', pluginId: 'telegram@fixture' }),
  readChannelToken: () => (h.hasChannel ? 'fixture-bot-token' : null),
}))
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(h.agentRoot, name),
  listAgentNames: () => [],
  readAgentAuthMode: () => h.authMode,
  readAgentClaudePlan: () => null,
  readAgentDisplayName: (name: string) => name,
  readAgentMemoryIsolation: () => false,
  readAgentModel: () => h.model,
  readAgentRemoteConfig: () => ({ host: null, workdir: null }),
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/agent-scaffold.js', () => ({
  ensureAutonomySection: vi.fn(),
  ensureFleetRosterSection: vi.fn(),
  ensureNoReaderSection: vi.fn(),
  ensureWorkDocSection: vi.fn(),
  writeAgentSettingsFromProfile: vi.fn(),
}))
vi.mock('../web/agent-team.js', () => ({ resolveAgentSecurityProfile: () => 'default' }))
vi.mock('../web/channel-plugin-unlock.js', () => ({ schedulePluginUnlockAfterRespawn: vi.fn() }))
vi.mock('../web/channel-poller-reap.js', () => ({ reapChannelOrphans: vi.fn(), reapDetachedChannelClaudes: vi.fn() }))
vi.mock('../web/claude-credentials-guard.js', () => ({ renameSharedCredentialsIfSafe: vi.fn() }))
vi.mock('../web/claude-plans.js', () => ({ resolveAgentConfigDir: () => ({ configDir: h.configDir, planUnresolved: false }) }))
vi.mock('../web/claude-plan-handoff-marker.js', () => ({ recoverActivePlanFromHandoff: vi.fn() }))
vi.mock('../web/memory-boundary.js', () => ({ provisionMemoryBoundaryDir: vi.fn() }))
vi.mock('../web/skill-regen.js', () => ({ generateTenantSkillFilesForAgent: vi.fn(), removeGeneratedTenantSkillFilesForAgent: vi.fn() }))
vi.mock('../web/openrouter-models.js', () => ({ resolveOpenRouterModel: (m: string) => m }))
vi.mock('../web/profiles.js', () => ({ loadProfileTemplate: () => ({ permissionMode: 'default' }) }))
vi.mock('../web/provider-dispatch.js', () => ({ buildProviderEnv: () => '' }))
vi.mock('../web/ssh-tmux.js', () => ({
  buildContinueProbeCommand: vi.fn(),
  buildRemoteLaunchCommand: vi.fn(),
  buildSshExec: vi.fn(),
  cleanStaleSshSockets: vi.fn(),
  ensureControlDir: vi.fn(),
}))
vi.mock('../web/telegram.js', () => ({ parseTelegramToken: () => null }))
vi.mock('../web/vault.js', () => ({ getSecret: (id: string) => (id === 'agent-agent-a-api-key' && h.apiKey ? h.apiKey : null) }))
vi.mock('../web/agent-process-identity.js', () => ({ scheduleIdentitySetup: vi.fn() }))
vi.mock('../web/agent-process-config.js', () => ({
  FLEET_OAUTH_TOKEN_PATH: '/fixture/store/.claude-oauth-token',
  buildTelegramMcpServerConfig: vi.fn(),
  ensureIsolatedChannelConfigDir: (name: string) => `/fixture/isolated/${name}`,
  ensureMainAgentIsolatedConfigDir: vi.fn(),
  ensureSharedClaudeOnboarded: vi.fn(),
  hasFleetOauthToken: () => h.fleetToken,
  maybeAlertSharedConfigCollision: vi.fn(),
  ownChannelProviderForScope: () => null,
  resetSharedConfigCollisionAlert: vi.fn(),
  resolveAgentProvider: () => 'telegram',
  scopeChannelPlugins: (_p: unknown, plugins: unknown) => plugins,
  stampFableOverageConsent: vi.fn(),
  stampProjectTrustForDir: vi.fn(),
}))
vi.mock('../web/agent-process-session.js', () => ({
  agentRunState: () => 'stopped',
  agentSessionName: (name: string) => `agent-${name}`,
  claudeBin: () => '/fixture/bin/claude',
  isAgentRunning: () => false,
  isSessionReadyForPrompt: vi.fn(),
  runTmux: (_host: unknown, args: string[]) => { if (args[0] === 'new-session') h.commands.push(args[args.length - 1]) },
  sendPromptToSession: vi.fn(),
  shSingleQuote: (v: string) => `'${v.replace(/'/g, `'\\''`)}'`,
  tmuxBin: () => '/fixture/bin/tmux',
}))

import { mkdirSync } from 'node:fs'
import { startAgentProcess } from '../web/agent-process-spawn.js'

const TOKEN_EXPORT = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '/fixture/store/.claude-oauth-token')" && `
const PREFIX = 'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
const COMMON = 'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false && export CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 && export DISABLE_AUTOUPDATER=1 && '

async function launch(): Promise<string> {
  h.commands.length = 0
  const res = await startAgentProcess('agent-a')
  expect(res.ok).toBe(true)
  expect(h.commands).toHaveLength(1)
  return h.commands[0]
}

beforeEach(() => {
  h.agentRoot = mkdtempSync(join(tmpdir(), 'spawn-oauth-env-'))
  mkdirSync(join(h.agentRoot, 'agent-a'), { recursive: true })
  h.model = 'claude-sonnet-5-5'
  h.authMode = 'shared'
  h.configDir = null
  h.fleetToken = true
  h.hasChannel = false
  h.apiKey = ''
})
afterEach(() => {
  rmSync(h.agentRoot, { recursive: true, force: true })
})

describe('launch command of the agent types that are not touched', () => {
  it('a Claude agent on the shared login with a fleet token: isolated dir, fleet token, no unset of it', async () => {
    const cmd = await launch()
    expect(cmd).toBe(`${PREFIX} && ${COMMON}export CLAUDE_CONFIG_DIR="/fixture/isolated/agent-a" && ${TOKEN_EXPORT}cd "${join(h.agentRoot, 'agent-a')}" && /fixture/bin/claude --dangerously-skip-permissions --model 'claude-sonnet-5-5'`)
  })

  it('a Claude agent with a config dir of its own: that dir, no fleet token', async () => {
    h.configDir = '/fixture/plan-a'
    const cmd = await launch()
    expect(cmd).toBe(`${PREFIX} && ${COMMON}export CLAUDE_CONFIG_DIR="/fixture/plan-a" && cd "${join(h.agentRoot, 'agent-a')}" && /fixture/bin/claude --dangerously-skip-permissions --model 'claude-sonnet-5-5'`)
  })

  it('a Claude agent without a fleet token stays on the shared login', async () => {
    h.fleetToken = false
    const cmd = await launch()
    expect(cmd).toBe(`${PREFIX} && ${COMMON}cd "${join(h.agentRoot, 'agent-a')}" && /fixture/bin/claude --dangerously-skip-permissions --model 'claude-sonnet-5-5'`)
  })

  it('a non-Claude model keeps getting the fleet token exactly as before', async () => {
    h.model = 'fixture-local-model'
    const cmd = await launch()
    expect(cmd).toBe(`${PREFIX} && ${COMMON}${TOKEN_EXPORT}cd "${join(h.agentRoot, 'agent-a')}" && /fixture/bin/claude --dangerously-skip-permissions --model 'fixture-local-model'`)
  })
})

describe('an authMode api agent never gets the fleet OAuth token', () => {
  const dirOf = () => join(h.agentRoot, 'agent-a')

  it('exports its own key, no token, and unsets one inherited from the tmux environment', async () => {
    h.authMode = 'api'
    h.apiKey = 'fixture-api-key'
    const cmd = await launch()
    expect(cmd).toBe(`${PREFIX} CLAUDE_CODE_OAUTH_TOKEN && ${COMMON}export ANTHROPIC_API_KEY="fixture-api-key" && cd "${dirOf()}" && /fixture/bin/claude --dangerously-skip-permissions --model 'claude-sonnet-5-5'`)
    expect(cmd).not.toContain('export CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('a channel agent in the isolated dir authenticates from its key, not the fleet token', async () => {
    h.authMode = 'api'
    h.apiKey = 'fixture-api-key'
    h.hasChannel = true
    const cmd = await launch()
    expect(cmd).toContain(`export CLAUDE_CONFIG_DIR="/fixture/isolated/agent-a" && `)
    expect(cmd).toContain('export ANTHROPIC_API_KEY="fixture-api-key" && ')
    expect(cmd).not.toContain('export CLAUDE_CODE_OAUTH_TOKEN')
    expect(cmd).toContain('DISCORD_BOT_TOKEN CLAUDE_CODE_OAUTH_TOKEN &&')
  })

  it('unsets an inherited token also when there is no fleet token', async () => {
    h.authMode = 'api'
    h.apiKey = 'fixture-api-key'
    h.fleetToken = false
    expect(await launch()).toContain('DISCORD_BOT_TOKEN CLAUDE_CODE_OAUTH_TOKEN &&')
  })

  it('an api agent with its own config dir keeps the dir and its key, and still unsets the token', async () => {
    h.authMode = 'api'
    h.apiKey = 'fixture-api-key'
    h.configDir = '/fixture/plan-a'
    const cmd = await launch()
    expect(cmd).toContain('export CLAUDE_CONFIG_DIR="/fixture/plan-a" && ')
    expect(cmd).toContain('export ANTHROPIC_API_KEY="fixture-api-key" && ')
    expect(cmd).toContain('DISCORD_BOT_TOKEN CLAUDE_CODE_OAUTH_TOKEN &&')
    expect(cmd).not.toContain('export CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('without a vault key it starts with no credential, fail closed, and warns with the agent name', async () => {
    h.authMode = 'api'
    h.apiKey = ''
    logWarn.mockClear()
    const cmd = await launch()
    expect(cmd).not.toContain('export CLAUDE_CODE_OAUTH_TOKEN')
    expect(cmd).not.toContain('ANTHROPIC_API_KEY')
    expect(cmd).toContain('DISCORD_BOT_TOKEN CLAUDE_CODE_OAUTH_TOKEN &&')
    const warned = logWarn.mock.calls.filter((c) => String(c[1]).includes('no API key in the vault'))
    expect(warned).toHaveLength(1)
    expect(warned[0][0]).toEqual({ name: 'agent-a' })
  })

  it('with a vault key, or for another authMode, there is no such warning', async () => {
    logWarn.mockClear()
    h.authMode = 'api'
    h.apiKey = 'fixture-api-key'
    await launch()
    h.authMode = 'shared'
    h.apiKey = ''
    await launch()
    expect(logWarn.mock.calls.filter((c) => String(c[1]).includes('no API key in the vault'))).toEqual([])
  })

  it('the api rule needs a Claude model: a non-Claude agent marked api is launched as any other', async () => {
    h.authMode = 'api'
    h.model = 'fixture-local-model'
    const cmd = await launch()
    expect(cmd).toContain(TOKEN_EXPORT)
    expect(cmd).not.toContain('DISCORD_BOT_TOKEN CLAUDE_CODE_OAUTH_TOKEN')
  })
})
