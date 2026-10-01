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

**Agent** -- full read and write access to one tenant's data (memories, kanban, messages, blackboard). No access to other tenants' data or the admin interface. Default role for B2B partners.

**Read-only** -- read only: list memories, kanban, agents, and blackboard. No create or delete.

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
- In the dashboard, creating, editing, moving to another tenant and activating tasks is an admin action: for other users the **+ Task** button is hidden and the row actions are disabled. A tenant user requests a task through their agent in the chat. The agent creates it as a draft in that user's tenant, and an admin activates it after seeing which tenant it belongs to.
- A task only runs on an agent that serves its tenant. If the agent is switched off for the tenant, or the tenant is disabled, the task stops firing and each missed occurrence is recorded as `skipped_tenant_mismatch` in its run history.
- Deleting a tenant also deletes its tasks, their pending retries and their mirrored files.

> **Shadow mode and the schedules endpoints.** While RBAC runs in shadow mode (`RBAC_MODE` not set to `enforce`), the schedules endpoints are not admin-only yet: RBAC only logs the denial that enforce mode would issue, so a plain request from a tenant user is not stopped by RBAC itself. The task rules below are part of the schedules routes and apply in both modes. A tenant user cannot read or touch another tenant's tasks (they answer 404); cannot activate a task (403, activation is for a signed-in admin); cannot change a task's status, tenant or runner script options (an edit simply drops those keys; asking for a different tenant answers 403); cannot re-point a task to another agent (the key is ignored for them); and a task they create is always a draft in their own tenant. What shadow mode does **not** stop: a tenant user who calls the API directly can still edit the other fields of their own tenant's tasks, including the prompt and schedule of a live one, switch them on and off, run them, delete them and create drafts. Only `RBAC_MODE=enforce` makes these endpoints answer 403 to everyone but admins.

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
