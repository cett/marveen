# F01 Telepítés

## Áttekintés

A telepítés egyetlen paranccsal indul. A varázsló végigvezet az összes beállításon, majd elindítja a háttérszolgáltatásokat.

**Becsült idő:** 10-15 perc (az internet sebességétől és a letöltendő modellek méretétől függően).

## 1. A repo klónozása

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
```

> Ha saját forkból telepítesz, a forked repo URL-jét add meg. A telepítő forrásfüggetlen.

## 2. A telepítő futtatása

### macOS / Linux

```bash
./install.sh
```

A szkript automatikusan felismeri az operációs rendszert, és a megfelelő telepítőt indítja:
- `install-macos.sh` -- macOS
- `install-linux.sh` -- Linux (Ubuntu/Debian, Fedora/RHEL)

### Windows

PowerShell-ben (rendszergazda nem szükséges, de a WSL telepítéshez igen):

```powershell
.\install-windows.ps1
```

A szkript ellenőrzi a WSL 2 jelenlétét, telepíti az Ubuntu-t, ha hiányzik, majd az Ubuntu shellben folytatja a Linux-os telepítővel.

### Egyéni port

Az alapértelmezett dashboard port 3420. Más port megadása:

```bash
./install.sh --port 3421
# vagy
WEB_PORT=3421 ./install.sh
```

## 3. A varázsló lépései

### Nyelv

```
  🌍  1. Magyar (HU)    2. English (EN)
  Language / Nyelv [1/2, default: 1]:
```

### Előfeltételek ellenőrzése

A telepítő ellenőrzi: Node.js (v20+), npm, tmux, git, Bun, Claude Code CLI. Hiányzó eszközöket automatikusan telepíti (macOS: Homebrew, Linux: apt/dnf).

Ha a macOS verziód 10.15 és 14 közé esik, figyelmeztető üzenetet kapsz a Homebrew korlátozott támogatásáról, és megerősítést kér a folytatáshoz.

### Claude Code hitelesítés

**Lépés 1: operátori bejelentkezés (terminál)**

```
Claude Code bejelentkezés (i/n)?
```

Ez a `claude auth login` parancsot futtatja a böngészős OAuth-folyamathoz.

**Lépés 2: szolgáltatás-token (háttérszolgáltatásokhoz)**

A böngészős bejelentkezés csak a terminálodnak szól. A háttérszolgáltatások nem férnek hozzá a Keychainhez, ezért külön tokent igényelnek.

1. Nyiss egy **másik** terminált
2. Futtasd: `claude setup-token`
3. Másold ide a kiírt tokent

```
OAuth token: sk-ant-oat01-...
```

Ha kihagyod, a szolgáltatások nem indulnak el. A token később is megadható a `scripts/auth.sh` szkripttel.

### Személyes adatok

```
A te neved:
```

Ez az `OWNER_NAME` mező a konfigurációban -- az ágens erre a névre hivatkozik. Csak az `.env` fájlba kerül, nem publikus.

### Csatorna kiválasztása

```
  1. Telegram
  2. Slack
  3. Discord
