# Memories

The Memories view manages agents' long-term memories. Memories are stored in a three-tier system and can be retrieved by keyword or vector search. The daily log holds summaries of activities each agent completed that day.

---

## Tier system

| Tier | Description | When to use |
|------|-------------|-------------|
| **Hot** | Active tasks, in-progress decisions | What is happening right now |
| **Warm** | Stable configuration, preferences, project context | Things that change rarely |
| **Cold** | Long-term lessons, archived decisions | Anything to keep with "remember this" intent |
| **Shared** | Information relevant to other agents as well | Fleet-wide knowledge |
| **Import** | Memories loaded from an external source | Bulk data ingestion |

---

## View tabs

### Hot / Warm / Cold / Shared / Import

The list of memories in the selected tier. Each memory card shows:

- Content (first few lines)
- The agent that created it
- Creation timestamp
- Keywords (if provided)
- Edit and delete buttons

Clicking a card opens the detail view where the full content can be read and edited.

### Daily log

Agent-generated daily summaries, browsable by date. The log records tasks completed, decisions made, and events that occurred during the day. Use the date navigation arrows to view earlier logs.

### Graph / Timeline

The Graph tab shows connections between memories as an interactive network graph; nodes are colour-coded by tier to reveal relationships. The Timeline tab displays memories on a chronological swim-lane chart.

---

## Search

Above the search field you can choose the search mode:

| Mode | Description |
|------|-------------|
| **Hybrid** | Combines keyword and vector search (default) |
| **Keyword** | Exact text match |
| **Vector** | Semantic similarity (requires embeddings) |

Search triggers after a 300 ms debounce, or immediately on Enter.

---

## Filters

- **Agent** - filter to a specific agent's memories
- **Tenant** - filter by tenant (when the tenant selector is active)

---

## Statistics

Stat cards at the top of the view show:

- Total memory count
- Breakdown by tier
- Number and percentage of vectorised memories
- Number of imported memories

The **Generate vectors** button back-fills missing embeddings; useful if older memories were not yet vectorised.

---

## Creating a memory

1. Click the **+ Memory** button.
2. Select the tier (Hot / Warm / Cold / Shared).
3. Enter the content.
4. Optionally add keywords (comma-separated) and select an agent.
5. Click **Save**.

---

## Editing and deleting

Clicking a card opens the detail panel with **History** and **Edit** tabs. The history tab lets you browse earlier versions of the memory. The edit tab lets you change the content, tier, keywords, and agent.

---

## Import

Use the **Import** button to bulk-load memories from a JSON file; useful when migrating data from an external system.

---

## Tips

- Hot-tier memories should be deleted or moved to Warm/Cold once the corresponding task is done, to keep Hot uncluttered.
- Adding keywords improves keyword search accuracy.
- The Graph view is useful for visualising connections; the slider controls how many nodes are shown at once.
