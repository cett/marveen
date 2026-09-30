# F02 Configuration

## Overview

Marveen's configuration has three layers. The first matching value wins:

1. **`system_config` database** — editable on the dashboard Settings page; loaded at every startup
2. **`/run/secrets/<KEY>`** — Docker/Kubernetes secret-mount (if present)
3. **`.env` file** — in the install directory, editable by hand

This means a value set on the dashboard cannot be overridden by `.env` — the database always takes priority.

## The .env file

The `.env` file lives in the install directory with `0600` permissions (owner-readable only). It is generated from `.env.example` during installation.

### Required fields

```ini
# Channel type: telegram | slack | discord
CHANNEL_PROVIDER=telegram

# Bot credentials (channel-specific — see F04 Channels)
TELEGRAM_BOT_TOKEN=...
# SLACK_BOT_TOKEN=...
# SLACK_APP_TOKEN=...
# DISCORD_BOT_TOKEN=...

# Owner name (the agent uses this to refer to you)
OWNER_NAME=Your Name

# Paired Telegram chat ID (filled automatically during first pairing)
ALLOWED_CHAT_ID=0
```

### Agent identity

```ini
# Agent display name
BOT_NAME=Marveen

# Product/system name shown in the dashboard (default: BOT_NAME)
# BRAND_NAME=AcmeAI

# Internal agent identifier: tmux session name, database agent_id, API routing
# Generated automatically from BOT_NAME (ASCII slug)
# MAIN_AGENT_ID=marveen

# OS service name (launchd com.<id>.* / systemd <id>-*)
# Default: MAIN_AGENT_ID
# SERVICE_ID=marveen
```

### Claude authentication

The system looks for credentials in five places, in this order (first match wins):

1. `CLAUDE_CODE_OAUTH_TOKEN` in `.env`
2. `ANTHROPIC_API_KEY` in `.env`
3. `~/.claude/.credentials.json` (interactive login, Linux)
4. `store/.claude-oauth-token` (onboarding wizard)
5. macOS Keychain (interactive login, macOS)

```ini
# OAuth token — Pro/Max subscription: run claude setup-token
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Alternative: API key (Anthropic Console, pay-as-you-go)
# ANTHROPIC_API_KEY=sk-ant-...
```

> If authentication is missing, the background services will not start. To add it later: `bash scripts/auth.sh`

### Network and dashboard

```ini
# Dashboard port (default: 3420)
# WEB_PORT=3420

# Dashboard network interface
# 127.0.0.1 = local machine only (default)
# 0.0.0.0  = accessible from the network (DASHBOARD_TOKEN is REQUIRED!)
# WEB_HOST=127.0.0.1

# Platform override (if auto-detection is wrong)
# Valid values: macos | linux-server | linux-gui
# MARVEEN_ENV=linux-server
```

### Model and AI

```ini
# Model for the main agent's channel session
# If unset, falls back to .model in .claude/settings.json
# MAIN_AGENT_MODEL=claude-opus-5

# Ollama URL (for semantic memory search)
# OLLAMA_URL=http://localhost:11434

# Timezone (IANA tz, e.g. Europe/Budapest)
# If unset, the OS timezone is used
# SCHEDULER_TZ=Europe/Budapest
```

### Other optional fields

```ini
# Owner email address (agents use this in <OWNER_EMAIL> placeholders)
# OWNER_EMAIL=your.email@example.com

# Google API key (for some MCP connectors)
# GOOGLE_API_KEY=...

# Artifact HMAC key (optional, rotatable independently of the dashboard Bearer token)
# ARTIFACT_HMAC_SECRET=

# Automatic updates (default: 0 = disabled)
# AUTO_UPDATE_ENABLED=0

# External systems (non-fleet agents) allowed to send via POST /api/messages
# SYSTEM_SENDER_IDS=cortex

# SQL skill system file regeneration (default: on; set 0/false/off/no to disable)
# SKILL_SQL_REGEN=0

# Generated copies of tenant skills in the agents' own skills directories (default: single)
#   single = only agents enabled for exactly ONE tenant; off = tenant skills stay DB-only;
#   all = every enabled agent, including agents shared by several tenants (cross-tenant exposure)
# TENANT_SKILL_FILES=single

# Use-time tenant context (default: 43200 = 12 h, 0 = no age limit)
#   How long an agent's per-prompt tenant context stays valid for the skill gate; after that tenant
#   skills are denied until the next prompt re-resolves the source. Not a binding cache: changing or
#   deleting a binding, disabling the agent or the tenant, or changing the tenant's main agent drops
#   the affected context at once.
# TENANT_CONTEXT_MAX_AGE_SECONDS=43200
```

