# F03 Operations

## Starting and stopping services

Marveen runs as two background services: `dashboard` (API + web UI) and `channels` (channel connection + agents).

### macOS (launchd)

```bash
# Start
launchctl start com.<agent-id>.dashboard
launchctl start com.<agent-id>.channels

# Stop
launchctl stop com.<agent-id>.dashboard
launchctl stop com.<agent-id>.channels

# Restart
launchctl kickstart -k gui/$(id -u)/com.<agent-id>.dashboard
launchctl kickstart -k gui/$(id -u)/com.<agent-id>.channels

# Status
launchctl list | grep <agent-id>
```

> `<agent-id>` is the `MAIN_AGENT_ID` value in `.env` (e.g. `marveen`).

#### Helper launchd jobs (macOS)

The helper installers (`install-channel-keepalive-probe.sh`, `install-channel-coordinator.sh`, `install-channel-watchdog.sh`) build the launchd label from the install's own id: `com.<service-id>.channel-keepalive-probe`, `com.<service-id>.channel-coordinator`, `com.<service-id>.channel-watchdog`. The id is the `SERVICE_ID` value in the install's `.env`, else `MAIN_AGENT_ID`, else `marveen`. Two installs under one user therefore no longer overwrite each other's helper job. On a default install the label is still `com.marveen.<name>`, so nothing moves.

- Read the label without installing anything: `scripts/install-channel-keepalive-probe.sh --print-label`.
- Rollout (a manual step, a few minutes without the keepalive): on an install that was already renamed (`SERVICE_ID` is not `marveen`), run the installer again with `--load`. The installer retires the install's own old `com.marveen.<name>` job (only when the plist's `WorkingDirectory` is this tree; another install's `com.marveen.*` job is left alone) and loads the new one.
- Way back: restore the previous version, run the installer again with `--load` (it writes the old `com.marveen.<name>` label again), then unload the new job: `launchctl bootout gui/$(id -u)/com.<service-id>.<name>` and delete `~/Library/LaunchAgents/com.<service-id>.<name>.plist`.
- `SERVICE_ID` must consist of letters, digits, `_` or `-`; any other value makes the installer warn and use `marveen`.

### Linux (systemd)

```bash
# Start
systemctl --user start marveen-dashboard
systemctl --user start marveen-channels

# Stop
systemctl --user stop marveen-dashboard
systemctl --user stop marveen-channels

# Restart
systemctl --user restart marveen-dashboard
systemctl --user restart marveen-channels

# Status
systemctl --user status marveen-dashboard
systemctl --user status marveen-channels

# Logs
journalctl --user -u marveen-dashboard -f
journalctl --user -u marveen-channels -f
```

### Restart via the API

If the dashboard is running, a restart can also be triggered at the `/api/updates/apply` endpoint (call it through `bash scripts/agent-api.sh --token operator POST /api/updates/apply`; the wrapper reads the token, you never put it on a command line).

At startup the dashboard takes `WEB_PORT` over from its own previous instance: it terminates the node process holding the port. This only applies to a process of this install (its command line or working directory is under the install tree). If the dashboard of another install or another checkout holds the same port (for example an identical `WEB_PORT` in a copy prepared for a trial), the dashboard leaves it alone: the log carries the line `Port holder belongs to a different install, leaving alone`, and the start stops with `EADDRINUSE`. Give the other install its own `WEB_PORT` in that case.

## Updating

```bash
./update.sh
```

The updater runs: `git pull` (fast-forward only), `npm install`, TypeScript compilation, restarts the services, then verifies with a health check.

**Automatic rollback:** if the dashboard does not respond within 20 seconds after restart, the updater automatically reverts to the previous commit and restarts again.

### Update options

```bash
# Force-refresh fleet seed skills and scheduled tasks
# (does NOT touch your own customizations — only seed-* directory contents)
./update.sh --reseed-fleet

# Regenerate CLAUDE.md from the template (using the current .env identity)
# The existing CLAUDE.md is backed up first
./update.sh --regen-claudemd

# Force rebuild even when code is already up to date
# (useful when dist/ is stale after an interrupted build)
./update.sh --rebuild
```

Options can be combined: `./update.sh --reseed-fleet --rebuild`

### Automatic updates

Automatic updates are disabled by default. To enable:

```ini
# .env
AUTO_UPDATE_ENABLED=1
```

When enabled, the seeded `auto-update` scheduled task runs `update.sh` every Wednesday at 04:00 and sends a notification on the configured channel.

## Claude Code updates

This is separate from the Marveen update above: it updates the `claude` binary itself.

Claude Code's built-in auto-updater is **switched off in every session** (`DISABLE_AUTOUPDATER=1` at every launch site and in the tmux global environment). With a fleet of sessions respawned together, each session used to start the updater in the same second against the one shared install (npm-global installs failed with `ENOTEMPTY` on the package-directory rename), and the binary changed under a running session at a moment nobody chose.

Instead, one command task updates the binary once:

