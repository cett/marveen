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

The `store/.dashboard-token` file generated at install time holds an admin-role, globally-scoped token. Running agents use this token -- it stays unchanged.

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

## Tenant management `[planned]`

> The tenant management API is coming in the next development phase.

A tenant is an isolated data island. All data (memories, kanban, messages, imported content) belongs to a specific tenant. That data is not visible or modifiable with another tenant's token.

**Add a tenant:** use the **+ Add tenant** button on the Tenants tab. The identifier (slug) cannot be changed after saving.

**Disable a tenant:** revokes the token and removes access -- data is retained.

### Tenant isolation `[planned]`

After the enforce phase is enabled (`RBAC_MODE=enforce`), the system automatically filters every query by the token's tenant scope. Currently isolation runs in shadow mode -- all requests pass, but the system logs what it would reject.

**Intentionally not isolated:**
- The agent list (`/api/v1/agents`) is tenant-independent -- all authenticated users can see which agents are running.
- The blackboard is also tenant-independent for agent and admin roles -- fleet coordination requires agents to see each other's state.

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
> - **The permission table, in enforce mode.** `schedules:read`, `schedules:write` and, for activation and the scheduler heartbeat, `admin:all` are checked by the RBAC gate only when `RBAC_MODE=enforce`. While the mode is shadow, the gate only logs what it would refuse, so the differences between the roles (for example that `read_only` and `viewer` do not write) take effect when enforce mode is switched on.
>
> Before enforce mode is switched on, do not give tenant users a login or token that can reach the API.

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
