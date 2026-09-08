// Split from the former monolithic src/web/agent-process.ts (775).

import { getProviderType, type ChannelProviderType } from '../channel-provider.js'
import { CHANNEL_PROVIDER, MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { CHANNEL_PLUGIN_IDS } from './plugin-ids.js'
export { CHANNEL_PLUGIN_IDS }
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dismissModelConsentDialogIfPresent } from './agent-process-identity.js'
import { agentHasChannel, agentRunState, sendPromptToSession } from './agent-process-session.js'
import { startAgentProcess } from './agent-process-spawn.js'

export function scopeChannelPlugins(
  explicitProvider: string | null,
  existing?: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...(existing ?? {}) }
  const ownPlugin = explicitProvider ? CHANNEL_PLUGIN_IDS[explicitProvider as keyof typeof CHANNEL_PLUGIN_IDS] : undefined
  for (const pid of Object.values(CHANNEL_PLUGIN_IDS)) {
    out[pid] = pid === ownPlugin
  }
  return out
}

// Pure: which channel provider a sub-agent should ENABLE the plugin for at spawn.
// The enable decision MUST match the --channels launch gate, which is the
// presence of a REAL own bot token in the agent's own channel .env (hasOwnToken).
// Spawn-time scoping originally keyed enabledPlugins on the EXPLICIT channelProvider
// config field, but that field is null for every sub-agent (none set it) -- so a
// sub-agent with a genuine own token still got its plugin forced off: --channels
// loaded it, yet enabledPlugins:false made Claude Code refuse to register it (no
// MCP entry, no bun poller, no bot.pid -> dead bot after any respawn). Gating on
// the own token keeps the dup-poller intent: a channel-less agent (no own token,
// only the legacy/global-token fallback that still marks hasChannel) returns null,
// so scopeChannelPlugins(null) disables all three and it never fights the main
// agent over the shared getUpdates slot.
export function ownChannelProviderForScope(
  hasOwnToken: boolean,
  resolvedProvider: string | null,
): string | null {
  return hasOwnToken && resolvedProvider ? resolvedProvider : null
}

// Wrap the telegram plugin's bun stdio server in a tee that persists each
// inbound channel notification to <stateDir>/inbox-pending.jsonl, which the
// channel-inbox-drain UserPromptSubmit hook then pulls into the next turn.
// Sub-agents load the plugin as a plain MCP server, so Claude Code drops its
// channel notifications; this tee is what makes SUBAGENT_TELEGRAM_WAKE_ENABLED
// have an inbox to wake on.
export function buildTelegramMcpServerConfig(bunBin: string, pluginDir: string, stateDir: string) {
  const wrapper = join(PROJECT_ROOT, 'scripts', 'channel-inbound-tee.mjs')
  return {
    command: 'node',
    args: [wrapper, bunBin, 'run', '--cwd', pluginDir, '--shell=bun', '--silent', 'start'],
    env: { TELEGRAM_STATE_DIR: stateDir },
  }
}

// The fleet's shared long-lived OAuth token (from `claude setup-token`), stored
// 0600 in store/. Isolated channel sub-agents authenticate via this token in the
// CLAUDE_CODE_OAUTH_TOKEN env var -- NOT via a copied/symlinked .credentials.json.
// See ensureIsolatedChannelConfigDir for why.
export const FLEET_OAUTH_TOKEN_PATH = join(STORE_DIR, '.claude-oauth-token')

// True when the fleet OAuth token file exists and is non-empty. Provisioning an
// isolated config dir WITHOUT auth would launch the sub-agent logged-out, so
// isolation is gated on this: no token -> keep the shared ~/.claude (degraded
// dup-poller risk, but never a broken login).
export function hasFleetOauthToken(): boolean {
  try {
    return existsSync(FLEET_OAUTH_TOKEN_PATH) && readFileSync(FLEET_OAUTH_TOKEN_PATH, 'utf-8').trim().length > 0
  } catch {
    return false
  }
}

