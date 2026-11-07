// What the sub-agent launch command does for an http MCP server whose headers take their secret from the vault:
// the reference is exported and `claude` is started through the env wrapper, the file keeps only the
// placeholder, and an agent with no such header gets exactly the command it got before.
//
// The launcher is driven for real (startAgentProcess); the tmux call and the config readers around it are
// replaced, the header reader is the real one and reads real files in a temp dir.
//
// Privacy: neutral fixtures only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE_VALUE = 'fixture-secret-value-0123456789'
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
  ensureCheckpointSection: vi.fn(),
  ensureHookPolicySection: vi.fn(),
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
vi.mock('../web/vault.js', () => ({ getSecret: (id: string) => (id === 'fixture-secret-a' ? FIXTURE_VALUE : null) }))
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

const WRAPPER = fileURLToPath(new URL('../../scripts/vault-env-wrapper.sh', import.meta.url))
const PREFIX = 'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
const COMMON = 'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false && export CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 && export DISABLE_AUTOUPDATER=1 && '


async function launch(): Promise<string> {
  h.commands.length = 0
  const res = await startAgentProcess('agent-a')
  expect(res.ok).toBe(true)
  expect(h.commands).toHaveLength(1)
  return h.commands[0]
}

let cfgDir = ''
const dirOf = () => join(h.agentRoot, 'agent-a')
const BASE_TAIL = "/fixture/bin/claude --dangerously-skip-permissions --model 'claude-sonnet-5-5'"

function writeUserConfig(servers: Record<string, unknown>) {
  writeFileSync(join(cfgDir, '.claude.json'), JSON.stringify({ mcpServers: servers }))
}
const httpServer = (env: Record<string, unknown>) => ({
  type: 'http', url: 'https://mcp.example.test/x', headers: { Authorization: 'Bearer ${FIXTURE_TOKEN}' }, env,
})

beforeEach(() => {
  h.agentRoot = mkdtempSync(join(tmpdir(), 'spawn-http-header-'))
  mkdirSync(join(h.agentRoot, 'agent-a'), { recursive: true })
  cfgDir = join(h.agentRoot, 'cfg')
  mkdirSync(cfgDir, { recursive: true })
  h.model = 'claude-sonnet-5-5'
  h.authMode = 'shared'
  h.configDir = cfgDir
  h.fleetToken = true
  h.hasChannel = false
  h.apiKey = ''
  logWarn.mockClear()
})
afterEach(() => {
  rmSync(h.agentRoot, { recursive: true, force: true })
})

describe('an http MCP header fed from the vault', () => {
  it('exports the reference before the cd and starts claude through the env wrapper', async () => {
    writeUserConfig({ s: httpServer({ FIXTURE_TOKEN: 'vault:fixture-secret-a' }) })
    const cmd = await launch()
    expect(cmd).toBe(`${PREFIX} && ${COMMON}export CLAUDE_CONFIG_DIR="${cfgDir}" && export FIXTURE_TOKEN='vault:fixture-secret-a' && cd "${dirOf()}" && '${WRAPPER}' ${BASE_TAIL}`)
  })

  it('the resolved value is never in the command, and the config file keeps only the placeholder', async () => {
    writeUserConfig({ s: httpServer({ FIXTURE_TOKEN: 'vault:fixture-secret-a' }) })
    const cmd = await launch()
    expect(cmd).not.toContain(FIXTURE_VALUE)
    const onDisk = readFileSync(join(cfgDir, '.claude.json'), 'utf-8')
    expect(onDisk).not.toContain(FIXTURE_VALUE)
    expect(onDisk).toContain('Bearer ${FIXTURE_TOKEN}')
  })

  it('a project .mcp.json in the agent directory is read too', async () => {
    writeFileSync(join(dirOf(), '.mcp.json'), JSON.stringify({ mcpServers: { s: httpServer({ FIXTURE_TOKEN: 'vault:fixture-secret-a' }) } }))
    expect(await launch()).toContain(`export FIXTURE_TOKEN='vault:fixture-secret-a' && cd "${dirOf()}" && '${WRAPPER}' `)
  })
})

describe('an agent with nothing to feed keeps its launch command byte for byte', () => {
  const unchanged = `${PREFIX} && ${COMMON}export CLAUDE_CONFIG_DIR="${'$CFG'}" && cd "${'$DIR'}" && ${BASE_TAIL}`
  const expected = () => unchanged.replace('$CFG', cfgDir).replace('$DIR', dirOf())

  it('no config file', async () => {
    expect(await launch()).toBe(expected())
  })

  it('a config with only a stdio server, and a header that has no placeholder', async () => {
    writeUserConfig({
      stdio: { command: 'node', args: [], env: { FIXTURE_TOKEN: 'vault:fixture-secret-a' } },
      plain: { type: 'http', url: 'https://mcp.example.test/y', headers: { Authorization: 'Bearer literal' } },
    })
    expect(await launch()).toBe(expected())
  })
})

describe('a header variable that cannot be fed is left out and logged by name and id', () => {
  const cases: Array<[string, Record<string, unknown>, string, string | undefined]> = [
    ['an id that is not in the vault', { FIXTURE_TOKEN: 'vault:fixture-secret-missing' }, 'unresolved', 'fixture-secret-missing'],
    ['a literal instead of a vault reference', { FIXTURE_TOKEN: 'a-literal-value' }, 'no-vault-binding', undefined],
    ['an SSH key id', { FIXTURE_TOKEN: 'vault:ssh-key-fixture' }, 'ssh-key', 'ssh-key-fixture'],
  ]
  it.each(cases)('%s', async (_label, env, reason, secretId) => {
    writeUserConfig({ s: httpServer(env) })
    const cmd = await launch()
    expect(cmd).not.toContain('FIXTURE_TOKEN')
    expect(cmd).not.toContain('vault-env-wrapper')
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-a', var: 'FIXTURE_TOKEN', reason, secretId }),
      'http-mcp-header-env: header variable not fed from the vault',
    )
    // the agent still starts: the rest of the session does not depend on this one header
    expect(cmd).toContain(BASE_TAIL)
  })

  it('the warning carries no value', async () => {
    writeUserConfig({ s: httpServer({ FIXTURE_TOKEN: 'vault:fixture-secret-missing' }) })
    await launch()
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(FIXTURE_VALUE)
  })
})
