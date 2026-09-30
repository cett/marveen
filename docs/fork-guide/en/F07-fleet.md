# F07 Fleet, tenant management, and scheduling

## Fleet -- managing multiple agents

The fleet is the collective name for all Claude Code agents running within a single Marveen installation. Each agent has its own role description (`agents/<name>/CLAUDE.md`), its own tmux session (`agent-<name>`), and optionally its own channel configuration.

### Creating an agent

1. Open the dashboard Agents page
2. Click "New agent"
3. Enter the agent ID (`agent_id`), display name, and persona
4. Select MCP connectors and model profile
5. Optionally assign a channel (Telegram/Slack/Discord)
6. Save -- the dashboard creates the `agents/<name>/` directory and the required configuration files

Manual creation:

```bash
mkdir -p agents/<name>
# Copy templates:
cp templates/CLAUDE.md.tpl agents/<name>/CLAUDE.md
cp templates/.mcp.json.tpl agents/<name>/.mcp.json
```

### Starting and stopping agents

The dashboard manages agents automatically. Manual control via the API:

```bash
# Start
curl -s -X POST http://localhost:3420/api/agents/<name>/start \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"

# Stop
curl -s -X POST http://localhost:3420/api/agents/<name>/stop \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"
```

Or directly via the tmux session:

```bash
tmux attach -t agent-<name>        # attach
tmux kill-session -t agent-<name>  # stop
```

### Fleet blackboard

Fleet agents signal their current status via the `fleet_blackboard` table. Query the blackboard:

```bash
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/blackboard
```

An agent updates its own row while working (`status: active/done/blocked`), so other agents and the dashboard can see who is doing what.

### Inter-agent messaging

Agents communicate via the `agent_messages` queue:

```bash
curl -s -X POST http://localhost:3420/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"from":"sender-agent","to":"target-agent","content":"Task description"}'
```

The message is injected into the target agent's tmux session; the agent processes it and responds on its own channel.

The executor closes a delegated message with `PUT /api/messages/<id>` (`status`: `done`, `failed` or `refused`, optional `result`). The delegator then receives a completion notice that starts with `[Eredmény]`; that notice is stored in the same tenant as the original message, so a tenant-scoped delegator sees the result of its own request.

Tenant rule for this endpoint: a non-admin caller can only update messages of its own tenant (a message without a tenant counts as `default`). A message of another tenant answers exactly like a missing id (`404 not_found`), so message ids cannot be probed across tenants; the rejected attempt is written to the audit log. Admin callers are not restricted.

---

## Tenant management (RBAC)

Marveen supports multi-user operation: each tenant's data (memories, kanban, agents) is stored in isolation from other tenants.

> **Note:** tenant enforcement (RBAC_MODE=enforce) currently runs in shadow mode -- all requests pass through, but the system logs what would be rejected under strict enforcement. Activating enforce mode is planned for a future release.

### Roles

| Role | Access |
|------|--------|
| `admin` | Full access, all tenants, administration interface |
| `agent` | Full read/write access to one tenant's data, no admin |
| `read_only` | One tenant's data, read-only |
| `viewer` | List memories, kanban, agents (without blackboard) |

### Token management

API tokens are managed at `/api/v1/admin/tokens`:

```bash
# Create a token
curl -s -X POST http://localhost:3420/api/v1/admin/tokens \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{
    "name": "partner-token",
    "role": "agent",
    "tenant_id": "acme-corp",
    "expires_at": "2027-01-01T00:00:00Z"
  }'
```

```bash
# Revoke a token
curl -s -X PATCH http://localhost:3420/api/v1/admin/tokens/<id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"revoked": true}'
```

### Onboarding a B2B partner

An external partner (B2B tenant) receives an `agent`-role token scoped to their own `tenant_id` and can only see data in that scope. Onboarding steps:

1. Create the tenant in the admin UI (Settings > Tenants)
2. Generate an `agent` token with an expiry (`expires_at`, e.g. 90 days)
3. Deliver the token over a secure channel (not in plaintext email)
4. Isolation test: a query for a `default` tenant memory using the new token must return an empty list
5. Agree on a rotation process: the partner should request a new token at least 2 weeks before expiry

### External system message sending

If a non-agent external system also needs to send messages via `POST /api/messages`, register its ID in `.env`:

```ini
SYSTEM_SENDER_IDS=cortex
```

---

## Scheduled tasks

Scheduled tasks are file-based: each task is a directory containing a `SKILL.md` (instructions) and a `task-config.json` (cron + metadata) file.

### Task locations

| Directory | Scope |
|-----------|-------|
| `~/.claude/scheduled-tasks/` | Global (all agents) |
| `scheduled-tasks/` (project root) | Project-level tasks |

### task-config.json structure

```json
{
  "schedule": "0 8,12,16,20 * * *",
  "agent": "marveen",
  "enabled": true,
  "type": "task",
  "skipIfBusy": true,
  "description": "Description (optional)",
  "timeoutMs": 30000
}
```

**`type`** values:
- `task` -- always sends a notification with the result after each run
- `heartbeat` -- only notifies when something important or urgent is detected
- `command` -- runs a shell command directly (no agent session, no prompt); see "Command tasks" below

### Built-in tasks

Marveen seeds the following tasks at install time:

| Task | Cron | Description |
|------|------|-------------|
| `auto-update` | `0 4 * * 3` (Wednesdays) | Automatic update (opt-in: `AUTO_UPDATE_ENABLED=1`) |
| `kanban-audit` | `0 8,12,16,20 * * *` | 4-hourly kanban cleanup and stuck-task detection |
| `memory-maintenance` | `0 3 * * *` | Daily memory maintenance (tier reassignment, version pruning) |
| `budget-plafon-monitor` | own cron | Token usage threshold monitoring |
| `bumblebee-hygiene-scan` | own cron | Bumblebee (Go) service health check |

