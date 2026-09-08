// Split from the former monolithic src/web/agent-process.ts (775).

import { channelStateDir, getProvider, readChannelToken } from '../channel-provider.js'
import { MAIN_AGENT_ID, SUBAGENT_INBOX_TEE } from '../config.js'
import { logger } from '../logger.js'
import { detectPaneState } from '../pane-state.js'
import { agentDir, listAgentNames, readAgentAuthMode, readAgentClaudePlan, readAgentDisplayName, readAgentMemoryIsolation, readAgentModel, readAgentRemoteConfig, readAgentRemoteHost } from './agent-config.js'
import { ensureAutonomySection, ensureFleetRosterSection, writeAgentSettingsFromProfile } from './agent-scaffold.js'
import { resolveAgentSecurityProfile } from './agent-team.js'
import { schedulePluginUnlockAfterRespawn } from './channel-plugin-unlock.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'
import { renameSharedCredentialsIfSafe } from './claude-credentials-guard.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { provisionMemoryBoundaryDir } from './memory-boundary.js'
import { resolveOpenRouterModel } from './openrouter-models.js'
import { loadProfileTemplate } from './profiles.js'
import { buildProviderEnv } from './provider-dispatch.js'
import { buildContinueProbeCommand, buildRemoteLaunchCommand, buildSshExec, cleanStaleSshSockets, ensureControlDir } from './ssh-tmux.js'
import { parseTelegramToken } from './telegram.js'
import { getSecret } from './vault.js'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FLEET_OAUTH_TOKEN_PATH, buildTelegramMcpServerConfig, ensureIsolatedChannelConfigDir, ensureMainAgentIsolatedConfigDir, ensureSharedClaudeOnboarded, hasFleetOauthToken, maybeAlertSharedConfigCollision, ownChannelProviderForScope, resetSharedConfigCollisionAlert, resolveAgentProvider, scopeChannelPlugins, stampFableOverageConsent, stampProjectTrustForDir } from './agent-process-config.js'
import { scheduleIdentitySetup } from './agent-process-identity.js'
import { agentRunState, agentSessionName, claudeBin, isAgentRunning, isSessionReadyForPrompt, runTmux, sendPromptToSession, shSingleQuote, tmuxBin } from './agent-process-session.js'

function startRemoteAgentProcess(
  name: string,
  host: string,
  workdir: string,
  opts: { fresh?: boolean },
): { ok: boolean; error?: string; hint?: string } {
  const state = agentRunState(name)
  if (state === 'running') return { ok: false, error: 'conflict', hint: 'Agent is already running' }
  if (state === 'unreachable') {
    return { ok: false, error: 'internal_error', hint: `Remote host '${host}' unreachable -- refusing to start (cannot confirm state)` }
  }

  ensureControlDir()
  cleanStaleSshSockets(host)

  const session = agentSessionName(name)

  // Pre-flight: claude must be on PATH on the laptop, else the session starts
  // and instantly dies with a silent "command not found".
  try {
    const probe = buildSshExec(host, 'which claude')
    execFileSync(probe.file, probe.args, { timeout: 8000, stdio: 'ignore' })
  } catch {
    return { ok: false, error: 'internal_error', hint: `claude not found on PATH on '${host}' (or host unreachable)` }
  }

  // --continue only when the remote session dir already exists. workdir is an
  // absolute path (validated), so the `/`->`-` encoding matches Claude Code's
  // own leading-'-' scheme. A probe failure defaults to a fresh launch (safe).
  let hasPriorSession = false
  if (!opts.fresh) {
    try {
      const probe = buildSshExec(host, buildContinueProbeCommand(workdir))
      execFileSync(probe.file, probe.args, { timeout: 8000, stdio: 'ignore' })
      hasPriorSession = true
    } catch {
      hasPriorSession = false
    }
  }

  const model = readAgentModel(name)
  const cmd = buildRemoteLaunchCommand({ workdir, model, continue: hasPriorSession })

  try {
    runTmux(host, ['new-session', '-d', '-s', session, cmd], { timeout: 10000 })
    logger.info({ name, session, host, workdir }, 'Remote agent tmux session started')
    // Fire-and-forget: scheduleIdentitySetup only schedules delayed timers and
    // resolves immediately; startRemoteAgentProcess stays synchronous (out of scope).
    void scheduleIdentitySetup(session, readAgentDisplayName(name), host)
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, host }, 'Failed to start remote agent tmux session')
    return { ok: false, error: 'internal_error', hint: 'Failed to start remote tmux session' }
  }
}

