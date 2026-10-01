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

### Scheduled tasks and tenants

Scheduled tasks are tenant-owned (`schedules.tenant_id`, never empty; see "Tenant ownership of scheduled tasks" below). For the access model this means:

- A non-admin caller only gets the tasks, the selectable agents (`GET /api/v1/schedules/agents`) and the pending retries of its own tenant; another tenant's task answers `404 not_found`, like a missing name.
- Two permissions cover the group: `schedules:read` (admin, agent, read_only, viewer) and `schedules:write` (admin, agent). Every tenant user holds `schedules:write` automatically through the `agent` role; there is no per-tenant switch and no new role. The rows in `ENDPOINT_PERMISSION_TABLE` (paths reach the table already normalised from `/api/v1` to `/api`, so there are no `/api/v1/schedules` rows):

| Request | Needs | Where |
|---------|-------|-------|
| `GET /api/schedules/tick-status` | `admin:all` | exact row, listed before the GET prefix row so the prefix cannot cover it |
| `GET /api/schedules` (prefix: list, `agents`, `pending`, `<name>/runs`) | `schedules:read` | prefix row |
| `POST /api/schedules/<name>/activate` | `admin:all` | regex table; it is consulted before the prefix table, so the POST prefix row cannot cover activation |
| `POST /api/schedules` (prefix: create, toggle, run, `expand-questions`, `expand-prompt`) | `schedules:write` | prefix row |
| `PUT /api/schedules` (prefix) | `schedules:write` | prefix row |
| `DELETE /api/schedules` (prefix: a task, `pending/<id>`) | `schedules:write` | prefix row |

