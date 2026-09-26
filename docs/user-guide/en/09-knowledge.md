# Knowledge Base

The Knowledge Base consists of three sub-pages: Ideas (development suggestions), Artifacts (file outputs saved by agents), and Workspace Docs (documents shared between agents).

---

## Ideas

The Ideas sub-page is a collection point for development ideas, feedback, and suggestions. Ideas follow a lifecycle from new submission through review to conversion into a kanban card.

### Statuses

| Status | Description |
|--------|-------------|
| **New** | Just submitted, not yet reviewed |
| **Reviewed** | Someone looked at it; decision in progress |
| **Kanban** | Converted to a kanban card; actively being developed |
| **Rejected** | Will not be implemented |

The default list shows active ideas (New + Reviewed).

### The idea list

Ideas are grouped by category. Each card shows:

- Title
- Status badge
- Score badge (Impact minus Effort, if provided)
- Stale badge (if unchanged for a long time)
- Short description (first 120 characters)
- Action buttons

### Score (Impact / Effort)

Each idea can have an Impact and Effort value on a 1-10 scale. Score is calculated as `Impact - Effort`. A positive score appears green, a negative score red.

### Filters

- **Status** - Active / All / New / Reviewed / Kanban / Rejected
- **Category** - from the list of available categories
- **Tenant** - tenant-level filtering

### Creating a new idea

1. Click the **+ Idea** button.
2. Enter the title (required) and an optional description.
3. Select a category.
4. Optionally enter Impact and Effort values.
5. Click **Save**.

### Idea details and status changes

Clicking an idea title opens the detail panel: full description, Impact/Effort editing, and comments. Buttons in the list row let you change status directly: **Reviewed** / **Reject** / **Reopen** / **Edit**.

### AI-based kanban breakdown

Clicking **AI breakdown** asks the system to automatically generate kanban subtasks from the idea. Before creating, you can also provide a Definition of Done.

---

## Artifacts

The Artifacts sub-page lists file outputs saved by agents - for example, generated reports, exported data, and scripts.

### List columns

| Column | Description |
|--------|-------------|
| **Title** | The artifact name |
| **Agent** | Which agent created it |
| **Type** | Artifact type (e.g. `text`, `markdown`, `json`) |
| **Modified** | Time of last modification |

### Filters

- **Agent** - filter by agent
- **Type** - filter by artifact type
- **Date** - filter by creation date
- **Tenant** - tenant-level filtering

### Actions

- **Preview** - opens the content preview panel; text, markdown and JSON are rendered inline; binary files show a download link
- **Rename** - change the artifact's title
- **Delete** - permanently removes the artifact

---

## Workspace Docs

The Workspace Docs sub-page lists documents that agents have written to the shared workspace. These are typically files used for agent-to-agent handoffs, task context sharing, or storing longer-lived outputs.

### List columns

| Column | Description |
|--------|-------------|
| **Title** | Document name (and task reference, if set) |
| **Agent** | Which agent created it |
| **Type** | Document type (e.g. `dream`, `digest`, `report`) |
| **Content** | Content type (e.g. `text`, `markdown`, `code`, `binary`) |
| **Size** | Document size |
| **Modified** | Time of last modification |

### Filters

- **Agent** - filter by agent
- **Type** - filter by document type
- **Content** - filter by content type
- **Tenant** - tenant-level filtering

### Viewing and deleting

Clicking **View** opens the preview panel, which renders the content as markdown or plain text; binary files show a download link. **Delete** permanently removes the document.

---

## Tips

- The stale badge on idea cards indicates an idea has not changed for a long time; check whether it is still relevant.
- The artifact preview renders markdown content with formatting and code with syntax highlighting.
- Workspace docs are written automatically by agents; manual edits are rarely needed, but stale documents can be deleted from the dashboard.