// H1 silent-degradation hardening (2026-06-30, refined 2026-07-10).
//
// When the fleet OAuth token is absent, channel sub-agents skip isolation and
// fall back to the SHARED ~/.claude (the pre-isolation behaviour, gated in
// startAgentProcess). ONE channel sub-agent on the shared dir is harmless -- it
// owns the single plugin-install slot and poller. The collision the alert
// guards against needs TWO OR MORE agents actually contending for the SAME
// provider's plugin slot at the same time (only one registers its plugin, the
// rest go deaf -- see ensureIsolatedChannelConfigDir).
//
// 2026-07-10 refinement -- the original check over-triggered ("cried wolf"):
//   - It counted CONFIGURED channel sub-agents. An agent that is not running
//     cannot contend for anything: 6 configured / 2 running must not read as
//     a 6-way collision.
//   - It counted across providers. Plugin installs are keyed per plugin id
//     (telegram/slack/teams/... are separate slots in installed_plugins.json),
//     so a running Teams agent never collides with running Telegram agents.
//   - On macOS the collision does not manifest (verified empirically
//     2026-07-10 on the origin host: three concurrent telegram pollers --
//     main + two sub-agents, distinct own tokens, a live `bun server.ts`
//     each, all on the shared ~/.claude while the installed_plugins.json
//     telegram slot pointed at a THIRD agent's projectPath). Channel agents
//     always launch fresh with an explicit --channels plugin:<id> flag, which
//     loads the plugin regardless of the project-scoped install slot; and
//     macOS auth lives in the Keychain, so the Linux credentials-refresh
//     motive for isolation does not apply either. The guard is
//     process.platform-based -- nothing host-specific is baked into this
//     distribution artifact. On Linux/other the alert stays: the shared-config
//     multi-bot eviction remains the documented failure mode there and has
//     not been empirically cleared. If a real macOS collision is ever
//     observed again, drop the darwin early-return.
//
// The decision stays pure (token, same-provider contender count, platform) so
// it is unit-tested without I/O, mirroring shouldSendDeferAlert. Token PRESENT
// -> isolation works -> never alerts, regardless of agent count.
export function shouldAlertSharedConfigCollision(
  hasToken: boolean,
  sameProviderContenderCount: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'darwin') return false
  return !hasToken && sameProviderContenderCount > 1
}

// Pure: the largest number of channel sub-agents contending for a single
// provider's plugin slot. Only RUNNING agents with a channel of their own
// count; agents on different providers occupy different slots and never
// collide with each other.
export function maxSameProviderContenders(
  agents: Array<{ provider: string; running: boolean; hasChannel: boolean }>,
): number {
  const counts = new Map<string, number>()
  for (const a of agents) {
    if (!a.running || !a.hasChannel) continue
    counts.set(a.provider, (counts.get(a.provider) ?? 0) + 1)
  }
  return counts.size ? Math.max(...counts.values()) : 0
}

// Same-provider contender count for the fleet (main agent excluded -- it comes
// up via channels.sh and keeps the shared root by design). Uses the same
// own-token signal as the launch path. `startingName` is the agent being
// spawned right now: its tmux session does not exist yet at alert time, so it
// is treated as running -- otherwise the very launch that completes a real
// collision would never see itself in the count.
export function countSameProviderChannelContenders(startingName: string): number {
  return maxSameProviderContenders(
    listAgentNames()
      .filter((n) => n !== MAIN_AGENT_ID)
      .map((n) => ({
        provider: resolveAgentProvider(n),
        running: n === startingName || agentRunState(n) === 'running',
        hasChannel: agentHasChannel(n),
      })),
  )
}

// One operator alert per degradation episode: spamming on every spawn would
// bury the signal. Cleared the moment the token reappears (isolation restored),
// so a later token-loss re-alerts. Process-local, like defer-alert's dedup set.
let sharedConfigCollisionAlerted = false

export function resetSharedConfigCollisionAlert(): void {
  sharedConfigCollisionAlerted = false
}

// Loud, owner-facing alert routed via notifyChannel (direct Bot API POST from
// the dashboard process) -- NOT an inter-agent relay, which would itself need a
// healthy channel agent to deliver. No-op unless the token is absent AND >1
// RUNNING same-provider channel sub-agent would share ~/.claude (and never on
// macOS -- see shouldAlertSharedConfigCollision).
export function maybeAlertSharedConfigCollision(name: string): void {
  const count = countSameProviderChannelContenders(name)
  if (!shouldAlertSharedConfigCollision(false, count) || sharedConfigCollisionAlerted) return
  sharedConfigCollisionAlerted = true
  logger.error(
    { name, sameProviderContenders: count },
    'isolated-config: fleet OAuth token missing with multiple RUNNING same-provider channel sub-agents -- shared ~/.claude plugin-slot collision, bots may go deaf',
  )
  void notifyChannel(
    `⚠️ Flotta-figyelmeztetes: hianyzik a fleet OAuth token (store/.claude-oauth-token), es ${count} AZONOS csatorna-providerü sub-agent fut egyszerre. Izolacio nelkul mind a kozos ~/.claude-ot hasznalja, igy a plugin-slot utkozhet es bot nemulhat el. Javitas: futtasd a \`claude setup-token\`-t, mentsd a store/.claude-oauth-token fajlba, majd inditsd ujra az agenseket.`,
  ).catch(() => { /* notifyChannel logs internally */ })
}