- The `claude-update` schedule (seeded once per install, Monday 06:00 in the server's time zone) runs `scripts/claude-update.sh`. It takes a lock, compares the installed version with the latest published one, updates once (`claude update` for a native install, a single `npm install -g` for an npm-global install), checks that the binary still runs and records the result in `store/claude-update.json`. A failure alerts on Telegram after the first occurrence and restarts nothing.
- After a real version change the dashboard restarts the sessions that started before the change: **only idle sessions, one at a time, at least 45 seconds apart, the main agent last**. Sub-agents resume with `--continue`; the main agent comes back with a fresh conversation (memory persists). Remote agents run their own install and are not touched.
- The **Updates** view shows the installed and latest version, the last check, whether a restart is pending and a warning when the last check is older than 10 days (the weekly task is not running).

Controls:

```bash
# Check without changing anything (prints installed/latest)
bash scripts/claude-update.sh --check

# Hold the fleet on a version (the weekly task then only records "pinned")
echo 2.1.300 > store/claude-pin        # or: CLAUDE_UPDATE_PIN=2.1.300 in the environment
rm store/claude-pin                    # release the hold
```

- AVX-less x86 hosts are always held: the pinned Node-based build (`install-linux.sh`) must not be replaced by the latest Bun binary, which crashes without AVX.
- `CLAUDE_UPDATE_AUTO_RESTART=0` (Settings, system module) keeps the update but leaves running sessions on the old build until their next restart; the Updates view then shows the restart as pending.
- Run the update now from the Tasks page ("run now" on `claude-update`). To stop updating, disable that schedule; deleting it is remembered and the task is not re-created.
- Rollback: install the older version by hand, then pin it with `store/claude-pin`.

## Health check

```bash
bash scripts/doctor.sh
```

`doctor.sh` checks:
- launchd/systemd services are running
- the dashboard HTTP endpoint responds
- the tmux session is alive
- `.env` essential fields are set
- Node.js and npm are available
- every agent token file matches an active token (`agent-tokens check`; a missing or stale file is a warning)

Exit code: 0 = all OK, 1 = something failed.

Direct HTTP health check:

```bash
curl -f http://localhost:3420/
```

## Skill usage log

A hook logs agents' skill use; the dream-engine skill-health check and the Skills page badges are built on it. The hook is added to every sub-agent's settings when the dashboard starts (the main agent's lives in the repo's tracked settings); it also widens an older, already configured matcher, but a running session re-reads its settings only after a restart.

Each row also stores the kind of use (`source`): `skill_tool` (the Skill tool), `read_tool` (Read on any file in a skill directory), `bash_read` (a reading command on one concrete skill file), `bash_script` (an interpreter or `./` on a file under the skill's `scripts/`), `api_read` (a GET on the skills database API), `slash` (a slash call). `trigger_type` keeps its old two values; older rows have a NULL `source`, which is derived from `trigger_type` on read; there is no backfill. A repeat of the same agent, skill, session and `source` within 60 seconds is one row.

Limits (best effort): a path built at run time, a command inside `bash -c "..."` and a shell path with a space are not seen; a slash call counts only at the start of the input and `plugin:skill` names do not count; the dashboard UI's own requests are not logged.

---

## What a PreToolUse hook may do

A PreToolUse hook may only **deny** a call (`permissionDecision: "deny"` or exit code 2) or **add context**. It may not rewrite the call's input, and it may not allow, ask or defer. The reason is the outgoing mail: `scripts/hooks/email-approval-gate.py` claims an approval for the hash of the mail it reads from the call, and for the MCP route that hash is the only binding (the MCP server does not check it again). A second hook that rewrote the input of the same call could make the mail that leaves differ from the mail that was approved. The email gate is therefore the only PreToolUse hook that decides anything about a send; the others can only refuse. `updatedToolOutput` (it replaces a tool result, not the input) is allowed only in the files the ratchet lists (today the browser content notice).

`scripts/__tests__/hook-input-rewrite.test.py` (run by the CI Python step) fails on any hook script, gate or source file that uses the input-rewrite key, sets `permissionDecision` to anything but `deny`, or uses `updatedToolOutput` outside its allowlist. If a rewrite or an allow is really needed, the email hash must be re-checked at the point of effect (the sender claims for the hash it computed itself) and the allowlist gets a reviewed entry with the reason. Nothing in the repo's own hooks or the installed plugins does any of this today, so the rule costs nothing now.

## Interrupted-turn hint

A session that dies in the middle of a turn (crash, watchdog respawn, host restart) used to leave its successor blind: Claude Code does not re-run a cut-off turn, and an inter-agent message or channel prompt injected just before the death vanished without a trace. `scripts/hooks/inflight-turn.py` closes that gap with one row per agent in `agent_inflight_turns` (migration 0085, API `/api/agent-inflight-turn/:agent/{begin,end,replay,consume}`):

- `UserPromptSubmit` runs `inflight-turn.py begin`: notes the source (channel, agent message, scheduled task, direct prompt), the `msg_id:N` if the prompt names one, a 200-character preview and a hash. It prints nothing.
- `Stop` runs `inflight-turn.py end`: the turn finished, the note is dropped.
- `SessionStart` (`startup`, `resume`, `clear`; never `compact`, which fires inside a healthy turn) runs `inflight-turn.py replay`: a note that is still there, under 6 hours old and not offered before becomes an `additionalContext` hint, then it is marked offered. A second start offers nothing.

The hint is advice, never a re-run: it names the source, message id and start time, quotes the preview as data, and tells the agent to decide whether the work needs doing again and to check for side effects (mail, push, delete, delegation, card moves) before repeating anything. An agent served by two or more tenants gets the hint without the preview, and its prompt text is not kept (the check is made again at replay, so an agent enabled for a second tenant later is covered too).

Known false positive: a user interrupt (Esc) runs no `Stop` hook, so the note survives and one needless hint can follow the next restart; the TTL and the single offer bound it.

The hooks never block: every path ends in exit 0, a dashboard that is down is a silent no-op, and without the agent's own token file no call is made. Wiring (one hook command each; a matcher is needed only on `SessionStart`):

```json
"UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "python3 <install>/scripts/hooks/inflight-turn.py begin", "timeout": 10 }] }],
"Stop":             [{ "hooks": [{ "type": "command", "command": "python3 <install>/scripts/hooks/inflight-turn.py end", "timeout": 10 }] }],
"SessionStart":     [{ "matcher": "startup|resume|clear", "hooks": [{ "type": "command", "command": "python3 <install>/scripts/hooks/inflight-turn.py replay", "timeout": 15 }] }]
```

## Tenant skill gate

Agents that serve several tenants keep each tenant's skills inside that tenant's requests. Two hooks do it (both wired at dashboard start into every sub-agent's `settings.json`; the main agent is not gated; running sessions pick them up after a restart):

- `tenant-context.py` (UserPromptSubmit) records, per agent, which tenant the request it is about to serve belongs to (`agent_tenant_context`).
- `tenant-skill-gate.py` (PreToolUse: `Skill`, file tools, `Bash`) blocks a tenant skill, its directory and its companion scripts outside that tenant's requests. Fleet skills are never affected.

**Bind a source to a tenant** (chat, dashboard user or inter-agent sender, per agent) with the admin API:

```bash
bash scripts/agent-api.sh --token operator PUT /api/v1/admin/channel-bindings '{"agent_id":"<agent>","channel":"telegram","external_id":"<chat id>","tenant_id":"<tenant>"}'
# GET lists (?tenant_id= / ?agent_id=), DELETE unbinds (?agent_id=&channel=&external_id=)
```

- A source with no binding belongs to the `default` tenant: tenant skills are not usable for it.
- A message an agent sends while serving a tenant's request is stamped with that tenant, so a coordinator's delegation carries it to the receiving agent. That message is then visible to that tenant's dashboard users and to admins, and to no other tenant.
- The agent must be enabled for the tenant (or be its main agent) and the tenant must not be disabled; otherwise the source resolves to "unknown" and no tenant skill is usable.
- A scheduled task carries its tenant in its own row (`schedules.tenant_id`, `default` when missing), not in a chat binding: the hook reads it from the task prompt. The task's agent has to serve that tenant. The schedules API enforces this when a task is created or edited, and the runner re-checks it on every tick and does not fire a task whose pair broke (run history `skipped_tenant_mismatch`); see F07, "Tenant ownership of scheduled tasks".
- Changing or deleting a binding, disabling an agent for a tenant, disabling a tenant or changing its main agent drops the affected context at once; tenant skills stay denied until the agent's next prompt re-resolves the source.
- Fail closed: a missing table, a database error, a stale context (`TENANT_CONTEXT_MAX_AGE_SECONDS`) or a gate error denies the tenant skill. The prompt hook refuses the prompt when it cannot record the context. It never creates tables: migration 0065 owns `agent_tenant_context`, so the dashboard must have migrated first.

To check a rollout (before and after the dashboard restart that wires the hooks), run `python3 scripts/tenant-gate-rollout-check.py`: it is read-only and reports migrations, hook scripts, per-agent wiring, live hook evidence and multi-tenant agents without a channel binding. The migration, hook-evidence and channel-binding facts come from the running dashboard (`GET /api/admin/tenant-gate-status`); a dashboard that predates the endpoint gives a WARN instead, so the first run before the restart still reports the file-side checks.

The main agent is intentionally not under the gate: a fail-closed prompt hook could refuse its prompts on a database error and stall the whole fleet's coordination, and it needs no tenant skills.

Limits: this enforces the **use** of tenant skills, best-effort on the shell side (a command that builds a path from variables is not caught). It is not data isolation: an agent's shared session still holds the earlier tenant's messages in its context.

### Starter pack for an existing tenant

The starter pack (one daily-summary scheduled task, details: F07 "Tenant starter pack") is created by itself only for a tenant created after the release that introduced it (see F07 "Tenant starter pack", automatic creation); an existing tenant does not get it automatically. For those, and for a repair, an admin asks for it, per tenant, at any time; the request is idempotent, and repeating it never overwrites anything. On the dashboard the **Starter pack** button on the Tenants tab does it; through the API:

```bash
bash scripts/agent-api.sh --token operator POST /api/v1/admin/tenants/<tenant>/starter-pack '{"agent_id":"<agent>"}'
# the body may be omitted: the agent is the tenant's main agent, failing that the only enabled agent
# GET on the same path only reads: the state, and the agent a create would choose
```

The steps:

1. The agent has to be enabled for the tenant (or be its main agent) and must not serve another tenant as well. If that does not hold, the request answers `409`; if there is no single agent, `400 required` (pass `agent_id` then).
2. The request creates a `draft` and disabled task. A signed-in admin has to activate it (Tasks page), and then **Resume** enables it.
3. A channel message goes to the tenant's users only when they have a Telegram channel binding to the agent (the `channel-bindings` call above, a private chat) and the same chat is on the `allowFrom` list of the agent's `access.json`. At most 3 recipients get the message, group chats are left out. With no binding the task only writes the daily log.
4. If the tenant's agent changes later, changing the agent availability re-aims the task automatically (and puts it back to `draft` and disabled). After an agent is deleted or renamed, or when the tenant's main agent is replaced from SQL, there is no automation: repeating the request (or the button) fixes it.

## Watchdog

The channel connection is supervised by an independent watchdog (`scripts/channel-watchdog.sh`) that runs separately from the dashboard process (systemd timer, every 5 minutes). If the channel session gets stuck or exits, the watchdog recovers it with `tmux respawn-pane` — only the channel session, not any other agent sessions.

Two detection signals:

| Signal | Description |
|--------|-------------|
| STALE | `store/.channel-keepalive` file mtime: older than 3 minutes means the channel session is likely down |
| AUTHDEAD | Claude login error in the live session pane (e.g. "Please run /login", 401) — fallback path for when the dashboard is down; when the dashboard is running, its own reauth handler acts first |

The watchdog is patient: it only intervenes after `AUTH_DEAD_THRESHOLD_TICKS` consecutive negative signals (approximately 10–15 minutes), so a brief network blip does not trigger an unnecessary restart.

### Sleep and wake (macOS)

A sleeping Mac runs no timer: the keepalive probe and the watchdog both stop, and the overdue ticks fire right after the wake in no fixed order. Without a guard the watchdog came first, saw a keepalive file as old as the sleep and respawned a healthy main session (twice in two days, each time throwing away a live conversation). So the watchdog reads the last wake time (`sysctl -n kern.waketime`, which also moves on a DarkWake, a maintenance wake) and, for `WAKE_GRACE_SECONDS` (600) after it:

- does nothing in that tick and logs `recently woken (<n>s ago, grace 600s) -- skipping this tick`; the dead-token arm waits too, because the network is often not back yet;
- afterwards measures the keepalive age from the wake at the earliest, so a file that predates the sleep is never "stale" before the keepalive probe has had its ticks.

It only delays: a session that is still dead after the grace is respawned by a later tick. Where the wake time cannot be read (not macOS, `sysctl` missing) the watchdog behaves as before. On a machine that wakes every 15 minutes on battery (Maintenance Sleep) the watchdog is therefore mostly paused; that machine serves nothing then, and the first full wake gets the 10-minute grace. `pmset -c sleep 0` keeps a machine awake on AC only; on battery the wake gate is what protects the session. The context guard has the same problem with its handoff deadlines: a sweep that finds the previous one more than three intervals ago treats the excess as sleep and moves the running deadlines by it (`context-guard: the machine slept between sweeps, running deadlines moved`).

The Telegram progress sentry (`scripts/hooks/telegram_progress_watchdog.py`, the "working on it" placeholder watchdog) has the same gate: it ages a placeholder on the wall clock, so after a sleep it saw every live placeholder as old and rewrote the placeholder of a healthy turn into the error text. It reads the wake time through the same `portable_wake_epoch` helper, does nothing for 600 seconds after a wake (`recently woken (<n>s ago, grace 600s) -- skipping this run` in the progress directory's `debug.log`), and afterwards counts a placeholder's age, and the age of the dedup markers it sweeps, from the later of the file's modification time and the wake. An unknown wake time (not macOS, no `sysctl`, a stray copy of the script without `scripts/lib/portable.sh`, a wake time in the future) behaves as before. `scripts/__tests__/telegram-watchdog-wake.test.sh` covers it.

## Model fallback on usage limit

When an agent hits the plan's usage limit, or its model becomes unavailable, the model-fallback runner can move it down a configurable chain (for example opus, then sonnet, then haiku) and later climb back. It is off by default. Admins configure it in Settings, "Model fallback", or with `GET` / `PUT /api/model-fallback` (`enabled`, `chain`, `revertAfterMinutes`; the default revert window is 330 minutes, overridable with `DEFAULT_REVERT_AFTER_MINUTES`). The configuration is stored in the database (`system_config`).

How it works:

- A sweep runs every 60 seconds over the main agent and every running sub-agent. It reads the pane, and acts only when the pane is idle.
- A usage-limit banner is one detection. A "model unavailable" message must be seen in two consecutive sweeps, so an error text quoted in a chat does not cause a switch. The "approaching usage limit" warning does not count as an exhausted quota.
- A downgrade is stored as a **persistent overlay** in `store/model-fallback-state.json` (per agent: `primary`, `current`, `downgradedAt`). The model resolvers, including `scripts/channels.sh` for the main agent, read the overlay first while it is active. Your own configuration (`MAIN_AGENT_MODEL` in `.env`, or the agent's `model` in `agent-config.json`) is never rewritten.
- A sub-agent is respawned with its conversation kept (`--continue`). The main agent is relaunched fresh, so its conversation is not preserved; the model swap is what matters there.
- The overlay survives a dashboard restart, so the revert still happens. After `revertAfterMinutes` without a limit, the agent returns to **its own configured model** (not the first model of the chain), and the overlay is removed.
- After any switch there is a 10 minute cooldown before a new downgrade, because a respawned pane can still show the old banner and would otherwise be walked down the whole chain within minutes.
- If the agent's configured model is changed to the very model the overlay pins, the overlay is dropped as stale at the next sweep.
- Changing an agent's model on purpose (dashboard, or `PUT /api/agents/<name>` with a `model` different from the configured one) clears its overlay, so your choice wins over an automatic downgrade. Saving a form that only repeats the unchanged model does not cancel an active downgrade.
- The agent summary (`GET /api/v1/agents`, `GET /api/v1/agents/<name>`) reports both models: `model` is the configured model, `fallback` is the active overlay (`{ primary, current, downgradedAt }`, or `null`), and `effectiveModel` is what the agent launches with (the fallback model while an overlay is active). The dashboard model selector holds `model` and shows a `fallback active: <model>` marker; saving it unchanged sends no request and does not restart the agent, so the overlay stays. A client that builds its own model picker must use `model` as the picker value. Sending `effectiveModel` or the live model back unchanged would be read as an operator change and drop the overlay.
- **Switching the feature off** only forbids new downgrades. The sweep still visits every agent that carries an overlay (and only those) and reverts it through the same path as with the feature on: once `revertAfterMinutes` has passed since `downgradedAt`, the overlay is cleared first, then the session is restarted (a sub-agent with `--continue`, the main agent relaunched fresh), and the overlay is put back if the restart fails. The pane must be readable and idle, otherwise the revert waits for a later sweep. With the feature off the usage-limit and model-unavailable detections are not evaluated, so a banner in the pane cannot delay the revert, and the 10 minute cooldown (which only guards new downgrades) does not apply. Because the sweep runs every 60 seconds (the first one 50 seconds after the dashboard starts), a due revert happens within about a minute. An agent that is not running when its overlay is due just loses the overlay without a restart, so its next start uses the configured model; this also happens with the feature on. To release an agent sooner, delete its entry from `store/model-fallback-state.json` and restart it.
- The main agent's launcher `scripts/channels.sh` reads the overlay with `jq`. It needs `jq` on the `PATH`, and it ignores an overlay value that is not a plain model id (letters, digits, `.`, `_`, `:`, `/`, `-`, brackets, at most 128 characters), because the value is placed into the launch command. In both cases the main agent launches on `MAIN_AGENT_MODEL` or the model in `.claude/settings.json`, as if there were no overlay.
- `scripts/channels.sh` does not check whether the overlay is due for a revert. A main agent that is respawned (for example by the watchdog) before the next model-fallback sweep therefore launches on the overlay model even if its revert time has passed, and stays there until the next sweep reverts it (the sweep runs every 60 seconds).

## Context restart gate

The context restart gate keeps long sessions healthy without cutting work in flight. When an agent's context grows past a token threshold it sends a soft `/clear`, so the SessionStart hooks can carry the agent into a fresh session, but only when nothing is in flight. It uses no model tokens: every check is a database query, a file read, or a pane/process snapshot.

It is opt-in per agent (disabled by default). The per-agent settings live in the `agent_settings` table (key `context_restart_gate`) and the run state in the `agent_state` table; there is no HTTP route for them. Defaults: threshold 400000 tokens, stale cutoff 2 hours, re-check every 5 minutes, persistent-block alert after 2 hours, forced `/clear` after 4 hours of block.

The gate is fail-closed: a signal it cannot measure blocks the restart. It blocks while any of these holds: the pane is not confirmed idle or shows a usage-limit banner, the hard context guard is managing the session, the claude process has live children (Task-tool subagents, background shell commands), the agent has dispatched messages still awaiting a result, the last inbound channel message has no later reply, or a structured task state is in progress. A gate that stays blocked for hours raises an alert, and past the forced-restart window, with nothing in flight and the pane idle, it sends the `/clear` anyway.

Signals that no longer describe live work are ignored, so a gate cannot stay shut on stale data:

- An unanswered inbound message older than the stale cutoff counts as abandoned, like a dispatched message of the same age.
- Completion reports (`[Eredmény]` messages) and a sub-agent's messages to the main agent (status reports, replies) are not counted as pending outbound, because no result ever comes back for them. The main agent's own outbound messages are real delegation and still count.
- A blocking streak that began before the current session started is discarded: a restarted agent does not inherit the old session's block clock, alert or forced-restart eligibility.
- The context size is measured from the **active** session's transcript only. A transcript last written before the session started belongs to the previous session; a new session with no transcript yet counts as 0 tokens, not as the old session's size.

## Backup and restore

### Running a backup

```bash
bash scripts/backup.sh
```

Archives go to `backups/` (`claudeclaw-YYYYMMDD-HHMMSS.tar.gz`) with a SHA-256 sidecar file (`.sha256`). When a vault exists, the vault master key is written to a separate `claudeclaw-YYYYMMDD-HHMMSS.vault-key` file (mode 0600) -- see below.

**Retention:** the most recent 30 archives are kept (default). Override:

```bash
BACKUP_KEEP=14 bash scripts/backup.sh
```

To run the backup nightly, schedule it as a `type: command` task (see F07, "Command tasks"): it runs without an agent session, and with `failThreshold: 1` the first failure sends a Telegram alert.

### Archive contents

The archive has two groups:

**`repo/` group** (relative to the project root):
- `store/claudeclaw.db` (+ `-shm`/`-wal`) — database (after WAL checkpoint)
- the `api_tokens` rows (token hashes) inside the database
- `store/vault.json` — the *encrypted* secret vault (the key is not in the archive)
- `.env` — main configuration
- `agents/*/CLAUDE.md`, `SOUL.md`, `.mcp.json` — agent identities
- `agents/*/.claude/channels/*/` — per-agent channel configuration
- `agents/*/memory/` — per-agent memory directory

**`home/` group** (relative to `$HOME`):
- `.claude/skills/` — skill library
- `.claude/scheduled-tasks/` — file-based scheduled tasks
- `.claude/projects/*/memory/` — auto-memory of the main agent, workers and sub-agents (their `projects` dirs are symlinks to this one shared location, so it is stored once)
- `.claude/channels/*/` — channel tokens and pairing state
- `Library/LaunchAgents/com.<agent-id>.*.plist` — launchd jobs (macOS)

**Not in the archive, on purpose:** the per-agent token files (`agents/<agent>/.agent-token`), the main agent's `.agent-token` in the project root, `store/.operator-token` and the shared dashboard token file `store/.dashboard-token` (an archived shared token would bring a rotated-away token back to life). They are re-issued or rotated after a restore.

### Vault master key

`store/vault.json` is encrypted; the master key lives in the macOS Keychain (item `com.marveen.vault` / `master-key`) or, as a fallback, in `store/.vault-key`. The key is deliberately **not** in the archive: anyone holding the archive and the key can decrypt the vault. `backup.sh` writes it to `backups/claudeclaw-YYYYMMDD-HHMMSS.vault-key` (0600). **Store that file somewhere other than the archive** (a different disk or a password manager). If no key can be found at backup time, the backup still completes and prints a warning -- the vault in that archive cannot be decrypted. To restore the key: copy the file to `store/.vault-key` (`chmod 600`), or import it into the Keychain without putting the key on a command line (arguments are visible to other processes via `ps`): run `security add-generic-password -U -s com.marveen.vault -a master-key -w` with `-w` as the last option and no value, and paste the key when it prompts.

`scripts/verify-restore.sh` fails if a key file is found *inside* an archive, and warns if `vault.json` is archived but the `.vault-key` sidecar is not next to it. It also fails if an agent, operator or shared dashboard token file is found inside an archive (the backup scope changed), warns if the archive's shared token row is older than the live one (the archive predates a rotation), and ends with the token steps below; the `restore_log` note then reads `token-step pending`.

### Restore

```bash
# 1. Inspect
tar -tzf backups/claudeclaw-20260101-120000.tar.gz | head -20

# 2. Extract to a temporary directory first
mkdir /tmp/restore
tar -xpzf backups/claudeclaw-20260101-120000.tar.gz -C /tmp/restore

# 3. Copy back to project root and home
cp -a /tmp/restore/repo/. ./
cp -a /tmp/restore/home/. ~/
```

> The `-p` (preserve modes) flag ensures `0600` token files remain owner-readable after restore.

### After a restore: API tokens

Every agent signs its dashboard calls with its own token file, and the operator scripts use `store/.operator-token`; neither is in the archive, so a restored install has agents that cannot call the API until the files are re-issued. There is no shared-token fallback: an agent whose own token is missing gets no answer from the wrapper (`agent-api.sh` exits 3, `agent_token.py` and `agent-api.mjs` report source `none`) and sends no request. The shared dashboard token (`store/.dashboard-token`) is kept out of the archive too, but the database rows are in it, so rotate it as well: the archive may predate an earlier rotation, and a restore must not bring a replaced shared token back. Run the token steps **before** the dashboard and the agents start (steps 2 to 5 work with the dashboard stopped: they talk to the database directly):

```bash
# 1. extract the archive and copy it back (see "Restore"), then restore the vault key
# 2. re-issue the token files; an already valid file is kept, a file the database does not know is replaced
npm run agent-tokens -- issue
npm run agent-tokens -- issue-operator
# 3. rotate the shared token, always: it mints a new one, writes it to store/.dashboard-token and revokes
#    the restored row, so the old value is refused (401, counted as shared_token_refused). It refuses to
#    run while DASHBOARD_TOKEN is set in .env or the environment (the variable overrides the file).
#    A browser that still holds the old token (?token= link) has to be enrolled again with
#    `npm run dashboard-url`.
npm run agent-tokens -- rotate-shared
# 4. check every file against the database
npm run agent-tokens -- check
bash scripts/doctor.sh
# 5. only now start the dashboard and the agents
```

`agent-tokens issue-operator` is also what the operator scripts (`fleet-safe-start`, `pre-pr-review`, `settings-verify`, `doctor.sh` and the like) tell you to run when `store/.operator-token` is missing: they take no other token.

`agent-tokens check` is read-only and never prints a token. One line per file, `subject  status  role  path`, exit code 1 when anything is not `ok`:

| Status | Meaning | Fix |
|--------|---------|-----|
| `ok` | the file holds a token the database accepts for that subject | none |
| `missing` | no file, or an empty one | `agent-tokens -- issue` (`issue-operator` for the operator) |
| `unknown_hash` | the database has never seen this token (an older database under newer files, or the reverse) | `issue` replaces it |
| `revoked` | the token was revoked or has expired | `issue` replaces it |
| `wrong_role` | the file holds a valid token of another subject or role | `issue` replaces it |
| `multiple_active` | the file token is valid, but its name has more than one active row (a fifth column names the token name and the count); the other rows belong to nobody | `issue --rotate` (`issue-operator --rotate`): a plain `issue` keeps the valid file and leaves the extra rows |
| `shared_mismatch` | `store/.dashboard-token` does not hash to the active `dashboard` row | `rotate-shared` (step 3) |
| `shared_in_env` | `DASHBOARD_TOKEN` is set in `.env` or the environment; the archive carries `.env`, and the variable overrides the token file | remove it from `.env`, then `rotate-shared` |

`doctor.sh` runs the same check in its "Agent tokens" section. A missing or stale agent or operator token is a FAIL there (not a warning): nothing falls back to the shared token any more.

### After a restore: regenerate the skill files

The skills database is the source of truth; the `SKILL.md` files and their `scripts/`, `references/` companions under `~/.claude/skills/` and `agents/*/.claude/skills/` are a cache generated from it (the archive still contains `.claude/skills`, so a full restore brings them back too). When the database was restored without the files, or the files are older than the database:

```bash
# 0. Files that exist on disk but not in the DB yet (e.g. a newer file restore): insert-if-absent, never overwrites a row
npx tsx scripts/materialize-skills.ts

# 1. List what the DB has but the disk lacks (skills, companion files, tenant copies); exit 1 if anything
npx tsx scripts/regen-skills.ts --check

# 2. Write everything from the DB (fleet + agent-local skills, companion files, tenant skills under the tenants' own agents)
npx tsx scripts/regen-skills.ts --force
```

The dashboard does the same at every start unless `SKILL_SQL_REGEN=0`; with the switch off it logs a `Skills exist in the DB but their files are missing` warning instead. A file that differs from its DB row is restored from the row (with a warning), so a hand-edited file that never reached the DB is overwritten: save it first if it matters.

Running agent sessions load their skills at start, so restart them afterwards (the loop covers the sub-agents; the main agent is restarted the same way with `POST /api/agents/<MAIN_AGENT_ID>/restart`, which goes through its channels service):

```bash
for a in $(bash scripts/agent-api.sh --token operator GET /api/agents | python3 -c 'import sys,json; print(" ".join(x["name"] for x in json.load(sys.stdin)))'); do
  bash scripts/agent-api.sh --token operator POST "/api/agents/$a/restart"; echo " $a"
done
```

### SHA-256 verification

```bash
# macOS
shasum -a 256 -c backups/claudeclaw-20260101-120000.sha256

# Linux
sha256sum -c backups/claudeclaw-20260101-120000.sha256
```

## Logs

### macOS

```bash
# Dashboard
log stream --predicate 'subsystem contains "com.<agent-id>"' --level info

# Or from the launchd stdout/stderr files
cat ~/Library/Logs/Marveen/dashboard.log
cat ~/Library/Logs/Marveen/channels.log
```

### Linux

```bash
journalctl --user -u marveen-dashboard --since "1 hour ago"
journalctl --user -u marveen-channels --since "1 hour ago"

# Follow live
journalctl --user -u marveen-dashboard -f
```

### Secrets in the process log

The dashboard's own log (`src/logger.ts`) masks credentials before a line is written: field names such as `token`, `apiKey`, `authorization`, `password` and this install's own names (`agent_token`, `dashboard_token`, `session_token`, `device_key`, `bot_token`, ...) at any depth of a logged object, a child logger's bindings (also those added later with `setBindings()`) and an `Error` (message, stack, cause); and in free text `Bearer <token>`, `name=value` and `"name":"value"` for the same names, plus known token shapes (device key `mvdk_`, `sk-ant-`, OpenAI `sk-`, GitHub, Slack, Google API key, Telegram bot token, JWT, `vault:<id>`). A masked value reads `[REDACTED]`. The OTLP log export still receives every call.

A redactor is a safety net, not a guarantee; keep secrets out of log calls. Known limits:

- A fleet agent token is 64 hex characters, indistinguishable from a SHA-256, so it is masked next to its name or `Bearer`, never bare.
- Other token shapes (cloud access keys, Stripe, npm) and other `Authorization` schemes (Digest, Negotiate, AWS4-HMAC) are not recognised; `Basic` only in the `Authorization: Basic <base64>` shape.
- A `name=value` value stops at whitespace, `&`, `#`, quotes, brackets, comma and semicolon.
- Class instances inside a logged object (`URL`, `Map`, `Set`) are left to pino; a secret inside one is not found. An object nested deeper than 10 levels is logged as `[MaxDepth]`, and a `%j` argument that cannot be stringified as `[Circular]` (nothing leaks, the line is less detailed).
- A secret split across several log calls, or in an encoding other than plain text, is not recognised.
- Only this process log is covered, not hook logs, scripts or tmux output.

Cost, measured on one development machine (macOS, Node 22, null destination, median of 7 runs of 100,000 calls): a plain message goes from about 0.4 to 1.6 microseconds per call, an object with a message from about 1.0 to 8.6 (nested three levels: 1.5 to 12.2), a logged `Error` from about 31 to 49, and a call below the log level is unchanged (about 20 nanoseconds). Of the 10.8 microsecond increase on the nested object, the field-name redaction is about 4.0, the message hook 0.8 and the object walk 5.5. A thousand object lines per second is about one percent of a core.

### Secrets on a command line

An argument of a running process is readable by every local user (`ps -ww`). A script that calls an outside API therefore hands the secret to curl as a config on stdin, with the helpers in `scripts/lib/curl-tok.sh` (source it, no install step):

```bash
. "$INSTALL_DIR/scripts/lib/curl-tok.sh"
curl_tok "$TOKEN" -s "$URL"                                        # the token as a Bearer header, on stdin
curl_hdr 'x-goog-api-key' "$KEY" -s "$URL"                          # any one secret header
curl_tok_url "$BOT" 'https://api.telegram.org/bot@TOKEN@/getMe' -s  # the secret is part of the URL
```

A body must come from `-d "$text"` (not secret) or `--data-binary @file`, because stdin belongs to the config. A value with a double quote, a backslash or a line break is refused (return code 2, nothing sent). `scripts/set-bot-menu.sh`, `scripts/smoke-test-slack-channel.sh` and `scripts/pre-pr-review.sh` use them. `scripts/__tests__/curl-tok.test.sh` (Shell tests in CI) proves with a live `ps` probe that the secret is not in the process list, and holds a ratchet: no shell script may build a Bearer header, a `bot<token>` URL or a `?key=` query on the command line, except the legacy rows listed in the test, which can only be lowered. Not covered: scripts in other languages, and the legacy rows (the Telegram notifiers and the installers still send the bot token in the URL).

`scripts/pre-pr-review.sh` sends the diff to ChatGPT and Gemini, so the diff goes through the secret gate first (`scripts/secret-gate.ts --outbound <base>...<head>`, the detectors of the pre-commit hook and CI, run over the diff text of every changed file, removed lines included). A secret shape, a denied path (evidence or transcript directories) or channel material stops it: nothing is sent and the script exits 1. The gate prints where, never what.

### Update log

```bash
cat store/update.log
cat store/update.last-result  # JSON: status, phase, old/new version
```

## Disk space guard

`scripts/disk-space-guard.sh` can run as a timer: when free disk space drops below a threshold it sends a notification and optionally pauses database writes. The threshold is configurable in `.env` or on the dashboard Settings page.

## File permissions and encryption

Sensitive files and their permissions:

| File | Permission | Contents |
|------|-----------|---------|
| `.env` | `0600` | Bot tokens, auth key |
| `store/.dashboard-token` | `0600` | Shared dashboard Bearer token |
| `store/.operator-token` | `0600` | The operator's own admin token |
| `agents/<id>/.agent-token`, `.agent-token` (main agent) | `0600` | The agent's own API token |
| `store/.claude-oauth-token` | `0600` | Fleet OAuth token |
| `~/.claude/channels/*/.env` | `0600` | Channel bot tokens |
| `~/.claude/channels/*/access.json` | `0644` | Pairing state (not sensitive) |

Vault secrets are stored encrypted in the database — actual values are never written to plaintext files (see F02 Configuration, Vault section).

**Network exposure:** by default the dashboard binds to loopback only (`WEB_HOST=127.0.0.1`). If you expose it to the network (`WEB_HOST=0.0.0.0`), set a strong Bearer token and place it behind a reverse proxy with HTTPS.

## Multi-node

Each machine running Marveen is an independent installation — there is no distributed database. Separate fleet instances on different machines can be linked through **Federation** (see F06 Fleet), which provides reliable message exchange between two Marveen instances without sharing a database.

---

*Previous: [F02 Configuration](F02-configuration.md)*
*Next: F04 Channel configuration (coming soon)*