## Autonomy configuration

Autonomy categories control how much agents can act without human approval. The data lives in the `autonomy_categories` DB table (not an editable JSON file) — you set a category's level on the **dashboard Settings > Autonomy** page, or via `POST /api/autonomy`.

### Levels

| Level | Behavior |
|-------|---------|
| 1 | Notify only — performs the action but sends a notification first |
| 2 | Approval required — waits for human decision before acting |
| 3 | Autonomous — acts immediately, reports afterwards |

### Categories

A category's fields (as returned in the `categories` array of `GET /api/autonomy`):

```json
{
  "key": "email_send",
  "label": "Send / reply to email",
  "level": 1,
  "locked": false,
  "maxLevel": 2
}
```

- `locked: true` — level cannot be raised (safety constraint)
- `maxLevel` — highest level that can be configured
- `timeout_minutes` (DB field, not in the `GET /api/autonomy` response) — approval request timeout in minutes, level 2 only

Agents (per the CLAUDE.md instruction) query a category's current level via `GET /api/autonomy` rather than reading a file — if the dashboard is unreachable, the safe default is level 1 (notify only).

## Model profile map

The `model_profile_map` DB table lets agents use named profiles (`premium_reasoning`, `build_strong`, `analysis_efficient`, `routine_lowcost`) instead of concrete model names. The startup migration (0054) seeds all four profiles with the models the fleet already runs — Phase 1 intent is abstraction, not re-tiering.

Edit it from the dashboard's Settings > Model profiles tab (admin-only), or directly:

```http
GET /api/v1/model-profiles
PATCH /api/v1/model-profiles
{ "profileId": "build_strong", "modelId": "claude-sonnet-5" }
```

- All four profiles are always present — a profile whose entry is missing falls that agent back to the install default model, with an error surfaced
- An agent's explicit `model` field overrides its profile
- Reads are cached for 90 seconds; a PATCH invalidates the cache immediately
- There is no more `store/model-profile-map.json` file or `config-examples/model-profile-map.example.json` template — the old manual-copy install step has been retired

## Vault — secret management

The Vault stores API keys, bot tokens, and other sensitive values encrypted in the database. Secrets never leave the `store/` directory in plaintext.

### Referencing a vault value

Use a `vault:<id>` reference in `.env` or MCP server configuration:

```ini
# In .env
SOME_API_KEY=vault:my-api-key-id
```

The system resolves the reference to the actual value at startup before passing it to the process.

### Vault wrapper scripts

**`scripts/vault-env-wrapper.sh`** — for env-injected secrets. Use as the MCP server `command` when the server expects the secret as an environment variable:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "scripts/vault-env-wrapper.sh",
      "args": ["node", "my-mcp-server.js"],
      "env": {
        "MY_SECRET": "vault:my-secret-id"
      }
    }
  }
}
```

**`scripts/vault-file-materializer.sh`** — for file-based secrets. For MCP servers that expect a credential as a file path. Writes the secret to a private (`0700`) temporary directory at startup, deletes it on shutdown.

**`scripts/vault-inject-http-mcp.sh`** — for HTTP-mode MCP servers. Resolves `vault:<id>` references in `~/.claude.json` `mcpServers.*.headers` fields immediately before Claude Code starts.

### Managing vault entries

Use the dashboard Settings > Vault page to create entries, rotate (replace the value), or revoke. Actual values are not readable back through the dashboard after saving.

## Changing configuration at runtime

Changes to `.env` require restarting the background services:

```bash
# macOS
launchctl stop com.<agent-id>.dashboard
launchctl start com.<agent-id>.dashboard

# Linux
systemctl --user restart marveen-dashboard
```

Changes made on the dashboard Settings page go into the `system_config` database and take effect immediately — no restart needed.

---

*Previous: [F01 Installation](F01-installation.md)*  
*Next: F03 Operations (coming soon)*
