// T4-7 W6: which credential an agent session authenticates with. The classifiers describe the launch
// behaviour, so two things are pinned: the decision table itself, and the launcher
// source lines the table is derived from (a change to the precedence in agent-process-spawn.ts or
// scripts/channels.sh must come with a change to the classifier, not drift past it).
//
// Privacy: neutral fixtures only.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyMainAgentAuth, classifySubAgentAuth, type SubAgentAuthInput } from '../web/agent-auth-source.js'

const base: SubAgentAuthInput = { isClaude: true, authMode: 'shared', hasAgentApiKey: false, configDir: null, hasFleetToken: false, hasChannel: false }
const sub = (o: Partial<SubAgentAuthInput>) => classifySubAgentAuth({ ...base, ...o })

describe('classifySubAgentAuth', () => {
  it('a Claude agent with the fleet token authenticates from the token, in an isolated dir', () => {
    expect(sub({ hasFleetToken: true })).toEqual({ winner: 'oauth-env', configDir: 'isolated', shadowed: [] })
    expect(sub({ hasFleetToken: true, hasChannel: true }).configDir).toBe('isolated')
  })

  it('without the fleet token it stays on the shared login, in the shared dir', () => {
    expect(sub({})).toEqual({ winner: 'shared-login', configDir: 'shared', shadowed: [] })
    expect(sub({ hasChannel: true })).toEqual({ winner: 'shared-login', configDir: 'shared', shadowed: [] })
  })

  it('an explicit or plan config dir keeps its own login only while no fleet token is exported next to it', () => {
    expect(sub({ configDir: '/x/plan-a' })).toEqual({ winner: 'config-dir-login', configDir: 'explicit', shadowed: [] })
    // a config dir switches the fleet-token export off in the launcher: the dir's login is what applies
    expect(sub({ configDir: '/x/plan-a', hasFleetToken: true })).toEqual({ winner: 'config-dir-login', configDir: 'explicit', shadowed: [] })
  })

  it('an authMode api agent with a key and no config dir and no fleet token runs on its key', () => {
    expect(sub({ authMode: 'api', hasAgentApiKey: true })).toEqual({ winner: 'api-key-env', configDir: 'shared', shadowed: [] })
  })

  it('an authMode api agent keeps its key: the launcher never exports the fleet token to it', () => {
    // the pin used to say the opposite (the key lost to the token); that recorded the defect this fixes
    const r = sub({ authMode: 'api', hasAgentApiKey: true, hasFleetToken: true })
    expect(r).toEqual({ winner: 'api-key-env', configDir: 'shared', shadowed: [] })
    // not isolated: an api agent without a channel keeps the shared root
    expect(sub({ authMode: 'api', hasAgentApiKey: true, hasFleetToken: true, hasChannel: true }))
      .toEqual({ winner: 'api-key-env', configDir: 'isolated', shadowed: [] })
  })

  it('an authMode api agent with no vault key does not fall back to the fleet token either', () => {
    expect(sub({ authMode: 'api', hasAgentApiKey: false, hasFleetToken: true }))
      .toEqual({ winner: 'shared-login', configDir: 'shared', shadowed: [] })
  })

  it('an authMode api agent with a config dir keeps its key over the dir login', () => {
    expect(sub({ authMode: 'api', hasAgentApiKey: true, configDir: '/x/plan-a', hasFleetToken: true }))
      .toEqual({ winner: 'api-key-env', configDir: 'explicit', shadowed: ['config-dir login'] })
  })

  it('an authMode api agent with no vault key falls back like a shared one', () => {
    expect(sub({ authMode: 'api', hasAgentApiKey: false })).toEqual({ winner: 'shared-login', configDir: 'shared', shadowed: [] })
  })

  it('a non-Claude model uses its provider endpoint whatever else is set', () => {
    expect(sub({ isClaude: false, hasFleetToken: true, hasChannel: true }).winner).toBe('provider-endpoint')
    expect(sub({ isClaude: false }).configDir).toBe('shared')
  })
})

