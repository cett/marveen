# F05 Csatornák konfigurálása

A Marveen három csatorna-típust támogat: **Telegram**, **Slack** és **Discord**. Egyszerre csak egy csatorna lehet aktív a `CHANNEL_PROVIDER` beállítástól függően (az értéke: `telegram`, `slack` vagy `discord`).

A csatornát a telepítési varázsló konfigurálja. Ez a fejezet a kézi beállítást, a hibaelhárítást és a speciális opciókat ismerteti.

## Telegram

### Bot létrehozása

1. Nyisd meg a `@BotFather`-t a Telegramban
2. Küldj `/newbot` parancsot
3. Add meg a bot nevét és felhasználónevét
4. Másold ki a kapott tokent

### .env beállítás

```ini
CHANNEL_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=<bot-token>

# Párosított chat ID -- a telepítő tölti ki automatikusan,
# kézzel is megadható az első párosítás után
ALLOWED_CHAT_ID=<chat-id>
```

### Párosítás

Az első futtatáskor a bot üdvözlő üzenetet küld. A párosítási folyamat:

1. Írd be `/start` parancsot a botnak Telegramban
2. A bot egy párosítási kódot küld vissza (`/telegram:access pair <kod>`)
3. Futtasd a terminálban: `claude`, majd `/telegram:access pair <kod>`

A telepítő automatikusan elvégzi a párosítást, ha a token beállításakor elvégzed a folyamatot.

### access.json

A párosítás állapota a `~/.claude/channels/telegram/access.json` fájlban tárolódik:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<chat-id-1>", "<chat-id-2>"]
}
```

- `dmPolicy: "pairing"` -- párosításra vár (az első `/start` előtt)
- `dmPolicy: "allowlist"` -- csak az `allowFrom` listán szereplők üzenhetnek

### Többfelhasználós mód

Ha több felhasználónak szeretnéd engedélyezni az üzenetküldést, add hozzá az ő chat ID-jüket az `allowFrom` tömbhöz az `access.json`-ban. Az engedélyezés elvégezhető a dashboard csatorna-beállításai között is.

---

## Slack

### Slack App létrehozása

1. Nyisd meg az [api.slack.com/apps](https://api.slack.com/apps) oldalt
2. Hozz létre egy új alkalmazást ("From scratch")
3. **Socket Mode** engedélyezése: App Settings > Socket Mode > Enable
4. **OAuth & Permissions > Bot Token Scopes** hozzáadása:
   - `app_mentions:read`, `channels:history`, `channels:join`, `channels:read`
   - `chat:write`, `files:read`, `files:write`
   - `groups:history`, `im:history`, `reactions:write`, `users:read`
5. **Event Subscriptions > Bot Events** hozzáadása:
   - `app_mention`, `message.channels`, `message.groups`, `message.im`
6. Az alkalmazást telepítsd a workspace-re, majd másold ki:
   - **Bot User OAuth Token** (`xoxb-...`) -- ez a `SLACK_BOT_TOKEN`
   - **App-Level Token** (Socket Mode, `xapp-...`) -- ez a `SLACK_APP_TOKEN`

### .env beállítás

```ini
CHANNEL_PROVIDER=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Opcionális: alapértelmezett csatorna (DM helyett ide posztol)
# SLACK_CHANNEL_ID=C0XXXXXXX
```

### managed-settings.json (Slack kötelező)

A Slack plugin a `slack-channel@marveen-marketplace` marketplace plugin, amelyet a rendszer-szintű managed-settings fájl engedélyez. A telepítő elvégzi a beállítást, de kézi telepítésnél el kell végezni:

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

**Linux** (`/etc/claude-code/managed-settings.json`):

```bash
sudo python3 - <<'EOF'
import json, os, shutil
p = '/etc/claude-code/managed-settings.json'
# ... ugyanaz a szkript, eltérő útvonallal
EOF
```

---

## Discord

### Discord alkalmazás létrehozása

1. Nyisd meg a [discord.com/developers/applications](https://discord.com/developers/applications) oldalt
2. Hozz létre egy új alkalmazást
3. **Bot** fülön: **Add Bot**, majd másold ki a tokent
4. **Privileged Gateway Intents**: kapcsold be a **MESSAGE CONTENT INTENT**-et
5. **OAuth2 > URL Generator**: `bot` scope, szükséges jogosultságok kiválasztása, majd meghívó URL generálása -- a botot ezzel hívd meg a Discord szerveredre
6. Másold ki a csatorna ID-ját: Developer Mode bekapcsolása (User Settings > Advanced), majd jobb klikk a csatornán > Copy Channel ID
7. Másold ki a saját (operator) user ID-det: jobb klikk a nevedre > Copy User ID

### .env beállítás

```ini
CHANNEL_PROVIDER=discord
DISCORD_BOT_TOKEN=<bot-token>
DISCORD_CHANNEL_ID=<csatorna-id>

