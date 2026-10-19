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

A card's priority shows on the whole card: an **Urgent** card is tinted red, a **High** card gets a tint in the accent colour (stronger in the dark theme), **Normal** and **Low** stay plain. A card that has stood still for a long time keeps its aging stripe on the left edge.

The board totals sit beside the view switcher: "X open / Y on the board" (open = everything not in the Done column). While a project, assignee or label filter is on it adds "(Z shown)". The totals and the number in each column header count the whole board, even when only the first 20 cards of a column are loaded.

---

## Card detail

Clicking a card opens the detail panel:

- **Title and description** - editable
- **Status, priority, assignee, due date** - modifiable
- **Time in progress** - how long the card has stood in the In progress column, summed over every stay (for example `3h 20m` or `2d 4h`). It is worked out in the panel from the card's own status changes, so it is the same for everyone who may see the card. It is wall-clock time in the column, not time worked: a card left in progress overnight counts the night, so read it as an upper bound (the tooltip says so). `not measured` means the card has no status history yet (older cards that have not moved since the history was started), which is different from `never been in progress`, a measured zero.
- **Parent** - set a parent card (for organizing subtasks)
- **Subtasks** - smaller steps within the card; progress ratio is shown on the card summary (`X/Y subtasks`)
- **Comments** - chronological; you can add your own comments at any time

---

## Filters and grouping

**Project filter** - show only cards from a specific project.

**Assignee filter** - show only cards assigned to a specific person.

**Mine** (`Mine` button) - show only cards assigned to the logged-in user.

**Group by** - split the board into swimlanes by assignee or priority. Swimlane headers can be clicked to collapse them.

**Sort** - the cards in each column can be ordered: manual order (the default, set by dragging), by number ascending or descending, by created or by updated (newest first). A card with no number or time always goes last. The choice is remembered after a reload. Outside the manual order cards cannot be dragged (a hand-placed position means nothing in a sorted column), and the whole board is loaded instead of page by page. Search stays the existing server-side search.

**Clear filters** - resets all active filters.

---

## Ongoing band

Open cards (not in Done) that carry the **Ongoing** (or **Folyamatos**) label do not appear in their status column: they sit in a band above the board, one button each. It is for standing, always-in-flight duties that would otherwise sit in one column forever. The card keeps its status (still editable in its details), the band is not a drop target, and a click opens the card. A card moved to Done returns to the Done column. The band follows the active filters and is hidden while empty. If such a card has subtasks, they stay in their own columns and do not disappear with it.

The label has to be created once on the board (an admin works with labels; the name is not case-sensitive, and labels are separate per tenant). While the board has a label with that name it is loaded in full instead of page by page, so the band is complete. A card in the band is not counted in the number on a column header or in the WIP badge (it is in no column), but it is counted in the board total beside the view switcher, because it is on the board.

---

## Drag and drop

- Click and hold a card, then drag it to the target column.
- The column name highlights to indicate the drop target.
- Touch drag works on mobile.
- The order inside a column is the same manual order for everyone, and every card shows its number (#N), also when you are not signed in as an administrator.

---

## Auto-breakdown

The **Auto-breakdown** button in the card detail panel lets the AI suggest subtasks based on the card description. You can accept, modify, or discard the suggestions.

---

## Moving a card from the API

`POST /api/kanban/<id>/move` takes `status` (and optionally `actor`, `sort_order`, `orderedIds`). An agent that decides from an earlier read can add `expected_status`: the card is moved only if it is still in that status. If someone else moved it in the meantime (for example the owner put it back to Waiting), the call answers `409` with `status_conflict`, the `current_status` and the `expected_status`, and nothing changes: no status change, no history entry, no wake-up message, no parent update. Read the card again before deciding. Without `expected_status` the move is unconditional, as before; dragging on the board does not send it. A key the endpoint does not know (a misspelt `expectedStatus`, say) is a `400`, so a typo cannot silently turn the guard off.

---

## Archiving and deletion

- **Archive** - removes the card from the board view but keeps it in the database.
- **Delete** - permanently deletes the card; this cannot be undone.

---

## Tips

- The number of visible cards depends on active filters; filters do not affect the underlying data.
- The Kanban board loads fresh data on every page load; no manual refresh is needed.
