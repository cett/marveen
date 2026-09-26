# Tasks

The Tasks view manages scheduled tasks. Each task is assigned to a specific agent and runs automatically on a cron schedule - the task runner checks for due tasks once per minute.

---

## Task types

| Type | Description |
|------|-------------|
| **Task** | Always delivers a result notification after each run |
| **Heartbeat** | Notifies only when something important or urgent is found; silent runs produce no output |

Use the heartbeat type for continuous background monitoring (e.g. calendar, email, kanban watching), and the plain task type when you always want to see the result.

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
| **Type** | Task or Heartbeat |
| **Name** | Unique identifier (cannot be changed after creation) |
| **Description** | Optional short text |
| **Schedule** | Cron expression in human-readable form |
| **Agent** | Which agent runs it |
| **Status** | Live or Draft / Pending review |
| **Actions** | Pause / Resume / Edit / Delete |

---

## Creating a new task

1. Click the **+ Task** button.
2. Enter a name (unique, cannot be changed later) and an optional description.
3. Select the task type (Task / Heartbeat).
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
