# Tasks

The Tasks view manages scheduled tasks. Each task is assigned to a specific agent and runs automatically on a cron schedule - the task runner checks for due tasks every 15 seconds. The exception is the command type, which runs a shell command directly and does not involve an agent (see below).

---

## Task types

| Type | Description |
|------|-------------|
| **Task** | Always delivers a result notification after each run |
| **Heartbeat** | Notifies only when something important or urgent is found; silent runs produce no output |
| **Command** | Runs a shell command directly, with no AI agent involved; sends a Telegram alert after repeated failures |

Use the heartbeat type for continuous background monitoring (e.g. calendar, email, kanban watching), and the plain task type when you always want to see the result. Use the command type for plain infrastructure jobs that need no AI, such as a nightly backup.

---

## Views

Tasks can be viewed in three layouts:

- **List** - a table of all tasks
- **Timeline** - daily breakdown showing runs on a horizontal track
- **Week** - calendar-style weekly view

---

## List columns

| Column | Description |
|--------|-------------|
| **Type** | Task, Heartbeat or Command |
| **Name** | Unique identifier (cannot be changed after creation) |
| **Description** | Optional short text |
| **Schedule** | Cron expression in human-readable form |
| **Agent** | Which agent runs it (not used for execution by command tasks) |
| **Status** | Live or Draft / Pending review |
| **Tenant** | The tenant the task belongs to, shown as a small badge next to the agent (global admins only, see [Tenants and tasks](#tenants-and-tasks)) |
| **Actions** | Activate (drafts only) / Run now / Pause / Resume / Run history / Delete; click the row to edit |

---

## Creating a new task

1. Click the **+ Task** button.
2. Global admins: pick the **Tenant** the task belongs to (the field is at the top of the dialog; see [Tenants and tasks](#tenants-and-tasks)). Everyone else has no such field, the task goes to their own tenant.
3. Enter a name (unique, cannot be changed later) and an optional description.
4. Select the task type (Task / Heartbeat / Command). A command task asks for a shell command, an optional timeout and the number of consecutive failures after which an alert is sent, instead of a prompt; see [Command tasks](#command-tasks).
5. For heartbeat tasks, you can choose a built-in template as a starting point:
   - **Calendar** - watch for upcoming events (every 15 minutes)
   - **Email** - watch for urgent messages (every 30 minutes)
   - **Kanban** - watch for overdue cards (every 2 hours)
   - **Full** - calendar + email + kanban combined (every 15 minutes)
6. Write the prompt (instruction) the agent will receive.
7. Set the schedule:
   - **Daily** / **Weekdays** / **Mondays** / **Fridays** - with a specific time
   - **Hourly** / **Every 2 h** / **Every 4 h** / **Every 30 min** - fixed interval
   - **Custom** - any cron expression
8. Select the target agent. When the dialog has a tenant field, the list only offers the agents that serve the picked tenant.
9. Click **Save**.

---

## Running a task now

The **Run now** button in the list row runs the task immediately, outside its schedule. It is disabled for tasks that are not live yet, and a paused task cannot be run.

- For a task or heartbeat, the prompt is delivered to the assigned agent. If the agent is busy, the delivery is parked and retried.
- For a command task, the shell command is executed directly and the request returns at once with `command: started` (the confirmation toast shows it too). The outcome is not part of that response; it is recorded asynchronously (see [Command tasks](#command-tasks)). The same is available through `POST /api/schedules/{name}/run`.

---

## Command tasks

A command task runs a raw shell command (`bash -lc`) on the server. There is no AI model and no agent session involved, so it costs no tokens and works even when the agent is stopped or busy. It is meant for checks and jobs that must not depend on an AI: a nightly backup, a token refresh, a disk check.

| Setting | Meaning |
|---------|---------|
| `command` | The shell command to run |
| `timeoutMs` | Time limit in milliseconds (default 10000) |
| `failThreshold` | Consecutive failures before an alert is sent (default 2) |

How it behaves:

- **Success and failure** - exit code 0 is a success. Any other exit code, a failure to start, or hitting the time limit is a failure. Standard output is discarded; the first 200 characters of the error output are kept as the failure detail.
- **Not held back** - a command task ignores the skip-if-busy option, the usage-quota hold-back and the pre-check that apply to agent tasks.
- **Asynchronous** - the command runs in the background and never blocks the dashboard, so it may even call the dashboard's own API. When the time limit is reached, the whole process tree the command started is stopped (a polite stop first, a forced kill after 2 seconds), not just the shell.
- **No overlap** - if the previous run is still going when the next one is due, or when you press Run now, the new run is skipped instead of started twice.
- **After downtime** - if the dashboard was down when a command task was due, the run is caught up on the next start as long as it is at most 24 hours old by default (tasks: 3 hours, heartbeats: 30 minutes). Older occurrences are recorded as missed.

### Health file and failure alerts

Every run updates `store/command-task-health.json`, which holds one entry per command task: the number of consecutive failures, whether an alert has already been sent, the last status (`ok` or `fail`) and the time of the last run (milliseconds since the epoch).

- A success resets the failure counter.
- When the counter reaches `failThreshold`, one Telegram alert goes to the owner with the failure detail. Further failures do not repeat the alert.
- The first success after an alert sends a single "recovered" message and clears the alert state.
- Alerts need the Telegram bot token and the owner chat to be configured; otherwise the alert is skipped and only written to the log. The alert text is currently always Hungarian.

Each finished run is also added to the task's run history. The badge in the list (`command ran`) only tells that the run was started; read the health file for the result.

### Setting one up

Choose the **Command (shell, no LLM)** type in the New task dialog. The dialog then asks for the **Command** (required), the **Timeout (ms)** and **Alert after this many consecutive failures**, and the prompt is not required and is not sent. The Edit dialog shows an existing command task the same way with the type selector disabled, and keeps its type when you save it.

Through the API, `POST /api/schedules` with `type` set to `command` needs a `command` and no `prompt`; `timeoutMs` and `failThreshold` are optional positive integers.

The server refuses a change that would turn a command task into another type unless the request explicitly sends `allowTypeChange: true`, so an older client cannot convert it by accident.

---

## Required MCP servers

A task that works through an MCP server (for example email or calendar) can declare the servers it needs with `requires.mcp_servers` in its configuration. Before the prompt is delivered, the scheduler checks that each named server has a live process under the agent's session.

- If a required server is proven to be missing, the prompt is not delivered. The run is held and retried on later checks until the server is back, and the dashboard log names the missing server.
- The check sees servers configured at user level, in the project and in the agent's own configuration (in this order of precedence). Servers started through `npx`, `bunx` or `pnpm dlx` are recognised by their package name.
- Servers that cannot be identified by a process (remote URL-based servers, an unreadable configuration) and sessions on a remote host are not checked and count as available.
- Command tasks have no MCP requirements check.

---

## Run history and skipped runs

The **Run history** action in the list row shows the latest 10 runs of a task: the time, the status and an estimated token use. The usual statuses are shown as OK, Error and Skipped; any other status is shown under its stored name.

The scheduler does not let a due occurrence of an enabled task disappear without a trace. When an occurrence is due but the task is held back, one row is added to the run history, once per occurrence and once for every agent the task would have run on:

| Status | Meaning |
|--------|---------|
| `skipped_not_live` | The task is enabled but still a Draft or Pending review, so the review gate holds it back. Every due occurrence is recorded. |
| `skipped_disabled` | The task was switched off together with most of the other tasks at once (see below). Every due occurrence is recorded for as long as it stays off, for at most 24 hours. |
| `skipped_tenant_mismatch` | The task is enabled and live, but its tenant and agent no longer fit together: the agent was switched off for the task's tenant, the tenant was disabled or its main agent changed, or the agent no longer exists. Every due occurrence is recorded until the pair is valid again. |

These rows only record that the occurrence was held back; the task is not run. A task you pause on your own, or a single toggle, is the normal switch: it leaves no row.

`skipped_tenant_mismatch` exists because a task of a tenant has to run on an agent that serves that tenant: the agent's session takes the tenant, and with it the tenant's skills, from the task. Before this check such a task kept running and its skills stayed locked without anyone noticing. Now it does not run, and the owner gets one notification when the breakage starts (a Telegram message, if the Telegram bot token and owner chat are configured, naming the task, the agent and the tenant; the text is currently always Hungarian; plus an audit log entry). The notification is not repeated while the task stays broken, and it comes again after a later breakage (or after a dashboard restart, since the flag is kept in memory). To fix it, enable the agent for the tenant again, or edit the task and move it to a tenant and agent that fit. Command tasks run no agent and are never held back by this check. Such rows count towards the mass-held-back alert below.

When most enabled tasks are held back at the same time (at least 4 tasks in play and more than half of them), the scheduler treats it as a fault instead of a deliberate pause. The owner then gets one Telegram alert listing the held tasks (if the Telegram bot token and owner chat are configured; the alert text is currently always Hungarian), and the event is also written to the audit log. There is no new alert until the situation has ended. If you see such an alert, check the **Status** and enabled state of the tasks, and that each task's tenant and agent still fit together.

---

## Pausing and resuming

The pause or play button in the list row temporarily pauses or resumes a task. A paused task does not run, but its configuration is preserved.

---

## Editing

Click a task row or select its edit icon to open the edit modal. The task name cannot be changed; all other fields can be edited. Global admins can also change the tenant here, which has a consequence: see [Moving a task to another tenant](#moving-a-task-to-another-tenant).

---

## Tenants and tasks

Every scheduled task belongs to exactly one tenant. There is no tenant-less "fleet" scope: the tasks that keep the system itself running (nightly backup, memory maintenance, the monitors) belong to the `default` tenant, like every task created without naming a tenant.

### What each user sees

- **Global admins** get a tenant selector at the top of the view, a **Tenant** field in the task dialog and a tenant badge on every row. The selector offers **All tenants** or one tenant; the "fleet only" option no longer exists.
- **Everyone else** sees no selector, no field and no badge. They only get the tasks of their own tenant, and anything they create belongs to it. A task of another tenant does not show up, and asking for it directly answers as if it did not exist.

### The tenant field in the dialog

The field sits at the top of the New task and Edit task dialogs (global admins only). A new task starts on the tenant the list is currently filtered to, or on `default` when the filter shows all tenants. When you pick another tenant, the agent list narrows to the agents that serve it; the current agent stays selected only if it is still on the list.

Which agents a task may name:

- **`default` tenant** - the main agent, plus any agent that is not enabled for a specific tenant or is explicitly enabled for `default`.
- **Any other tenant** - only an agent enabled for that tenant (or that tenant's own main agent). The fleet main agent is not allowed there, and neither is the API-only value `all` (a fan-out to every agent cannot belong to one tenant). A task of such a tenant must name its agent.

The server checks the same rule on save, so a combination that is not valid is refused with a 400 error (also for admins), and an unknown or disabled tenant is refused too.

### Moving a task to another tenant

Only a signed-in global admin can change the tenant of an existing task. The dialog warns about the consequence as soon as you pick a different tenant: **the task goes back to Draft and has to be activated again**. After saving, a message says so ("Task moved, now a draft: activate it again"). The move is checked like a new task: the agent has to serve the new tenant, so change both together when the old agent does not. An edit that leaves the tenant alone changes nothing about the task's tenant or status.

### Tasks created through a chat or by an agent

Creating and editing tasks in the dashboard is an admin action: for everyone else the **+ Task** button is hidden and the row actions are disabled. A user of a tenant asks their agent in the chat instead, and the agent creates the task through the API. Such a task:

- belongs to the tenant of the request the agent is serving at that moment (the tenant the chat is bound to), or to the agent's only tenant when it serves just one;
- is always created as a **Draft**: it does not run until a signed-in admin activates it. The row shows the tenant badge, and the Activate button's tooltip names the tenant, so the admin sees whose task it is before approving it;
- is refused with a 400 error ("The task needs a tenant", token `tenant_required`) when the tenant cannot be determined, for example when an agent that serves several tenants has no request in progress. In that case the admin creates the task in the dashboard, or asks the agent again from inside a tenant's chat.

The tenant is recorded from what the agent reports about itself, which is why the task never goes live on its own: the activation step is where a wrong tenant is caught.

### What an edit can change

Besides the tenant move, the fields an edit can change are the description, prompt, schedule, enabled state, type, the busy and send options and the command settings. The review status (Draft, Live), the tenant and the runner script options can only be changed through the dedicated actions (Activate, the tenant move by an admin), never by simply sending them in an edit. The agent of an existing task can only be changed by an admin, and only to one that serves the task's tenant. This holds whether or not role enforcement is switched on; see [15 - Users](15-users.md) for what only enforcement adds.

---

## Tips

- For heartbeat prompts, include a clear decision condition ("if X, notify on Telegram; if nothing found, do not write anything") to avoid unnecessary notification noise.
- Scheduled tasks and auto-restart idle-flush can interact: if a task fires more often than the agent's idle window, the idle threshold can never be reached. The agent detail panel shows a warning when this is the case.
- Custom cron expressions are evaluated in the server's timezone (Europe/Budapest).
