# 13 - Audit Log `[ADMIN]`

> This section is visible to administrators only.

The Audit Log records system events in chronological order. It draws from two data sources presented in a unified, time-sorted view.

---

## Data sources

**Agent events (`agent`)** -- writes performed by agents: memory saves, kanban changes, message sends, blackboard updates, approval handling. These are recorded by the system at the point of execution.

**Hook events (`hook`)** -- hook system decisions: PreToolUse, PostToolUse, PreCompact, Stop. Each hook execution result (allow/deny) and the triggering context are included.

Both sources are active on page load. The checkboxes in the upper right allow filtering by source.

---

## Filtering

- **Agent** -- select which agent's events to display from the dropdown.
- **Search** -- free-text search across event content.
- Source checkboxes (Agent / Hook) can be combined.

Filters persist across page changes.

---

## Pagination

The audit log is paginated at 200 entries per page. The paginator appears at the bottom of the list. Exported files contain at most 10,000 entries.

---

## Event detail

Clicking a row opens a detail panel showing the full raw event data in JSON format. This is especially useful for tracing hook decisions (e.g. which gate blocked a given action and why).

---

## Export

The **Export** button downloads a JSON file of entries matching the current filters (up to 10,000). The filename includes the export timestamp.

---

## Security reset entries

Running `npm run dashboard-user security:reset` and the HTTP break-glass endpoint both write to the `config_change_log` table (visible under the `config` source, with `security.*` keys). Entries contain metadata only (username, counts) -- never credentials.

For details on recovery procedures, see [17 - Updates](17-updates.md).

---

## Related sections

- [17 - Updates](17-updates.md) -- break-glass and security:reset
- [15 - Users](15-users.md) -- token audit trail
