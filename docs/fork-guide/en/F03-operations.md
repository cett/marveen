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

If the dashboard is running, a restart can also be triggered at the `/api/updates/apply` endpoint (using the `store/.dashboard-token` Bearer token).

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

Exit code: 0 = all OK, 1 = something failed.

Direct HTTP health check:

```bash
curl -f http://localhost:3420/
```

## Tenant skill gate

Agents that serve several tenants keep each tenant's skills inside that tenant's requests. Two hooks do it (both wired at dashboard start into every sub-agent's `settings.json`; the main agent is not gated; running sessions pick them up after a restart):

- `tenant-context.py` (UserPromptSubmit) records, per agent, which tenant the request it is about to serve belongs to (`agent_tenant_context`).
- `tenant-skill-gate.py` (PreToolUse: `Skill`, file tools, `Bash`) blocks a tenant skill, its directory and its companion scripts outside that tenant's requests. Fleet skills are never affected.

**Bind a source to a tenant** (chat, dashboard user or inter-agent sender, per agent) with the admin API:

```bash
curl -s -X PUT http://localhost:3420/api/v1/admin/channel-bindings \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" -H "Content-Type: application/json" \
  -d '{"agent_id":"<agent>","channel":"telegram","external_id":"<chat id>","tenant_id":"<tenant>"}'
# GET lists (?tenant_id= / ?agent_id=), DELETE unbinds (?agent_id=&channel=&external_id=)
```

- A source with no binding belongs to the `default` tenant: tenant skills are not usable for it.
- A message an agent sends while serving a tenant's request is stamped with that tenant, so a coordinator's delegation carries it to the receiving agent. That message is then visible to that tenant's dashboard users and to admins, and to no other tenant.
- The agent must be enabled for the tenant (or be its main agent) and the tenant must not be disabled; otherwise the source resolves to "unknown" and no tenant skill is usable.
- Changing or deleting a binding, disabling an agent for a tenant, disabling a tenant or changing its main agent drops the affected context at once; tenant skills stay denied until the agent's next prompt re-resolves the source.
- Fail closed: a missing table, a database error, a stale context (`TENANT_CONTEXT_MAX_AGE_SECONDS`) or a gate error denies the tenant skill. The prompt hook refuses the prompt when it cannot record the context. It never creates tables: migration 0065 owns `agent_tenant_context`, so the dashboard must have migrated first.

To check a rollout (before and after the dashboard restart that wires the hooks), run `python3 scripts/tenant-gate-rollout-check.py`: it is read-only and reports migrations, hook scripts, per-agent wiring, live hook evidence and multi-tenant agents without a channel binding.

The main agent is intentionally not under the gate: a fail-closed prompt hook could refuse its prompts on a database error and stall the whole fleet's coordination, and it needs no tenant skills.

Limits: this enforces the **use** of tenant skills, best-effort on the shell side (a command that builds a path from variables is not caught). It is not data isolation: an agent's shared session still holds the earlier tenant's messages in its context.

## Watchdog

The channel connection is supervised by an independent watchdog (`scripts/channel-watchdog.sh`) that runs separately from the dashboard process (systemd timer, every 5 minutes). If the channel session gets stuck or exits, the watchdog recovers it with `tmux respawn-pane` — only the channel session, not any other agent sessions.

Two detection signals:

| Signal | Description |
|--------|-------------|
| STALE | `store/.channel-keepalive` file mtime: older than 3 minutes means the channel session is likely down |
| AUTHDEAD | Claude login error in the live session pane (e.g. "Please run /login", 401) — fallback path for when the dashboard is down; when the dashboard is running, its own reauth handler acts first |

The watchdog is patient: it only intervenes after `AUTH_DEAD_THRESHOLD_TICKS` consecutive negative signals (approximately 10–15 minutes), so a brief network blip does not trigger an unnecessary restart.

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
- `store/.dashboard-token` — Bearer token
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

### Vault master key

`store/vault.json` is encrypted; the master key lives in the macOS Keychain (item `com.marveen.vault` / `master-key`) or, as a fallback, in `store/.vault-key`. The key is deliberately **not** in the archive: anyone holding the archive and the key can decrypt the vault. `backup.sh` writes it to `backups/claudeclaw-YYYYMMDD-HHMMSS.vault-key` (0600). **Store that file somewhere other than the archive** (a different disk or a password manager). If no key can be found at backup time, the backup still completes and prints a warning -- the vault in that archive cannot be decrypted. To restore the key: copy the file to `store/.vault-key` (`chmod 600`), or import it into the Keychain without putting the key on a command line (arguments are visible to other processes via `ps`): run `security add-generic-password -U -s com.marveen.vault -a master-key -w` with `-w` as the last option and no value, and paste the key when it prompts.

`scripts/verify-restore.sh` fails if a key file is found *inside* an archive, and warns if `vault.json` is archived but the `.vault-key` sidecar is not next to it.

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
TOKEN=$(cat store/.dashboard-token)
for a in $(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/agents | python3 -c 'import sys,json; print(" ".join(x["name"] for x in json.load(sys.stdin)))'); do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://localhost:3420/api/agents/$a/restart"; echo " $a"
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
| `store/.dashboard-token` | `0600` | Dashboard Bearer token |
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