```

**Telegram (ajánlott):**

1. Nyisd meg a `@BotFather`-t Telegramban
2. Küldj `/newbot` üzenetet
3. Adj nevet a botnak
4. Másold ide a kapott tokent

A telepítő ellenőrzi a tokent a Telegram API-n. Figyelmeztet, ha:
- a token érvénytelen
- a bot webhookra van kötve (le kell kapcsolni)
- a tokent már más rendszer használja (409 Conflict)

**Slack:**

Bot token (xoxb-...) és App token (xapp-...) szükséges. A szkript beállítja a `managed-settings.json`-t, hogy a Claude Code elfogadja a Slack channel plugint.

**Discord:**

Bot token, csatorna ID és a saját Discord user ID szükséges. Az utóbbit a párosításhoz használja a rendszer (az ismeretlen felhasználók jóváhagyásához).

### Az ágens neve

```
Bot neve [Marveen]:
```

Ez lesz a tmux munkamenet neve, a launchd/systemd service neve és az ágens azonosítója (ASCII, kisbetűs, kötőjeles formátumra alakítva). Például "My Assistant" -> `my-assistant`.

### Tenant megjelenítési neve (opcionális)

```
Tenant megjelenítési neve [Enter a kihagyáshoz]:
```

A dashboardon megjelenő név. Ha üres, az ágens neve kerül ide.

### Függőségek telepítése

A telepítő automatikusan elvégzi:

1. `npm install` -- npm csomagok
2. `npm rebuild better-sqlite3 --build-from-source` -- natív SQLite modul (a `node@22` ABI-hoz fordítva)
3. `npm run build` -- TypeScript fordítás
4. Ollama telepítése (ha hiányzik) + `nomic-embed-text` modell letöltése
5. Whisper telepítése (opcionális, Apple Silicon: mlx-whisper, egyéb: openai-whisper)
6. ffmpeg telepítése (opcionális)
7. Go + bumblebee telepítése (opcionális, supply-chain scanner)

### Konfiguráció

A telepítő létrehozza:

- `.env` -- fő konfiguráció (bot token, csatorna, port)
- `store/` -- adatkönyvtár (SQLite, token, stb.)
- `CLAUDE.md` -- az ágens személyiség- és konfigurációs fájlja (sablonból)
- `SOUL.md` -- az ágens hangnem- és viselkedési fájlja (sablonból)
- `~/.claude/channels/<provider>/` -- csatorna-specifikus konfiguráció
- `~/.claude/scheduled-tasks/` -- alapértelmezett ütemezett feladatok
- `~/.claude/skills/` -- seed skillek

### Háttérszolgáltatás telepítése

**macOS:** LaunchAgent (automatikus indítás bejelentkezéskor)

```
~/Library/LaunchAgents/com.<agent-id>.dashboard.plist
~/Library/LaunchAgents/com.<agent-id>.channels.plist
```

**Linux:** systemd user units (automatikus indítás bejelentkezéskor)

```
~/.config/systemd/user/marveen-dashboard.service
~/.config/systemd/user/marveen-channels.service
```

## 4. Első indítás

A telepítő automatikusan elindítja a szolgáltatásokat. Nyisd meg a dashboardot:

```
http://localhost:3420
```

Ha a portot megváltoztattad, azt a portot használd.

## 5. Telegram párosítás

Az első futtatáskor az ágens vár a párosításra. Küldj egy üzenetet a botodnak Telegramban -- a párosítási folyamat elindul, és az ALLOWED_CHAT_ID automatikusan beállítódik.

## Újrafuttatás / frissítés

A telepítő idempotens: meglévő fájlokat nem írja felül, a tokeneket megtartja. Frissítéshez az `update.sh` ajánlott:

```bash
./update.sh
```

## Hibaelhárítás

**"Az ügynökök nem indulnak el"**

Ellenőrizd, hogy megvan-e a szolgáltatás-token:

```bash
# macOS / Linux
grep CLAUDE_CODE_OAUTH_TOKEN .env
ls -la store/.claude-oauth-token
```

Ha hiányzik:

```bash
bash scripts/auth.sh
```

**"better_sqlite3.node was compiled against NODE_MODULE_VERSION..."**

A natív modul és a Node.js verziója eltér. Futtasd újra:

```bash
npm rebuild better-sqlite3 --build-from-source
```

**"npm install sikertelen" macOS-en (EACCES)**

A globális npm könyvtár root tulajdonú. A telepítő megkísérli a javítást; ha nem sikerül, kövesd a kiírt utasításokat (`nvm` vagy npm prefix átállítása).

**Dashboard nem érhető el**

Ellenőrizd a szolgáltatást:

```bash
# macOS
launchctl list | grep <agent-id>

# Linux
systemctl --user status marveen-dashboard
```

---

*Következő fejezet: [F02 Üzemeltetés](F02-uzemeltetes.md)*
