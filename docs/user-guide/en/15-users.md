# 15 - Users `[ADMIN]`

> This section is visible to administrators only.

The Users view is the access management hub: manage tenants, dashboard accounts, device keys, API tokens, partner senders, and skill access. The full view is only available to global admins (admin role with no tenant scope).

---

## Tabs

The page is divided into six tabs:

- **Tenants** -- manage B2B data islands
- **Users** -- dashboard login accounts, roles, permission matrices
- **Device keys** -- paired mobile devices and Bridge connections
- **Tokens** -- create, rotate, and revoke API tokens
- **Partner senders** -- allowlist management for federated agents
- **Skill access** -- which skills are available to which agents

---

## Roles and permissions

The system defines four access levels.

**Admin** -- full access to all tenant data and the admin interface. Running agents use a bearer token with admin privileges.

**Agent** -- full read and write access to one tenant's data (memories, kanban, messages, blackboard, scheduled tasks). No access to other tenants' data or the admin interface. Default role for B2B partners.

**Read-only** -- read only: list memories, kanban, agents, blackboard, and scheduled tasks. No create or delete.

**Viewer** -- dashboard view: read memories, kanban, and agents, without blackboard. Default role for new users.

### Permission summary

| Feature | admin | agent | read_only | viewer |
|---------|:-----:|:-----:|:---------:|:------:|
| Read memories | X | X | X | X |
| Write/delete memories | X | X | | |
| Read kanban | X | X | X | X |
| Write/delete kanban | X | X | | |
| List agents | X | X | X | X |
| Send messages to agents | X | X | | |
| Read approvals | X | X | X | X |
| Write approvals | X | | X | X |
| Read blackboard | X | X | X | X |
| Write blackboard | X | X | | |
| Read scheduled tasks | X | X | X | X |
| Create/edit/pause/run/delete scheduled tasks | X | X | | |
| Activate scheduled tasks (approval) | X | | | |
| Agent settings (context guard, auto-restart) | X | X | | |
| Read federation | X | X | | |
| Write federation | X | X | | |
| Admin interface | X | | | |

The "Role-permission matrix" view on the Users tab mirrors live source data -- this table follows the code, not the other way around.

---

## Token management

### The base bearer token

The `store/.dashboard-token` file generated at install time holds an admin-role, globally-scoped token. Until the per-agent tokens are enforced it keeps working for every agent; each agent now calls the API with its own token (`agents/<id>/.agent-token`) and falls back to this one only when its own file is missing (see the fork guide, F07).

### API tokens (Tokens tab)

The **Tokens** tab lets you create additional tokens. Each token has:

- **name** -- human-readable identifier
- **role** -- admin / agent / read_only / viewer
- **tenant scope** -- which tenant's data it can access (empty for global admin)
- **expiry** -- optional; if not set, the token does not expire
- **revocation state** -- a revoked token is immediately invalid; data is not deleted

**Create a token:** click **+ Add token**, fill in the fields. The raw token value is shown only once -- save it somewhere secure.

**Rotate a token:** use the button at the end of the row to generate a new token. The old one is immediately invalidated.

**Revoke a token:** revocation is immediate. Requests with a revoked token receive a 401 error.

---

## Tenant management

A tenant is an isolated data island. All data (memories, kanban, messages, imported content) belongs to a specific tenant. That data is not visible or modifiable with another tenant's token.

**Add a tenant:** use the **+ Add tenant** button on the Tenants tab. The identifier (slug) cannot be changed after saving.

**Disable a tenant:** revokes the token and removes access -- data is retained.

### Tenant isolation and the RBAC mode

The RBAC gate **runs in enforce mode** (`RBAC_MODE=enforce`): what the caller's role does not allow is refused (403), and queries are filtered by the caller's tenant scope. The earlier shadow mode only logged and let every request through; it is now just a fallback state (see below).

