# Settings

The Settings view groups the Marveen system configuration keys into 9 tabs. Changes are saved through a dirty-state bar; saving only sends keys that were actually modified to the server.

---

## Accessing settings

Click the gear icon in the top navigation, or select **Settings** from the navigation menu.

A yellow bar appears at the top of the view when any key has been changed but not yet saved. The bar shows the count of modified keys; the **Save** button sends all changes at once. Navigating away from the page triggers a browser warning if there are unsaved changes.

---

## 1. System

Core system configuration: agent identifiers, network settings, and operating mode.

| Key | Description |
|-----|-------------|
| `BOT_NAME` | The displayed name of the system |
| `MAIN_AGENT_ID` | Identifier of the main coordinator agent |
| `OWNER_NAME` | Name of the system owner |
| `WEB_PORT` | Dashboard HTTP port (default: 3420) |
| `DASHBOARD_PUBLIC_URL` | Publicly reachable URL of the dashboard (e.g. via Tailscale) |
| `DASHBOARD_LANG` | Default dashboard language (`hu` or `en`) |
| `SCHEDULER_TZ` | Time zone for the scheduler (e.g. `Europe/Budapest`) |
| `ALERT_THRESHOLD_MS` | Threshold in milliseconds after which an API response is flagged as slow |
| `DEFAULT_REVERT_AFTER_MINUTES` | Minutes after which autonomy levels are automatically reset to the lowest value |

---

## 2. Channels

Communication channel and security settings. The **Login card** is shown at the bottom of this tab.