- **Row order and route rules.** Two ordering rules hold if you touch the group: the `tick-status` row stays before the GET prefix row, and the activate row stays in the regex table (consulted first); a new admin-only schedules route has to be matched before the prefix row of its method. Route rules that apply **whatever `RBAC_MODE` says** sit in `src/web/routes/schedules.ts` (`nonAdminRefusal`, run for every `/api/schedules*` path before any other check) and apply to callers whose role is not `admin`: an account without a tenant gets 403 on every request including reads; a write needs `auth.kind` `session` or `token` (a device key and a federation principal get 403); a write on the `default` tenant gets 403. The shared dashboard token and a signed-in admin carry the `admin` role and are exempt from this function; what they may write is decided by the review gate below. The permission rows, on the other hand, only decide anything in `enforce` mode: in shadow mode `applyRbacGate` logs a would-deny (`rbac:shadow`) and lets the request through, so the role differences (for example `read_only` and `viewer` writing) show up as refusals only once enforce mode is on. Before enforce mode is switched on, do not give tenant users a login or token that can reach the API.
- The rest of the tenant rules sit in the route handlers and hold in both modes: other tenants are invisible (404), activation needs a signed-in admin (403), `status`, `tenantId` and the runner script keys of an edit are dropped, a non-admin's `agent` key is ignored, a non-admin naming a different `tenant_id` gets 403, and a task a non-admin creates is a `draft` in its own tenant.
- **Review gate and re-review.** Status is `draft` (never approved), `pending_review` (approved, then changed by a caller that is not a signed-in admin) or `live`; the runner holds both non-live states the same way (see "Held-back occurrences"). `PUT /api/v1/schedules/<name>` by anyone who is not a signed-in admin (`isHumanAdmin`: role `admin` and `auth.kind` `session`; the shared token has the role but is no person) sets a `live` task to `pending_review` when it changes any of `prompt`, `command`, `type`, `schedule`, `agent`, `targetSession`, `timeoutMs`, `failThreshold`, `skipIfBusy` or `forceSend`. `description` and `enabled` never trigger it. The comparison is per field against the row as it is stored at the moment of the write (`reviewTriggerFields` in `src/web/schedule-review.ts`): strings are trimmed, an empty string, null and a missing value are the same, `false` equals unset for the two boolean options, numbers and strings differ by type. Resending the stored values (the dashboard does that on every save) is therefore a no-op: the task stays `live` and the answer is a plain `{ ok: true }`. A task that is not live keeps its status when edited, a tenant move by an admin stays a plain `draft` and does not go through this rule, and the rule lives in the route and the pure helper, not in `writeScheduledTask`, because the seed, fleet import and the toggle file mirror call that writer directly. The write lands first; a triggering edit answers `{ ok: true, status: "pending_review", review_required: true, changed: [field, ...] }`.
- **Activation protocol.** `GET /api/v1/schedules` adds `contentHash` to every task: a SHA-256 over the reviewed fields (`REVIEWED_FIELDS`: prompt, schedule, agent, type, skipIfBusy, forceSend, targetSession, command, timeoutMs, failThreshold) in fixed order and normalised form, so a changed description or enabled state does not move it. `POST /api/v1/schedules/<name>/activate?expected_hash=<contentHash>` compares it with the current hash and answers `409 stale_revision` with `content_hash` (the current value) in the body when they differ; nothing is activated, and the dashboard reloads the list so the admin looks at, and then activates, the current content. The parameter is optional: a caller with no screen (a script, the `dashboard-schedule-crud` recipe) omits it and activation is unchecked. The route needs a signed-in admin either way (403 otherwise). `stale_revision` is an error token in the catalog (`src/api-error-catalog.ts`, allowed for 409), the OpenAPI enum and both dashboard languages.
- **Draft cap.** A tenant may have at most 20 schedules that are not live (draft or `pending_review`), `MAX_OPEN_REVIEW_PER_TENANT` in the route. Creating the 21st draft answers `400 limit_exceeded` (field `name`, hint with the count) and writes nothing. Live tasks do not count, deleting frees a slot, editing a task the tenant already owns is never blocked, and a signed-in admin creating a `live` task is exempt; an agent on the shared token creating a draft for a tenant is counted. Who may create: any caller the route guards let through creates a `draft`; only a signed-in admin creates `live`.
- **Audit and notification.** Every schedule write writes one `agent_audit_log` row (entity `schedule`; action `create`, `update`, `delete`, `toggle`, `activate` or `review_requested`; entity id the task name). The detail holds the tenant, `actor_kind` (`session`, `token`, `device`, `other`), the self-declared `X-Agent-Id` kept apart as `claimed_agent` (it is not authentication), and for an edit the changed field names with a before and after SHA-256 and a short preview of the new value (200 characters), never the whole value. The `agent_id` is the session user, `token:<name>` for a scoped token, `claimed:<id>` for the shared token with a header. A write that is refused (another tenant's task, a 403) leaves no row. A task sent back to review, and a draft created by a non-admin, also send the main agent a system message (`createAgentMessage('system', MAIN_AGENT_ID, ...)`) of the form `[SCHEDULE_REVIEW] task=<name> tenant=<id> reason=edited|created [changed=[...]] by=<actor>`. It is at most one message per task and reason per hour, the throttle is in memory (a restart can send one more), and an audit or notification failure never fails the write (best effort). What the main agent does with it is up to its own instructions.
- **Dashboard.** The Tasks page gates on `can('schedules:write')`: the **+ Task** button, the edit dialog's save and the Run now, Pause and Delete actions. Activation and the scheduler heartbeat indicator gate on `can('admin:all')`. A held task shows the badge `tasks.status.pending_review` ("awaiting review" / "jóváhagyásra vár"), and a save that answers `review_required` shows the `tasks.toast.review_required` toast. The Activate request carries `expected_hash`. The role-permission matrix and the screen-access matrix of the Users tab list the two permissions and the Tasks screen row follows them.
- **Adding a permission.** The permissions are one tuple, `ALL_PERMISSIONS` in `src/web/rbac.ts`, and the `Permission` type derives from it. The dashboard keeps hand-written mirrors that cannot import it: `web/modules/rbac-client.js` (the `can()` role map), `web/modules/rbac-permission-matrix-data.js` and `web/modules/rbac-screen-access-data.js`, plus the i18n labels (`admin.b2b.perm.<resource>.<action>.label` / `.desc` and the category label, in both `hu.js` and `en.js`). `src/__tests__/rbac-permission-matrix-data.test.ts` walks `ALL_PERMISSIONS` against the matrix mirror and fails on a permission without a row, and `rbac-screen-access-data.test.ts` checks that the Tasks screen row follows `schedules:read` and `schedules:write`. The role map of `rbac-client.js` has no such test, so change it together with `rbac.ts`.

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
  "timeoutMs": 30000,
  "tenantId": "default"
}
```

**`type`** values:
- `task` -- always sends a notification with the result after each run
- `heartbeat` -- only notifies when something important or urgent is detected
- `command` -- runs a shell command directly (no agent session, no prompt); see "Command tasks" below

`tenantId` names the tenant that owns the task. Every write of the mirror records it, and a `task-config.json` without one (an old file, or a seed that does not name a tenant) is filed under `default` when an empty schedules table is seeded from the files (`seedSchedulesFromFilesIfEmpty`, `scripts/migrate-schedules-to-db.ts`), so a reseed can never produce a task without a tenant.

The database row is the source of truth for `enabled`; `task-config.json` is only a mirror of it. The scheduler pulls a drifted `enabled` in the file back to the database value at startup and then once an hour (database to file only, never the other way round). Only that key is rewritten, every other key keeps its value, `SKILL.md` is not touched, and a missing or unparseable file is skipped (the mirror is never created by the sync). Each correction is logged as a warning that names the tasks.

### Built-in tasks

Marveen seeds the following tasks at install time:

| Task | Cron | Description |
|------|------|-------------|
| `auto-update` | `0 4 * * 3` (Wednesdays) | Automatic update (opt-in: `AUTO_UPDATE_ENABLED=1`) |
| `kanban-audit` | `0 8,12,16,20 * * *` | 4-hourly kanban cleanup and stuck-task detection |
| `nightly-backup` | `0 3 * * *` | Daily data backup (`scripts/backup.sh`), a command task without an LLM |
| `memory-maintenance` | `15 3 * * *` | Daily memory maintenance (tier reassignment, version pruning, link-graph upkeep), a command task without an LLM |
| `budget-plafon-monitor` | own cron | Token usage threshold monitoring |
| `bumblebee-hygiene-scan` | own cron | Bumblebee (Go) service health check |

### Creating and modifying tasks

Tasks can be managed graphically from the dashboard Scheduling page. Via the API:

```bash
# Create
POST http://localhost:3420/api/v1/schedules