**What a non-admin caller sees:**
- The agent list and the org chart are narrowed to the agents enabled for the caller's own tenant. There is no main-agent node, no other tenant's id or name, and no link that points at a hidden agent.
- The blackboard narrows to the caller's own tenant; the whole-fleet picture is the admin's.
- The brand and the language are readable by every signed-in role (`GET /api/marveen`, `GET /api/settings`), but a non-admin receives only an allowlist: the name, the brand name, the agent id, the role, the channel provider and the kanban display settings, and from the settings only the value of `DASHBOARD_LANG`. Instruction files, MCP configuration, the owner's name, the model and the session are not shown. Writing (`PUT /api/marveen`, `POST /api/settings`) stays admin-only.
- The agent export (`/api/agents/export-all`, `/api/agents/<name>/export`) is admin-only.
- The dashboard hides the pages a role cannot use: Messages, Skills, Ideas, Artifacts, Token monitor, Updates, Settings, Backups, MCP connectors and Import (all `admin:all`) are not shown to a non-admin, and Federation (`federation:read`) is not shown to `read_only` and `viewer`. A typed hash or a bookmark to such a page lands on the overview. This is a UI layer only: the server's 403 stays the last word.

**Observation: the shadow log.** The gate writes every decision to the `rbac_shadow_log` table, in both modes:

| Decision | Meaning |
|----------|---------|
| `would-deny` | shadow mode let it through, enforce mode would refuse it |
| `denied` | enforce mode refused it |
| `permitted` | a non-admin request that passed (admin traffic is not recorded, it carries no signal) |

Rows older than 30 days are pruned, and a tenant delete purges the tenant's rows. To read it: `GET /api/v1/rbac/shadow-log` (admin only) with the filters `decision`, `tenant`, `principal`, `role`, `permission`, `route`, `from`, `to`, `since_hours`, `limit` and `offset`, or with `summary=1` for the counts per decision and the most frequent refusal shapes.

The `rbac-shadow-monitor` scheduled command task (daily at 07:30, no LLM) summarises the last 24 hours and alerts when there is any `would-deny` or `denied` row, or when the summary cannot be read. In enforce mode a `denied` row can also be the gate working as intended (for example a `viewer` trying to write), so the alert is a call to review: was it a legitimate refusal or a false positive. An empty window means no non-admin traffic arrived, not that everything is fine.

