// Which Anthropic credential an agent session ends up authenticating with (T4-7 W6 inventory).
//
// READ-ONLY description of the launch behaviour. Nothing here is wired into the launchers
// (agent-process-spawn.ts, scripts/channels.sh, agent-worker.ts): it mirrors their precedence so the
// credential an agent really runs on is visible per agent, and so a change to that precedence fails a
// test instead of silently moving an agent to another identity.
//
// Precedence Claude Code applies (the guard in claude-credentials-guard.ts states it): a
// CLAUDE_CODE_OAUTH_TOKEN in the environment strictly overrides ANTHROPIC_API_KEY and a login stored in
// the config dir; an API key beats a stored login. So the launcher decides the identity by what it
// exports, not by what the agent config says.

export type AuthSource =
  | 'provider-endpoint' // not a Claude model: Ollama / DeepSeek / OpenRouter env, no Anthropic credential
  | 'oauth-env' // CLAUDE_CODE_OAUTH_TOKEN exported (the fleet setup-token)
  | 'api-key-env' // the agent's own ANTHROPIC_API_KEY
  | 'config-dir-login' // the login stored in an explicit / plan CLAUDE_CONFIG_DIR
  | 'shared-login' // the shared ~/.claude (rotating credential)

export type ConfigDirKind = 'explicit' | 'isolated' | 'shared'

export interface SubAgentAuthInput {
  isClaude: boolean
  authMode: 'shared' | 'own_team' | 'api'
  hasAgentApiKey: boolean
  /** Per-agent config dir (a resolved claude plan wins over the raw claudeConfigDir), null when unset. */
  configDir: string | null
  hasFleetToken: boolean
  hasChannel: boolean
}

export interface MainAgentAuthInput {
  /** ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN present in .env (the launcher exports them into the shell). */
  envFileApiKey: boolean
  envFileOauth: boolean
  hasFleetToken: boolean
  /** The config-dir mode main-agent-isolated-config.mjs prints; null = none (shared ~/.claude). */
  cfgMode: 'explicit' | 'rotated' | 'isolated' | null
}

export interface AuthSourceResult {
  winner: AuthSource
  configDir: ConfigDirKind
  /** Credentials the launch exports that lose to the winner (a configured identity that does not apply). */
  shadowed: string[]
}

/**
 * Sub-agent, as agent-process-spawn.ts launches it. The three facts that decide it, in the order the
 * launcher evaluates them:
 *  1. apiKeyEnv: authMode 'api' on a Claude model with a vault key.
 *  2. a fleet-token export: for an agent with no config dir, except an authMode 'api' agent on a Claude
 *     model (it never gets the token, the launcher unsets an inherited one), and with the isolated dir for
 *     every Claude-OAuth agent or channel agent.
 *  3. the config dir: explicit/plan wins, else isolated (non-api Claude agent or channel agent, needs the
 *     fleet token), else the shared root.
 */
export function classifySubAgentAuth(i: SubAgentAuthInput): AuthSourceResult {
  const needsFleetOauth = i.isClaude && i.authMode !== 'api'
  const isolated = !i.configDir && (i.hasChannel || needsFleetOauth) && i.hasFleetToken
  const configDir: ConfigDirKind = i.configDir ? 'explicit' : isolated ? 'isolated' : 'shared'
  // The launcher exports the fleet token for every agent without a config dir, except one on its own API key.
  const oauthExported = !i.configDir && i.hasFleetToken && !(i.isClaude && i.authMode === 'api')
  const apiKeyExported = i.isClaude && i.authMode === 'api' && i.hasAgentApiKey

  if (!i.isClaude) return { winner: 'provider-endpoint', configDir, shadowed: [] }

  const shadowed: string[] = []
  if (oauthExported) {
    if (apiKeyExported) shadowed.push('ANTHROPIC_API_KEY')
    return { winner: 'oauth-env', configDir, shadowed }
  }
  if (apiKeyExported) return { winner: 'api-key-env', configDir, shadowed: i.configDir ? ['config-dir login'] : [] }
  return { winner: i.configDir ? 'config-dir-login' : 'shared-login', configDir, shadowed }
}

/**
 * Main agent, as scripts/channels.sh launches it: the shell exports ANTHROPIC_API_KEY and
 * CLAUDE_CODE_OAUTH_TOKEN (from .env, the OAuth one falling back to the fleet token file) before the
 * config-dir block; the explicit / rotated modes unset the token again in the launch command, so the
 * directory's own login is what applies (the API key is not touched).
 */
export function classifyMainAgentAuth(i: MainAgentAuthInput): AuthSourceResult {
  const ownDirLogin = i.cfgMode === 'explicit' || i.cfgMode === 'rotated'
  const oauthExported = !ownDirLogin && (i.envFileOauth || i.hasFleetToken || i.cfgMode === 'isolated')
  const configDir: ConfigDirKind = i.cfgMode === null ? 'shared' : i.cfgMode === 'isolated' ? 'isolated' : 'explicit'
  const shadowed: string[] = []
  if (oauthExported) {
    if (i.envFileApiKey) shadowed.push('ANTHROPIC_API_KEY')
    return { winner: 'oauth-env', configDir, shadowed }
  }
  if (i.envFileApiKey) return { winner: 'api-key-env', configDir, shadowed: configDir === 'explicit' ? ['config-dir login'] : [] }
  return { winner: configDir === 'explicit' ? 'config-dir-login' : 'shared-login', configDir, shadowed }
}
