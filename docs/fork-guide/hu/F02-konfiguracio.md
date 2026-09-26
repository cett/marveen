# F02 Konfiguráció

## Áttekintés

A Marveen konfigurációja három rétegen alapul. Az első alkalmazott érték nyer:

1. **`system_config` adatbázis** -- a dashboard Beállítások oldalán szerkeszthető; minden indításkor betöltődik
2. **`/run/secrets/<KULCS>`** -- Docker/Kubernetes secret-mount (ha jelen van)
3. **`.env` fájl** -- az install könyvtárban, kézzel szerkeszthető

Ez azt jelenti, hogy a dashboard-on beállított értéket a `.env` nem írja felül -- az adatbázis mindig prioritást élvez.

## Az .env fájl

Az `.env` fájl az install könyvtárban él, és `0600` jogosultsággal rendelkezik (csak a tulajdonos olvashatja). Sablonból generálódik (`.env.example`), a telepítő tölti ki az alapértékeket.

### Kötelező mezők

```ini
# A csatorna típusa: telegram | slack | discord
CHANNEL_PROVIDER=telegram

# Bot-azonosítás (csatornánként eltérő -- lásd F04 Csatornák)
TELEGRAM_BOT_TOKEN=...
# SLACK_BOT_TOKEN=...
# SLACK_APP_TOKEN=...
# DISCORD_BOT_TOKEN=...

# A tulajdonos neve (az ágens erre hivatkozik)
OWNER_NAME=Your Name

# Párosított Telegram chat ID (automatikusan kitöltődik az első párosításkor)
ALLOWED_CHAT_ID=0
```

### Ágens-azonosítás

```ini
# Az ágens megjelenítési neve
BOT_NAME=Marveen

# A rendszer neve a dashboardon (alapértelmezés: BOT_NAME)
# BRAND_NAME=AcmeAI

# Belső ágens-azonosító: tmux session neve, adatbázis agent_id, API routing
# Automatikusan generálódik a BOT_NAME-ből (ASCII slug)
# MAIN_AGENT_ID=marveen

# OS-service-name (launchd com.<id>.* / systemd <id>-*)
# Alapértelmezés: MAIN_AGENT_ID
# SERVICE_ID=marveen
```

### Claude hitelesítés

A rendszer öt helyen keresi a hitelesítést, ebben a sorrendben (az első találat érvényes):

1. `CLAUDE_CODE_OAUTH_TOKEN` az `.env`-ben
2. `ANTHROPIC_API_KEY` az `.env`-ben
3. `~/.claude/.credentials.json` (interaktív login, Linux)
4. `store/.claude-oauth-token` (onboarding wizard)
5. macOS Keychain (interaktív login, macOS)

```ini
# OAuth token -- Pro/Max előfizetéssel: claude setup-token
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Alternatíva: API kulcs (Anthropic Console, pay-as-you-go)
# ANTHROPIC_API_KEY=sk-ant-...
```

> Ha a hitelesítés hiányzik, a háttérszolgáltatások nem indulnak el. Utólagos beállítás: `bash scripts/auth.sh`

### Hálózat és dashboard

```ini
# Dashboard portja (alapértelmezés: 3420)
# WEB_PORT=3420

# Dashboard hálózati interfész
# 127.0.0.1 = csak helyi gép (alapértelmezés)
# 0.0.0.0  = hálózatról is elérhető (DASHBOARD_TOKEN-t KÖTELEZŐ beállítani!)
# WEB_HOST=127.0.0.1

# Platform override (ha az auto-detect nem megfelelő)
# Lehetséges értékek: macos | linux-server | linux-gui
# MARVEEN_ENV=linux-server
```

### Modell és AI

```ini
# A főágens csatorna-munkamenetének modellje
# Ha nincs megadva: a .claude/settings.json .model értéke az alap
# MAIN_AGENT_MODEL=claude-opus-5

# Ollama URL (szemantikus kereséshez)
# OLLAMA_URL=http://localhost:11434

# Időzóna (IANA tz, pl. Europe/Budapest)
# Ha nincs megadva: az OS időzónája
# SCHEDULER_TZ=Europe/Budapest
```

### Egyéb opcionális mezők

```ini
# Tulajdonos e-mail cím (ágensek <OWNER_EMAIL> placeholderben használják)
# OWNER_EMAIL=your.email@example.com

# Google API kulcs (egyes MCP connectorokhoz)
# GOOGLE_API_KEY=...

# Artifact HMAC kulcs (opcionális, külön rotálható a dashboard Bearer tokentől)
# ARTIFACT_HMAC_SECRET=

# Automatikus frissítés (alapértelmezés: 0 = kikapcsolva)
# AUTO_UPDATE_ENABLED=0

# Külső rendszerek (nem flotta-ágensek), amelyek üzenhetnek a POST /api/messages-en
# SYSTEM_SENDER_IDS=cortex

# SQL skill-rendszer fájl-regenerálás (alapértelmezés: 0 = kikapcsolva)
# SKILL_SQL_REGEN=0
```