**Rollback.** If enforce causes a wrong refusal, set `RBAC_MODE=shadow` in the server environment (`.env`) and restart the dashboard (the mode is read at startup). The route rules that do not depend on the mode (schedules, starter pack, the agent export's admin check) stay in force in shadow mode as well.

**Accepted risks:**
- The fleet bearer token (`store/.dashboard-token`) has the admin role, so an agent that falls back to it is not tenant-limited. The tenant boundary applies to tenant users' own tokens and logins.
- The main agent is deliberately outside the tenant skill gate: a fail-closed hook could stop the fleet's coordination.
- Marveen does not run an MCP server of its own, so there is no tenant filter at the MCP layer. The catalog servers are external and do not know the tenant id.

### Deleting a tenant

Deleting a tenant (`DELETE /api/v1/admin/tenants/<tenant_id>`, admin only; the `default` tenant cannot be deleted) is permanent and cannot be undone. The delete removes the tenant's data in one transaction: memories, kanban, messages, working documents, skills, scheduled tasks, secrets (vault), imported knowledge, and the following, which earlier versions used to leave behind: cost budgets, egress allowlist entries, ideas, vault bindings, import sources with their audit log, the raw token usage rows (content previews and task titles included) and the blackboard history.

- **Agent-level settings follow the agent, not the tenant.** An agent's settings, state and blackboard row are tagged with the tenant that wrote them, but they are not owned by it. If the agent was enabled for the deleted tenant and no other, those rows are deleted. If it also serves another tenant (a shared agent), its settings stay, re-tagged to `default`.
- **What stays.** API tokens, as revoked tombstones kept for the audit trail; the daily and monthly token rollups (numbers only, no tenant identifier).
- **The response** lists the rows removed per table in `purged` (`<table>_retagged` for re-tagged rows) and, in `exclusive_agents`, the agents left without a tenant. The delete does not touch an agent's process, bot or directory: stopping or removing them is a separate step. The `admin.tenant.delete` audit entry carries the same fields.

### Scheduled tasks and tenants

Scheduled tasks are owned by a tenant (details in [06 - Tasks](06-tasks.md)):

- Every task belongs to exactly one tenant. The system's own tasks (backup, maintenance, monitors) and every task created without naming a tenant belong to `default`.
- A tenant user only gets the tasks, the agents to choose from and the pending retries of its own tenant. Another tenant's task answers as if it did not exist.
- Access is governed by two permissions: `schedules:read` (list the tasks, their runs and the pending retries) and `schedules:write` (create, edit, pause or resume, run and delete). The `admin` and `agent` roles have both, so every tenant user can manage the tasks of their own tenant in the dashboard: the **+ Task** button, the edit dialog and the Run now, Pause and Delete actions are theirs. `read_only` and `viewer` only have `schedules:read`: they see the tasks, the **+ Task** button is hidden and the row actions are disabled. There is no per-tenant switch; the role grants the permission.
- Activation and the scheduler heartbeat indicator stay admin-only (`admin:all`), and activation additionally needs a signed-in admin. Moving a task to another tenant is also an admin action. A task a tenant user (or an agent on their behalf, through the chat) creates is a draft in that user's tenant, and an admin activates it after seeing which tenant it belongs to. A tenant can have at most 20 tasks waiting for review at a time.
- When a tenant user changes what an approved task executes (prompt, command, schedule and so on), the task goes back to review: it stops running until an admin activates it again. Details, with the exact fields: [06 - Tasks](06-tasks.md).
- The default tenant holds the system's own tasks. Nothing on it can be changed by a non-admin, and a non-admin account that has no tenant is refused on every schedules endpoint.
- A task only runs on an agent that serves its tenant. If the agent is switched off for the tenant, or the tenant is disabled, the task stops firing and each missed occurrence is recorded as `skipped_tenant_mismatch` in its run history.
- Deleting a tenant also deletes its tasks, their pending retries and their mirrored files.

> **Scheduled-task rules and the RBAC mode.** Two layers decide who may do what with the schedules endpoints, and only one of them depends on the mode.
>
> - **Route rules, in both modes** (shadow mode too). A non-admin caller (a dashboard login or an API token that is not admin) whose account has no tenant is refused with 403, for reads as well. A non-admin cannot change tasks on the `default` tenant (the system's own tasks stay with the admins), and a device key or a federation principal cannot change any task (403). Another tenant's task answers 404, as if it did not exist. Activation needs a signed-in admin (403 for everyone else, the shared agent token included). An edit cannot change a task's status, tenant or runner script options (those keys are dropped; asking for a different tenant answers 403), the agent of a task is changed by admins only, and a task a non-admin creates is always a draft in their own tenant, within the limit of 20 tasks waiting for review per tenant. A non-admin edit of what a live task executes sends it back to review (see [06 - Tasks](06-tasks.md)).
> - **The permission table, in enforce mode.** `schedules:read`, `schedules:write` and, for activation and the scheduler heartbeat, `admin:all` are checked by the RBAC gate only when `RBAC_MODE=enforce`. In enforce mode the differences between the roles (for example that `read_only` and `viewer` do not write) show up as refusals. If you roll the mode back to shadow, the gate only logs what it would refuse and those differences no longer apply.
>
> If you roll the mode back to shadow, do not give tenant users a login or token that can reach the API until enforce is switched back on.

### Tenant starter pack

The starter pack is a ready-made scheduled task (a daily summary) for a tenant. What the task does, how to activate it and who gets the channel message: [06 - Tasks](06-tasks.md#tenant-starter-pack). This section describes where the button is and who can reach what.

**Where the button is.** On the **Tenants** tab, in each tenant's row next to the agent-management button, there is a **Starter pack** button (not on the `default` tenant). Clicking it opens the Starter pack panel below the tenant list. The panel shows:

- the state of the task: not created yet, up to date, waiting to be re-aimed (the agent changed), or parked (the task's agent no longer serves the tenant);
- the task's name, agent, status (draft or live) and whether it is enabled;
- which agent the system would choose by itself (the tenant's main agent, failing that the only enabled agent).

The agent picker appears only when the system cannot choose on its own (none or several candidates). An agent that also serves another tenant cannot be chosen. The button reads **Create starter pack** when the task does not exist yet, and **Check / re-aim** otherwise.

**Pressing it again.** The button is idempotent: it never overwrites an existing task, and when nothing changed it does nothing ("Nothing changed"). When the agent changed, it re-aims the task and puts it back to draft and paused. When the task was deleted in the meantime, it creates it again.

**Who sees and may do what.**

| | admin (global) | agent | read_only | viewer |
|---|:---:|:---:|:---:|:---:|
| Starter pack button and panel on the Tenants tab | X | | | |
| Create the starter pack and read its state (API) | X | | | |
| The starter-pack task in the Tasks list (own tenant) | X | X | X | X |
| Edit | X | X | | |
| Activate (draft to live) | X | | | |
| Resume, pause, delete | X | X | | |

Alongside the table:

- A tenant user does not see the button or the panel: it is not merely hidden, it is not in the page at all. The starter-pack API is also reachable only with the admin role; any other role, a device key and a federation principal get 403. That holds whatever the mode (in a rolled-back shadow mode too), because the admin check also lives in the route, not only in the permission table.
- A tenant user sees the starter-pack task of their own tenant in the Tasks list, with a draft badge until it is activated. They cannot activate it (activation needs a signed-in admin). Resuming after activation is open to the `agent` role, as pausing and resuming any other task is.
- When a tenant user edits the starter-pack task, the usual rule applies to them too: for a live task the change asks for re-review (see [06 - Tasks](06-tasks.md)).
- A non-admin account without a tenant is refused by every schedules endpoint, so it does not see the starter-pack task either.
- The recipients of the channel message are not set by the user: Telegram channel bindings can only be created by an admin (see [F03 - Operations](../../fork-guide/en/F03-operations.md#tenant-skill-gate)). Someone who is not among the tenant's bindings does not receive the summary on a channel, even if they can see the task.
- The starter-pack task and its daily-summary entry use and write only the tenant's own data; the tenant's memory is read with the tenant scope.

### External MCP servers and tenant isolation

External MCP servers (e.g. GitHub, Hetzner, filesystem) have no tenant concept. If an agent carrying such a server is assigned to a B2B tenant, that tenant sees the credential's full scope -- this cannot be restricted by data-layer filtering, only by policy.

For high-risk MCP servers (`hetzner`, `github`, `gitlab`, `filesystem`, `ga4` family), the system shows a confirmation dialog when assigning a tenant.

---

## B2B partner onboarding steps `[planned]`

> The steps below become actionable once tenant enforcement is enabled.

1. **Define a tenant identifier** -- a unique, URL-safe slug (e.g. `acme-corp`).
2. **Create the tenant** on the Tenants tab.
3. **Generate an agent token** for the partner (Tokens tab) with a 90-day expiry.
4. **Isolation test** -- query `default` tenant memories with the new token: expect an empty list.
5. **Agree on a rotation process** with the partner (at least 2 weeks before expiry).

---

## Related sections

- [12 - Vault](12-vault.md) -- encrypted credentials
- [13 - Audit Log](13-audit.md) -- token usage logging
- [17 - Updates](17-updates.md) -- break-glass password reset