// Per-agent isolated CLAUDE_CONFIG_DIR provisioning (2026-06-26 fleet outage).
//
// Claude Code records a plugin's PROJECT-scoped install in a single shared file
// -- ~/.claude/plugins/installed_plugins.json -- keyed by ONE projectPath per
// plugin id. Every sub-agent ran out of the SAME ~/.claude, so each agent launch
// (claude --channels plugin:telegram@...) rewrote that single slot to its OWN
// project, evicting whichever agent registered before it. Net effect: only ONE
// agent's channel plugin could be registered (one bun getUpdates poller / one
// bot.pid) fleet-wide; every other agent saw "No MCP servers configured", spawned
// no poller, and went deaf. Sequentialising restarts did NOT help (the slot is
// shared state, not a startup race); the only structural fix is to stop the
// agents sharing one plugin-install file.
//
// This gives each channel sub-agent its own CLAUDE_CONFIG_DIR: symlink every
// top-level ~/.claude entry so project transcripts and plugin marketplaces stay
// shared, EXCEPT settings.json and plugins/ which become per-agent (so each
// agent's project-scoped install lives in its own installed_plugins.json and can
// never evict another's).
//
// AUTH (2026-06-28, addressing Szotasz's #459 review): we DELIBERATELY do NOT
// symlink or copy .credentials.json. On Linux/Windows Claude Code refreshes the
// OAuth token atomically (temp file + rename), which would replace a symlink with
// a standalone file -- the isolated agent's token then diverges from the shared
// one, and because OAuth refresh tokens are single-use, concurrent refreshes from
// multiple isolated dirs race and break the shared login (confirmed: claude-code
// issues #27933, #24317, #43392). Instead the launcher passes a long-lived
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, ~1y, no refresh) via env.
// With that env var present Claude Code authenticates from it and writes NO
// .credentials.json into the config dir -- so there is nothing to diverge and no
// refresh race. .credentials.json is therefore in the skip set below.
//
// Idempotent and best-effort: returns the dir on success, or null so the caller
// falls back to the shared ~/.claude (degraded, but never a launch failure).
const ISOLATED_CONFIG_SKIP = new Set(['settings.json', 'plugins', '.credentials.json'])

export function ensureIsolatedChannelConfigDir(
  name: string,
  // null = channel-less agent: provision the isolated dir with EVERY channel
  // plugin disabled (scopeChannelPlugins(null)) instead of enabling one.
  providerType: ChannelProviderType | null,
): string | null {
  return provisionIsolatedConfigDir(join(agentDir(name), '.claude-config'), agentDir(name), providerType, name)
}

// The main channels agent (started by scripts/channels.sh, cwd = PROJECT_ROOT)
// normally keeps the shared ~/.claude by design. That means it authenticates
// from whatever on-process credential refreshes that shared root -- the
// ROTATING macOS Keychain OAuth session, or (Linux) the shared
// ~/.claude/.credentials.json, which self-refreshes on its own ~8h cycle --
// either way, a periodic-401 risk: the refresh can hit a transient error and
// never retry, and Claude Code prefers an on-disk .credentials.json over an
// otherwise-valid CLAUDE_CODE_OAUTH_TOKEN env var (claude-credentials-guard.ts),
// so a stale file wins even with a live token sitting right next to it
// (confirmed root cause of the 2026-07-23 marveen-channels silent outage,
// PLAN.md GAP 1). The isolated sub-agents, which authenticate from the
// long-lived fleet setup-token via an isolated CLAUDE_CONFIG_DIR carrying no
// .credentials.json at all, never hit this. This gives the main agent the SAME
// isolated CLAUDE_CONFIG_DIR as the sub-agents so it too authenticates from
// CLAUDE_CODE_OAUTH_TOKEN and never touches a rotating on-disk credential.
//
// Deliberately narrow and OPT-IN (default OFF), so nothing changes for existing
// installs unless the operator turns it on:
//   - any platform -- the provisioning itself (provisionIsolatedConfigDir) is
//     100% filesystem-based and already proven identical on every platform via
//     the sub-agent path; there is no macOS-specific step here. This does NOT
//     touch shouldAlertSharedConfigCollision's darwin early-return (a different,
//     genuinely macOS-specific failure mode: plugin-slot collision).
//   - gated on the MAIN_AGENT_ISOLATED_CONFIG setting via the settings-store, so
//     BOTH the dashboard toggle (config-overrides.json) AND a hand-set .env key
//     take effect (resolution: override > .env > default '0'). channels.sh no
//     longer parses the flag itself -- it always calls the helper and this
//     function is the single gate.
//   - gated on the fleet OAuth token (no token -> no isolation, since the
//     isolated dir carries no .credentials.json -- identical gate to the
//     sub-agent path in startAgentProcess);
//   - returns null (caller keeps the shared root) whenever not applicable.
export function ensureMainAgentIsolatedConfigDir(
  provider?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let enabled = false
  try { enabled = String(getEffectiveSettingValue('MAIN_AGENT_ISOLATED_CONFIG')) === '1' } catch { enabled = false }
  if (!enabled) return null
  if (!hasFleetOauthToken()) return null
  return provisionIsolatedConfigDir(
    join(PROJECT_ROOT, '.channels-config'),
    PROJECT_ROOT,
    getProviderType(provider),
    MAIN_AGENT_ID,
  )
}

