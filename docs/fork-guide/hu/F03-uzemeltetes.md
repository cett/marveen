# F03 Üzemeltetés

## Szolgáltatások indítása és leállítása

A Marveen két háttérszolgáltatásból áll: `dashboard` (API + webes felület) és `channels` (csatorna-kapcsolat + ágensek).

### macOS (launchd)

```bash
# Indítás
launchctl start com.<agent-id>.dashboard
launchctl start com.<agent-id>.channels

# Leállítás
launchctl stop com.<agent-id>.dashboard
launchctl stop com.<agent-id>.channels

# Újraindítás
launchctl kickstart -k gui/$(id -u)/com.<agent-id>.dashboard
launchctl kickstart -k gui/$(id -u)/com.<agent-id>.channels

# Állapot
launchctl list | grep <agent-id>
```

> Az `<agent-id>` az `.env` fájl `MAIN_AGENT_ID` értéke (pl. `marveen`).

### Linux (systemd)

```bash
# Indítás
systemctl --user start marveen-dashboard
systemctl --user start marveen-channels

# Leállítás
systemctl --user stop marveen-dashboard
systemctl --user stop marveen-channels

# Újraindítás
systemctl --user restart marveen-dashboard
systemctl --user restart marveen-channels

# Állapot
systemctl --user status marveen-dashboard
systemctl --user status marveen-channels

# Naplók
journalctl --user -u marveen-dashboard -f
journalctl --user -u marveen-channels -f
```

### Dashboard újraindítás az API-n keresztül

Ha a dashboard fut, az újraindítás elvégezhető a `/api/updates/apply` végponton is (a `store/.dashboard-token` Bearer-tokennel).

## Frissítés

```bash
./update.sh
```

A frissítő elvégzi: `git pull` (fast-forward only), `npm install`, TypeScript fordítás, majd újraindítja a szolgáltatásokat és health-check-kel ellenőrzi az eredményt.

**Automatikus visszaállás (rollback):** ha a fordítás vagy az újraindítás után a dashboard nem válaszol 20 másodpercen belül, a frissítő automatikusan visszaállítja a korábbi commit-ot és újraindít.

### Frissítési opciók

```bash
# Fleet seed-skillek és ütemezett feladatok erőltetett frissítése
# (az egyéni módosításokat NEM érinti -- csak a seed-* mappák tartalmát)
./update.sh --reseed-fleet

# CLAUDE.md újragenerálása a sablonból (az aktuális .env adataival)
# A korábbi CLAUDE.md mentése előtte automatikus
./update.sh --regen-claudemd

# Kényszer-újrafordítás akkor is, ha a kód már aktuális
# (pl. stale dist/ után)
./update.sh --rebuild
```

Az opciók kombinálhatók: `./update.sh --reseed-fleet --rebuild`

### Automatikus frissítés

Az automatikus frissítés alapértelmezetten ki van kapcsolva. Engedélyezés:

```ini
# .env
AUTO_UPDATE_ENABLED=1
```

Engedélyezve, a seedelt `auto-update` ütemezett feladat minden szerdán 04:00-kor futtatja az `update.sh`-t és az eredményről értesítést küld a csatornán.

## Egészség-ellenőrzés

```bash
bash scripts/doctor.sh
```

A `doctor.sh` ellenőrzi:
- a launchd/systemd szolgáltatások futnak-e
- a dashboard HTTP végpont válaszol-e
- a tmux munkamenet él-e
- az `.env` alapvető mezői kitöltöttek-e
- a Node.js és npm elérhető-e

Kilépési kód: 0 = minden rendben, 1 = valamilyen hiba.

A dashboard HTTP health végpont közvetlen ellenőrzése:

```bash
curl -f http://localhost:3420/
```

## Watchdog

A csatorna-kapcsolatot egy független watchdog felügyeli (`scripts/channel-watchdog.sh`), amely a dashboard folyamattól függetlenül fut (systemd timer, 5 percenként). Ha a csatorna-munkamenet elakad vagy leáll, a watchdog `tmux respawn-pane`-nel állítja helyre -- kizárólag a csatorna-munkamenetet, a többi ágenst nem érinti.

Két érzékelési jel:

| Jel | Leírás |
|-----|--------|
| STALE | `store/.channel-keepalive` fájl időbélyege: ha 3 percnél régebbi, a csatorna-munkamenet valószínűleg leállt |
| AUTHDEAD | A futó munkamenetben Claude bejelentkezési hibaüzenet (pl. "Please run /login", 401) -- csak a dashboard nélküli esetekre: ha a dashboard fut, az saját reauth-folyamata kezeli előbb |

A watchdog türelmes: csak `AUTH_DEAD_THRESHOLD_TICKS` egymást követő negatív jelzés után avatkozik be (kb. 10-15 perc), hogy ne indítson felesleges újraindítást egy rövid hálózatkimaradás után.

## Mentés és visszaállítás

### Mentés futtatása

```bash
bash scripts/backup.sh
```