# Update (the editable fields only, see below)
PUT http://localhost:3420/api/v1/schedules/<name>

# Delete
DELETE http://localhost:3420/api/v1/schedules/<name>
```

Also available: `POST .../<name>/toggle`, `POST .../<name>/activate[?expected_hash=<contentHash>]` (signed-in admin only, see "Scheduled tasks and tenants"), `POST .../<name>/run`, `GET .../<name>/runs`, `GET /schedules/agents`, `GET /schedules/pending` and `DELETE /schedules/pending/<id>`; all are in `docs/openapi.yaml`.

For the full cron format and payload reference, see the `dashboard-schedule-crud` skill.

> Do not write directly to the SQLite `scheduled_tasks` table -- that is a deprecated API. Use the dashboard API or the file-based directories.

### Tenant ownership of scheduled tasks

Every task belongs to exactly one tenant: `schedules.tenant_id` is `'default'` or a tenant id, never empty. The column stays nullable in SQLite (it cannot become `NOT NULL` in place) and the application keeps it filled. Migration 0066 gave every row without a tenant the `default` tenant (`UPDATE schedules SET tenant_id = 'default' WHERE tenant_id IS NULL`, idempotent, rows that already name a tenant are untouched). The tenant-context hook already read a missing tenant and `default` the same way, so nothing changed at run time and no task moved. The tenant-less "fleet" scope is gone: `?tenant=fleet` matches nothing, and a stored NULL (a row older than the migration) still reads as `default` everywhere (`rowToTask`, the tenant filter of the list).

Before an upgrade, back up (`scripts/backup.sh`); after the restart, `SELECT tenant_id, count(*) FROM schedules GROUP BY 1` must show no NULL.

**Which tenant a new task gets** (`POST /api/v1/schedules`, first match wins):

1. a non-admin caller: its own tenant (a `tenant_id` in the body is ignored);
2. an admin that sends `tenant_id`: that tenant (the shared agent token counts as admin);
3. a signed-in human admin that sends none: `default`;
4. otherwise (the shared token with no `tenant_id`): the tenant derived from the `X-Agent-Id` header. The header is self-declared, not authentication. The tenant is the one of the request the agent is serving right now: a fresh `bound` context row in `agent_tenant_context` whose tenant the agent still serves, or a fresh `default` row (an unbound source). "Fresh" is `TENANT_CONTEXT_MAX_AGE_SECONDS` (default 43200, 12 hours). Without a usable context, the agent's own tenant counts, but only when it has exactly one (no enabled `tenant_agent_availability` row means `default`). An agent enabled for several tenants and without a context is ambiguous.

When none of that yields a tenant (no `X-Agent-Id`, or an ambiguous shared agent), the answer is `400 tenant_required` (field `tenant_id`) instead of a silent `default`. The task is never filed under a guess, and it stays a `draft` for a non-human caller, so a person activates it with the tenant shown (badge and tooltip in the dashboard). Generated agent `CLAUDE.md` files send `X-Agent-Id` in their create example; instructions generated before that change do not, and their create calls answer `tenant_required` until the header is added.

After the tenant is known: it must exist and not be disabled (`400 invalid_value`, field `tenant_id`).

**The (tenant, agent) pair.** The task's agent has to serve its tenant, because the hook binds the tenant to the agent's session when the task fires. Checked on create and on every edit that moves the tenant or the agent (`400 invalid_value`, field `agent`, or `tenant_id` when the move itself broke the pair); a non-default tenant has no default agent, so `agent` is required there (`400 required`):

| Tenant | Valid agents |
|--------|--------------|
| `default` | the fleet main agent, `all`, any known agent with no enabled tenant row, or enabled for `default` |
| any other | its main agent or an agent enabled for it (`tenant_agent_availability.enabled = 1`) while the tenant is not disabled; never the fleet main agent (no tenant hook, so no isolation) and never `all` (a fan-out cannot be bound to one tenant) |

An unknown agent name is invalid for every tenant.

**Editing (`PUT`).** The handler writes only `description`, `prompt`, `schedule`, `enabled`, `type`, `skipIfBusy`, `forceSend`, `targetSession`, `command`, `timeoutMs`, `failThreshold`. Every other key is dropped, in particular `status` (an edit can no longer turn a draft into a live task: activation stays the signed-in admin's step), `tenantId`, and the runner script keys `preCheck`, `catchUpMaxAgeMinutes`, `stuckAfterMinutes`, `requires`. `agent` is admin-only (ignored for others, but the shared token has the admin role, so an agent on it can set one) and the resulting pair must be valid. A caller that is not a signed-in admin who changes an executed field of a `live` task also sets it to `pending_review` (see "Review gate and re-review" above). `tenant_id` moves the task: signed-in admin only (`403` for anyone else, the shared token included, when it names a different tenant), target must exist and be enabled, the pair is re-checked, the task goes back to `draft` and the answer is `{ ok: true, tenant_id, status: "draft" }`. A `tenant_id` equal to the current one is a no-op. A non-admin only reaches tasks of its own tenant (`404` otherwise), on `PUT`, `DELETE`, toggle, run-now and `runs`.

**Reads.** `GET /schedules` returns every task with `tenantId`: admins get all of them or those of `?tenant=`, everyone else their own tenant. `GET /schedules/agents` returns `{ name, label, avatar }` objects: a non-admin only the agents serving its tenant, an admin all of them or those of `?tenant=` (the dashboard dialog uses it to narrow the selector). `GET /schedules/pending` and `DELETE /schedules/pending/<id>` follow the tenant of the retry's schedule; a retry whose schedule is gone is admin-only.

**Runner.** Each tick, every enabled, live, non-`command` task whose pair no longer holds is not fired, whatever the reason (agent switched off for the tenant, tenant disabled, tenant main agent changed, agent deleted). The check is memoised per distinct pair for one tick, and a failed lookup counts as valid so a database hiccup never stops tasks. Each due occurrence is written to `task_runs` as `skipped_tenant_mismatch` by the same skip ledger as `skipped_not_live` (see "Held-back occurrences"). One notification goes out per breakage: an error log line, an audit row (agent `scheduler`, entity `schedule`, action `skip_tenant_mismatch`, entity id the task name, detail tenant and agent) and a Telegram message to the owner chat when configured (text currently always Hungarian). The flag is in memory: it clears when the pair is valid again, and a restart inside a breakage notifies again. `command` tasks run no agent and are not checked.

**The hook link.** `scripts/hooks/tenant_context_lib.py` resolves a `<scheduled-task source="scheduled-task:NAME">` prompt with `SELECT tenant_id FROM schedules WHERE id = ? AND agent = ?`: missing or `default` is the default tenant, another id is `bound` when the agent serves it and `unknown` otherwise (the skill gate then denies tenant skills), and a row with another agent (or an `all` row) is `unknown`. So setting `tenant_id` is all the tenant skill isolation of a scheduled run needs, and the pair rule above keeps that binding valid. The main agent has no tenant hook, which is why it cannot be given a non-default tenant's task. See F03, "Tenant skill gate".

**Around the edges.**
- Deleting a tenant (`DELETE /api/v1/admin/tenants/<id>`; `default` cannot be deleted) removes its schedules, their `pending_task_retries` and their file mirror (`~/.claude/scheduled-tasks/<name>`, which an empty-table reseed would otherwise bring back); the `admin.tenant.delete` audit row carries `schedules_deleted` and `schedule_mirrors_removed`.
- Fleet import re-homes a schedule whose exported `tenant_id` is not an enabled tenant on this machine to `default` (tenants are local to a machine). Schedules still arrive disabled, and the dry run and the apply report count how many were re-homed.
- Overview `tasksToday` in a tenant view counts the `task_runs` of that tenant's schedules (matched by task name), not the runs of the tenant's agents, so an agent shared by several tenants no longer vanishes from every tenant view. A run whose schedule was deleted since belongs to no tenant and only shows in the fleet-wide count.
- `tenant_required` is an API error token (`400`) with a dashboard message.

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

`POST /api/v1/schedules/<name>/run` fires a task immediately, ignoring the cron match, the catch-up window and `skipIfBusy`. A disabled task answers `409 disabled`; a draft or `pending_review` task answers `409 not_live` (a signed-in admin may still run it to preview it before activating it).

- Prompt tasks (`task`, `heartbeat`): the prompt is delivered to the target agent session like a cron fire. A stopped agent is started, and a busy session gets a queued retry. The response lists one outcome per agent, for example `<agent>: fired`.
- Command tasks: the shell command is run directly, as the cron loop does, and the last-run time is recorded. The call does not wait for the command; it answers at once with `command: started (outcome in store/command-task-health.json)`.

### Held-back occurrences and the mass-skip alert

A due occurrence of an enabled task must not be consumed without a trace. Every tick the scheduler sorts each task into one of four states:

| State | Condition | Effect |
|-------|-----------|--------|
| runnable | enabled and live | normal fire and catch-up |
| disabled | `enabled` is off | normally the operator's own switch: no run, no row, never replayed by a catch-up |
| not live | enabled, but the review gate holds it (`draft`, or `pending_review` after a non-admin edit of a live task) | not run; the retry queue drops it too; every due occurrence is written to `task_runs` as `skipped_not_live` |
| tenant mismatch | enabled and live, but its (tenant, agent) pair no longer holds | not run; every due occurrence is written as `skipped_tenant_mismatch`, one notification per breakage (see "Tenant ownership of scheduled tasks") |

One row is written per due occurrence found in the tick window, once for every target agent (the task's agent, the main agent when none is set, or the main agent plus every running agent for an `all` task). The rows show in the run history (`GET /api/v1/schedules/<name>/runs`, latest 10) and the dashboard shows the raw status name.

A disabled task is also recorded, as `skipped_disabled`, when it is part of a **mass event**. A mass event is when at least 4 tasks are in play (the tasks that were runnable on the previous tick plus every task that is enabled now) and more than half of them are held back at once. Held back means not live, a tenant mismatch, or disabled although it was runnable on the previous tick. That is the scheduler reading its own tasks wrongly, not one operator toggling a switch, so each held occurrence is recorded. A task stays in the event until it is runnable again or 24 hours have passed. Tasks that were already disabled before the event are never part of it, and a single toggle never reaches the threshold.

When a mass event starts, one alert goes out:

- an error line in the dashboard log;
- an audit row (agent `scheduler`, entity `schedule`, action `mass_skip`, detail: number of held tasks, number of tasks, up to 8 names), visible in the dashboard audit log;
- a Telegram message to the owner chat with the number of held tasks and up to 8 names (`+N` for the rest), when the bot token and owner chat id are configured. The text is currently always Hungarian.

The alert is deduplicated, not rate-limited by time: the flag stays set while the event lasts and is re-armed as soon as the condition no longer holds. It lives in memory, so a restart that is still inside an event alerts again.

The detection survives a restart. The "runnable on the previous tick" baseline is kept in memory, so a freshly started process would have no history and could take a state where every task already reads as disabled as normal. On the first scan the baseline is therefore seeded from the database rows themselves (enabled and live, read independently of the tick's own task list), so a process that comes up inside a mass event records the held occurrences and sends the alert from its first tick. Tasks the database has disabled are not in the baseline and leave no rows. If the baseline read fails, the scan falls back to the tick's own evidence. A failure of the whole skip ledger is logged as a warning and never breaks the tick.

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
