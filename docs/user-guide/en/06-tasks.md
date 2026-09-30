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
| **Actions** | Activate (drafts only) / Run now / Pause / Resume / Run history / Delete; click the row to edit |

---

## Creating a new task

1. Click the **+ Task** button.
2. Enter a name (unique, cannot be changed later) and an optional description.
3. Select the task type (Task / Heartbeat / Command). A command task asks for a shell command, an optional timeout and the number of consecutive failures after which an alert is sent, instead of a prompt; see [Command tasks](#command-tasks).
4. For heartbeat tasks, you can choose a built-in template as a starting point:
   - **Calendar** - watch for upcoming events (every 15 minutes)
   - **Email** - watch for urgent messages (every 30 minutes)
   - **Kanban** - watch for overdue cards (every 2 hours)
   - **Full** - calendar + email + kanban combined (every 15 minutes)
5. Write the prompt (instruction) the agent will receive.
6. Set the schedule:
   - **Daily** / **Weekdays** / **Mondays** / **Fridays** - with a specific time
   - **Hourly** / **Every 2 h** / **Every 4 h** / **Every 30 min** - fixed interval
   - **Custom** - any cron expression
7. Select the target agent.
8. Click **Save**.

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

Choose the **Command (shell, no LLM)** type in the New task dialog. The dialog then asks for the **Command** (required), the **Timeout (ms)** and **Alert after this many consecutive failures**, and the prompt is not required and is not sent. The Edit dialog shows an existing command task the same way and keeps its type when you save it.

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

## Pausing and resuming

The pause or play button in the list row temporarily pauses or resumes a task. A paused task does not run, but its configuration is preserved.

---

## Editing

Click a task row or select its edit icon to open the edit modal. The task name cannot be changed; all other fields can be edited.

---

## Tenant filter

A tenant selector at the top of the view lets you filter by scope:

- **Fleet only** - shows all tasks not tied to a specific tenant
- Selecting a tenant shows only that tenant's tasks

---

## Tips

- For heartbeat prompts, include a clear decision condition ("if X, notify on Telegram; if nothing found, do not write anything") to avoid unnecessary notification noise.
- Scheduled tasks and auto-restart idle-flush can interact: if a task fires more often than the agent's idle window, the idle threshold can never be reached. The agent detail panel shows a warning when this is the case.
- Custom cron expressions are evaluated in the server's timezone (Europe/Budapest).
