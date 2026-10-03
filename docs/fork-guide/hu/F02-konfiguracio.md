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

# SQL skill-rendszer fájl-regenerálás (alapértelmezés: bekapcsolva; 0/false/off/no kikapcsolja)
# SKILL_SQL_REGEN=0

# A tenant-skillek generált másolata az ágensek saját skills könyvtárában (alapérték: single)
#   single = csak a PONTOSAN EGY tenantnál engedélyezett ágensek; off = a tenant-skillek csak DB-ben élnek.
#   A több tenant között megosztott ágens soha nem kap másolatot. A korábbi `all` érték megszűnt:
#   single-ként értelmeződik, és induláskor figyelmeztetést ír.
# TENANT_SKILL_FILES=single

# Használat-kori tenant-kontextus (alapérték: 43200 = 12 óra, 0 = nincs korhatár)
#   Az ágens promptonként rögzített tenant-kontextusa ennyi ideig érvényes a skill-kapu számára; utána a
#   tenant-skillek tiltottak, amíg a következő prompt újra nem oldja a forrást. Nem a kötések cache-e:
#   kötés módosítása/törlése, az ágens vagy a tenant letiltása, a tenant főágensének cseréje azonnal
#   törli az érintett kontextust.
# TENANT_CONTEXT_MAX_AGE_SECONDS=43200
```

## Megosztott ágensek és tenant-skillek

Az egynél több tenantnál engedélyezett ágens (**megosztott** ágens) mindegyik tenant kéréseit egyetlen skills
könyvtárból szolgálja ki. A tenant A skilljének fájlmásolata (a `SKILL.md` és a kísérő scriptek) abban a
könyvtárban olvasható és futtatható lenne akkor is, amikor az ágens a tenant B-nek válaszol, ezért a szabály:

- **A megosztott ágens soha nem kap fájlmásolatot tenant-skillről. A tenant-skillek nála csak DB-ben élnek.**
  Ez minden író útvonalra áll: az élő skill-szerkesztésre, az induláskori regenre és az ágens-indításkori
  generálásra. A fleet-skillekre (`tenant_id='fleet'`) nem vonatkozik.
- A `TENANT_SKILL_FILES=single` (alapérték) csak a pontosan egy tenantnál engedélyezett ágensekhez másol;
  az `off` senkihez. A korábbi `all` érték, amely a megosztott ágensekhez is másolt, megszűnt:
  `single`-ként értelmeződik, és induláskor figyelmeztetést ír.
- Az elérhetőség-változtatás (`PUT /api/admin/agent-availability`) az ágens **minden tenantjának** fájljait
  egyezteti, nem csak a módosítottét: egy egy-tenantos ágens második tenantra engedélyezése megosztottá teszi, és
  leveszi róla az első tenant generált másolatát; egy tenant letiltása visszaváltoztathatja egy-tenantossá, ekkor
  a megmaradó tenant másolatai íródnak. A kézzel szerkesztett `SKILL.md` megmarad (csak a generált kísérő fájlok
  törlődnek).

### Elfogadott kockázat

A DB-only fájlszintű garancia, nem teljes izoláció. A tulajdonos 2026-10-03-án a következőket elfogadta:

- A megosztott ágens a fleet bearer tokent használja, amely `admin` szerepre oldódik, így a `/api/skills/sql/*`
  végponton át bármely tenant skill-sorát továbbra is olvashatja. Hogy a B tenant skillje ne kerüljön az A tenant
  válaszaiba, azt a használat-kori tenant-kontextus és a `tenant-skill-gate.py` tartja: ez a `Skill` eszközt és a
  tenant-skill könyvtárba mutató fájlhozzáférést fedi, a shellből a dashboard API-ra küldött `curl`-t nem.
- A kapu shell-oldala best effort (egy parancs közvetve is felépíthet útvonalat).
- Az ágens saját skills könyvtárában kézzel létrehozott skill minden tenant számára látható, amelyet az ágens
  kiszolgál; a generált másolatokra szóló szabály a kézi fájlokra nem vonatkozik.

Akkor érdemes újranyitni, ha az ágensek tenantonkénti hitelesítő adatot kapnak, mert az a skill API-t tenant-tudatossá tenné számukra.

## Autonómia-konfiguráció

Az autonómia-kategóriák szabályozzák, hogy az ágensek milyen mértékben cselekedhetnek emberi jóváhagyás nélkül. Az adatok az `autonomy_categories` DB táblában élnek (nem egy szerkeszthető JSON fájlban) -- a szintet a **dashboard Beállítások > Autonómia** oldalán állítod, vagy a `POST /api/autonomy` végponton.

### Szintek

| Szint | Viselkedés |
|-------|-----------|
| 1 | Csak jelez -- elvégzi a műveletet, de előtte értesítést küld |
| 2 | Jóváhagyást kér -- vár az emberi döntésre, mielőtt cselekszik |
| 3 | Autonóm -- elvégzi, majd utólag jelenti |

### Kategóriák

Egy kategória mezői (a `GET /api/autonomy` válasz `categories` tömbjének elemei):

```json
{
  "key": "email_send",
  "label": "Email küldés / válasz",
  "level": 1,
  "locked": false,
  "maxLevel": 2
}
```

- `locked: true` -- a szint nem emelhető (biztonsági korlát)
- `maxLevel` -- a maximálisan beállítható szint
- `timeout_minutes` -- a jóváhagyás-kérés lejárata percben; a `GET /api/autonomy` válaszban `timeoutMinutes`. A 0067-es migráció 60 percre állítja minden olyan kategóriánál, amely jóváhagyást kérhet (`maxLevel` legalább 2) és még nem volt értéke; a már beállított érték megmarad, a zárolt (level 1) kategóriák NULL-on maradnak, náluk nem keletkezik kérés. A NULL nem "korlátlan", hanem a 24 órás plafont jelenti (1440 perc)

**Jóváhagyás-lejárat.**
- Minden új kérés kap `timeout_at`-ot: a kategória értékét, vagy a 24 órás plafont, ha a kategória ismeretlen (például `github_pr`) vagy az értéke NULL.
- A `POST /api/approvals` törzsének `timeout_seconds` mezője (amelyet az ágens-sablon és a flotta promptjai mindig is küldtek) csak rövidíthet a fenti értéken, nem hosszabbíthat. A hiányzó, nulla, negatív vagy nem szám értéket a szerver figyelmen kívül hagyja.
- A lejárt kérésre a `PATCH /api/approvals/<id>` 409-et ad (`Approval has expired`), akkor is, ha a söprés (60 másodpercenként fut) még nem jelölte `timeout`-nak; magának a `timeout` státusznak a rögzítése megengedett. A söprés `resolved_by = system:timeout` értéket ír, így a lejárat megkülönböztethető az emberi elutasítástól. Lejáratkor nem megy Telegram-értesítés, csak az eddig is írt összesített audit bejegyzés készül.
- A migráció a `timeout_at` nélküli, még függő kérésnek is ad határidőt: `requested_at` + 60 perc.
- A `POST /api/autonomy` a `level` mellett (vagy helyett) `timeout_minutes`-t is fogad: 1 és 10080 közötti egész szám, vagy `null` (a 24 órás plafon). Csak admin (más 403-at kap), írás előtt validált, és minden módosítás audit bejegyzést ír a régi és az új értékkel. Dashboard-mező hozzá egyelőre nincs.

Az ágensek (a CLAUDE.md-instrukció szerint) a `GET /api/autonomy`-t hívják egy kategória aktuális szintjének lekérdezéséhez, nem fájlt olvasnak -- ha a dashboard nem elérhető, a biztonságos alapállapot level 1 (csak jelez).

## Modell-profil térkép

A `model_profile_map` DB-tábla lehetővé teszi, hogy az ágensek névleges profilokat (`premium_reasoning`, `build_strong`, `analysis_efficient`, `routine_lowcost`) használjanak konkrét modell-nevek helyett. Az induláskori migráció (0054) a négy profilt a fleet ma is futó modelljeivel tölti fel -- ez a Phase 1 szándéka: absztrakció, nem újra-tierezés.

Szerkesztés a dashboard Settings > Model profiles fülén (admin-only), vagy közvetlenül:

```http
GET /api/v1/model-profiles
PATCH /api/v1/model-profiles
{ "profileId": "build_strong", "modelId": "claude-sonnet-5" }
```

- Mind a négy profil kötelező -- hiányos térkép esetén az adott profilt igénylő agent az install default modellre esik, hibajelzéssel
- Egy ágens explicit `model` beállítása felülírja a profilját
- A DB-olvasás 90 másodperces cache-elt; a PATCH azonnal invalidálja a cache-t
- Nincs többé `store/model-profile-map.json` fájl vagy `config-examples/model-profile-map.example.json` sablon -- a régi kézi-másolós telepítés retirálva

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