describe('classifyMainAgentAuth', () => {
  const main = (o: Partial<Parameters<typeof classifyMainAgentAuth>[0]>) =>
    classifyMainAgentAuth({ envFileApiKey: false, envFileOauth: false, hasFleetToken: false, cfgMode: null, ...o })

  it('no credential source configured: the shared login', () => {
    expect(main({})).toEqual({ winner: 'shared-login', configDir: 'shared', shadowed: [] })
  })

  it('the token from .env or the fleet token file wins and shadows the API key, when there is no own-login dir', () => {
    expect(main({ envFileOauth: true }).winner).toBe('oauth-env')
    expect(main({ hasFleetToken: true, envFileApiKey: true }).shadowed).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('an explicit or rotated dir keeps its own login: the launch command unsets the token the shell exported', () => {
    // the pin used to say the token shadowed the dir login; that recorded the defect this fixes
    for (const cfgMode of ['explicit', 'rotated'] as const) {
      expect(main({ hasFleetToken: true, envFileOauth: true, cfgMode })).toEqual({ winner: 'config-dir-login', configDir: 'explicit', shadowed: [] })
    }
    expect(main({ cfgMode: 'explicit' })).toEqual({ winner: 'config-dir-login', configDir: 'explicit', shadowed: [] })
  })

  it('an API key in .env still beats the login of an explicit dir', () => {
    expect(main({ cfgMode: 'explicit', envFileApiKey: true, hasFleetToken: true }))
      .toEqual({ winner: 'api-key-env', configDir: 'explicit', shadowed: ['config-dir login'] })
  })

  it('the isolated mode authenticates from the token it injects', () => {
    expect(main({ cfgMode: 'isolated', hasFleetToken: true })).toEqual({ winner: 'oauth-env', configDir: 'isolated', shadowed: [] })
  })
})

// The launcher lines the tables above are derived from. Whitespace is normalised so a reformat is not a failure.
const flat = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf-8').replace(/\s+/g, ' ')

describe('launcher source the classifiers mirror', () => {
  const spawn = flat('src/web/agent-process-spawn.ts')
  const channels = flat('scripts/channels.sh')

  it('sub-agent: the API key is exported only for authMode api on a Claude model', () => {
    expect(spawn).toContain("const ownApiKeyAuth = isClaude && authMode === 'api'")
    expect(spawn).toContain('if (ownApiKeyAuth) {')
    expect(spawn).toContain('apiKeyEnv = `export ANTHROPIC_API_KEY=')
  })

  it('sub-agent: the fleet token is exported for a dir-less agent, except one on its own API key', () => {
    expect(spawn).toContain('if (!claudeConfigDir && !ownApiKeyAuth && hasFleetOauthToken()) { oauthTokenEnv =')
    expect(spawn).toContain('if (!ownApiKeyAuth) { oauthTokenEnv =')
  })

  it('sub-agent: an own-key agent unsets a token inherited from the tmux environment', () => {
    expect(spawn).toContain("${ownApiKeyAuth ? ' CLAUDE_CODE_OAUTH_TOKEN' : ''}")
  })

  it('sub-agent: isolation covers channel agents and non-api Claude agents, not the main agent', () => {
    expect(spawn).toContain("const needsFleetOauth = isClaude && authMode !== 'api'")
    expect(spawn).toContain('if (!claudeConfigDir && (hasChannel || needsFleetOauth) && name !== MAIN_AGENT_ID) {')
  })

  it('sub-agent: the command exports key, then config dir, then token (the token is last, so it is what Claude Code sees)', () => {
    expect(spawn).toContain('${apiKeyEnv}${claudeConfigEnv}${oauthTokenEnv}${providerEnv}')
  })

  it('main agent: .env key and token are exported, the token falls back to the fleet token file', () => {
    expect(channels).toContain('[ -n "$_api_key" ] && export ANTHROPIC_API_KEY="$_api_key"')
    expect(channels).toContain('[ -n "$_oauth" ] && export CLAUDE_CODE_OAUTH_TOKEN="$_oauth"')
    expect(channels).toContain('store/.claude-oauth-token" ]; then _oauth="$(cat "$INSTALL_DIR/store/.claude-oauth-token")"')
  })

  it('main agent: explicit and rotated dirs unset the token, isolated seeds it', () => {
    const fn = channels.slice(channels.indexOf('main_cfg_env() {'))
    const explicitBranch = fn.slice(0, fn.indexOf(' else '))
    expect(explicitBranch).toContain("unset CLAUDE_CODE_OAUTH_TOKEN && ")
    expect(explicitBranch).not.toContain('export CLAUDE_CODE_OAUTH_TOKEN')
    const isolatedBranch = fn.slice(fn.indexOf(' else '), fn.indexOf(' fi '))
    expect(isolatedBranch).toContain('export CLAUDE_CODE_OAUTH_TOKEN=')
    expect(channels).toContain('CFG_ENV="$(main_cfg_env "$_cfg_mode" "$_cfg_dir")"')
  })
})