### Creating and modifying tasks

Tasks can be managed graphically from the dashboard Scheduling page. Via the API:

```bash
# Create
POST http://localhost:3420/api/v1/schedules

# Update
PATCH http://localhost:3420/api/v1/schedules/<id>

# Delete
DELETE http://localhost:3420/api/v1/schedules/<id>
```

For the full cron format and payload reference, see the `dashboard-schedule-crud` skill.

> Do not write directly to the SQLite `scheduled_tasks` table -- that is a deprecated API. Use the dashboard API or the file-based directories.

### Command tasks

A `type: command` task runs its `command` through `bash -lc` inside the dashboard process, without any agent session or model call. The cron loop and a manual run use the same code path.

| Field | Default | Meaning |
|-------|---------|---------|
| `command` | -- | Shell command; a task without one is skipped |
| `timeoutMs` | `10000` | Run time limit |
| `failThreshold` | `2` | Consecutive failures before the first alert |

- The command runs **asynchronously**, so the dashboard keeps serving requests while it runs. A command that calls the dashboard's own API (`curl http://localhost:<port>/api/...`) therefore gets an answer.
- On timeout the **whole process tree** is stopped (SIGTERM, then SIGKILL after 2 seconds), not only the shell, and the run counts as a failure.
- A run that is still in progress when the next occurrence (or a manual run) arrives is skipped, never started twice.
- Health is tracked per task in `store/command-task-health.json` (failure streak, last status, last run). A Telegram alert is sent once when the streak reaches `failThreshold`, and a recovery message when the task succeeds again. With `failThreshold: 1` the first failure alerts. Alerts need the Telegram token and chat id to be configured; otherwise they are only logged.

Example, a nightly backup that alerts on the first failure (give it a generous timeout, the default 10 seconds is too short for a backup):

```json
{
  "schedule": "0 3 * * *",
  "agent": "marveen",
  "enabled": true,
  "type": "command",
  "description": "Nightly backup",
  "command": "cd /path/to/marveen && bash scripts/backup.sh",
  "timeoutMs": 600000,
  "failThreshold": 1
}
```

### Running a task manually

`POST /api/v1/schedules/<name>/run` fires a task immediately, ignoring the cron match, the catch-up window and `skipIfBusy`. A disabled task answers `409 disabled`; a draft task answers `409 not_live` (a human admin may still run a draft to preview it before activating it).

- Prompt tasks (`task`, `heartbeat`): the prompt is delivered to the target agent session like a cron fire. A stopped agent is started, and a busy session gets a queued retry. The response lists one outcome per agent, for example `<agent>: fired`.
- Command tasks: the shell command is run directly, as the cron loop does, and the last-run time is recorded. The call does not wait for the command; it answers at once with `command: started (outcome in store/command-task-health.json)`.

### MCP pre-check

A task can declare the MCP servers it depends on in `task-config.json`:

```json
{ "requires": { "mcp_servers": ["gmail", "google-drive"] } }
```

Before the prompt is delivered, the runner checks that each named server has a live process under the target session's `claude` process. If one is provably missing, the task is deferred to the pending-retry queue and an alert names the missing server, instead of the prompt running against a dead server.

How a server is recognised: the runner merges the MCP configs the session can see, in increasing priority: user scope (`mcpServers` in `~/.claude.json`), the project `.mcp.json`, then the agent's own `.mcp.json`. For servers started through `npx`, `bunx` or `pnpm dlx` the match pattern is the package name (without the version suffix); for other servers it is the script path, or the command plus its first argument for a bare binary. The check is **fail-open**: a remote (`sse`/`http`) server, a runner without a package name, an unreadable config file, a remote session or an unresolvable `claude` process never block a task.

### Fleet memory heartbeat sweep

`scripts/fleet-heartbeat-sweep.sh [stagger_seconds]` asks every running sub-agent (discovered live from `/api/agents`, the main agent excluded) to run its own memory heartbeat, one agent at a time with a pause between them (default 60 seconds). Log: `store/fleet-heartbeat-sweep.log`. It is meant to be triggered by a scheduled task every few hours.

The sweep multiplies one scheduled decision into one model turn per agent, so it has its own quota guard. It reads `store/claude-usage.json` and skips the whole sweep when the higher of `sessionPct` and `weeklyPct` reaches `QUOTA_THRESHOLD` (default `75`). The guard only trusts a **fresh** snapshot: if `fetchedAt` is older than `QUOTA_STALE_MINUTES` (default `20`), or missing, the guard logs the reason and lets the sweep run (fail-open). A usage number that stopped updating therefore cannot silence the sweep for weeks.

### Timezone

Cron expressions are evaluated in the server's timezone (`SCHEDULER_TZ` in `.env`; default: the OS timezone). Check the current setting:

```bash
grep SCHEDULER_TZ .env || date
```

---

## Federation (experimental)

Federation connects two independent Marveen installations so they can exchange messages reliably without sharing a database. The link runs over an SSH tunnel.

### How it works

A message from a "partner machine" agent is delivered through the local `agent_messages` table; an SSH forward tunnel provides the connection to the remote installation's dashboard. The source installation never has direct access to the remote database.

### Key enrollment

```bash
# Display your own public key (to share with the partner)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/federation/key

# Register the partner's key
curl -s -X POST http://localhost:3420/api/federation/enroll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"bundle": "<base64-bundle-from-partner>"}'
```

Key exchange must be performed in both directions. The setup is also available from the dashboard Settings > Federation page.

---

*Previous: [F06 MCP connectors](F06-mcp.md)*
