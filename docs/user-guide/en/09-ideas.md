# Ideas

The Ideas view is a collection point for development ideas, feedback, and suggestions. Ideas follow a lifecycle from new submission through review to conversion into a kanban card.

---

## Statuses

| Status | Description |
|--------|-------------|
| **New** | Just submitted, not yet reviewed |
| **Reviewed** | Someone looked at it; decision in progress |
| **Kanban** | Converted to a kanban card; actively being developed |
| **Rejected** | Will not be implemented |

The default list shows active ideas (New + Reviewed).

---

## The idea list

Ideas are grouped by category. Each card shows:

- Title
- Status badge
- Score badge (Impact minus Effort, if provided)
- Stale badge (if unchanged for a long time)
- Short description (first 120 characters)
- Action buttons

---

## Score (Impact / Effort)

Each idea can have an Impact and Effort value on a 1-10 scale. The score is calculated as `Impact - Effort`. A positive score appears green, a negative score red.

---

## Filters

- **Status** - Active / All / New / Reviewed / Kanban / Rejected
- **Category** - from the list of available categories

---

## Statistics

Stat cards at the top of the view show the count of ideas by status.

---

## Creating a new idea

1. Click the **+ Idea** button.
2. Enter the title (required) and an optional description.
3. Select a category.
4. Optionally enter Impact and Effort values.
5. Click **Save**.

---

## Idea details

Clicking an idea title opens the detail panel, where:

- The full description is readable
- Impact / Effort values can be edited and saved
- Comments can be added to the idea

---

## Changing status

Buttons in each card row let you change the status directly:

- **Reviewed** - New -> Reviewed
- **Reject** - from any status to Rejected
- **Reopen** - Reviewed or Rejected -> New
- **Edit** - opens the edit modal

---

## AI-based kanban breakdown

Clicking the **AI breakdown** button asks the system to automatically generate kanban subtasks from the idea. The AI proposes the required steps, which can then be created as kanban cards. Before creating, you can also provide a Definition of Done.

---

## Tenant filter

A tenant selector at the top of the view enables tenant-level filtering.

---

## Tips

- The stale badge means an idea has not changed for a long time; check whether it is still relevant.
- Categories grow automatically as new ideas are categorised; consistent naming improves clarity.
- The score is advisory only; the actual decision is recorded through the status change and AI breakdown.