// An EXPLICIT config dir for the main channels agent (MAIN_AGENT_CONFIG_DIR),
// for the operator who already keeps a separate Claude login for the main bot --
// e.g. a personal subscription for the bot and a different one for the fleet.
// The isolated-config path above cannot serve that case: it provisions a dir with
// NO .credentials.json and authenticates from the fleet setup-token, so the main
// agent necessarily shares the fleet's identity, and it is a hard no-op without
// that token. Pointing CLAUDE_CONFIG_DIR at an existing, separately logged-in dir
// is the only way to keep the two identities apart.
//
// Fails closed: unset -> null (shared ~/.claude, unchanged default); set but
// missing on disk -> null + a warn, because silently falling back to the shared
// root with the WRONG identity is how a bot ends up authenticated as the fleet.
// Takes precedence over MAIN_AGENT_ISOLATED_CONFIG: an explicit dir is a
// deliberate choice, and the two cannot both own CLAUDE_CONFIG_DIR.
export function resolveMainAgentConfigDir(): string | null {
  let raw = ''
  try { raw = String(getEffectiveSettingValue('MAIN_AGENT_CONFIG_DIR') ?? '').trim() } catch { return null }
  if (!raw) return null
  const dir = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  if (!existsSync(dir)) {
    logger.warn({ dir }, 'main-agent config dir: MAIN_AGENT_CONFIG_DIR does not exist, keeping the shared ~/.claude')
    return null
  }
  return dir
}

// Shared provisioning core for BOTH the sub-agents (ensureIsolatedChannelConfigDir)
// and the main agent (ensureMainAgentIsolatedConfigDir) -- one code path so the
// two can never diverge. `cfg` is the isolated CLAUDE_CONFIG_DIR to create; `cwd`
// is the agent's project dir stamped into its own installed_plugins.json; `name`
// is used for logs only.
// Write JSON through a temp file + rename, so a Claude Code process reading
// the file concurrently sees either the old content or the new one, never a
// half-written one. The temp name carries the pid so two provisions racing on
// the same dir cannot truncate each other's staging file.
//
// The mode is carried over deliberately. A plain writeFileSync writes THROUGH
// the existing inode and keeps its permissions; tmp + rename replaces the file
// with a NEW inode, which would silently take the umask default and relax an
// 0600 config to 0644. That matters here: some isolated .claude.json files are
// 0600, and their mcpServers entries carry env blocks with credentials -- and
// this reconcile is exactly the path that starts rewriting the file regularly.
// Fall back to 0600 (not the umask) when the target does not exist yet, since
// the content class is the same either way.
function writeJsonAtomic(path: string, value: unknown): void {
  let mode = 0o600
  try { mode = statSync(path).mode & 0o777 } catch { /* new file -> owner-only */ }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode })
  renameSync(tmp, path)
}