export function startAgentProcess(name: string, opts: { fresh?: boolean } = {}): { ok: boolean; pid?: number; error?: string; hint?: string } {
  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'not_found', hint: 'Agent not found' }

  // Remote agents are handled entirely by the ssh path above (with its own
  // start guard), before any local already-running check / scaffolding.
  const remote = readAgentRemoteConfig(name)
  if (remote.host && remote.workdir) {
    return startRemoteAgentProcess(name, remote.host, remote.workdir, opts)
  }

  // Opt-in per-agent auto-memory isolation (local agents only; a remote
  // workdir cannot be provisioned from here). Default OFF: without the
  // memoryIsolation flag this is a no-op and the shared-memory behavior of
  // existing installs is byte-identical.
  if (readAgentMemoryIsolation(name)) provisionMemoryBoundaryDir(dir)

  // Linux shared-credentials race guard (opt-in, default OFF; no-op on macOS
  // and without the flag). Runs before launch so a valid setup-token retires
  // the rotating ~/.claude/.credentials.json; idempotent, so calling it per
  // start also self-heals if Claude Code recreates the file on a refresh.
  renameSharedCredentialsIfSafe(claudeBin())

  // Shared-root agents park on the first-run "Select login method" picker when
  // ~/.claude.json lost hasCompletedOnboarding (2026-07-15 bootcamp incident);
  // idempotent re-seed before every launch.
  ensureSharedClaudeOnboarded()


  if (isAgentRunning(name)) return { ok: false, error: 'conflict', hint: 'Agent is already running' }

  const agentProvider = resolveAgentProvider(name)
  const provider = getProvider(agentProvider)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const token = readChannelToken(agentProvider, join(agentChannelDir, '.env'))
  // Backward compat: try legacy Telegram token if provider-aware lookup misses
  let hasChannel = !!token
  if (!token && agentProvider === 'telegram') {
    const legacyToken = parseTelegramToken(name)
    hasChannel = !!legacyToken
    // Channel-less agents (inter-agent only, no direct Telegram/Slack) are allowed to start
  }

  // Teams name-sync (companion to make-teams-manifest.sh): keep
  // TEAMS_BOT_DISPLAY_NAME in the agent's teams .env equal to the agent's
  // displayName, so the generated Teams manifest names the bot after the agent
  // (not the generic fallback). Idempotent; writes only on drift, non-fatal.
  if (agentProvider === 'teams' && hasChannel) {
    try {
      const envPath = join(agentChannelDir, '.env')
      const displayName = readAgentDisplayName(name)
      const raw = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
      const current = raw.match(/^TEAMS_BOT_DISPLAY_NAME=(.*)$/m)?.[1]?.trim()
      if (displayName && current !== displayName) {
        const line = `TEAMS_BOT_DISPLAY_NAME=${displayName}`
        const next = current !== undefined
          ? raw.replace(/^TEAMS_BOT_DISPLAY_NAME=.*$/m, line)
          : (raw === '' || raw.endsWith('\n') ? raw + line + '\n' : raw + '\n' + line + '\n')
        writeFileSync(envPath, next)
      }
    } catch { /* best-effort name-sync; never block launch */ }
  }

  const session = agentSessionName(name)

  try {
    try {
      runTmux(null, ['kill-session', '-t', session])
      execSync('sleep 3', { timeout: 5000 })
    } catch { /* ok */ }

    // Reap any orphan poller (bun/node) left over from a previous run BEFORE
    // we spawn the new tmux session. The plugin process is a grandchild of
    // the tmux server, so a tmux kill-session does not always tear it down -
    // it can be orphaned and keep polling getUpdates with the agent's bot
    // token, racing the freshly-spawned poller and producing 409 Conflict on
    // a roughly hourly cadence. See channel-poller-reap.ts.
    try {
      const agentProvider = resolveAgentProvider(name)
      const dir = agentDir(name)
      reapChannelOrphans(agentProvider, dir)
    } catch (err) {
      logger.warn({ err, name }, 'pre-launch channel-poller reap failed (continuing)')
    }

    // Also reap DETACHED channel claudes (the parent-process leak): a prior
    // --continue session that survived kill-session keeps a poller 409-racing
    // this agent's bot token, which the health monitor reads as "down" and
    // restarts -- a self-feeding thrash loop (zara, 2026-06-03). We just killed
    // this agent's tmux session above, so its leftover claude is now detached;
    // pane attribution spares every live sibling and the main session.
    try {
      reapDetachedChannelClaudes({ tmuxPath: tmuxBin() })
    } catch (err) {
      logger.warn({ err, name }, 'pre-launch detached-claude reap failed (continuing)')
    }

    // `openrouter-auto:<tier>` resolves to the tier's current recommended model
    // (weekly-refreshed); a concrete OpenRouter id (contains '/') passes through.
    const model = resolveOpenRouterModel(readAgentModel(name))
    const authMode = readAgentAuthMode(name)
    const isClaude = model.startsWith('claude-')
    // Provider-specific env vars (Ollama, Deepseek, OpenRouter). Empty string
    // for Claude -- auth handled below via OAuth / apiKeyEnv. See provider-dispatch.ts.
    const providerEnv = buildProviderEnv(model)
    // When authMode is 'api', the agent uses its own ANTHROPIC_API_KEY from
    // the vault instead of the host's OAuth. The vault entry ID follows the
    // convention `agent-{name}-api-key`. We inject it as an env var so Claude
    // Code picks it up without needing OAuth credentials at all.
    let apiKeyEnv = ''
    if (isClaude && authMode === 'api') {
      const agentApiKey = getSecret(`agent-${name}-api-key`) ?? ''
      if (agentApiKey) {
        apiKeyEnv = `export ANTHROPIC_API_KEY="${agentApiKey}" && `
      }
    }
    // Apply security profile: write allow/deny list into settings.json, and
    // skip the dangerously-skip-permissions flag for strict profiles so
    // Claude Code enforces the list rather than bypassing it.
    // Role-derived applier-pool: an explicit non-default profile wins, else a
    // `leader` (tech-lead) -> 'applier' (Supabase retained), everyone else ->
    // 'default' (deny-by-default). Keeps a fresh install's tech-lead an applier
    // without hardcoding agent names.
    const profile = loadProfileTemplate(resolveAgentSecurityProfile(name))
    writeAgentSettingsFromProfile(name, profile)
    ensureFleetRosterSection(name)
    ensureAutonomySection(name)
    // A sub-agent must load ONLY its own channel plugin. The user-scope
    // enabledPlugins would otherwise make EVERY sub-agent spawn a telegram
    // (and slack/discord) poller that falls back to the main agent's bot
    // token and fights it over the same getUpdates slot (409 Conflict /
    // orphan-poller churn / recurring MCP disconnects). Scope the agent's
    // settings.json so exactly its configured provider stays enabled and the
    // other channel plugins are forced off; a channel-less agent disables all
    // three. Applies to channel-HAVING sub-agents too (e.g. a slack agent must
    // not also run a telegram poller). Re-applied on EVERY spawn because
    // writeAgentSettingsFromProfile() above regenerates settings.json from the
    // profile template -- so this survives respawns, unlike a one-off manual
    // per-agent override (which a respawn silently wiped). The main agent runs
    // via channels.sh, not this path, so it remains the sole telegram poller.
    //
    // CATASTROPHE GUARD: never scope the MAIN agent's plugins here. marveen is
    // not in agents/ (so listAgentNames never spawns it through this path) and
    // its channel comes up via channels.sh -- but if a future caller ever passed
    // MAIN_AGENT_ID in, scopeChannelPlugins(null) would DISABLE the owner's
    // telegram channel (Szabi's primary line). Refuse outright.
    //
    // Telegram agents use a per-agent .mcp.json to spawn their own bun process
    // instead of the shared --channels flag path. The --channels path goes
    // through the plugin's .in_use/<pid> lock: if one process already holds the
    // lock, every other agent that starts with --channels gets "already in use"
    // and ends up with No MCP servers configured -- no bun, no bot.pid, deaf to
    // inbound Telegram. The mcp.json path bypasses the lock: Claude Code spawns a
    // fresh bun stdio server per agent, each with its own TELEGRAM_STATE_DIR. The
    // stdio tee wrapper restores inbound delivery by persisting notifications to a
    // local inbox that the UserPromptSubmit drain hook pulls into context.
    //
    // OPT-IN / DEFAULT OFF (SUBAGENT_INBOX_TEE). This mcp.json+tee swap is a
    // delivery-path change: it writes inbound message content to a local inbox
    // file for the drain hook to pull. With the flag off, telegram sub-agents
    // keep the upstream `--channels` path unchanged and nothing is written to
    // disk. Only opt in together with the channel-inbox-drain hook + (optionally)
    // SUBAGENT_TELEGRAM_WAKE_ENABLED.
    let useMcpJsonForChannel = false
    if (SUBAGENT_INBOX_TEE && hasChannel && agentProvider === 'telegram' && name !== MAIN_AGENT_ID) {
      try {
        const pluginCacheDir = join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram')
        const versions = existsSync(pluginCacheDir)
          ? readdirSync(pluginCacheDir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort().reverse()
          : []
        const pluginVersion = versions[0] ?? '0.0.6'
        const pluginDir = join(pluginCacheDir, pluginVersion)
        const bunBin = join(homedir(), '.bun', 'bin', 'bun')
        // The agent working-dir .mcp.json (NOT .claude/mcp.json) is what Claude Code
        // loads as project-scope MCP config. An empty .mcp.json already present would
        // override .claude/mcp.json, so write to the same file Claude Code reads.
        const mcpJsonPath = join(agentDir(name), '.mcp.json')
        const mcpConfig = {
          mcpServers: {
            'plugin:telegram:telegram': buildTelegramMcpServerConfig(bunBin, pluginDir, agentChannelDir),
          },
        }
        writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2))
        useMcpJsonForChannel = true
        logger.info({ name, pluginVersion, pluginDir }, 'Wrote per-agent mcp.json for telegram plugin')
      } catch (err) {
        logger.warn({ err, name }, 'Could not write mcp.json for telegram agent; falling back to --channels flag')
      }
    }

    if (name !== MAIN_AGENT_ID) {
      const settingsPath = join(agentDir(name), '.claude', 'settings.json')
      try {
        const s = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        // When mcp.json is used for the telegram plugin, force enabledPlugins.telegram
        // to false so Claude Code does not ALSO load the plugin via the marketplace
        // enabledPlugins path -- that would spawn a second bun process and produce
        // 409 Conflict / poller races. When --channels is still used (non-telegram
        // providers or mcp.json write failure), keep the original token-gated logic.
        const scopeProvider = useMcpJsonForChannel
          ? null
          : ownChannelProviderForScope(!!token, agentProvider)
        s.enabledPlugins = scopeChannelPlugins(
          scopeProvider,
          s.enabledPlugins as Record<string, boolean> | undefined,
        )
        writeFileSync(settingsPath, JSON.stringify(s, null, 2))
      } catch (err) {
        logger.warn({ err, name }, 'Could not scope channel plugins for sub-agent')
      }
    }
    const skipFlag = profile.permissionMode === 'strict' ? '' : '--dangerously-skip-permissions '
    // Optional per-agent CLAUDE_CONFIG_DIR (alternate Claude Code config dir,
    // e.g. for routing this agent to a separate Anthropic login). When the
    // agent-config field is missing or blank, claudeConfigDir is null and we
    // emit no export, preserving the default Claude Code behavior.
    // An explicit per-agent config dir wins. Otherwise, a channel sub-agent gets
    // an auto-provisioned isolated config dir so its plugin install cannot collide
    // with the rest of the fleet in the shared ~/.claude (see
    // ensureIsolatedChannelConfigDir). The main agent comes up via channels.sh and
    // keeps the shared root. Isolation is GATED on the fleet OAuth token: the
    // isolated dir carries no .credentials.json, so without CLAUDE_CODE_OAUTH_TOKEN
    // the sub-agent would launch logged-out -- so when the token is absent we skip
    // isolation and keep the shared ~/.claude (the pre-isolation, still-stable
    // behaviour) rather than break auth.
    // Named plan wins over the raw per-agent claudeConfigDir; both are opt-in,
    // so with neither set this is exactly the prior behaviour. The plan's
    // configDir is already launcher-validated (claude-plans.ts reuses
    // expandAndValidateConfigDir). NOTE: this covers regular agents only; the
    // main agent still launches via channels.sh (separate, gated follow-up).
    const planResolution = resolveAgentConfigDir(name)
    if (planResolution.planUnresolved) {
      // The agent has a claudePlan set but it no longer resolves (registry
      // entry removed/renamed). Do NOT silently boot on the host login --
      // surface it. The channelsAllowed enforcement guardrail is a separate
      // gated follow-up; this is just the visibility floor.
      logger.warn(
        { name, plan: readAgentClaudePlan(name) },
        'claude-plan: configured plan id does not resolve in store/claude-plans.json; falling back to raw config-dir / default login',
      )
    }
    let claudeConfigDir = planResolution.configDir
    let oauthTokenEnv = ''
    // Shared-home agents (no isolated config dir) authenticate from the rotating
    // ~/.claude/.credentials.json by default. If the operator has a long-lived
    // fleet setup-token, export it so EVERY locally launched agent uses the
    // stable token instead -- this is what makes the Linux credentials-guard
    // rename safe (a shared sub-agent with no env token would otherwise be
    // locked out once credentials.json is moved aside). No-op without a token.
    if (!claudeConfigDir && hasFleetOauthToken()) {
      oauthTokenEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')" && `
    }
    // Isolation must also cover CHANNEL-LESS Claude-OAuth agents, not just
    // channel ones. A shared-root agent authenticates from the ROTATING shared
    // credential (macOS Keychain entry / .credentials.json), which Claude Code
    // prefers over an otherwise-valid CLAUDE_CODE_OAUTH_TOKEN env var (see the
    // ensureMainAgentIsolatedConfigDir header) -- so when that credential
    // rotates or expires, the agent parks on a 401 even though the fleet token
    // exported right next to it is fine (dani/geri recurring outage,
    // 2026-07-25). Only agents that never touch Anthropic OAuth stay on the
    // shared root: local/BYO-endpoint models (Ollama/DeepSeek/OpenRouter) and
    // per-agent API-key (authMode 'api') agents.
    const needsFleetOauth = isClaude && authMode !== 'api'
    if (!claudeConfigDir && (hasChannel || needsFleetOauth) && name !== MAIN_AGENT_ID) {
      if (hasFleetOauthToken()) {
        // Token present -> isolation works; any earlier degradation is resolved,
        // so re-arm the one-shot alert for a future token loss.
        resetSharedConfigCollisionAlert()
        // A channel-less agent provisions with a null provider so its isolated
        // settings.json disables EVERY channel plugin -- it has no bot token,
        // so a loaded plugin could only fight the fleet over poller slots.
        const isolated = ensureIsolatedChannelConfigDir(name, hasChannel ? agentProvider : null)
        if (isolated) {
          claudeConfigDir = isolated
          // Read the token at launch via $(cat) so the literal secret never
          // appears in the JS-built command string or in `ps`. The file is 0600
          // and the value lands only in this process's own environment.
          oauthTokenEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')" && `
        }
      } else {
        logger.warn({ name }, 'isolated-config: no fleet OAuth token (store/.claude-oauth-token); keeping shared ~/.claude. Run `claude setup-token` and store it to enable per-agent isolation.')
        // H1: the WARN above is silent. With >1 channel sub-agent sharing
        // ~/.claude this is an active plugin-slot collision -> raise a loud
        // alert. Channel-less agents cannot contend for a plugin slot, so they
        // only get the WARN.
        if (hasChannel) maybeAlertSharedConfigCollision(name)
      }
    }
    // Per-project trust pre-seed in the config root this session will ACTUALLY
    // use (isolated CLAUDE_CONFIG_DIR when set, shared ~/.claude.json
    // otherwise). Without it a fresh install's first launch of each agent
    // parks on the "Do you trust the files in this folder?" dialog -- see
    // stampProjectTrustForDir.
    stampProjectTrustForDir(
      claudeConfigDir ? join(claudeConfigDir, '.claude.json') : join(homedir(), '.claude.json'),
      dir,
    )
    // Same target file: pre-acknowledge the Fable usage-credit consent so the
    // model-switch dialog (default: Sonnet) never renders -- see
    // stampFableOverageConsent for the drift root-cause chain.
    stampFableOverageConsent(
      claudeConfigDir ? join(claudeConfigDir, '.claude.json') : join(homedir(), '.claude.json'),
    )
    const claudeConfigEnv = claudeConfigDir ? `export CLAUDE_CONFIG_DIR="${claudeConfigDir}" && ` : ''
    // `--continue` requires an existing session; on a brand-new agent the
    // Claude Code projects directory does not yet exist and `claude` exits
    // immediately with an obscure "No deferred tool marker found" error
    // that is silent inside tmux. Detect first launch by probing for the
    // encoded project dir and skip `--continue` only then. The encoding
    // mirrors Claude Code's own scheme: replace every `/` with `-`.
    const projectsRoot = claudeConfigDir
      ? join(claudeConfigDir, 'projects')
      : join(homedir(), '.claude', 'projects')
    const encodedProject = dir.replace(/\//g, '-')
    const hasPriorSession = existsSync(join(projectsRoot, encodedProject))
    // opts.fresh forces a brand-new conversation (auto-restart 'fresh' mode):
    // omit --continue so the heavy accumulated context is dropped. Without it
    // we resume the prior session (the 'continue' mode / normal restart).
    //
    // CC 2.1.193 REGRESSION: a `--continue` resume does NOT re-initialise the
    // `--channels` plugin MCP server -- the agent comes up with the plugin
    // absent from /mcp, no bun poller, no bot.pid -> permanently deaf on its
    // channel. A FRESH launch loads the plugin correctly. So channel-having
    // agents are ALWAYS launched fresh: the lost conversation context is the
    // price of a reachable bot (file/db memory persists either way). Channel-
    // less agents keep --continue to preserve their accumulated context.
    const continueFlag = (hasPriorSession && !opts.fresh && !hasChannel) ? '--continue ' : ''
    const stateEnvVar = agentProvider === 'slack' ? 'SLACK_STATE_DIR' : agentProvider === 'discord' ? 'DISCORD_STATE_DIR' : agentProvider === 'googlechat' ? 'GOOGLECHAT_STATE_DIR' : agentProvider === 'teams' ? 'TEAMS_STATE_DIR' : 'TELEGRAM_STATE_DIR'
    const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
    // Slack plugin is third-party; its "not on approved allowlist" check is
    // bypassed via `allowedChannelPlugins` in /Library/Application Support/ClaudeCode/managed-settings.json.
    const auditLogEnv = agentProvider === 'slack' ? ` && export SLACK_AUDIT_LOG="${agentChannelDir}/audit.jsonl"` : ''
    const channelSetup = hasChannel
      ? `export ${stateEnvVar}="${agentChannelDir}"${auditLogEnv} && `
      : ''
    // When the per-agent mcp.json+tee path is active (SUBAGENT_INBOX_TEE), the
    // plugin is already loaded as a plain MCP server, so ALSO passing --channels
    // would register the plugin a SECOND way -- a duplicate poller racing the tee
    // process over the same getUpdates slot. Suppress --channels in that case and
    // rely solely on mcp.json (enabledPlugins is already forced false above for
    // the same reason). Every other agent (non-telegram, main, or flag off) keeps
    // the --channels launch path unchanged.
    const channelFlag = hasChannel && !useMcpJsonForChannel ? `--channels plugin:${provider.pluginId}` : ''
    // Channel-plugin MCP-registration guard (2026-06-23): the telegram/slack/etc.
    // channel plugin registers as a stdio MCP server loaded via --channels. Claude
    // Code connects stdio MCP servers in batches of MCP_SERVER_CONNECTION_BATCH_SIZE
    // (default 3); when an agent ALSO runs a slow local .mcp.json stdio server
    // (e.g. google-workspace/workspace-mcp, which spends seconds on OAuth + Google
    // API init) plus many claude.ai connectors, the channel plugin gets starved
    // out of the startup batch / hits MCP_TIMEOUT and never registers -- no /mcp
    // entry, no bun poller, dead bot (observed: balazsmarveenja with workspace-mcp
    // had NO telegram; removing workspace-mcp restored it). Raise the stdio batch
    // size and per-server timeout, and force non-blocking startup, so a slow local
    // MCP can never crowd the channel plugin out of registration. Only set for
    // channel-having agents (channel-less agents have no plugin to protect).
    const mcpEnv = hasChannel
      ? 'export MCP_SERVER_CONNECTION_BATCH_SIZE=10 && export MCP_CONNECTION_NONBLOCKING=1 && export MCP_TIMEOUT=60000 && '
      : ''
    // Disable Claude Code's history-based prompt suggestions -- the DIM (ANSI
    // SGR-2 faint) ghost-text of a previous prompt that Claude shows in an empty
    // input box. The stuck-input recovery scrapes the pane with `capture-pane -p`
    // (no colour), so it cannot tell a dim ghost suggestion apart from REAL
    // parked input and re-submits the suggestion as a command. That is the root
    // of the 2026-06-26 phantom-injection incident: a stale "Sztornózd" ghost was
    // re-submitted and cancelled a live invoice; an earlier ghost emailed a family
    // member. Killing the suggestion at the source removes the ghost the recovery
    // misreads. Env var verified present in claude.exe (CLAUDE_CODE_ENABLE_*).
    const promptSuggestionEnv = 'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false && '
    // shSingleQuote(model) (card b7fa5281): the model is POSIX single-quote ESCAPED, which both keeps
    // values like `claude-opus-4-8[1m]` (1M-context suffix) from being glob-expanded AND makes a `'`
    // in the value inert rather than a quote-break -> command injection. Same escape at the three
    // ANTHROPIC_MODEL env sites above.
    const cmd = `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && ${promptSuggestionEnv}${mcpEnv}${channelSetup}${apiKeyEnv}${claudeConfigEnv}${oauthTokenEnv}${providerEnv}cd "${dir}" && ${claudeBin()} ${continueFlag}${skipFlag}--model ${shSingleQuote(model)} ${channelFlag}`.trimEnd()
    runTmux(null, ['new-session', '-d', '-s', session, cmd], { timeout: 10000 })

    logger.info({ name, session, channelDir: agentChannelDir }, 'Agent tmux session started')

    // After a restart with --continue, a session that's been idle for >24h
    // shows the "Resume from summary" modal before the prompt input is ready
    // (113.6k tokens at 2d age in observed cases). Until the operator either
    // sends a new prompt or dismisses the modal, every scheduled task and
    // every inter-agent message stalls because isSessionReadyForPrompt sees
    // a non-idle pane state. The pre-flight dismiss baked into
    // sendPromptToSession only fires on outgoing traffic -- so on a fresh
    // restart with no inbound, the modal can sit indefinitely.
    //
    // Fire a delayed dismiss after Claude Code has had time to render the
    // modal. 8 seconds is a comfortable margin in observed restarts (modal
    // typically appears within 4-6s). Survey-rating modals from prior
    // sessions can also be present, so dismiss both. Errors are swallowed
    // -- the outbound pre-flight remains the safety net if this misses.
    // Fire-and-forget: scheduleIdentitySetup only schedules delayed timers;
    // startAgentProcess stays synchronous (out of scope, per the conversion rules).
    void scheduleIdentitySetup(session, readAgentDisplayName(name))

    // Colleague auto-unlock (2026-06-22): mirror the main session's
    // post-respawn unlock probe for channel-having sub-agents. After a restart
    // the bun channel poller sometimes never attaches during the cold-start
    // window (observed fleet-wide after a managed restart: the TUI comes up but
    // bot.pid stays empty, so the agent goes deaf to inbound). The main session
    // self-heals because channel-monitor schedules schedulePluginUnlockAfterRespawn;
    // sub-agents had no such probe and stayed stuck until a manual /mcp kick.
    // Schedule the same probe here. It is gated on bun-absence (a healthy poller
    // is left untouched) and on an idle pane, so it never disturbs a colleague
    // mid-turn. Channel-less agents (hasChannel false) get no probe; MAIN never
    // takes this path (it comes up via channels.sh) but guard defensively.
    if (hasChannel && name !== MAIN_AGENT_ID) {
      schedulePluginUnlockAfterRespawn(session, provider.type)
    }

    return { ok: true }
  } catch (err) {
    logger.error({ err, name }, 'Failed to start agent tmux session')
    return { ok: false, error: 'internal_error', hint: 'Failed to start tmux session' }
  }
}

