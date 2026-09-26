# F01 Installation

## Overview

Installation starts with a single command. The setup wizard walks you through all configuration, then starts the background services automatically.

**Estimated time:** 10–15 minutes (depending on network speed and model downloads).

## 1. Clone the repository

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
```

> If you are installing from your own fork, use your forked repository URL. The installer is source-agnostic.

## 2. Run the installer

### macOS / Linux

```bash
./install.sh
```

The script detects your operating system and launches the appropriate installer:
- `install-macos.sh` — macOS
- `install-linux.sh` — Linux (Ubuntu/Debian, Fedora/RHEL)

### Windows

In PowerShell (admin not required, but WSL installation does need it):

```powershell
.\install-windows.ps1
```

The script checks for WSL 2, installs Ubuntu if missing, then continues with the Linux installer inside the Ubuntu shell.

### Custom port

The default dashboard port is 3420. To use a different port:

```bash
./install.sh --port 3421
# or
WEB_PORT=3421 ./install.sh
```

## 3. Wizard steps

### Language

```
  🌍  1. Magyar (HU)    2. English (EN)
  Language / Nyelv [1/2, default: 1]:
```

### Prerequisite check

The installer checks for: Node.js (v20+), npm, tmux, git, Bun, Claude Code CLI. Missing tools are installed automatically (macOS: Homebrew, Linux: apt/dnf).

On macOS 10.15–13 you will see a warning about Homebrew's limited support and a confirmation prompt before proceeding.

### Claude Code authentication

**Step 1: operator login (terminal)**

```
Claude Code login (y/n)?
```

This runs `claude auth login` for the browser-based OAuth flow.

**Step 2: service token (for background services)**

The browser login only authenticates your terminal session. Background services cannot access the Keychain, so they need a separate token.

1. Open a **separate** terminal
2. Run: `claude setup-token`
3. Paste the printed token here

```
OAuth token: sk-ant-oat01-...
```

If you skip this, the services will not start. You can provide the token later with `scripts/auth.sh`.

### Personal information

```
Your name:
```

This sets `OWNER_NAME` in the configuration — the agent uses this name to refer to you. It only goes into `.env` and is not public.

### Channel selection

```
  1. Telegram
  2. Slack
  3. Discord
```

**Telegram (recommended):**

1. Open `@BotFather` in Telegram
2. Send `/newbot`
3. Give the bot a name
4. Paste the token you receive here

The installer validates the token against the Telegram API. It warns you if:
- the token is invalid
- the bot is bound to a webhook (must be removed)
- the token is already in use by another system (409 Conflict)

**Slack:**

Requires a bot token (xoxb-...) and an app token (xapp-...). The script configures `managed-settings.json` so Claude Code accepts the Slack channel plugin.

**Discord:**

Requires a bot token, a channel ID, and your own Discord user ID. The user ID is used for pairing (approving unknown users).

### Agent name

```
Bot name [Marveen]:
```

This becomes the tmux session name, the launchd/systemd service name, and the agent identifier (converted to lowercase ASCII with dashes). For example "My Assistant" → `my-assistant`.

### Tenant display name (optional)

```
Tenant display name [press Enter to skip]:
```

The name shown on the dashboard. If blank, the agent name is used.

### Dependency installation

The installer performs these steps automatically:

1. `npm install` — npm packages
2. `npm rebuild better-sqlite3 --build-from-source` — native SQLite module (compiled for `node@22` ABI)
3. `npm run build` — TypeScript compilation
4. Ollama installation (if missing) + `nomic-embed-text` model download
5. Whisper installation (optional: mlx-whisper on Apple Silicon, openai-whisper elsewhere)
6. ffmpeg installation (optional)
7. Go + bumblebee installation (optional, supply-chain scanner)

### Configuration

The installer creates:

- `.env` — main configuration (bot token, channel, port)
- `store/` — data directory (SQLite, token, etc.)
- `CLAUDE.md` — agent personality and configuration file (generated from template)
- `SOUL.md` — agent tone and behavior file (generated from template)
- `~/.claude/channels/<provider>/` — channel-specific configuration
- `~/.claude/scheduled-tasks/` — default scheduled tasks
- `~/.claude/skills/` — seed skills

### Background service installation

**macOS:** LaunchAgent (auto-start on login)

```
~/Library/LaunchAgents/com.<agent-id>.dashboard.plist
~/Library/LaunchAgents/com.<agent-id>.channels.plist
```

**Linux:** systemd user units (auto-start on login)

```
~/.config/systemd/user/marveen-dashboard.service
~/.config/systemd/user/marveen-channels.service
```

## 4. First start

The installer starts the services automatically. Open the dashboard:

```
http://localhost:3420
```

If you changed the port, use that port instead.

## 5. Telegram pairing

On first run, the agent waits for pairing. Send a message to your bot in Telegram — the pairing flow starts, and `ALLOWED_CHAT_ID` is set automatically.

## Re-running / updating

The installer is idempotent: it does not overwrite existing files and preserves tokens. For updates, use `update.sh`:

```bash
./update.sh
```

## Troubleshooting

**"Agents won't start"**

Check whether the service token is present:

```bash
# macOS / Linux
grep CLAUDE_CODE_OAUTH_TOKEN .env
ls -la store/.claude-oauth-token
```

If missing:

```bash
bash scripts/auth.sh
```

**"better_sqlite3.node was compiled against NODE_MODULE_VERSION..."**

The native module and Node.js version mismatch. Rebuild:

```bash
npm rebuild better-sqlite3 --build-from-source
```

**"npm install failed" on macOS (EACCES)**

The global npm directory is root-owned. The installer tries to fix this automatically; if it fails, follow the printed instructions (use `nvm` or change the npm prefix).

**Dashboard unreachable**

Check the service status:

```bash
# macOS
launchctl list | grep <agent-id>

# Linux
systemctl --user status marveen-dashboard
```

---

*Next: [F02 Operations](F02-operations.md)*
