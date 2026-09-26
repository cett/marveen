# F04 Architecture

## Overview

Marveen consists of two independent processes that coordinate through a shared SQLite database:

| Process | Managed by | Role |
|---------|-----------|------|
| `dashboard` | launchd/systemd `dashboard` service | REST API, web UI, database administration |
| `channels` | launchd/systemd `channels` service | Claude Code CLI channel connection, agent orchestration |

The `dashboard` is a Node.js/TypeScript HTTP server (default port: 3420). The `channels` service is the `scripts/channels.sh` script, which starts the main agent's Claude Code process inside a dedicated tmux session.

## Processes and tmux layout

### Main agent session

When the `channels` service starts, it creates a tmux session named `<MAIN_AGENT_ID>-channels` (e.g. `marveen-channels`). The main agent's Claude Code process runs inside it and receives user messages through the channel plugin (Telegram/Slack/Discord).

```
tmux attach -t marveen-channels
```

### Fleet agent sessions

The dashboard starts each fleet agent in its own tmux session, named `agent-<agent_id>`:

```
tmux attach -t agent-<agent_id>
```

Each agent runs in an isolated `CLAUDE_CONFIG_DIR` directory and authenticates from the `store/.claude-oauth-token` fleet token rather than a rotating interactive login.

### Summary

```
tmux ls
  marveen-channels    -- main agent (channels service)
  agent-<name1>       -- fleet agent 1 (dashboard-managed)
  agent-<name2>       -- fleet agent 2
  ...
```

## Directory structure

```
marveen/
  install.sh              -- installer (macOS + Linux)
  install-windows.ps1     -- Windows installer (WSL2)
  update.sh               -- updater
  .env                    -- main configuration (0600)
  package.json
  tsconfig.json

  src/                    -- TypeScript source
    index.ts              -- dashboard entry point
    channel-coordinator/  -- agent orchestration, spawn, auth
    db/                   -- database CRUD modules
    web/                  -- API routes, web server
    migrations/           -- SQL migrations (0001..N.sql)

  dist/                   -- TypeScript build output (gitignored)

  web/                    -- frontend static files (SPA)

  store/                  -- runtime state (gitignored)
    claudeclaw.db         -- SQLite database
    .dashboard-token      -- Bearer token (0600)
    .claude-oauth-token   -- Fleet OAuth token (0600)
    autonomy-config.json  -- autonomy levels
    model-profile-map.json

  agents/                 -- fleet agents directory
    <name>/
      CLAUDE.md           -- agent instructions
      .mcp.json           -- MCP configuration
      .claude/channels/   -- channel token + pairing state

  scripts/                -- shell utilities
    channels.sh           -- channels service entry point
    backup.sh
    doctor.sh
    channel-watchdog.sh
    auth.sh
    vault-*.sh

  seed-config/            -- default configs written at install time
  seed-skills/            -- default skill library
  seed-scheduled-tasks/   -- default scheduled tasks
  config-examples/        -- .env.example, model-profile-map.example.json

  backups/                -- backup archives (gitignored)
  scheduled-tasks/        -- project-level scheduled tasks
```

The `~/.claude/` user home directory holds Claude Code global configuration:

```
~/.claude/
  skills/                 -- global skill library
  scheduled-tasks/        -- file-based scheduled tasks
  channels/<provider>/    -- channel token + pairing state (main agent)
    .env                  -- bot token
    access.json           -- paired chat IDs
```

## Database

The database is the SQLite file at `store/claudeclaw.db`. The schema is built from numbered SQL files in `src/migrations/`; on every startup the dashboard automatically runs any pending migrations.

### Table groups

**Memory**

| Table | Contents |
|-------|---------|
| `memories` | Memory entries (hot/warm/cold/shared tiers) |
| `memory_links` | Cross-entry references |
| `memory_versions` | Edit history |
| `daily_logs` | Daily summaries |
| `workspace_docs` | Shared workspace document storage |
| `import_sources` | External memory import sources |
| `import_memories` | Imported memory entries |

**Kanban**

| Table | Contents |
|-------|---------|
| `kanban_cards` | Task cards (planned/in_progress/waiting/done) |
| `kanban_comments` | Card comments |
| `kanban_card_events` | Status-change log |
| `kanban_card_labels` | Card-label join table |
| `labels` | Labels |
| `idea_box` | Idea inbox |
| `idea_comments` | Idea comments |

**Agents and messaging**

| Table | Contents |
|-------|---------|
| `agent_messages` | Inter-agent message queue |
| `fleet_blackboard` | Fleet blackboard (current agent status) |
| `fleet_blackboard_history` | Blackboard entry history |
| `sessions` | Channel session state |
| `pending_channel_requests` | In-flight channel requests |

**Scheduling**

| Table | Contents |
|-------|---------|
| `scheduled_tasks` | Scheduled task definitions |
| `schedules` | Schedule entries |
| `task_runs` | Run log |
| `background_tasks` | Background tasks (async operations) |
| `pending_task_retries` | Tasks waiting for retry |

**Models and cost**

| Table | Contents |
|-------|---------|
| `token_usage` | Token usage (per message) |
| `token_usage_daily` | Daily rollup |
| `token_usage_monthly` | Monthly rollup |
| `cost_line_items` | Detailed cost rows |
| `cost_sources` | Cost sources |
| `otel_spans` | OpenTelemetry spans |
| `claude_plans_registry` | Claude subscription plan registry |

**Authentication and security**

| Table | Contents |
|-------|---------|
| `api_tokens` | API tokens |
| `auth_sessions` | Dashboard login sessions |
| `device_keys` | Device keys (agent device auth) |
| `vault_ssh_keys` | SSH keys stored in Vault |
| `vault_ssh_servers` | SSH servers stored in Vault |
| `approvals` | Autonomy approval requests |

**Configuration**

| Table | Contents |
|-------|---------|
| `system_config` | Dashboard-managed configuration (overrides .env) |
| `config_change_log` | Configuration change audit log |

**Skills and tenants**

| Table | Contents |
|-------|---------|
| `skills` | Skill catalog |
| `skill_usage` | Skill usage log |
| `skill_tenant_access` | Tenant-level skill access |
| `tenants` | Tenant definitions |
| `dashboard_users` | Dashboard users (per-tenant) |
| `tenant_agent_availability` | Tenant-agent assignment |
| `partner_senders` | External (non-agent) message senders |

**Audit and observability**

| Table | Contents |
|-------|---------|
| `agent_audit_log` | Agent action log |
| `hook_audit_log` | Hook run log |
| `store_file_audit` | Store directory file-change log |
| `import_audit_log` | Import operation log |
| `artifacts` | Generated artifact metadata |

## Configuration layers

Configuration follows a three-level precedence (first match wins):

1. `system_config` database table (editable from the dashboard Settings page)
2. `/run/secrets/<KEY>` files (Docker/Kubernetes secret mounts)
3. `.env` file

See [F02 Configuration](F02-configuration.md) for full details.

## Data flow (simplified)

```
User message (Telegram/Slack/Discord)
         |
         v
  channels service (Claude Code CLI + channel plugin)
         |
         v
  Main agent processes it (per CLAUDE.md instructions)
         |
         |-- SQLite (memory read/write, kanban, blackboard)
         |
         |-- inter-agent message --> sub-agent (agent-<name> tmux session)
         |
         v
  Response sent back to the channel
```

The dashboard is a separate process: it serves the REST API and web UI, handles database administration, and starts/stops fleet agents via their tmux sessions.

---

*Previous: [F03 Operations](F03-operations.md)*
*Next: F05 Channel configuration (coming soon)*