export function stopAgentProcess(name: string): { ok: boolean; error?: string; hint?: string } {
  const session = agentSessionName(name)
  if (!isAgentRunning(name)) return { ok: false, error: 'conflict', hint: 'agent is not running, nothing to stop' }

  const host = readAgentRemoteHost(name)

  try {
    runTmux(host, ['kill-session', '-t', session], { timeout: 5000 })
    execSync('sleep 2', { timeout: 4000 })
    // Reap any orphaned plugin grandchild that tmux did not tear down. This is
    // a LOCAL pkill against this host's process table, so it only makes sense
    // for local agents; a remote agent is channel-less and its processes live
    // on the laptop, so skip it.
    if (!host) {
      try {
        const agentProvider = resolveAgentProvider(name)
        const dir = agentDir(name)
        reapChannelOrphans(agentProvider, dir)
      } catch (err) {
        logger.warn({ err, name }, 'post-stop channel-poller reap failed')
      }
    }
    logger.info({ name, session, host }, 'Agent tmux session stopped')
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, session, host }, 'Failed to stop agent tmux session')
    return { ok: false, error: 'internal_error', hint: 'Failed to stop tmux session' }
  }
}

export function getAgentProcessInfo(name: string): { running: boolean; session?: string } {
  const running = isAgentRunning(name)
  if (!running) return { running: false }
  return {
    running: true,
    session: agentSessionName(name),
  }
}

export function restartAgentProcess(name: string, opts: { fresh?: boolean } = {}): { ok: boolean; pid?: number; error?: string; hint?: string } {
  if (isAgentRunning(name)) {
    const stopResult = stopAgentProcess(name)
    if (!stopResult.ok) return { ok: false, error: stopResult.error ?? 'internal_error', hint: stopResult.hint || 'Failed to stop running agent before restart' }
  }
  return startAgentProcess(name, opts)
}

// Claude Code occasionally pops a "How is Claude doing this session? (optional)"
// rating modal above the prompt input. The footer line still reads
// "bypass permissions on (shift+tab to cycle)" so detectPaneState() classifies
// the pane as idle, but the modal swallows the next keystroke and pinches off
// every scheduled prompt + agent message until a human dismisses it. We strip
// it pre-flight by sending "0" (Dismiss) when the marker is visible, so any
// caller writing a prompt has a clear input field.
