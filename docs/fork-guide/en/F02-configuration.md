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
#   single = only agents enabled for exactly ONE tenant; off = tenant skills stay DB-only.
#   An agent shared by several tenants never gets a copy. The former value `all` is gone: it is read as
#   single and a warning is printed at startup.
# TENANT_SKILL_FILES=single

# Use-time tenant context (default: 43200 = 12 h, 0 = no age limit)
#   How long an agent's per-prompt tenant context stays valid for the skill gate; after that tenant
#   skills are denied until the next prompt re-resolves the source. Not a binding cache: changing or
#   deleting a binding, disabling the agent or the tenant, or changing the tenant's main agent drops
#   the affected context at once.
# TENANT_CONTEXT_MAX_AGE_SECONDS=43200
```

## Shared agents and tenant skills

An agent enabled for more than one tenant (a **shared** agent) serves requests of all of them from one
skills directory. A file copy of tenant A's skill (its `SKILL.md` and companion scripts) in that directory
would be readable and runnable while the agent answers tenant B, so the rule is:

- **A shared agent never gets a file copy of a tenant skill. Its tenant skills are DB-only.** This holds
  for every writer: the live skill edit, the startup regen and the agent-start generation. Fleet skills
  (`tenant_id='fleet'`) are not affected.
- `TENANT_SKILL_FILES=single` (default) copies a tenant skill only to agents enabled for exactly one
  tenant; `off` copies to none. The `all` value that used to write copies to shared agents too was removed;
  it is read as `single` and a warning is printed at startup.
- An availability change (`PUT /api/admin/agent-availability`) reconciles the files of **every tenant the
  agent serves**, not only the changed one: enabling a second tenant on a single-tenant agent turns it into a
  shared agent and removes the first tenant's generated copy from it; disabling one can turn it back into a
  single-tenant agent and its remaining tenant's copies are written. A hand-edited `SKILL.md` is kept (only
  the generated companion files go).

### Accepted risk

DB-only is a file-level guarantee, not full isolation. The owner accepted the following, 2026-10-03:

- A shared agent holds the fleet bearer token, which resolves to the `admin` role, so it can still read any
  tenant's skill rows through `/api/skills/sql/*`. Keeping tenant B's skills out of tenant A's answers is up
  to the use-time tenant context and `tenant-skill-gate.py`, which covers the `Skill` tool and file access
  into a tenant skill directory; it does not cover a `curl` to the dashboard API issued from a shell.
- The shell side of the gate is best effort (a command can build a path indirectly).
- A skill an operator creates by hand in a shared agent's own skills directory is visible to every tenant that
  agent serves; the generated-copy rule does not apply to hand-made files.

Revisit this when agents get per-tenant credentials, which would make the skill API tenant-aware for them.

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
- `timeout_minutes` -- approval request lifetime in minutes; reported as `timeoutMinutes` in the `GET /api/autonomy` response. Migration 0067 sets it to 60 on every category that can raise an approval (`maxLevel` at least 2) and has no value yet; a value that was already set is kept, and the locked (level 1) categories stay NULL because they never raise a request. NULL does not mean unlimited, it means the 24 hour ceiling (1440 minutes)

**Approval expiry.**
- Every new request gets a `timeout_at`: the category's value, or the 24 hour ceiling when the category is unknown (for example `github_pr`) or its value is NULL.
- The `timeout_seconds` field of the `POST /api/approvals` body (which the agent template and the fleet's prompts have always sent) can only shorten that value, never extend it. A missing, zero, negative or non-numeric value is ignored by the server.
- `PATCH /api/approvals/<id>` answers 409 (`Approval has expired`) for an expired request, even when the sweeper (it runs every 60 seconds) has not marked it `timeout` yet; recording the `timeout` status itself is allowed. The sweeper writes `resolved_by = system:timeout`, so an expiry can be told apart from a human rejection. No Telegram message is sent on expiry, only the aggregated audit entry that was already written.
- The migration also gives a still-pending request that has no `timeout_at` a deadline: `requested_at` + 60 minutes.
- `POST /api/autonomy` accepts `timeout_minutes` next to (or instead of) `level`: a whole number from 1 to 10080, or `null` (the 24 hour ceiling). Admin only (anyone else gets 403), validated before anything is written, and each change writes an audit entry with the old and new value. There is no dashboard field for it yet.

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
