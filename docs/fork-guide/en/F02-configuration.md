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

# SQL skill system file regeneration (default: 0 = disabled)
# SKILL_SQL_REGEN=0
```

## Autonomy configuration

`store/autonomy-config.json` controls how much agents can act without human approval.

### Levels

| Level | Behavior |
|-------|---------|
| 1 | Notify only — performs the action but sends a notification first |
| 2 | Approval required — waits for human decision before acting |
| 3 | Autonomous — acts immediately, reports afterwards |

### Categories

```json
{
  "categories": [
    {
      "key": "kanban_archive_done",
      "label": "Archive done cards older than 7 days",
      "level": 1,
      "locked": false,
      "maxLevel": 3
    },
    {
      "key": "email_send",
      "label": "Send / reply to email",
      "level": 1,
      "locked": false,
      "maxLevel": 2,
      "timeout_minutes": 30
    },
    {
      "key": "data_delete",
      "label": "File / data deletion",
      "level": 1,
      "locked": true,
      "maxLevel": 1
    }
  ]
}
```

- `locked: true` — level cannot be raised (safety constraint)
- `maxLevel` — highest level that can be configured
- `timeout_minutes` — approval request timeout (level 2 only)

The full category list and current levels are also manageable on the dashboard Settings > Autonomy page.

## Model profile map

`store/model-profile-map.json` (template: `config-examples/model-profile-map.example.json`) lets agents use named profiles (`premium_reasoning`, `build_strong`, `analysis_efficient`, `routine_lowcost`) instead of concrete model names.

```json
{
  "version": "1",
  "profiles": {
    "premium_reasoning": "claude-opus-5",
    "build_strong": "claude-sonnet-5",
    "analysis_efficient": "claude-sonnet-5",
    "routine_lowcost": "claude-haiku-4-5-20251001"
  }
}
```

- All four profiles are required — a partial map is rejected at startup
- An agent's explicit `model` field overrides its profile
- The file lives in `store/` (gitignored), keeping the concrete model mapping off version control

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