## Autonómia-konfiguráció

Az `store/autonomy-config.json` fájl szabályozza, hogy az ágensek milyen mértékben cselekedhetnek emberi jóváhagyás nélkül.

### Szintek

| Szint | Viselkedés |
|-------|-----------|
| 1 | Csak jelez -- elvégzi a műveletet, de előtte értesítést küld |
| 2 | Jóváhagyást kér -- vár az emberi döntésre, mielőtt cselekszik |
| 3 | Autonóm -- elvégzi, majd utólag jelenti |

### Kategóriák

```json
{
  "categories": [
    {
      "key": "kanban_archive_done",
      "label": "7+ napos done kártya archiválás",
      "level": 1,
      "locked": false,
      "maxLevel": 3
    },
    {
      "key": "email_send",
      "label": "Email küldés / válasz",
      "level": 1,
      "locked": false,
      "maxLevel": 2,
      "timeout_minutes": 30
    },
    {
      "key": "data_delete",
      "label": "Fájl / adat törlés",
      "level": 1,
      "locked": true,
      "maxLevel": 1
    }
  ]
}
```

- `locked: true` -- a szint nem emelhető (biztonsági korlát)
- `maxLevel` -- a maximálisan beállítható szint
- `timeout_minutes` -- jóváhagyás-kérés timeout (csak level 2-nél)

A teljes kategórialistát és az aktuális szinteket a dashboard Beállítások > Autonómia oldalán is kezelheted.

## Modell-profil térkép

A `store/model-profile-map.json` fájl (sablon: `config-examples/model-profile-map.example.json`) lehetővé teszi, hogy az ágensek névleges profilokat (`premium_reasoning`, `build_strong`, `analysis_efficient`, `routine_lowcost`) használjanak konkrét modell-nevek helyett.

```json
{
  "version": "1",
  "profiles": {
    "premium_reasoning": "claude-opus-5",
    "build_strong": "claude-sonnet-5",
    "analysis_efficient": "claude-sonnet-5",
    "routine_lowcost": "claude-haiku-4-5-20251001"
  }
}
```

- Mind a négy profil kötelező -- hiányos térkép esetén az indítás megtagadja
- Egy ágens explicit `model` beállítása felülírja a profilját
- A fájl a `store/` könyvtárban él (gitignored), így a konkrét modellmapping nem kerül a verziókezelőbe

## Vault -- titkos értékek kezelése

A Vault az API kulcsok, bot tokenek és egyéb érzékeny értékek biztonságos tárolására szolgál. A titkos értékek titkosítva tárolódnak az adatbázisban, nem kerülnek ki a `store/` könyvtárból.

### Hivatkozás vault értékre

A `.env` fájlban vagy az MCP szerver konfigurációban `vault:<id>` alakú hivatkozást használj:

```ini
# .env-ben
SOME_API_KEY=vault:my-api-key-id
```

A rendszer indításkor feloldja a hivatkozást a tényleges értékre, és azt adja át a folyamatnak.

### Vault wrapper szkriptek

**`scripts/vault-env-wrapper.sh`** -- env-változóba injektált titkokhoz. Az MCP szerver `command`-jaként használható, ha a titkos értéket env-változóként várja:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "scripts/vault-env-wrapper.sh",
      "args": ["node", "my-mcp-server.js"],
      "env": {
        "MY_SECRET": "vault:my-secret-id"
      }
    }
  }
}
```

**`scripts/vault-file-materializer.sh`** -- fájl-alapú titkokhoz. Olyan MCP szerverekhez, amelyek hitelesítő adatot fájlútvonalként várnak. Indításkor a titkot egy privát (`0700`) ideiglenes könyvtárba írja, leálláskor törli.

**`scripts/vault-inject-http-mcp.sh`** -- HTTP MCP szerverekhez. A `~/.claude.json` `mcpServers.*.headers` mezőiben lévő `vault:<id>` hivatkozásokat oldja fel közvetlenül a Claude Code indítása előtt.

### Vault kezelése

A Vault tartalmát a dashboard Beállítások > Vault oldalán kezelheted: új bejegyzés létrehozása, rotálás (a régi érték lecserélése), visszavonás. A tényleges értékek mentés után nem olvashatók vissza a dashboardon.

## A konfiguráció módosítása futás közben

Az `.env` fájl módosításához a háttérszolgáltatásokat újra kell indítani:

```bash
# macOS
launchctl stop com.<agent-id>.dashboard
launchctl start com.<agent-id>.dashboard

# Linux
systemctl --user restart marveen-dashboard
```

A dashboard Beállítások oldalán végzett módosítások a `system_config` adatbázisba kerülnek, és azonnali hatályúak -- nincs szükség újraindításra.

---

*Előző fejezet: [F01 Telepítés](F01-telepites.md)*
*Következő fejezet: F03 Üzemeltetés (hamarosan)*