| Key | Description |
|-----|-------------|
| `CHANNEL_PROVIDER` | Message channel type (e.g. `telegram`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token |
| `ALLOWED_CHAT_ID` | Comma-separated list of allowed Telegram chat IDs |
| `MAIN_AGENT_ISOLATED_CONFIG` | Isolated config directory path for the main agent |
| `MAIN_AGENT_CONFIG_DIR` | Path to the main agent's `.claude-config` directory |

### Login card

The card manages the dashboard browser login mode:

- **Set up login** - create a username and password alongside the access token
- **Active sessions** - list of currently logged-in sessions with the option to sign them out
- **Device keys** - generate per-device revocable keys (e.g. for Bridge or mobile); the raw key is shown exactly once and cannot be retrieved again
- **Bridge pairing** - authorization flow for the Claude Code Bridge SSH tunnel

---

## 3. Agents

Agent behavior parameters and heartbeat configuration.

### Model

| Key | Description |
|-----|-------------|
| `DEFAULT_AGENT_MODEL` | Default Claude model used by agents |
| `MESSAGE_LOG_RETENTION_DAYS` | How many days to keep inter-agent message history |

### Heartbeat

| Key | Description |
|-----|-------------|
| `HEARTBEAT_ENABLED` | Enable silent background checks |
| `HEARTBEAT_INTERVAL_MINUTES` | Interval between heartbeat runs in minutes |
| `HEARTBEAT_CALENDAR` | Include calendar check in the heartbeat |
| `HEARTBEAT_EMAIL` | Include email check in the heartbeat |
| `HEARTBEAT_KANBAN` | Include kanban status check in the heartbeat |
| `HEARTBEAT_FULL_CHECK` | Run a full system review during the heartbeat |

---

## 4. Kanban

Fine-tuning the kanban board and the Ideas inbox. The section is divided into sub-groups:

### WIP limits

The `KANBAN_WIP_*` keys define how many cards can be in a given status or assigned to a given agent at the same time.

### WIP colors

The `KANBAN_WIP_*_COLOR` keys set the warning color of a column header when a WIP limit is close to being reached or has been exceeded.

### Archive

| Key | Description |
|-----|-------------|
| `KANBAN_ARCHIVE_DONE_DAYS` | Days after which done-cards are automatically archived |
| `KANBAN_ARCHIVED_MAX_ROWS` | Maximum number of archived cards to retain |

### Aging

The `KANBAN_AGING_*` keys control the aging visualization (cards change color when they have not moved for a long time).

### Display

| Key | Description |
|-----|-------------|
| `KANBAN_SWIMLANE_DEFAULT_GROUP` | Default swimlane grouping (e.g. priority, agent) |
| `KANBAN_SWIMLANE_SEPARATOR_COLOR` | Background color of swimlane dividers |
| `KANBAN_LABEL_COLORS` | Custom label-to-color mappings as a JSON object |

### Ideas

| Key | Description |
|-----|-------------|
| `IDEA_BREAKDOWN_MAX_SUBTASKS` | Maximum number of kanban subtasks the AI breakdown may generate |
| `IDEA_STALE_DAYS` | Days of inactivity after which an idea is flagged as stale |

---

## 5. Memory

Memory system and local Ollama vector generation settings.

| Key | Description |
|-----|-------------|
| `OLLAMA_URL` | Ollama API URL for local embedding generation |
| `MEMORY_RERANK_ENABLED` | Enable reranking of search results |
| `WORKSPACE_DOCS_TTL_DAYS` | Days after which workspace documents are automatically deleted |
| `WORKSPACE_DOC_RECALL_DEFAULT` | Whether workspace document recall is on by default |

---

## 6. Fleet monitor

Blackboard monitoring and stale-detection thresholds.

### BB signals

| Key | Description |
|-----|-------------|
| `BB_SIGNAL_A_BB_HOURS` | Hours without blackboard activity before issuing signal A |
| `BB_SIGNAL_A_MSG_HOURS` | Hours without inter-agent messages before issuing signal A |
| `BB_SIGNAL_B_ACTIVE_HOURS` | Hours of continuous "active" status before issuing signal B |

### Stale detection

The `BB_STALE_*` keys control how long the monitor waits before marking an agent's blackboard row as stale.

---

## 7. Data retention

Log retention, telemetry, and backup policies.

### Audit log

| Key | Description |
|-----|-------------|
| `AUDIT_LOG_RETENTION_DAYS` | Days to keep audit log entries |
| `AUDIT_LOG_MAX_ENTRIES` | Maximum number of audit log entries to retain |

### Token usage retention

| Key | Description |
|-----|-------------|
| `TOKEN_USAGE_RETENTION_DAYS` | Retention period for raw token usage records, in days |
| `TOKEN_USAGE_DAILY_RETENTION_DAYS` | Retention period for daily aggregates, in days |
| `TOKEN_USAGE_MONTHLY_RETENTION_DAYS` | Retention period for monthly aggregates, in days |

### OpenTelemetry

The `OTEL_*` keys configure the telemetry exporter (endpoint, headers, protocol).

### Backups

| Key | Description |
|-----|-------------|
| `BACKUP_KEEP` | Number of backup files to retain |

---

## 8. Autonomy

The Autonomy section is synthetic: rather than key-value pairs, it shows and edits per-category autonomy levels stored at the `/api/autonomy` endpoint.

Three levels are available for each category:

| Level | Behavior |
|-------|----------|
| **1 - Notify** | The agent sends a notification but does not perform the action |
| **2 - Approve** | The agent requests owner approval before acting |
| **3 - Autonomous** | The agent acts and reports afterward |

Some categories are capped at a maximum level (shield icon) and some are locked and cannot be changed (padlock icon).

The last modified time is shown at the bottom of the section.

---

## 9. Budgets and Claude plans

The ninth section is also synthetic: it shows the token cost budgets configured in costops and Claude API plan parameters.

### Claude plan settings

| Key | Description |
|-----|-------------|
| `CLAUDE_ROTATION_ENABLED` | Enable automatic Claude API key rotation |
| `PLAN_STALE_MIN` | Minutes after which the system considers plan status stale |

### Costops budgets

Configured budgets are listed here; editing them requires changes to the configuration file. A detailed status view is available in [Statistics](10-statistics.md).

---

## Tips

- The dirty-state bar shows the count of modified keys; unsaved changes are lost if you navigate away.
- Device keys are displayed only once upon creation; store them securely immediately after generating.
- Autonomy levels can be reset to 1 at any time to protect sensitive categories from autonomous execution.
