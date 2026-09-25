# Kanban

The Kanban view manages all tasks and projects. Cards are arranged in columns by status and can be moved between columns by dragging.

---

## Columns

| Column | Description |
|--------|-------------|
| **Planned** | Tasks not yet started |
| **In Progress** | Actively being worked on |
| **Testing** | Completed, under review |
| **Waiting** | Blocked, waiting on an external condition |
| **Done** | Completed tasks |

---

## Creating a card

1. Click **New card** in the top-right corner.
2. Fill in the required **Title** field.
3. Optionally set: Project, Assignee, Priority, Due date, Description, Parent card.
4. Save the card.

New cards default to "Planned" status.

---

## Priorities

| Level | Description |
|-------|-------------|
| **Low** | Not urgent, can wait |
| **Normal** | Default level |
| **High** | Takes precedence over normal |
| **Urgent** | Requires immediate attention |

---

## Card detail

Clicking a card opens the detail panel:

- **Title and description** - editable
- **Status, priority, assignee, due date** - modifiable
- **Parent** - set a parent card (for organizing subtasks)
- **Subtasks** - smaller steps within the card; progress ratio is shown on the card summary (`X/Y subtasks`)
- **Comments** - chronological; you can add your own comments at any time

---

## Filters and grouping

**Project filter** - show only cards from a specific project.

**Assignee filter** - show only cards assigned to a specific person.

**Mine** (`Mine` button) - show only cards assigned to the logged-in user.

**Group by** - split the board into swimlanes by assignee or priority. Swimlane headers can be clicked to collapse them.

**Clear filters** - resets all active filters.

---

## Drag and drop

- Click and hold a card, then drag it to the target column.
- The column name highlights to indicate the drop target.
- Touch drag works on mobile.

---

## Auto-breakdown

The **Auto-breakdown** button in the card detail panel lets the AI suggest subtasks based on the card description. You can accept, modify, or discard the suggestions.

---

## Archiving and deletion

- **Archive** - removes the card from the board view but keeps it in the database.
- **Delete** - permanently deletes the card; this cannot be undone.

---

## Tips

- The number of visible cards depends on active filters; filters do not affect the underlying data.
- The Kanban board loads fresh data on every page load; no manual refresh is needed.
