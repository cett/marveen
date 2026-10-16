# Settings

The Settings view groups the Marveen system configuration keys into tabs. Changes are saved through a dirty-state bar; saving only sends keys that were actually modified to the server.

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
| `DEFAULT_REVERT_AFTER_MINUTES` | Default number of minutes before an agent on a fallback model returns to its configured model (default 330); a value saved on the Model fallback tab takes precedence |

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

The `BB_STALE_*` keys control how long the monitor waits before marking an agent's blackboard row as stale. The value is in minutes and depends on the agent's tier: `BB_STALE_ORCHESTRATOR_MIN` (default 120), `BB_STALE_INTERACTIVE_MIN` (90), `BB_STALE_SHORT_RUNNING_MIN` (30, range 5 to 60; heartbeat and scheduled agents), `BB_STALE_DEFAULT_MIN` (60) and `BB_STALE_ASSIGNED_MIN` (120, delegated tasks nobody has started). An agent whose scheduled run is still in progress is never marked stale while it runs.

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

The `OTEL_*` keys configure the telemetry exporter. It pushes closed traces and the token usage metric as OTLP/HTTP JSON to the collector every 30 seconds.

| Key | Description |
|-----|-------------|
| `OTEL_EXPORT_ENABLED` | Turns the push exporter on (default off) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL, `http://` or `https://` (for example `http://localhost:4318`), without credentials in it; traces go to `/v1/traces`, metrics to `/v1/metrics`. While `OTEL_EXPORTER_OTLP_HEADERS` is set in the env file, the endpoint is taken from there too and a value saved here has no effect (the save is still recorded in the config change log) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra request headers, usually authentication, in the OpenTelemetry format `name1=value1,name2=value2` with each value percent-encoded (`Authorization=Bearer%20abc`). Set it in the `.env` file only: it is a secret, so the dashboard never shows it and `POST /api/settings` refuses to write it (even for an admin; the exporter would not read a stored value anyway). While it is set, `OTEL_EXPORTER_OTLP_ENDPOINT` is read from `.env` too (a value entered in the dashboard is ignored), so the credential can only go to the host you wrote next to it; with the headers in `.env` and no endpoint there, nothing is exported |
| `OTEL_SERVICE_NAME` | Value of the `service.namespace` resource attribute |
| `OTEL_EXPORT_INPUT_SUMMARY` | Also export the short description of what a tool call was given (default off, see below) |
| `OTEL_EXPORT_LOGS` | Also send audit events as OTLP logs to `/v1/logs` (default off; needs `OTEL_EXPORT_ENABLED` too, see below) |
| `OTEL_EXPORT_APP_LOGS` | Also send the dashboard's own warn, error and fatal log lines as OTLP logs (default off; needs `OTEL_EXPORT_ENABLED` too, separate from `OTEL_EXPORT_LOGS`, see below) |

The exporter speaks OTLP over HTTP with a JSON body, nothing else: there is no gRPC and no protocol switch. Headers are sent over `https`, or over plain `http` inside a private network (localhost, a private address, a `.local` or single-word host name); with headers set, an `http` endpoint on a public host is not used at all. Redirects are not followed, so a header never reaches another host.

When the collector fails, the exporter waits 30 seconds, then 60, 120 and so on up to 10 minutes before the next try (a `Retry-After` from the collector is honoured), per signal, and keeps the data meanwhile. A reply that says the payload itself is wrong (400, 413, 415, 422) discards that batch instead of retrying it for ever. If the collector accepts only part of a batch, the rest is counted, not retried. The counts go to the collector once it answers again as two counters, `marveen.otel.export.failures` (requests) and `marveen.otel.export.rejected` (items), each split by `marveen.otel.signal` (`traces` or `metrics`), and each failure is a warning in the dashboard log.