# Az operator user ID -- erre az ID-re kap értesítést a bot,
# ha ismeretlen felhasználó próbál üzenni
OPERATOR_DISCORD_USER_ID=<user-id>
```

### managed-settings.json (ha már létezik)

Ha a gépen már van managed-settings fájl (pl. Slack korábbi telepítéséből), és abban nincs benne a Discord plugin, a bot nem fog reagálni. A Discord plugin hozzáadása:

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

Ha a managed-settings fájl nem létezik, Discord esetén nem kell létrehozni -- az official-marketplace plugin anélkül is fut.

---

## managed-settings.json összefoglalás

A `managed-settings.json` egy rendszer-szintű (root tulajdonú) JSON fájl, amellyel a szervezeti IT-policy szabályozza, hogy a Claude Code CLI milyen csatorna-plugineket futtathat.

| Platform | Elérési út |
|----------|-----------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\ProgramData\ClaudeCode\managed-settings.json` |

Minimális struktúra Slack-hez:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "plugin": "slack-channel", "marketplace": "marveen-marketplace" }
  ]
}
```

**Telegram** és **Discord** az official-marketplace-ről érkeznek, és nem igénylik a `managed-settings.json`-t, hacsak más plugin már nem hozott létre ilyen fájlt a gépen -- ebben az esetben be kell kerülniük az allowlistbe.

---

## Flotta-ágensek csatornái

A flotta-ágensek csatorna-konfigurációja az `agents/<name>/.claude/channels/<provider>/` könyvtárban él, nem a `~/.claude/channels/`-ban. Ez elkülöníti a főágens csatornáját a sub-ágensek csatornáitól.

A flotta-ágensek csatorna-beállítása a dashboard Ágensek oldalán kezelhető.

---

## Hibaelhárítás

### A bot nem reagál indítás után

1. Ellenőrizd a channels service naplóját: `journalctl --user -u marveen-channels -f` (Linux) vagy `cat ~/Library/Logs/Marveen/channels.log` (macOS)
2. Ellenőrizd, hogy a bot token érvényes-e (Telegram: `curl https://api.telegram.org/bot<token>/getMe`)
3. Slack esetén győződj meg a managed-settings fájl meglétéről és a `channelsEnabled: true` értékről
4. Futtasd a `bash scripts/doctor.sh` egészség-ellenőrzőt

### "Please run /login" hibaüzenet a channels session-ben

A főágens hitelesítése lejárt. Megoldás:

```bash
bash scripts/auth.sh
```

Ez megújítja a `store/.claude-oauth-token` tokent és újraindítja a channels service-t.

### Párosítási kód nem érkezett

Ellenőrizd, hogy a bot elindult-e (`launchctl list | grep <agent-id>` / `systemctl --user status marveen-channels`), és hogy a bot tokene helyes. Ha a `ALLOWED_CHAT_ID` értéke nem `0`, a bot nem fogad új párosítási kérést.

---

*Előző fejezet: [F04 Architektúra](F04-architektura.md)*
*Következő fejezet: F06 MCP connectorok (hamarosan)*
