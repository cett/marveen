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

### Agent API tokens and the API wrapper

Every agent calls the dashboard API with its own token (`agents/<id>/.agent-token`; the main agent's lives in the project root), not with the shared `store/.dashboard-token`, which no script, wrapper or hook reads any more. The operator has one of their own too (`store/.operator-token`). Manage them on the machine that hosts the install, the dashboard may be stopped:

```bash
npm run agent-tokens -- issue [--rotate] [--dry-run] [<agent>...]   # default: the main agent and every agent
npm run agent-tokens -- issue-operator [--rotate]
npm run agent-tokens -- check [<agent>...]   # read-only: does each token file match an active token? exit 1 if not
npm run agent-tokens -- list
npm run agent-tokens -- revoke <agent>
npm run agent-tokens -- rotate-shared   # always mints a new shared token, revokes the old row; refuses while DASHBOARD_TOKEN is set
```

The files are `0600`, the command prints the file and never a token, and the backup leaves them out on purpose (the shared token file too). After a restore, follow the steps in F03, "After a restore: API tokens" (`doctor.sh` and `agent-tokens check` report a missing or stale one).

A person opening the dashboard does not use the shared token either: `npm run dashboard-url` (operator-signed, the dashboard must run) prints `<origin>/?enroll=<one-time code>`, which the browser trades for its own named, revocable admin token (`POST /api/auth/enroll-browser`; codes are issued by `POST /api/admin/browser-enroll-codes`, global admin only, single use, 10 minutes, kept in memory). The installers print such a link at the end.

Recipes, hooks and scripts call the API through `scripts/agent-api.sh`, which picks the right token and hands it to curl on stdin, so it never shows up in a process list or a transcript:

```bash
bash scripts/agent-api.sh [--agent ID] [--token agent|operator|admin|main] METHOD /api/... [BODY | - | @file]
```

- `agent` (default) is the calling agent's own token; the agent comes from `--agent`, `MARVEEN_AGENT_ID`, the agent the session was launched as (its `CLAUDE_CONFIG_DIR`: `agents/<id>/.claude-config`, or the main agent's `.channels-config`), or the working directory (`agents/<id>/`, the project root is the main agent), in that order: the launch beats the working directory, so a sub-agent that changed into the project root still acts as itself (and one that runs it from another agent's directory acts as itself there too, not as that agent). A sub-agent with no token file of its own gets exit 3 (`no readable own token`, no request) instead of the main agent's token.
- `operator` is the operator's token. `admin` is for a call that needs the admin role whoever makes it: the main agent uses its own token, every other agent is refused (exit 3) and asks the main agent through `/api/messages`. `main` acts as the main agent (system scripts).
- The endpoints a regular agent token is refused on (agent start/stop/restart, vault, egress allowlist writes, global skill writes) are the main agent's or the operator's: use `--token admin` (main agent) or `--token operator`. An agent's own skill (`agent/<id>/<name>`) it may write with its own token; a global skill needs admin.
- There is no shared-token kind and no fallback to it. `--token shared` is a usage error (exit 2). A missing or empty token file of the agent is exit 3 and **no request is made**; the same holds for `scripts/hooks/agent_token.py` (source `none` with an error) and `scripts/agent-api.mjs`. A token that is present but refused (revoked, stale) is never retried on another token: that would hide the fault.
- `AGENT_API_STRICT` (environment, read on every call; `0` by default, `1`): a session launched as a sub-agent may not ask for the main agent's identity (`--token main`, `--token admin`: E1), the operator token (E2) or another agent's identity (`--agent` / `MARVEEN_AGENT_ID` naming someone else: E3). With `1` such a call exits 3 and **no request is made**; with `0` it goes out as before and stderr says it would be refused. `--token admin` from a sub-agent session is refused in both modes (as before for its own directory); E1-E3 for the other tokens only warn under `AGENT_API_STRICT=0`. A call with no sub-agent session (a system script, cron, the main agent) is never touched. This is hygiene against the common slip, not a security boundary: agents share one OS user. Two callers in the repository are made to work under `1`: the `post-checkout` hook of `install-prod-tree-guard-hook.sh` sends its alert as whoever ran the checkout (the caller's own token, no `--token main`; it also says who switched the prod tree), and a failed send prints a line on stderr, and `pre-pr-review.sh` stops with exit 3 and the wrapper's reason when its operator-token vault read is refused (it needs the main agent's session or a terminal outside a sub-agent session).
- Exit code 0 on a 2xx, 22 on any other HTTP status (the status goes to stderr, the body is still printed), 2 on a usage error, 3 when there is no token to send.

The dashboard still accepts the shared token until it is rotated (`agent-tokens rotate-shared`); after that the old value is a 401, counted as `shared_token_refused` in the shadow counter so a straggler that still holds it shows up.

#### Identity enforce (`TOKEN_IDENTITY_MODE`)

`TOKEN_IDENTITY_MODE` (`src/config.ts`, read at startup from the environment or `.env`) is `shadow` unless it is exactly `enforce`. In `shadow` the counter above only counts. In `enforce` the same classification refuses: a request whose caller is not the main agent and that names another agent gets a 403 (`forbidden`, hint "A token may only act as its own agent") before the route runs. The caller is the agent a fleet-agent token names, or the `X-Agent-Id` of a shared-token request; a shared-token request that declares nobody has no caller and passes, so only taking the shared token away from the non-main agents closes that. Switch it on after the shared-token gate above says PASS and the shared token is rotated. Rollback: `TOKEN_IDENTITY_MODE=shadow` and a dashboard restart.

What counts as naming an agent follows the permission matrix (`WATCHED` in `src/web/token-shadow.ts`, field `enforce`): on the per-agent endpoints (ledger, agent state, task state, daily log, spans, hook audit, tool log, skill usage, artifacts, approvals, messages, schedules, recall, and the agent resources addressed by name under `/api/agents/:name/`) any method; on memories any method, except that the `shared` tier is readable across agents; on workspace and the blackboard only a write (reading another agent's rows stays allowed); on kanban never (it is scoped by tenant). The path, the query and the JSON body are checked; a body is checked whatever its size and every entry of a batch, and a value under the agent key that is not a string is refused. A route that acts as the main agent when no agent is named (memories, a schedule write, the daily log of a shared-token caller) is refused too: for a non-main caller "names nobody" means "names the main agent". The inter-agent `from` is the agent key of `/api/messages`, so a shared-token message must come from the agent that declared itself.

How the counter reads it. `foreign_row_access` counts only a request that enforce would refuse; a foreign read that enforce lets through (a workspace doc or a kanban card by id, a shared memory, the blackboard) is `foreign_row_read`, informational and not part of the gate; every request enforce did refuse is `identity_refused` (target = the agent it named), to be explained during the follow-up week: each row is a bug or an attempt. The `shared` memory tier is the one memory read across agents: a listing that asks for exactly that category, or one shared row by id without `include`, `agent` or `agent_id`. Under enforce a fleet agent that names no agent on a memory listing or search, the memory graph or `/api/recall` reads its own rows plus the shared tier (filtered and counted in SQL), instead of every agent of the tenant. A message posted by the main agent's token with a `from` other than its own writes an audit row with `declared_from` (the platform senders are exempt).

A check that cannot be made refuses. Where enforce has to decide (an endpoint it refuses on, a caller that is an agent and not the main agent) and the decision fails, the request gets a 500 (`internal_error`, hint "The token identity check could not be completed") instead of passing, and is counted as `identity_refused` with the target `_undecided`. The failures that count: the lookup of the owner of a row addressed by id (a workspace doc, a blackboard row, a schedule, a memory) raising a database error, a fault anywhere in the classification of that request, and a request body that cannot be read on a write enforce refuses. A row that does not exist is not a failure (the route answers its 404), and neither is a fault on an endpoint or for a caller enforce never refuses (kanban, the main agent, a read of a workspace doc). The counting that sits next to the check (the tenant-context counts) cannot take the check down with it.

#### Go-live gate: is the shared token still in use?

`python3 scripts/token-shadow-gate.py --window-start <YYYY-MM-DD>` reads the shadow counter over a measurement window and answers PASS (exit 0), FAIL (exit 1) or INCONCLUSIVE (exit 2). Rotating the shared token waits for a PASS. The window starts at the first 00:00 UTC after the last deploy that touched a call path (the deploy day itself mixes before and after) and needs 7 full UTC days plus today.

- **FAIL**: shared-token use of any caller (the gate's own canary is the only exception: the main agent and the dashboard's own page hold their own tokens now, so their former exceptions are gone), or any `agent_id_mismatch`, `foreign_row_access`, `missing_tenant_context` or `shared_agent_memories_no_tenant` row. The report lists the rows and the last hit; the window restarts after it. Every deploy that changes a call path restarts the clock.
- **INCONCLUSIVE** (never a PASS): the window is too short; an enabled schedule that runs at most weekly has not run in the window; a monthly-or-rarer schedule has no manual run in the window or no clean recipe dry-run (`--manual-run NAME`, `--dry-run-clean NAME` attest them); the dashboard's uptime is not confirmed (`--uptime-confirmed`: it must not have stood still for more than 24 hours on any window day); the canary did not move the counter; a query hit the row limit or the counter holds `_overflow` / `_invalid` rows. A zero count only counts when the counter is proven alive: the gate makes one shared-token call as `gate-canary` and requires the count to grow.
- Reported, never blocking: `fleet_skill_write_denied`, `foreign_row_read`, `identity_refused`, `channel_credential_drift` (a channel file differs from its adopted baseline: not an identity call, it has its own alert, listed so it never goes silent), `unscoped_read`, `main_token_from_subagent` (the main agent's token on a call whose wrapper says the session was launched as another agent: a sub-agent that changed into the install root or asked for `--token main`; measured from the `X-Caller-Config` header, never a credential) and `shared_token_refused` (after the rotation: which process still knocks with the old token, for the 7-day follow-up).
- The gate reads with the operator's own token and refuses to read through the shared one (its reads would land in the counter it judges). `TOKEN_SHADOW_WINDOW_START=YYYY-MM-DD` in `.env` makes `doctor.sh` print the gate state as an informational line.

### Starting and stopping agents

The dashboard manages agents automatically. Manual control via the API:

```bash
# Start
bash scripts/agent-api.sh --token operator POST /api/agents/<name>/start

# Stop
bash scripts/agent-api.sh --token operator POST /api/agents/<name>/stop
```

Or directly via the tmux session:

```bash
tmux attach -t agent-<name>        # attach
tmux kill-session -t agent-<name>  # stop
```

### Fleet blackboard

Fleet agents signal their current status via the `fleet_blackboard` table. Query the blackboard:

```bash
bash scripts/agent-api.sh GET /api/blackboard
```

An agent updates its own row while working (`status: active/done/blocked`), so other agents and the dashboard can see who is doing what.

**Row lifecycle and stale detection.** There is one row per agent. Who writes it depends on the work:

- A scheduled task or heartbeat: the schedule runner writes `active` (summary = the task name) before it injects the prompt and `done` when the session goes idle again; the agent does not have to. If the agent rewrote the row in between (own summary, `blocked`), the runner backs off and the agent closes it itself.
- Interactive work (3 or more tool calls): the agent posts `active` at the start and `done` or `blocked` at the end. A restart or a fresh session never closes a row (the row survives in the database, the work may not be finished), so the HANDOFF the context watchdog writes says so under `Aktualis feladat` whenever the agent's own row is `active` or `stale`.

The stale sweeper (every 5 minutes) turns an `active` row into `stale` when it has not been updated for longer than the threshold of the agent's tier (`BB_STALE_ORCHESTRATOR_MIN` 120, `BB_STALE_INTERACTIVE_MIN` 90, `BB_STALE_SHORT_RUNNING_MIN` 30, `BB_STALE_DEFAULT_MIN` 60; an `assigned` row uses `BB_STALE_ASSIGNED_MIN` 120). Settings screen or `.env`; the values are minutes. Two rules keep it from marking live work:

- An agent whose scheduled run is still tracked in flight is skipped (its `active` row belongs to the runner). A run that really hangs is caught by the task-timeout alert instead.
- If a `stale` row is still the runner's own (same summary and task reference), the runner still writes `done` when the run ends. A `stale` row the agent rewrote is left alone.

The hygiene monitor (`scripts/blackboard-hygiene.py`, hourly command task) is the safety net behind both: it nudges an agent that works without keeping its row current, an idle agent with a `blocked` row older than 1 hour, and an idle agent whose `active`/`stale` row is older than 30 minutes (to close it). A nudge is held back by a coordinator maintenance turn or a fresh nudge, two rounds in a row escalate to the coordinator, and the coordinator itself is never nudged.

### Inter-agent messaging

Agents communicate via the `agent_messages` queue:

```bash
bash scripts/agent-api.sh POST /api/messages '{"from":"sender-agent","to":"target-agent","content":"Task description"}'
```

The message is injected into the target agent's tmux session; the agent processes it and responds on its own channel.

The executor closes a delegated message with `PUT /api/messages/<id>` (`status`: `done`, `failed` or `refused`, optional `result`). The delegator then receives a completion notice that starts with `[Eredmény]`; that notice is stored in the same tenant as the original message, so a tenant-scoped delegator sees the result of its own request. An agent's own token can close only the messages addressed to that agent (a foreign message is a 403, and one of another tenant a 404); the admin tokens can close any. A message closes once: a second `PUT` on a message that is already `done` or `failed` is a `409` with `status_conflict` and `current_status`, changes nothing and sends no second notice. That is not an error to repeat or report; the first close stands (the hint says so). To change a card's status use `POST /api/kanban/<id>/move` (body `status`, `actor`; optional `expected_status` moves the card only if it is still in that status, else `409` `status_conflict` with `current_status` and nothing is written; an unknown body key is a `400`), which also wakes the assignee and updates the parent card; `PUT /api/kanban/<id>` is for the other fields (title, description, priority, assignee, project) and does neither. The wake-up message carries no card text: it names the card (id, assignee, priority) and the command that reads it, `GET /api/kanban/<id>` with the agent's own token (a non-admin caller reads only a card of its own tenant, a foreign id is a 404). The text of a card is its author's, so the agent treats it as data, not as an instruction; a card whose id is not a plain token (letters, digits, `.`, `_`, `-`, at most 80) wakes nobody.

Tenant rule for this endpoint: a non-admin caller can only update messages of its own tenant (a message without a tenant counts as `default`). A message of another tenant answers exactly like a missing id (`404 not_found`), so message ids cannot be probed across tenants; the rejected attempt is written to the audit log. Admin callers are not restricted.

---

## Tenant management (RBAC)

Marveen supports multi-user operation: each tenant's data (memories, kanban, agents) is stored in isolation from other tenants.

> **Note:** tenant enforcement is **live** (`RBAC_MODE=enforce`): the gate refuses what a role does not allow, enforce is also the default when nothing is set, and shadow mode is only a rollback state chosen by name. Observation, rollback and the rules for touching the gate: "RBAC mode, shadow log and rollback" below.

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
bash scripts/agent-api.sh --token operator POST /api/v1/admin/tokens '{
    "name": "partner-token",
    "role": "agent",
    "tenant_id": "acme-corp",
    "expires_at": "2027-01-01T00:00:00Z"
  }'
```

```bash
# Revoke a token
bash scripts/agent-api.sh --token operator PATCH /api/v1/admin/tokens/<id> '{"revoked": true}'
```

### Onboarding a B2B partner

An external partner (B2B tenant) receives an `agent`-role token scoped to their own `tenant_id` and can only see data in that scope. Onboarding steps:

1. Create the tenant in the admin UI (Settings > Tenants)
2. Generate an `agent` token with an expiry (`expires_at`, e.g. 90 days)
3. Deliver the token over a secure channel (not in plaintext email)
4. Isolation test: a query for a `default` tenant memory using the new token must return an empty list
5. Agree on a rotation process: the partner should request a new token at least 2 weeks before expiry

### RBAC mode, shadow log and rollback

**The mode.** The mode is the `system_config` row `RBAC_MODE` (`enforce` | `shadow`), read by `getRbacMode()` (`src/web/rbac-mode.ts`) from an in-memory value that is refreshed after every settings write and by an unref'd 5 s timer, so a change needs no restart. The default is `enforce`; only the exact word `shadow` loosens, anything else (a typo, an empty value, a missing row, a read error) is `enforce`, and an error never keeps a previous `shadow`. The first boot seeds the row once from the process environment or `.env` (`RBAC_MODE`, no value means an explicit `enforce`; `INSERT` if absent, journalled in `config_change_log` as `system:migration`, never overwritten afterwards). After that the environment can only tighten: `RBAC_MODE=enforce` there wins over a stored `shadow` (the emergency brake), an environment `shadow` is ignored with a warning. A stored `shadow` also counts only when the newest `config_change_log` row for the key says `shadow` too; a row written by hand is `enforce` plus an audit row (`security.rbac_shadow_unlogged`) and a notice to the main agent. Known limit: this is a check, not proof of who wrote the rows. Whoever can write the database file writes the value and the journal row together, and the same operating-system user is not stopped by any dashboard rule; for agents that path is narrowed, not closed, by `scripts/hooks/auth-admin-gate.py` (`system_config` is one of its tables; it is a denylist: SQL read from a file with `.read`, `-init`, a stdin redirect or a `cat` pipe, and a table name that interpreter code assembles from pieces, are not seen, for every table it lists), and every switch to `shadow` the server reads is announced. Binding the journal row to something a writer cannot forge (an HMAC with the signing key) is a separate follow-up. Who may change it: tightening is open to any admin caller of `POST /api/settings`; loosening to `shadow` needs a person logged in to the dashboard as a global admin (`denyUnlessHumanSessionAlways`), and only while `APPROVAL_HUMAN_ONLY_ENFORCE` is on (`denyUnlessHumanOnlyEnforced`, `403 human_only_enforce_required`, an unreadable switch counts as off): with the switch off a token can still create a dashboard admin and log in as that person, so the human-session rule would prove nothing; users created while it was off stay valid, so review the user list when you turn it on, every token (the main agent's included), device key and federation peer gets `403 human_session_required`, the attempt is journalled and the row stays. Every loosening warns and tells the main agent, and the Settings screen asks for a confirmation first. Rollback is the Settings page (or `RBAC_MODE=enforce` in the environment plus a restart for the brake). Tests that touch the mode must use an in-memory or temporary database: a `shadow` row in the shared store would loosen the live gate. The gate (`applyRbacGate`, `src/web/authz.ts`) consults the permission table (`ENDPOINT_PERMISSION_TABLE`, `src/web/rbac.ts`); a route that is not in the table is `admin:all`. In enforce mode it refuses, in shadow mode it lets the request through and writes a `would-deny` row.

**The log.** Migration 0068's `rbac_shadow_log` table durably records the gate's decisions in both modes (time, tenant, caller kind and label, role, method, route, the permission required, decision, reason). The decision is `would-deny` (shadow let it through, enforce would refuse), `denied` (enforce refused it) or `permitted` (a non-admin request that passed; admin traffic is not recorded). The writer prunes rows older than 30 days at most once an hour, and a tenant delete purges the tenant's rows; a failed insert is logged and never changes the gate's decision or fails the request. To read it: `GET /api/v1/rbac/shadow-log` (admin-only: the route checks the role itself, and the `/api/rbac/` row is an explicit `admin:all`), filters `decision`, `tenant`, `principal`, `role`, `permission`, `route` (substring), `from`/`to`/`since_hours`, `limit`, `offset`; `summary=1` returns the counts per decision and the most frequent refusal shapes.

**The monitor.** `rbac-shadow-monitor` is a `type: command` scheduled task (`30 7 * * *`, `scripts/rbac-shadow-summary.py`, no LLM) that reads the last 24 hours with `summary=1`. Exit code: `0` when there is no `would-deny` and no `denied` row, `42` (the command-task findings code) when there is (a possible false positive; the first line of stderr is the alert text), `2` when the summary cannot be read. Both non-zero codes alert through the command-task health; a finding is not an error span and does not count toward the failure streak, while `2` is a real failure (`failThreshold` 1). The alert fires when the finding or failure starts and again after a clean day, not every morning. An empty window is reported on stdout ("no evidence") and is not a clean day. In enforce mode a `denied` row can be a legitimate refusal, so a finding is a call to review, not automatically a bug.

**The non-admin view.** `/api/marveen` and `/api/settings` are readable by every role (`memories:read`), but a non-admin caller (and one with no resolved role) gets an allowlisted view (`src/web/non-admin-views.ts`): from `/api/marveen` the `name`, `brandName`, `agentId`, `role`, `channelProvider` and the kanban display settings, from `/api/settings` only `DASHBOARD_LANG` (`key`, `type`, `value`, `default`); the filter runs before any value is resolved, so a secret or unlisted setting is never resolved. **Rule:** a field added later stays admin-only until someone puts it on the allowlist. The agent readers (`/api/agents`, `/api/team/graph`, the latter `agents:read`) narrow to the caller's tenant's agents, and the agent export (`export-all`, `<name>/export`) is admin-only, checked by the route itself.

**Gating the dashboard.** Pages and tabs carry a `data-rbac-perm` attribute in `index.html`, and one router guard (`web/modules/nav-gate.js`, `can()`/`roleHas()` from `rbac-client.js`) redirects to the overview. A caller with no session role (the legacy bearer token) sees everything, and the guard never unhides what other code hides. It is a UX layer only: the server's 403 decides. Give a new admin-only page a `data-rbac-perm`; the drift test of the client role map (`rbac-client` against `rbac.ts`) fails when a permission is missing from it.

**Accepted risks.** (1) The fleet token is admin, so the running agents are not tenant-limited; the tenant boundary applies to tenant users' own tokens and logins. (2) The main agent is deliberately outside the tenant skill gate (a fail-closed hook could stop the fleet's coordination); the other agents have the hook. (3) There is no Marveen-hosted MCP server, so there is no MCP-level tenant filter; if one is ever built, tenant filtering is mandatory (see F06). (4) A shared agent can still read another tenant's skill rows through the API with the fleet token; the use-time gate covers the `Skill` tool and file access, not a `curl` from a shell (see F02).

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

- **Row order and route rules.** Two ordering rules hold if you touch the group: the `tick-status` row stays before the GET prefix row, and the activate row stays in the regex table (consulted first); a new admin-only schedules route has to be matched before the prefix row of its method. Route rules that apply **whatever `RBAC_MODE` says** sit in `src/web/routes/schedules.ts` (`nonAdminRefusal`, run for every `/api/schedules*` path before any other check) and apply to callers whose role is not `admin`: an account without a tenant gets 403 on every request including reads; a write needs `auth.kind` `session` or `token` (a device key and a federation principal get 403); a write on the `default` tenant gets 403. The shared dashboard token and a signed-in admin carry the `admin` role and are exempt from this function; what they may write is decided by the review gate below. The permission rows, on the other hand, only decide anything in `enforce` mode (the live mode): there the role differences (for example `read_only` and `viewer` writing) show up as refusals. In a rolled-back shadow mode `applyRbacGate` logs a would-deny (`rbac:shadow` in the log, and a row in `rbac_shadow_log`) and lets the request through; while the mode stands there, do not give tenant users a login or token that can reach the API.
- The rest of the tenant rules sit in the route handlers and hold in both modes: other tenants are invisible (404), activation needs a signed-in admin (403), `status`, `tenantId` and the runner script keys of an edit are dropped, a non-admin's `agent` key is ignored, a non-admin naming a different `tenant_id` gets 403, and a task a non-admin creates is a `draft` in its own tenant.
- **Review gate and re-review.** Status is `draft` (never approved), `pending_review` (approved, then changed by a caller that is not a signed-in admin) or `live`; the runner holds both non-live states the same way (see "Held-back occurrences"). `PUT /api/v1/schedules/<name>` by anyone who is not a signed-in admin (`isHumanAdmin`: role `admin` and `auth.kind` `session`; the shared token has the role but is no person) sets a `live` task to `pending_review` when it changes any of `prompt`, `command`, `type`, `schedule`, `agent`, `targetSession`, `timeoutMs`, `failThreshold`, `skipIfBusy` or `forceSend`. `description` and `enabled` never trigger it. The comparison is per field against the row as it is stored at the moment of the write (`reviewTriggerFields` in `src/web/schedule-review.ts`): strings are trimmed, an empty string, null and a missing value are the same, `false` equals unset for the two boolean options, numbers and strings differ by type. Resending the stored values (the dashboard does that on every save) is therefore a no-op: the task stays `live` and the answer is a plain `{ ok: true }`. A task that is not live keeps its status when edited, a tenant move by an admin stays a plain `draft` and does not go through this rule, and the rule lives in the route and the pure helper, not in `writeScheduledTask`, because the seed, fleet import and the toggle file mirror call that writer directly. The write lands first; a triggering edit answers `{ ok: true, status: "pending_review", review_required: true, changed: [field, ...] }`.
- **Activation protocol.** `GET /api/v1/schedules` adds `contentHash` to every task: a SHA-256 over the reviewed fields (`REVIEWED_FIELDS`: prompt, schedule, agent, type, skipIfBusy, forceSend, targetSession, command, timeoutMs, failThreshold) in fixed order and normalised form, so a changed description or enabled state does not move it. `POST /api/v1/schedules/<name>/activate?expected_hash=<contentHash>` compares it with the current hash and answers `409 stale_revision` with `content_hash` (the current value) in the body when they differ; nothing is activated, and the dashboard reloads the list so the admin looks at, and then activates, the current content. The parameter is optional: a caller with no screen (a script, the `dashboard-schedule-crud` recipe) omits it and activation is unchecked. The route needs a signed-in admin either way (403 otherwise). `stale_revision` is an error token in the catalog (`src/api-error-catalog.ts`, allowed for 409), the OpenAPI enum and both dashboard languages.
- **Draft cap.** A tenant may have at most 20 schedules that are not live (draft or `pending_review`), `MAX_OPEN_REVIEW_PER_TENANT` in the route. Creating the 21st draft answers `400 limit_exceeded` (field `name`, hint with the count) and writes nothing. Live tasks do not count, deleting frees a slot, editing a task the tenant already owns is never blocked, and a signed-in admin creating a `live` task is exempt; an agent on the shared token creating a draft for a tenant is counted. Who may create: any caller the route guards let through creates a `draft`; only a signed-in admin creates `live`.
- **Audit and notification.** Every schedule write writes one `agent_audit_log` row (entity `schedule`; action `create`, `update`, `delete`, `toggle`, `activate`, `review_requested` or `retarget`, the last being the re-aim of a tenant's starter pack; entity id the task name). The detail holds the tenant, `actor_kind` (`session`, `token`, `device`, `other`), the self-declared `X-Agent-Id` kept apart as `claimed_agent` (it is not authentication), and for an edit the changed field names with a before and after SHA-256 and a short preview of the new value (200 characters), never the whole value. The `agent_id` is the session user, `token:<name>` for a scoped token, `claimed:<id>` for the shared token with a header. A write that is refused (another tenant's task, a 403) leaves no row. A task sent back to review, and a draft created by a non-admin, also send the main agent a system message (`createAgentMessage('system', MAIN_AGENT_ID, ...)`) of the form `[SCHEDULE_REVIEW] task=<name> tenant=<id> reason=edited|created|retargeted [changed=[...]] by=<actor>`. The `retargeted` reason only occurs when a tenant's starter pack is re-aimed, and only when the trigger is not a signed-in admin (see "Tenant starter pack"). It is at most one message per task and reason per hour, the throttle is in memory (a restart can send one more), and an audit or notification failure never fails the write (best effort). What the main agent does with it is up to its own instructions.
- **Dashboard.** The Tasks page gates on `can('schedules:write')`: the **+ Task** button, the edit dialog's save and the Run now, Pause and Delete actions. Activation and the scheduler heartbeat indicator gate on `can('admin:all')`. A held task shows the badge `tasks.status.pending_review` ("awaiting review" / "jóváhagyásra vár"), and a save that answers `review_required` shows the `tasks.toast.review_required` toast. The Activate request carries `expected_hash`. The role-permission matrix and the screen-access matrix of the Users tab list the two permissions and the Tasks screen row follows them.
- **Adding a permission.** The permissions are one tuple, `ALL_PERMISSIONS` in `src/web/rbac.ts`, and the `Permission` type derives from it. The dashboard keeps hand-written mirrors that cannot import it: `web/modules/rbac-client.js` (the `can()` role map), `web/modules/rbac-permission-matrix-data.js` and `web/modules/rbac-screen-access-data.js`, plus the i18n labels (`admin.b2b.perm.<resource>.<action>.label` / `.desc` and the category label, in both `hu.js` and `en.js`). `src/__tests__/rbac-permission-matrix-data.test.ts` walks `ALL_PERMISSIONS` against the matrix mirror and fails on a permission without a row, and `rbac-screen-access-data.test.ts` checks that the Tasks screen row follows `schedules:read` and `schedules:write`. The role map of `rbac-client.js` (`ROLE_PERMISSIONS`, exported for the test) is walked against `rbac.ts` role by role by `rbac-client-mirror.test.ts`, so a permission that went missing there fails; still change the map together with `rbac.ts`.

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
| `memory-maintenance` | `15 3 * * *` | Daily memory maintenance (tier reassignment, version pruning, link-graph upkeep), a command task without an LLM that runs `scripts/memory-maintenance.sh`: a failed call or a link upkeep that failed for most memories fails the run, memories that could not be linked are a finding (exit 42) |
| `daily-log-summary` | `30 22 * * *` | Evening daily-log summary, a command task without an LLM that runs `scripts/daily-log-summary.py` as the main agent. Seeded once per install by `ensureDailyLogSummaryTask` (`src/web/daily-log-summary-task.ts`, marker `store/daily-log-summary.seeded`, like `claude-update`): an existing install gets it too, a deleted task is not put back, an edited row is not overwritten. `catch_up_max_age_minutes` 85 (a missed run is made up only until 23:55, because the entry is filed under the day it runs on), `fail_threshold` 2. The script reads only the API (`--token main`): the default tenant's memories (`limit=200`, counted per agent, keywords only), kanban cards and workspace documents of that day, plus the first-parent merge commits of its own checkout (`DAILY_LOG_SUMMARY_GIT=0` switches that off), and POSTs one `## Napi összefoglaló YYYY-MM-DD` entry to `/api/daily-log`. The text of a memory is never quoted (the owner's decision: free private text, and no scrub is a guarantee); only its keywords are (the most frequent 8, case-folded, each through the scrub, and left out when they hold a secret or an e-mail address, more than 4 digits or more than 40 characters). Every other quoted text (card and document titles, merge subjects) goes through `scrub()` first, on the whole text and before the cut to 90 characters: a Python port of the key shapes of `src/otel-scrub.ts` (`KEY_SCRUBS`, `SCRUBS`, `BLOB_SCRUB`, and the e-mail rule of `TEXT_SCRUBS`; its path and id rules are left out) plus PEM blocks and the Hungarian `jelszó` / `titok` / `kulcs` assignments. Unlike the original, the long-blob rule works on whole runs (`[A-Za-z0-9+/_-]{32,}`, one linear pass) and leaves a run alone when it is an identifier: it has separators (`-` `_` `/`; a `+` only occurs in base64 and stays inside a piece), every piece between them is lower case, letters and digits, at most 16 characters, and at least one piece has a letter outside a-f, so hex fragments joined by hyphens or underscores are not taken for a name (`report/<id>-workspace-search-delta-qa`, `hot_1017_phase0_prep`). A canonical UUID is the one exception and stays readable. A run with a long or mixed-case piece (`sk_test_51Hx...`, a base64url token, a hex digest, `secret_<28 hex>`) is starred out; Stripe-style keys also have a rule of their own. Every text is cut to 4000 characters before scrubbing (the rules, like the original, go quadratic on one very long run) and the last 200 characters of a cut text are dropped, so a secret split by the cut cannot reach the 90-character excerpt. Keep the two scrubs in step when one changes. Tenant filtering is done in the script (`in_default_tenant()`, the admin token returns every tenant's rows), so a new data source must be filtered the same way, as the comment at the top of the script says. It writes once a day (the header already in the day's log means exit 0 with no write), files an empty day as one line, and exits 1 when a call fails. `DAILY_LOG_SUMMARY_API` replaces the API wrapper in tests |
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
- Besides the schedules, a tenant delete also removes the tenant's other keyed rows (cost budgets, egress allowlist, ideas, vault bindings, import sources and their audit log, raw token usage, blackboard history); the agent-keyed rows (`agent_settings`, `agent_state`, `fleet_blackboard`) are deleted only for the tenant's exclusive agents, while a shared agent's row is re-tagged to `default`. The `purged` and `exclusive_agents` response fields and the audit entry show this; details: [F04](F04-architecture.md).
- Fleet import re-homes a schedule whose exported `tenant_id` is not an enabled tenant on this machine to `default` (tenants are local to a machine). Schedules still arrive disabled, and the dry run and the apply report count how many were re-homed.
- Overview `tasksToday` in a tenant view counts the `task_runs` of that tenant's schedules (matched by task name), not the runs of the tenant's agents, so an agent shared by several tenants no longer vanishes from every tenant view. A run whose schedule was deleted since belongs to no tenant and only shows in the fleet-wide count.
- `tenant_required` is an API error token (`400`) with a dashboard message.

### Tenant starter pack

A tenant's starter pack is, for now, one ready-made scheduled task, the daily summary: `<tenant>-starter-daily-summary` (the tenant id run through `sanitizeScheduleName`, plus the `-starter-daily-summary` suffix). The code is in `src/web/tenant-starter-pack.ts`, the template under `templates/tenant-starter-pack/daily-summary/` (`SKILL.md` and `task-config.json`), the routes in `src/web/routes/admin-b2b.ts`. The pack contains no heartbeat task: it does not touch the fleet memory heartbeat sweep, and the two do not overlap.

**Automatic creation for new tenants.** `POST /api/admin/tenants` marks the new tenant as owed a starter task (`markStarterPackPending`: an empty file `store/starter-pack-pending/<tenant>`) and tries to create it at once (`autoCreateStarterPack`, which calls `createStarterPack`, so the result is the same draft + disabled row with the same agent rules). A new tenant has no agent yet, so that normally refuses with `ambiguous`; the marker then stays, and `PUT /api/admin/agent-availability` tries again after its reconcile. The marker is removed when the task exists (or its name is taken by another tenant's task, which waiting cannot cure), so an admin who deletes the task does not see it return. A tenant without the marker, which means every tenant created before this release, is never touched by it: the button (`POST .../starter-pack`) stays the way to give those their task. The pack is deliberately one tenant-scoped LLM task, not the install-level `daily-log-summary` command task: that one reads the default tenant only, and the tenant task must run in the tenant agent's name from the tenant's own memories.

**Template.** Written in Hungarian, a single file, four placeholders: `{{TENANT_ID}}`, `{{AGENT_ID}}`, `{{INSTALL_DIR}}` and `{{WEB_PORT}}` (`renderStarterPrompt`, a pure function). The tenant's display name does not go into the prompt, and the template is tenant-neutral (checked by `tenant-starter-pack-template.test.ts`). Schedule `30 21 * * *` (in the server time zone), type `task`, `skipIfBusy` and `forceSend` false. The type is `task` because the runner only gives a delivery instruction to non-heartbeat types (see below). The task's one data source is the last 24 hours of `GET /api/memories?agent=<agent>&tenant=<tenant>&limit=50&include_docs=0`; the daily log serves the repeat guard (the `## Napi összefoglaló YYYY-MM-DD` header) and holds the result, but is never a data source. The daily log is not tenant-keyed, which is why the memory read is tenant-filtered.

**Endpoints.** Both are `admin:all` through the `/api/admin/` prefix, in the legacy and the `/api/v1` spelling alike. The route additionally checks itself that the caller's role is `admin`: shadow mode (the rollback state) never blocks, and a tenant user must not get through on it (`rbac-starter-pack.test.ts` covers the permission rows, `tenant-starter-pack.test.ts` the route-level check).

- `GET /api/v1/admin/tenants/<id>/starter-pack` only reads: `{ tenant_id, name, exists, state, task, resolution }`. `state` is `absent`, `ok`, `retarget_pending` (the next re-aim would move it) or `needs_agent`; `task` is `{ agent, status, enabled }` or `null`; `resolution` is `{ agent, reason }`, that is the agent a create would pick right now, or why it cannot pick one.
- `POST /api/v1/admin/tenants/<id>/starter-pack` takes `{ agent_id? }`; `201` when it created the task, `200` otherwise: `{ ok, tenant_id, agent, state, created, skipped, retargeted, reason? }`, where `state` is `created`, `ok`, `retargeted` or `needs_agent`.
- Errors: `400 invalid_value` (field `id`) for the `default` tenant; `404 not_found` for an unknown or disabled tenant; `403 forbidden` for a non-admin; `400 required` (field `agent_id`) when there is no single agent; `400 invalid_value` (field `agent_id`) when the given agent does not serve the tenant; `409 conflict` when the agent also serves another tenant, or when a task of that name already belongs to another tenant. `docs/openapi.yaml` holds the full shape.
- Audit: one `admin.tenant.starter_pack` row, plus an ordinary schedule audit row for the task write (`create` or `retarget`, flagged `starter_pack: true`).

**Choosing the agent** (`resolveStarterAgent`), the first match wins: (1) the tenant exists, is not disabled and is not `default`; (2) the given `agent_id`; (3) the tenant's `main_agent_id`, when it is a known agent and not the fleet's main agent; (4) exactly one agent enabled for the tenant (the fleet's main agent excluded); (5) otherwise ambiguous (zero or several candidates). A candidate has to serve the tenant (the same (tenant, agent) pair rule as the schedules route), and must not be shared: one that is also enabled for another tenant, or is another tenant's main agent, is refused. A shared agent would run the prompt in whatever tenant context its session happens to hold.

**Creation.** The task is created `draft` and disabled (`enabled=false`), with `writeScheduledTask` directly, not through the schedules POST route: the caller is an admin, so the draft cap does not stop it and no `[SCHEDULE_REVIEW]` notification goes out. The two steps (activate, then enable) are deliberate. A draft that is enabled would write a `skipped_not_live` row for every due occurrence and count towards the mass-skip alert; a live task that is disabled could be switched on by a tenant user without approval. Activation only sets the status, `enabled` stays false, and the task is enabled by Resume (the toggle), for which `schedules:write` is enough.

- **Idempotent.** When a row of that name already belongs to the tenant (name and `tenant_id` match), the call does not write again (`skipped: [{ name, reason: "exists" }]`) and runs the re-aim described below instead. A hand-edited prompt, schedule or `enabled` is never overwritten. A task the admin deleted is created again by the call.
- **Name collision.** The tenant id allows `--`, while `sanitizeScheduleName` collapses it, so two tenant ids can lead to the same name. When a task of that name already belongs to another tenant, the call answers `409` and writes nothing.
- **Draft cap.** The starter pack's draft takes one place of the tenant's limit of 20 non-live tasks (`MAX_OPEN_REVIEW_PER_TENANT`) until it is activated or deleted. There is no marker column (it would need a migration); the task is identified by its exact name and `tenant_id`. It never looks up by prefix, because a tenant user can create a task named `<tenant>-starter-...` through the route.
- **Deleting the tenant.** It removes the task, its pending retries and its file mirror with no extra code, like any other task ("Around the edges").

**Re-aim** (`reconcileStarterPack`). The task follows the agent behind it. It has two triggers: (a) after every `PUT /api/v1/admin/agent-availability`, next to `regenTenantSkillFiles`, inside a try/catch so a failure never fails the PUT; (b) repeating the POST (the button is also the manual repair). There is no hook on deleting or renaming an agent, nor on changing the tenant's `main_agent_id` column from SQL (`PATCH /admin/tenants/<id>` does not accept the field): in those cases the runner stops and alerts a task that is live and enabled (`skipped_tenant_mismatch`), and the fix is to repeat the POST. Row by row the rule is:

- A definite target (the tenant's main agent, or the only enabled agent) that differs from the task's current agent: `agent` is replaced and the task goes to `draft` and disabled. Only these three fields change; the prompt, schedule and description (with any human edits) stay. Audit: `retarget`, with `from` and `to`.
- The target equals the current agent, or there is no definite target but the current agent is still valid (it serves the tenant and is not shared): nothing changes. Enabling a second agent therefore neither moves nor demotes the task.
- The current agent is no longer valid and there is no definite target: the task goes to `draft` and disabled (parked), the agent stays, the state is `needs_agent`. The runner no longer alerts on it, because a disabled task is in the `disabled` class.
- Idempotent: the second run writes, audits and notifies nothing. It never touches another tenant's row of the same name, nor a user task named `<tenant>-starter-...`.

The re-aim does not go through the schedules PUT route, so the demotion rule there (editing a live task) does not run: the operation sets `draft` itself. When the trigger is not a signed-in admin (`isHumanAdmin` false, for example an agent calling with the shared token), the main agent gets a `[SCHEDULE_REVIEW]` message with `reason=retargeted` (with the existing one-per-hour throttle); a signed-in admin knows from the response and the panel, and no message goes out.

**Recipients of the channel message (runner).** `buildTaskDeliveryPrefix` in `src/web/schedule-runner.ts` puts the delivery instruction in front of a non-heartbeat task's prompt. For a task of a tenant other than `default` the recipients come from `resolveTenantDeliveryChats(agent, tenant)`: of the `tenant_channel_bindings` rows of the (tenant, agent) pair, those that

- belong to the Telegram channel and have a digits-only id (a private chat; a group chat's id is negative, so it is left out), and
- whose id is also in the `allowFrom` list of the agent's Telegram `access.json` (so the reply tool can deliver to it), and
- at most `MAX_TENANT_DELIVERY_CHATS` (3), in the order of the bindings.

With no such recipient the prompt gets no Telegram instruction (a `tenant has no deliverable telegram binding` warning goes to the log) and the task runs silently. Before, every task got the first entry of the agent's `access.json` `allowFrom`, with no tenant context; that could be the fleet owner, so a tenant's task could send its result to the wrong person. For tenants other than `default` that is gone, and it applies to every tenant task, not just the starter pack. A task of the `default` tenant still gets the agent's bound chat (`resolveBoundChatId`), and a heartbeat still gets no delivery instruction. The recipients are shaped only by bindings made through the admin API (`PUT`/`DELETE /api/v1/admin/channel-bindings`, see F03 "Tenant skill gate"); there is no UI for it. The only channel for now is Telegram.

**Dashboard.** On the **Tenants** tab, every tenant row other than `default` has a **Starter pack** button (`show-starter`) that opens the panel under it: it shows the `GET` state, offers an agent picker only when the server cannot choose, and its button calls the `POST`. The panel refreshes after an agent availability change. The button and panel are rendered for a global admin only (`role === 'admin'` with no tenant scope, the same condition as the rest of the Tenants tab's controls); for anyone else they are not in the DOM. That condition is display only, the protection is the route check. The new strings are the `admin.b2b.starter.*` keys in `hu.js` and `en.js`.

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
- Health is tracked per task in `store/command-task-health.json` (failure streak, last status, last run). A Telegram alert is sent once when the streak reaches `failThreshold`, and a recovery message when the task succeeds again. With `failThreshold: 1` the first failure alerts. Exit code `42` is a **finding**, not a failure: the run span stays `ok` (so it is not an error on the Overview), the failure streak is untouched, one "finding" alert goes out when the findings start, and the recovery message follows the first clean run. Alerts need the Telegram token and chat id to be configured; otherwise they are only logged.

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

`scripts/fleet-heartbeat-sweep.sh [stagger_seconds]` asks every running sub-agent (discovered live from `/api/agents`, the main agent excluded) to run its own memory heartbeat, one agent at a time with a pause between them (default 60 seconds). Log: `store/fleet-heartbeat-sweep.log`. It is meant to be triggered by a scheduled task every few hours. A tenant's starter pack contains no heartbeat task (see "Tenant starter pack"), so it does not overlap with the sweep.

The sweep multiplies one scheduled decision into one model turn per agent, so it has its own quota guard. It reads `store/claude-usage.json` and skips the whole sweep when the higher of `sessionPct` and `weeklyPct` reaches `QUOTA_THRESHOLD` (default `75`). The guard only trusts a **fresh** snapshot: if `fetchedAt` is older than `QUOTA_STALE_MINUTES` (default `20`), or missing, the guard logs the reason and lets the sweep run (fail-open). A usage number that stopped updating therefore cannot silence the sweep for weeks.

**An agent that serves only tenants other than `default` is left out.** The tenant stamp of a message sent as an admin is always `default`, so the sweep directive would reach such an agent in the `default` context, and the memories the agent saves during the heartbeat would land in the `default` tenant: visible to the fleet, and not removed when the tenant is deleted. The sweep therefore decides who is left out from the `/api/agents` fields. A running agent is left out when

- its `tenantIds` list (the tenants it is enabled for) is not empty and does not contain `default`, or
- its `primaryTenantId` (the id of the tenant it is the main agent of) is not `default`.

A shared agent, one that is also enabled for the `default` tenant, stays in, unless it is also another tenant's main agent: the second condition leaves it out then. An agent that serves no tenant at all (empty `tenantIds`, no `primaryTenantId`) stays in. A missing field (an older `/api/agents` answer) also reads as "not left out": nothing is skipped and the sweep runs as before. The main agent is still always left out, and the quota guard decides first; the tenant filter only matters after it.

Each skipped running agent gets one line in `store/fleet-heartbeat-sweep.log` (`-- <agent> : skipped (serves only non-default tenants)`) and is not counted in the "triggered" total. If no running agent is left after the filter, the log ends with the `no running sub-agents found, nothing to do` line.

Side effect: the main agent of a tenant other than `default` (a tenant's coordinator, for example), or any agent serving only such tenants, gets no automatic memory heartbeat from the sweep. Keeping that tenant's memory tidy is then up to the agent's own session; the tenant starter pack does not make up for it (it writes a daily summary, not a heartbeat).

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
bash scripts/agent-api.sh --token operator GET /api/federation/key

# Register the partner's key
bash scripts/agent-api.sh --token operator POST /api/federation/enroll '{"bundle": "<base64-bundle-from-partner>"}'
```

Key exchange must be performed in both directions. The setup is also available from the dashboard Settings > Federation page.

---

*Previous: [F06 MCP connectors](F06-mcp.md)*