Az archívum a `backups/` könyvtárba kerül (`claudeclaw-YYYYMMDD-HHMMSS.tar.gz`) SHA-256 sidecar fájllal együtt (`.sha256`).

**Megőrzés:** az utolsó 30 archívum marad meg (alapértelmezés). Felülírható:

```bash
BACKUP_KEEP=14 bash scripts/backup.sh
```

### Az archívum tartalma

Az archívum két csoportból áll:

**`repo/` csoport** (a projekt könyvtárához képest relatív):
- `store/claudeclaw.db` (+ `-shm`/`-wal`) -- az adatbázis (WAL-checkpoint után)
- `store/.dashboard-token` -- Bearer token
- `.env` -- fő konfiguráció
- `agents/*/CLAUDE.md`, `SOUL.md`, `.mcp.json` -- ágens-identitások
- `agents/*/.claude/channels/*/` -- csatorna-konfiguráció

**`home/` csoport** (a `$HOME`-hoz képest relatív):
- `.claude/skills/` -- skill könyvtár
- `.claude/scheduled-tasks/` -- fájl-alapú ütemezett feladatok
- `.claude/channels/*/` -- csatorna-tokenek és párosítási állapot
- `Library/LaunchAgents/com.<agent-id>.*.plist` -- launchd jobs (macOS)

### Visszaállítás

```bash
# 1. Ellenőrzés
tar -tzf backups/claudeclaw-20260101-120000.tar.gz | head -20

# 2. Ideiglenes könyvtárba kicsomagolás (ellenőrzéshez)
mkdir /tmp/restore
tar -xpzf backups/claudeclaw-20260101-120000.tar.gz -C /tmp/restore

# 3. Visszaállítás a projekt könyvtárba
tar -xpzf backups/claudeclaw-20260101-120000.tar.gz \
  -C /tmp/restore && \
  cp -a /tmp/restore/repo/. ./ && \
  cp -a /tmp/restore/home/. ~/
```

> A `-p` (preserve modes) opció gondoskodik arról, hogy a `0600` jogosultságú token-fájlok ne legyenek világ-olvashatók visszaállítás után.

### SHA-256 ellenőrzés

```bash
# macOS
shasum -a 256 -c backups/claudeclaw-20260101-120000.sha256

# Linux
sha256sum -c backups/claudeclaw-20260101-120000.sha256
```

## Naplók

### macOS

```bash
# Dashboard
log stream --predicate 'subsystem contains "com.<agent-id>"' --level info

# Vagy a launchd stdout/stderr fájlokból
cat ~/Library/Logs/Marveen/dashboard.log
cat ~/Library/Logs/Marveen/channels.log
```

### Linux

```bash
journalctl --user -u marveen-dashboard --since "1 hour ago"
journalctl --user -u marveen-channels --since "1 hour ago"

# Folyamatos figyelés
journalctl --user -u marveen-dashboard -f
```

### Dashboard update log

A frissítések eredménye:

```bash
cat store/update.log
cat store/update.last-result  # JSON: status, phase, old/new verzió
```

## Lemezterület-védelem

A `scripts/disk-space-guard.sh` szintén futhat timer-ként: ha a szabad lemezterület küszöb alá esik, értesítést küld és opcionálisan leállítja az adatbázis-írásokat. A küszöb az `.env`-ben vagy a dashboard beállításaiban konfigurálható.

## Titkosítás

Az érzékeny fájlok jogosultságai:

| Fájl | Jogosultság | Tartalom |
|------|------------|---------|
| `.env` | `0600` | Bot tokenek, auth kulcs |
| `store/.dashboard-token` | `0600` | Dashboard Bearer token |
| `store/.claude-oauth-token` | `0600` | Fleet OAuth token |
| `~/.claude/channels/*/.env` | `0600` | Csatorna bot tokenek |
| `~/.claude/channels/*/access.json` | `0644` | Párosítási állapot (nem titkos) |

A Vault titkait az adatbázis titkosítva tárolja -- a tényleges értékek nem kerülnek plaintext fájlba (lásd F02 Konfiguráció, Vault szekció).

**Hálózati kitettség:** alapértelmezetten a dashboard csak a loopback interfészre köt (`WEB_HOST=127.0.0.1`). Ha hálózatról is elérhetővé teszed (`WEB_HOST=0.0.0.0`), állíts be erős Bearer tokent, és helyezd fordított proxy mögé HTTPS-sel.

## Több gépen / multi-node

Ha több gépen futtatod a Marveen-t, minden gép önálló telepítés -- nincsen elosztott adatbázis. A gépenként különálló flottákat a **Föderáció** kötheti össze (lásd F06 Fleet), amely két Marveen-példány között megbízható üzenetváltást biztosít anélkül, hogy az adatbázisuk közös lenne.

---

*Előző fejezet: [F02 Konfiguráció](F02-konfiguracio.md)*
*Következő fejezet: F04 Csatornák konfigurálása (hamarosan)*