// Fill mcpServers gaps in an ALREADY provisioned isolated .claude.json from the
// shared ~/.claude.json.
//
// Why this exists (issue #834): the isolated .claude.json is seeded from a full
// copy of the shared one ONLY on first provision. Every later spawn just makes
// sure hasCompletedOnboarding stays set, so the server list is frozen at its
// first-seed snapshot -- an MCP server added to ~/.claude.json afterwards
// reaches brand-new agents but never an existing one, silently: the agent just
// lacks the tool, with no error anywhere. Rolling one out to a running fleet
// then needs a manual per-agent backfill, and that only fixes the current set.
//
// ADDITIVE ONLY, deliberately. This is a gap-fill, not a two-way sync:
//   - a server missing from the isolated file is copied in,
//   - an entry that already exists is NEVER overwritten -- Claude Code owns its
//     evolved state, and a per-agent scoping decision must survive,
//   - a server removed from the shared config is left in place,
//   - a non-object mcpServers on either side means we do not touch it at all,
//     because we cannot merge what we do not understand.
// Returns true if the caller should persist `cur`.
function reconcileMcpServers(
  cur: Record<string, unknown>,
  sharedDot: string,
  name: string,
): boolean {
  if (!existsSync(sharedDot)) return false
  let shared: Record<string, unknown>
  try { shared = JSON.parse(readFileSync(sharedDot, 'utf-8')) as Record<string, unknown> }
  catch { return false } // unparseable shared config -> leave the isolated one alone
  if (!isPlainObject(shared.mcpServers)) return false
  // An existing but non-object mcpServers is not ours to repair.
  if ('mcpServers' in cur && !isPlainObject(cur.mcpServers)) {
    logger.warn({ name }, 'isolated-config: mcpServers is not an object, skipping reconcile')
    return false
  }
  const own = isPlainObject(cur.mcpServers) ? cur.mcpServers : {}
  const added: string[] = []
  for (const [key, def] of Object.entries(shared.mcpServers)) {
    if (key in own) continue
    own[key] = def
    added.push(key)
  }
  if (added.length === 0) return false
  cur.mcpServers = own
  logger.info({ name, added }, 'isolated-config: added missing MCP servers from the shared config')
  return true
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function provisionIsolatedConfigDir(
  cfg: string,
  cwd: string,
  providerType: ChannelProviderType | null,
  name: string,
): string | null {
  try {
    const realClaude = join(homedir(), '.claude')
    if (!existsSync(realClaude)) return null
    mkdirSync(cfg, { recursive: true })

    // 1. Symlink every top-level ~/.claude entry except the ones we own or that
    //    must stay out of the isolated dir (.credentials.json -- see header). A
    //    stale non-symlink (e.g. a prior copy, or a .credentials.json left by an
    //    earlier build) is removed so it can never shadow the env-var auth.
    for (const entry of readdirSync(realClaude)) {
      if (ISOLATED_CONFIG_SKIP.has(entry)) {
        // Defensively drop a real .credentials.json that an older build may have
        // symlinked/copied here, so the env-var token is the only auth source.
        const stale = join(cfg, entry)
        if (entry === '.credentials.json') {
          try { rmSync(stale, { force: true }) } catch { /* absent */ }
        }
        continue
      }
      const link = join(cfg, entry)
      let needsLink = true
      try {
        if (lstatSync(link).isSymbolicLink()) needsLink = false
        else rmSync(link, { recursive: true, force: true })
      } catch { /* absent -> create */ }
      if (needsLink) {
        try { symlinkSync(join(realClaude, entry), link) }
        catch (err) { logger.warn({ err, entry, name }, 'isolated-config: symlink failed') }
      }
    }

    // 2. Own settings.json: copy the shared one (keeps hooks etc.) but force
    //    enabledPlugins to this agent's own provider only (all other channel
    //    plugins false), matching the spawn-time scope decision.
    const sharedSettings = join(realClaude, 'settings.json')
    let settings: Record<string, unknown> = {}
    if (existsSync(sharedSettings)) {
      try { settings = JSON.parse(readFileSync(sharedSettings, 'utf-8')) as Record<string, unknown> }
      catch { settings = {} }
    }
    const scopedPlugins = scopeChannelPlugins(
      providerType,
      settings.enabledPlugins as Record<string, boolean> | undefined,
    )
    settings.enabledPlugins = scopedPlugins
    // Keys the isolated file already carries that the shared file never
    // mentions must SURVIVE this rewrite. The rewrite runs on every main-agent
    // start, so a straight copy silently drops agent-only configuration. That
    // is how `statusLine` went missing three times (2026-07-28, 07-30, 08-03):
    // it is configured for the main agent alone, the shared file never names
    // it, and the symptom is invisible -- the agent starts fine, it just stops
    // reporting context usage, so nothing alerts.
    //
    // Shared wins on conflict: for every key the shared file DOES define it
    // stays the source of truth (that is the point of the copy). Target-only
    // keys are purely additive, so this cannot resurrect a key the shared file
    // deliberately changed.
    //
    // Scope: this is the shared provisioning core, so the change applies to
    // EVERY isolated config dir -- the main agent's and each sub-agent's alike
    // (ensureIsolatedChannelConfigDir and ensureMainAgentIsolatedConfigDir both
    // land here). There is no pre-existing merge anywhere to be consistent
    // with: before this commit every one of them was a pure copy.
    //
    // enabledPlugins is explicitly never inherited -- it is decided by the
    // scope call above and must not survive from the dir's own older copy.
    const ownSettingsPath = join(cfg, 'settings.json')
    if (existsSync(ownSettingsPath)) {
      try {
        const own = JSON.parse(readFileSync(ownSettingsPath, 'utf-8')) as unknown
        // A JSON array or `null` parses fine but is not a settings object;
        // spreading one would invent numeric keys instead of failing.
        if (isPlainObject(own)) {
          const inherited: string[] = []
          for (const [key, value] of Object.entries(own)) {
            if (key !== 'enabledPlugins' && !(key in settings)) {
              settings[key] = value
              inherited.push(key)
            }
          }
          // Additive merges must not be silent: the whole point of this block
          // is that a key nobody can see is a key nobody can debug. Key NAMES
          // only -- a settings.json may hold secrets, so values never land in
          // the log.
          if (inherited.length) {
            logger.info({ name, path: ownSettingsPath, keys: inherited }, 'isolated-config: kept target-only settings keys')
          }
        }
      } catch (err) {
        // Deliberately loud: rewriting an unparseable own-settings file from
        // the shared one is exactly the silent-loss shape this block fixes.
        logger.warn({ err, name, path: ownSettingsPath }, 'isolated-config: unparseable own settings.json, rewriting from shared')
      }
    }
    // Atomic: the file's CONTENT now depends on reading its own previous
    // content back. A torn write would fail the parse on the next start, the
    // code would fall back to the shared file, and that is precisely the
    // key-loss this commit fixes.
    writeJsonAtomic(ownSettingsPath, settings)

    // 3. Own plugins/ dir: symlink the heavy shared parts, own the install state.
    const pluginsDir = join(cfg, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const sharedPlugins = join(realClaude, 'plugins')
    for (const sub of ['cache', 'marketplaces', 'data']) {
      const link = join(pluginsDir, sub)
      const target = join(sharedPlugins, sub)
      if (!existsSync(target)) continue
      let needsLink = true
      try {
        if (lstatSync(link).isSymbolicLink()) needsLink = false
        else rmSync(link, { recursive: true, force: true })
      } catch { /* absent -> create */ }
      if (needsLink) {
        try { symlinkSync(target, link) }
        catch (err) { logger.warn({ err, sub, name }, 'isolated-config: plugin symlink failed') }
      }
    }
    const sharedKnown = join(sharedPlugins, 'known_marketplaces.json')
    if (existsSync(sharedKnown)) {
      writeFileSync(join(pluginsDir, 'known_marketplaces.json'), readFileSync(sharedKnown, 'utf-8'))
    }
    // Seed installed_plugins.json with every project-scoped install re-pointed at
    // THIS agent's cwd, so the channel plugin is registered for this project from
    // first launch (Claude Code keeps maintaining it thereafter).
    const sharedInstalled = join(sharedPlugins, 'installed_plugins.json')
    if (existsSync(sharedInstalled)) {
      try {
        const inst = JSON.parse(readFileSync(sharedInstalled, 'utf-8')) as {
          plugins?: Record<string, Array<{ scope?: string; projectPath?: string }>>
        }
        for (const entries of Object.values(inst.plugins ?? {})) {
          for (const e of entries) {
            if (e.scope === 'project') e.projectPath = cwd
          }
        }
        writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify(inst, null, 2) + '\n')
      } catch (err) {
        logger.warn({ err, name }, 'isolated-config: failed to seed installed_plugins.json')
      }
    }

    // 4. Seed onboarding/consent state so the FIRST interactive launch of this
    //    fresh CLAUDE_CONFIG_DIR does not drop into Claude Code's first-run
    //    dialogs. A brand-new config dir triggers a CHAIN of interactive prompts
    //    -- "Select login method" (gated on hasCompletedOnboarding) and the
    //    per-project "allow external imports" trust dialog (gated on
    //    projects[cwd].hasTrustDialogAccepted) -- each of which blocks the
    //    channels TUI before it ever authenticates from CLAUDE_CODE_OAUTH_TOKEN
    //    (the env token works headlessly but the interactive pickers bypass it).
    //    Rather than enumerate every flag (the set grows across Claude Code
    //    versions; confirmed on 2.1.195, 2026-06-29 fleet rollout), seed the
    //    isolated .claude.json from a COPY of the already-consented shared
    //    ~/.claude.json on first provision, so every consent flag is inherited.
    //    Only seed when absent -- once Claude Code owns the file we leave its
    //    evolved state alone, just guaranteeing hasCompletedOnboarding stays set.
    try {
      const dotClaude = join(cfg, '.claude.json')
      const sharedDot = join(homedir(), '.claude.json')
      if (!existsSync(dotClaude)) {
        let seed: Record<string, unknown> = { hasCompletedOnboarding: true }
        if (existsSync(sharedDot)) {
          try { seed = JSON.parse(readFileSync(sharedDot, 'utf-8')) as Record<string, unknown> } catch { /* keep minimal */ }
        }
        seed.hasCompletedOnboarding = true
        writeJsonAtomic(dotClaude, seed)
      } else {
        try {
          const cur = JSON.parse(readFileSync(dotClaude, 'utf-8')) as Record<string, unknown>
          let dirty = false
          if (cur.hasCompletedOnboarding !== true) {
            cur.hasCompletedOnboarding = true
            dirty = true
          }
          if (reconcileMcpServers(cur, sharedDot, name)) dirty = true
          if (dirty) writeJsonAtomic(dotClaude, cur)
        } catch { /* unparseable -> leave for Claude Code to recreate */ }
      }
    } catch (err) {
      logger.warn({ err, name }, 'isolated-config: failed to seed onboarding state')
    }

    return cfg
  } catch (err) {
    logger.warn({ err, name }, 'isolated-config: provisioning failed, falling back to shared ~/.claude')
    return null
  }
}

// Guarantee hasCompletedOnboarding in the SHARED ~/.claude.json.
//
// 2026-07-15 bootcamp field incident (root-caused live on the reference VPS):
// the key vanished from ~/.claude.json within ~1h of install despite
// install-linux.sh seeding it, so EVERY fresh (re)spawn of an agent on the
// shared config root parked on Claude Code's first-run "Select login method"
// picker -- looking exactly like a mass /login ejection -- while the on-disk
// credential was valid the whole time (the picker is gated ONLY on this flag;
// even a valid CLAUDE_CODE_OAUTH_TOKEN env does not bypass it, see the
// provisionIsolatedConfigDir comment above). Isolated config dirs already get
// this guarantee at provision time; this closes the same gap for the shared
// root. Called before every main-session respawn and sub-agent launch.
//
// The write is ATOMIC (tmp + rename): a non-atomic rewrite racing a live
// Claude Code process is the leading suspect for how the key got clobbered in
// the first place. An unparseable file is left alone -- Claude Code owns its
// recovery, and overwriting would destroy MCP/project state.
export function ensureSharedClaudeOnboarded(dotClaudePath: string = join(homedir(), '.claude.json')): boolean {
  try {
    if (!existsSync(dotClaudePath)) {
      atomicWriteFileSync(dotClaudePath, JSON.stringify({ hasCompletedOnboarding: true }, null, 2) + '\n', { mode: 0o600 })
      logger.info({ dotClaudePath }, 'shared-config: created ~/.claude.json with hasCompletedOnboarding')
      return true
    }
    const cur = JSON.parse(readFileSync(dotClaudePath, 'utf-8')) as Record<string, unknown>
    if (cur.hasCompletedOnboarding === true) return false
    cur.hasCompletedOnboarding = true
    atomicWriteFileSync(dotClaudePath, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
    logger.warn({ dotClaudePath }, 'shared-config: re-seeded missing hasCompletedOnboarding (prevents the first-run "Select login method" picker)')
    return true
  } catch (err) {
    logger.warn({ err, dotClaudePath }, 'shared-config: could not guarantee hasCompletedOnboarding (unparseable or unwritable ~/.claude.json)')
    return false
  }
}

// Pre-accept the PER-PROJECT first-run consent for an agent's working dir in
// the config root the session will boot from. Claude Code keys the "Do you
// trust the files in this folder?" dialog on projects[<cwd>].hasTrustDialogAccepted
// in <config root>/.claude.json -- a GLOBAL hasCompletedOnboarding does not
// cover it. The main session gets this via the channels.sh startup guard and
// the generation workers stamp it themselves (agent-worker.ts), but a normal
// sub-agent launch never did: on the ORIGIN fleet every agents/<name> dir was
// trusted interactively long ago, so the gap only bites on a FRESH install,
// where every newly created agent parks on the trust dialog forever and its
// scheduled tasks pile up as pending retries (Oligo2000 VPS, 2026-07-22).
//
// Stamps both the given dir and its realpath (macOS /var vs /private/var,
// symlinked homes) since Claude Code keys trust by the resolved path. Write is
// atomic and only performed on actual change, so a live Claude Code process
// racing us never sees a torn file and an already-stamped launch is a no-op.
export function stampProjectTrustForDir(dotClaudePath: string, projectDir: string): boolean {
  try {
    let data: Record<string, unknown> = {}
    if (existsSync(dotClaudePath)) {
      data = JSON.parse(readFileSync(dotClaudePath, 'utf-8')) as Record<string, unknown>
    }
    const dirs = new Set<string>([projectDir])
    try { dirs.add(realpathSync(projectDir)) } catch { /* dir may not resolve yet */ }
    const projects: Record<string, unknown> =
      (data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects))
        ? data.projects as Record<string, unknown>
        : {}
    let changed = false
    if (data.hasCompletedOnboarding !== true) {
      data.hasCompletedOnboarding = true
      changed = true
    }
    for (const dir of dirs) {
      const base = (projects[dir] && typeof projects[dir] === 'object')
        ? projects[dir] as Record<string, unknown>
        : {}
      if (base.hasTrustDialogAccepted === true && base.hasCompletedProjectOnboarding === true) continue
      projects[dir] = {
        ...base,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: Math.max(1, Number(base.projectOnboardingSeenCount) || 0),
      }
      changed = true
    }
    if (!changed) return false
    data.projects = projects
    atomicWriteFileSync(dotClaudePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    logger.info({ dotClaudePath, projectDir }, 'project-trust: stamped folder-trust consent for agent dir')
    return true
  } catch (err) {
    // Unparseable/unwritable file: leave it to Claude Code (same policy as
    // ensureSharedClaudeOnboarded). The scheduler's first-run gate + the
    // channel-monitor's dialog answering remain the runtime backstop.
    logger.warn({ err, dotClaudePath, projectDir }, 'project-trust: could not stamp trust flags (agent may park on the folder-trust dialog)')
    return false
  }
}

// Pre-stamp the Fable overage-consent acknowledgment in a config root's
// .claude.json so the "Fable 5 now uses usage credits" dialog never renders.
//
// Root cause chain (2026-07-23, card b71fc541): a config root without
// fableOverageConsentV2[<orgUuid>] parks the first Fable 5 turn on a TUI
// dialog whose DEFAULT option is "Switch to Sonnet 5 and continue". The
// fleet's own blind Enters (identity /name, sendPromptToSession retry-Enter)
// accept that default, silently switching the session to Sonnet while
// agent-config still says claude-fable-5 -- the long-unexplained
// model/activeModel drift. Fleet policy (owner decision 2026-07-23): the
// fleet stays on Fable 5, so the consent is pre-acknowledged the same way
// onboarding/trust flags already are (see stampProjectTrustForDir above).
//
// Claude Code keys the consent on oauthAccount.organizationUuid (or
// "acct:<accountUuid>" for org-less accounts) in the SAME .claude.json. A
// file without an oauthAccount (brand-new config root that has never
// authenticated) is left alone -- there is nothing to key the consent on;
// the runtime dialog-answer backstop (dismissModelConsentDialogIfPresent)
// covers that first session and this stamp catches up on the next launch.
// Write is atomic and change-only, mirroring ensureSharedClaudeOnboarded.
export function stampFableOverageConsent(dotClaudePath: string): boolean {
  try {
    if (!existsSync(dotClaudePath)) return false
    const data = JSON.parse(readFileSync(dotClaudePath, 'utf-8')) as Record<string, unknown>
    const oauth = (data.oauthAccount && typeof data.oauthAccount === 'object' && !Array.isArray(data.oauthAccount))
      ? data.oauthAccount as Record<string, unknown>
      : null
    const orgUuid = typeof oauth?.organizationUuid === 'string' && oauth.organizationUuid ? oauth.organizationUuid : null
    const acctUuid = typeof oauth?.accountUuid === 'string' && oauth.accountUuid ? oauth.accountUuid : null
    const key = orgUuid ?? (acctUuid ? `acct:${acctUuid}` : null)
    if (!key) return false
    const consent = (data.fableOverageConsentV2 && typeof data.fableOverageConsentV2 === 'object' && !Array.isArray(data.fableOverageConsentV2))
      ? data.fableOverageConsentV2 as Record<string, unknown>
      : {}
    if (consent[key] === true) return false
    data.fableOverageConsentV2 = { ...consent, [key]: true }
    atomicWriteFileSync(dotClaudePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    logger.info({ dotClaudePath }, 'fable-consent: pre-stamped fableOverageConsentV2 (prevents the usage-credit model-switch dialog)')
    return true
  } catch (err) {
    logger.warn({ err, dotClaudePath }, 'fable-consent: could not stamp consent (runtime dialog-answer backstop remains)')
    return false
  }
}

// FABLEFALL1: the per-agent stamp above only runs on the startAgentProcess
// spawn path. The MAIN channels session (spawned by channels.sh / launchd)
// and the interactive workers' shared roots never pass through it, so those
// roots never self-heal -- and the main session is exactly the long-running
// process the menu-recovery keystrokes hit (silent Fable->Sonnet drift,
// measured on 2026-07-28: 5 events, 514 post-fallback Sonnet turns here, 12
// events at a customer). Called at dashboard boot and before every hard
// restart of the channels session. Worker dir resolution mirrors
// agent-worker.ts (env override + fixed default); change-only writes.
export function stampFableOverageConsentSharedRoots(): void {
  const mainDir = ensureMainAgentIsolatedConfigDir()
  const candidates = [
    mainDir ? join(mainDir, '.claude.json') : null,
    join(homedir(), '.claude.json'),
    join(process.env.MARVEEN_WORKER_DIR || join(homedir(), '.marveen-worker'), '.claude-config', '.claude.json'),
    join(process.env.MARVEEN_WORKER_DIR_FAST || join(homedir(), '.marveen-worker-fast'), '.claude-config', '.claude.json'),
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) stampFableOverageConsent(p)
  }
}

export function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord' || perAgent === 'googlechat' || perAgent === 'teams') return perAgent
  return CHANNEL_PROVIDER
}