Besides the traces and the token usage metric, the dashboard process sends its own metrics (resource `marveen-dashboard`), all with counts, statuses and names only, never message or task text: `marveen.schedule.runs` (every scheduled occurrence by schedule and outcome) and `marveen.schedule.run.duration` (command tasks only, because the scheduler itself runs only those; an LLM task is a prompt typed into an agent's session and its end is not visible to the scheduler, so it has no duration), `marveen.agent_messages.pending` and `.oldest_pending_age` (queue depth and the age of its oldest entry), `.delivered`, `.delivery.duration` and `.failed` (by reason: abandoned, inject_failed, error, invalid_sender) for inter-agent messages, `marveen.channel.events` (Telegram events by status) and `marveen.channel.handoff.oldest_pending_age`, and the exporter's own `marveen.otel.export.failures` and `.rejected`. A command task also leaves a `schedule.run` trace, and an inter-agent message that ends as failed now closes its trace span as an error instead of leaving it open.

Spans and the token metric follow the OpenTelemetry GenAI conventions. A model response is a `chat <model>` span (kind CLIENT, `gen_ai.operation.name=chat`, `gen_ai.provider.name=anthropic`, `gen_ai.request.model` and `gen_ai.response.model` both set to the model Claude Code reports, since it does not tell the requested model apart from the answering one, and `gen_ai.usage.input_tokens`, `.output_tokens`, `.cache_read.input_tokens`, `.cache_creation.input_tokens`), a tool call is `execute_tool <tool>` (`gen_ai.tool.name`; the MCP server and tool stay as `marveen.mcp.server` and `marveen.mcp.tool`), and an agent turn is `invoke_agent <agent>` (`gen_ai.agent.id`, `gen_ai.agent.name`). An inter-agent message is a PRODUCER span, everything else INTERNAL. A span that ended in an error or a timeout carries `error.type` (`timeout`, otherwise `_OTHER`, as the exact cause is not recorded) and a status message. The span names and attribute keys changed with this: a dashboard that filtered on `model.call`, `tool.<name>`, `agent.turn`, `tool_name`, `model` or `input_tokens` has to use the new ones. `gen_ai.client.token.usage` is now a histogram of the tokens one model response used, `gen_ai.token.type` `input` or `output` only, with the convention's bucket bounds (1, 4, 16, ... 67108864). Cache reads, cache creations and thinking tokens are a separate sum, `marveen.gen_ai.client.token.usage.other` (`marveen.token.type`). Both are sent as DELTA (each export covers the time since the previous one); the first version of the metric was labelled CUMULATIVE by mistake, so a backend read every window as a running total. A Prometheus-style backend needs the collector's `deltatocumulative` processor in front of its exporter to turn them into the cumulative series it stores.

`gen_ai.client.operation.duration` (seconds, a delta histogram with the convention's bucket bounds) is an APPROXIMATION. Claude Code does not record how long a response took, so the context watchdog hook estimates it from the transcript timestamps: the time between the line the model was answering and the last block of its answer. A `model.call` span with such an estimate carries `marveen.duration.source=transcript`, and so does every data point of the metric. A response whose estimate cannot be made (a parent line outside the last 512 KB of the transcript, an unreadable line, a zero, negative or over-30-minute difference) has no duration: its span has start equal to end, it is left out of the metric, and nothing fails. The metric is built from the `model.call` spans as the exporter sends them, in memory: observations not yet sent when the dashboard stops are lost, and a send the collector refuses for good is dropped, while a failed send is retried.

The dashboard also reports its own HTTP server as the OpenTelemetry HTTP conventions define it: `http.server.request.duration` (seconds, cumulative histogram, the conventional bounds from 5 ms to 10 s) by `http.request.method`, `http.route` and `http.response.status_code`. `http.route` is a TEMPLATE, never the path: only the resource and a fixed list of words the dashboard's own routes use are kept (`/api/kanban/{id}`, `/api/memories/{id}/versions`, `/api/schedules/tick-status`), every id, name or search term becomes `{id}`, the query string is never read, everything that is not the API is `static`, an answer that says no (4xx) is labelled with the resource only (`/api/kanban`), so a stranger's made-up paths neither fill the template cap nor show which paths exist, and after 300 distinct templates new ones are `/other`. A request cut short by the client and event streams are not measured. A request that failed on the server (5xx) or took a second or more also gets a span (`GET /api/overview`, kind SERVER, the same three attributes and an error status for a 5xx); faster successes have only the histogram, to keep the database writes down. A `traceparent` header (W3C trace context) puts that span into the caller's trace, but only when the request came with credentials (a stranger's header is ignored), and ids starting with `w3c-` are reserved: `POST /api/spans` refuses them and only the dashboard's own request spans are sent with such an id as it is; the tool-log hook sends one derived from its session id, the same trace id the exporter uses for that session's spans. The span does not take over the caller's span id as its parent.

Only a fixed set of span attributes leaves the machine: tool name, MCP server and tool, message id, sender and recipient, model and the token counts. Anything else on a span is dropped. The input summary of a tool call (the start of a command, a file path, a URL) is not exported unless `OTEL_EXPORT_INPUT_SUMMARY` is on, and even then it is shortened to 120 characters with the credentials it recognises (`user:password@`, `curl -u`, Authorization, Bearer and Basic values, `password=` or `token=` style assignments) and the home directory removed. This scrub is a heuristic, not a guarantee: keep the switch off unless the collector is somewhere you trust with command lines. Every span and resource carries `marveen.tenant.id` (`unresolved` when the tenant could not be determined) and `service.instance.id` (a hash that names neither the host nor the install path).

Logs are opt-in (`OTEL_EXPORT_LOGS`) and come from the audit tables only: approval events (`marveen.approval.*`: consumed, refused, denied), RBAC refusals and would-deny decisions (`marveen.rbac.denied`, `marveen.rbac.would-deny`; the allowed requests of non-admin callers are not sent), setting changes (`marveen.config.changed`, with the setting key only) the agent audit trail (`marveen.audit.<entity>.<action>`) the blackboard (`marveen.blackboard.<active|done|blocked>`, a blocked post is WARN; the agent and the status only, never the summary or the task reference), card moves on the kanban board (`marveen.kanban.card.moved`, the two statuses, a keyed hash of the card and of the actor as `marveen.kanban.card.hash` and `marveen.actor.hash`: one card can be followed through its columns, no title, description, comment or id leaves) and the refusals of the PreToolUse gates (`marveen.hook.deny`, with the gate name in `marveen.gate` and a reason code; the allow and context-handoff rows of the same table are not sent). A record carries the event name, a severity, the time and a few bounded identifiers (decision, role, permission, setting key, entity, action, tenant), nothing else. Content never leaves the database: old and new setting values, audit details, approval references and request paths are not even read. Every actor (user, token, device, agent) is replaced by `marveen.actor.hash`, a keyed hash with a salt that stays in the database, so the same actor is the same value in every record but the name cannot be read back. Switching the export on does not replay the past: the first run starts after the newest row of each table, and from then on rows are sent once, oldest first, and kept for the next try while the collector fails. The PreToolUse gates count their own verdicts (destructive-gate, secret-read-gate, email-approval-gate, outgoing-copy-gate, auth-admin-gate, tenant-skill-gate), and the dashboard sends the running totals as the cumulative counter `marveen.gate.decisions` (`marveen.gate`, `marveen.gate.decision` = allow, deny or error, and for a deny or error `marveen.gate.reason` = denied, gate_error or exit_code), which is what an allow rate is made of. It is metrics, so it does not depend on `OTEL_EXPORT_LOGS`. The count is written by the gate process after it has decided; a failed or slow write is dropped and never changes what the gate decided (the cost is a few milliseconds per call). An allow also counts a call to a tool the gate does not inspect, and a deny that ends the gate by its own hard timeout is not counted. Nothing of the call the gate looked at (command, path, recipient) is ever stored.

The dashboard's own log lines are a second, separate opt-in (`OTEL_EXPORT_APP_LOGS`), because they are free text. Only warn, error and fatal lines go out, in the scope `marveen.app` of the `marveen-dashboard` resource, and of each line only its MESSAGE TEMPLATE: the values pino fills in (`%s` arguments) and the fields bound to the call, which is where a call's data lives, are never read. The template is cleaned of credentials, the home directory, mailboxes, paths and long ids and cut to 160 characters, plus, when the line carries an error, its class name and a string `code` (`exception.type`, `marveen.log.error_code`), never its message or stack. This is a heuristic: a value built into the message string itself (a template literal) is the one thing it cannot recognise, which is why it is not part of `OTEL_EXPORT_LOGS`. The code is held to fixed messages for that reason: a CI ratchet (`scripts/log-message-literal-ratchet.py`) fails when a warn, error or fatal call has a message that is not a fixed string (a built value, or a variable) instead of binding the data as a field, and the call sites that did (the homoglyph warnings, the prober's stderr, the API error catalog, a few names) were rewritten. The scrub also removes stand-alone provider credentials (Anthropic/OpenAI `sk-`, GitHub, Slack, JSON web tokens, AWS key ids) and, in log text, long mixed letter-digit runs. Identical lines are folded into one record with `marveen.log.count`, the buffer keeps the last 500 different lines in memory (a restart empties it) and what had to be dropped is the counter `marveen.log.dropped`. The exporter's own lines are not captured, so an unreachable collector does not log about itself.

The collector needs a logs pipeline (the OpenTelemetry Collector's `otlp` receiver accepts `/v1/logs` on the same port); a collector without one answers 404, which is retried with the usual backoff and shows in `marveen.otel.export.failures` with `marveen.otel.signal=logs`.

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

## 10. Model fallback

The Model fallback section is synthetic and admin-only. It configures the fleet-wide policy that moves an agent to a cheaper model when its plan usage limit runs out (how it behaves is described in [04 - Agents](04-agents.md)).

| Field | Description |
|-------|-------------|
| **Enabled** | Off by default; while unchecked, no agent is ever switched automatically |
| **Model chain** | The first entry is the primary model; each following entry is the next step down. At least 2 entries are required |
| **Revert after (minutes)** | How long after a downgrade the agent may return to its configured model, once the limit message is gone |

Unchecking **Enabled** stops new downgrades only. An agent that is already on a fallback model still returns to its configured model once the revert time has passed (the saved value applies), so you do not need to switch the feature back on to release it. The details are in [04 - Agents](04-agents.md#model-fallback-on-usage-limit).

---

## Tips

- The dirty-state bar shows the count of modified keys; unsaved changes are lost if you navigate away.
- Device keys are displayed only once upon creation; store them securely immediately after generating.
- Autonomy levels can be reset to 1 at any time to protect sensitive categories from autonomous execution.
