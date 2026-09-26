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

## Watchdog

The channel connection is supervised by an independent watchdog (`scripts/channel-watchdog.sh`) that runs separately from the dashboard process (systemd timer, every 5 minutes). If the channel session gets stuck or exits, the watchdog recovers it with `tmux respawn-pane` — only the channel session, not any other agent sessions.

Two detection signals:

| Signal | Description |
|--------|-------------|
| STALE | `store/.channel-keepalive` file mtime: older than 3 minutes means the channel session is likely down |
| AUTHDEAD | Claude login error in the live session pane (e.g. "Please run /login", 401) — fallback path for when the dashboard is down; when the dashboard is running, its own reauth handler acts first |

The watchdog is patient: it only intervenes after `AUTH_DEAD_THRESHOLD_TICKS` consecutive negative signals (approximately 10–15 minutes), so a brief network blip does not trigger an unnecessary restart.

## Backup and restore

### Running a backup

```bash
bash scripts/backup.sh
```

Archives go to `backups/` (`claudeclaw-YYYYMMDD-HHMMSS.tar.gz`) with a SHA-256 sidecar file (`.sha256`).

**Retention:** the most recent 30 archives are kept (default). Override:

```bash
BACKUP_KEEP=14 bash scripts/backup.sh
```

### Archive contents

The archive has two groups:

**`repo/` group** (relative to the project root):
- `store/claudeclaw.db` (+ `-shm`/`-wal`) — database (after WAL checkpoint)
- `store/.dashboard-token` — Bearer token
- `.env` — main configuration
- `agents/*/CLAUDE.md`, `SOUL.md`, `.mcp.json` — agent identities
- `agents/*/.claude/channels/*/` — per-agent channel configuration

**`home/` group** (relative to `$HOME`):
- `.claude/skills/` — skill library
- `.claude/scheduled-tasks/` — file-based scheduled tasks
- `.claude/channels/*/` — channel tokens and pairing state
- `Library/LaunchAgents/com.<agent-id>.*.plist` — launchd jobs (macOS)

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
