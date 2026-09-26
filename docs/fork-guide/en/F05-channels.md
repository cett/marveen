# F05 Channel configuration

Marveen supports three channel types: **Telegram**, **Slack**, and **Discord**. Only one channel can be active at a time, set by the `CHANNEL_PROVIDER` value (`telegram`, `slack`, or `discord`).

The install wizard configures the channel automatically. This chapter covers manual setup, troubleshooting, and advanced options.

## Telegram

### Creating a bot

1. Open `@BotFather` in Telegram
2. Send `/newbot`
3. Choose a name and username for your bot
4. Copy the token you receive

### .env settings

```ini
CHANNEL_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=<bot-token>

# Paired chat ID -- filled automatically by the installer,
# or set manually after the first pairing
ALLOWED_CHAT_ID=<chat-id>
```

### Pairing

On first run the bot sends a welcome message. The pairing flow:

1. Send `/start` to the bot in Telegram
2. The bot replies with a pairing code (`/telegram:access pair <code>`)
3. Run in the terminal: `claude`, then `/telegram:access pair <code>`

The installer handles pairing automatically when you complete the flow during setup.

### access.json

The pairing state is stored in `~/.claude/channels/telegram/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<chat-id-1>", "<chat-id-2>"]
}
```

- `dmPolicy: "pairing"` -- waiting for pairing (before the first `/start`)
- `dmPolicy: "allowlist"` -- only senders in `allowFrom` can message the bot

### Multi-user mode

To allow additional users to message the bot, add their chat IDs to the `allowFrom` array in `access.json`. You can also manage this from the dashboard channel settings.

---

## Slack

### Creating a Slack App

1. Open [api.slack.com/apps](https://api.slack.com/apps)
2. Create a new app ("From scratch")
3. **Socket Mode**: App Settings > Socket Mode > Enable
4. **OAuth & Permissions > Bot Token Scopes** -- add:
   - `app_mentions:read`, `channels:history`, `channels:join`, `channels:read`
   - `chat:write`, `files:read`, `files:write`
   - `groups:history`, `im:history`, `reactions:write`, `users:read`
5. **Event Subscriptions > Bot Events** -- add:
   - `app_mention`, `message.channels`, `message.groups`, `message.im`
6. Install the app to the workspace, then copy:
   - **Bot User OAuth Token** (`xoxb-...`) -- this is `SLACK_BOT_TOKEN`
   - **App-Level Token** (Socket Mode, `xapp-...`) -- this is `SLACK_APP_TOKEN`

### .env settings

```ini
CHANNEL_PROVIDER=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Optional: default channel (posts here instead of DMs)
# SLACK_CHANNEL_ID=C0XXXXXXX
```

### managed-settings.json (required for Slack)

The Slack plugin is `slack-channel@marveen-marketplace` and must be whitelisted in the system-level managed-settings file. The installer handles this, but for a manual setup:

**macOS** (`/Library/Application Support/ClaudeCode/managed-settings.json`):

```bash
sudo python3 - <<'EOF'
import json, os, shutil
p = '/Library/Application Support/ClaudeCode/managed-settings.json'
try:
    d = json.load(open(p))
except:
    d = {}
d['channelsEnabled'] = True
plugins = d.get('allowedChannelPlugins', [])
entry = {'plugin': 'slack-channel', 'marketplace': 'marveen-marketplace'}
if entry not in plugins:
    plugins.append(entry)
d['allowedChannelPlugins'] = plugins
tmp = p + '.tmp'
with open(tmp, 'w') as f: f.write(json.dumps(d, indent=2) + '\n')
shutil.copymode(p, tmp)
os.replace(tmp, p)
print('OK')
EOF
```

**Linux** (`/etc/claude-code/managed-settings.json`) -- same script, different path.

---

## Discord

### Creating a Discord application

1. Open [discord.com/developers/applications](https://discord.com/developers/applications)
2. Create a new application
3. **Bot** tab: **Add Bot**, then copy the token
4. **Privileged Gateway Intents**: enable **MESSAGE CONTENT INTENT**
5. **OAuth2 > URL Generator**: select `bot` scope, choose required permissions, generate the invite URL, and use it to invite the bot to your server
6. Copy the channel ID: enable Developer Mode (User Settings > Advanced), then right-click the channel > Copy Channel ID
7. Copy your own (operator) user ID: right-click your name > Copy User ID

### .env settings

```ini
CHANNEL_PROVIDER=discord
DISCORD_BOT_TOKEN=<bot-token>
DISCORD_CHANNEL_ID=<channel-id>

# The operator user ID -- the bot notifies this user
# when an unknown sender tries to message it
OPERATOR_DISCORD_USER_ID=<user-id>
```

### managed-settings.json (only if the file already exists)

If the machine already has a managed-settings file (e.g. from an earlier Slack install) and the Discord plugin is not listed in it, the bot will be silently blocked. Add Discord to the allowlist:

```bash
# macOS
sudo python3 - <<'EOF'
import json, os, shutil
p = '/Library/Application Support/ClaudeCode/managed-settings.json'
try:
    d = json.load(open(p))
except:
    d = {}
plugins = d.get('allowedChannelPlugins', [])
entry = {'plugin': 'discord', 'marketplace': 'claude-plugins-official'}
if entry not in plugins:
    plugins.append(entry)
d['allowedChannelPlugins'] = plugins
tmp = p + '.tmp'
with open(tmp, 'w') as f: f.write(json.dumps(d, indent=2) + '\n')
shutil.copymode(p, tmp)
os.replace(tmp, p)
print('OK')
EOF
```

If the file does not exist at all, Discord does not require you to create it -- the official-marketplace plugin works without it.

---

## managed-settings.json summary

`managed-settings.json` is a system-level (root-owned) JSON file that controls which channel plugins Claude Code CLI is allowed to run.

| Platform | Path |
|----------|------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\ProgramData\ClaudeCode\managed-settings.json` |

Minimal structure for Slack:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "plugin": "slack-channel", "marketplace": "marveen-marketplace" }
  ]
}
```

**Telegram** and **Discord** come from the official marketplace and do not require `managed-settings.json` unless another plugin has already created the file on the machine. In that case they must be present in the `allowedChannelPlugins` list.

---

## Fleet agent channels

Fleet agents store their channel configuration in `agents/<name>/.claude/channels/<provider>/`, not in `~/.claude/channels/`. This keeps each agent's channel state isolated from the main agent.

Fleet agent channel settings can be managed from the dashboard Agents page.

---

## Troubleshooting

### Bot does not respond after startup

1. Check the channels service log: `journalctl --user -u marveen-channels -f` (Linux) or `cat ~/Library/Logs/Marveen/channels.log` (macOS)
2. Verify the bot token is valid (Telegram: `curl https://api.telegram.org/bot<token>/getMe`)
3. For Slack: confirm the managed-settings file exists and has `"channelsEnabled": true`
4. Run `bash scripts/doctor.sh`

### "Please run /login" in the channels session

The main agent's authentication has expired. Fix:

```bash
bash scripts/auth.sh
```

This renews `store/.claude-oauth-token` and restarts the channels service.

### Pairing code never arrived

Check that the bot is running (`launchctl list | grep <agent-id>` / `systemctl --user status marveen-channels`) and that the bot token is correct. If `ALLOWED_CHAT_ID` is set to a non-zero value, the bot will not accept new pairing requests.

---

*Previous: [F04 Architecture](F04-architecture.md)*
*Next: F06 MCP connectors (coming soon)*
