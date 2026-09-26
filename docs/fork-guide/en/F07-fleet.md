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
- `command` -- runs a shell command (not a Claude Code prompt)

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
