# F07 Fleet, tenant-kezelés és ütemezés

## Fleet -- több ágens kezelése

A flotta az összes Claude Code ágens gyűjtőneve, amelyek egy Marveen telepítésen belül futnak. Minden ágensnek saját munkakör-leírása (`agents/<name>/CLAUDE.md`), saját tmux munkamenete (`agent-<name>`) és opcionálisan saját csatorna-konfigurációja van.

### Ágens létrehozása

1. Nyisd meg a dashboard Ágensek oldalát
2. Kattints az "Új ágens" gombra
3. Add meg az ágens azonosítóját (`agent_id`), megjelenítési nevét és személyleírását
4. Válaszd ki az MCP connectorokat és a modell-profilt
5. Opcionálisan rendelj csatornát hozzá (Telegram/Slack/Discord)
6. Mentés -- a dashboard létrehozza az `agents/<name>/` könyvtárat és a szükséges konfigurációs fájlokat

Kézzel is létrehozható:

```bash
mkdir -p agents/<name>
# Másold a sablon fájlokat:
cp templates/CLAUDE.md.tpl agents/<name>/CLAUDE.md
cp templates/.mcp.json.tpl agents/<name>/.mcp.json
```

### Ágens indítása és leállítása

Az ágenseket a dashboard kezeli automatikusan. Kézzel:

```bash
# Indítás
curl -s -X POST http://localhost:3420/api/agents/<name>/start \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"

# Leállítás
curl -s -X POST http://localhost:3420/api/agents/<name>/stop \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"
```

Vagy közvetlenül a tmux session-t is kezelheted:

```bash
tmux attach -t agent-<name>     # rácsatlakozás
tmux kill-session -t agent-<name>  # leállítás
```

### Fleet blackboard

A flotta-ágensek a `fleet_blackboard` táblában jelzik egymásnak az aktuális állapotukat. A blackboard lekérdezhető az API-n:

```bash
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/blackboard
```

Egy ágens munka közben frissíti a saját sorát (`status: active/done/blocked`), így a többi ágens és a dashboard látja, ki mivel foglalkozik.

### Inter-agent kommunikáció

Az ágensek az `agent_messages` tábla üzenetsoron keresztül kommunikálnak:

```bash
curl -s -X POST http://localhost:3420/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"from":"kuldo-agent","to":"cimzett-agent","content":"Feladat leírása"}'
```

Az üzenet a cél-ágens tmux session-jébe kerül injektálásra; az ágens feldolgozza és a saját csatornáján válaszol.

---

## Tenant-kezelés (RBAC)

A Marveen többfelhasználós működésre is alkalmas: az egyes tenantok adatai (memóriák, kanban, ágensek) egymástól elkülönítve tárolódnak.

> **Megjegyzés:** a tenant-enforcement (RBAC_MODE=enforce) jelenleg shadow módban fut -- minden kérés átmegy, de a rendszer naplózza, mit utasítana el éles enforce esetén. Az enforce bekapcsolása egy jövőbeli kiadásban várható.

### Szerepkörök

| Szerepkör | Hozzáférés |
|-----------|-----------|
| `admin` | Teljes hozzáférés, minden tenant, adminisztrációs felület |
| `agent` | Egy tenant összes adata (olvasás + írás), nincs admin |
| `read_only` | Egy tenant adatai csak olvasásra |
| `viewer` | Memóriák, kanban, ágensek listázása (blackboard nélkül) |

### Token kezelés

Az API tokenek a `/api/v1/admin/tokens` végponton kezelhetők:

```bash
# Új token létrehozása
curl -s -X POST http://localhost:3420/api/v1/admin/tokens \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{
    "name": "partner-token",
    "role": "agent",
    "tenant_id": "acme-corp",
    "expires_at": "2027-01-01T00:00:00Z"
  }'
```

```bash
# Token visszavonása
curl -s -X PATCH http://localhost:3420/api/v1/admin/tokens/<id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"revoked": true}'
```

### B2B partner beléptetése

Egy külső partner (B2B tenant) alapvetően az `agent` szerepkörrel kap tokent, és a saját `tenant_id`-jére szűrt adatokat lát. A beléptetési folyamat:

1. Tenant felvétele az admin felületen (Beállítások > Tenantok)
2. `agent` token generálása a partner számára (lejárattal, `expires_at`)
3. A tokent biztonságos csatornán kell átadni (nem emailben nyílt szövegként)
4. Izolációs teszt: az új tokennel egy `default` tenant memória lekérdezésének üres listát kell adnia
5. Rotációs folyamat egyeztetése: új token igénylése lejárat előtt legalább 2 héttel

### Külső rendszerek üzenetküldési engedélye

Ha egy nem-ágensként regisztrált külső rendszernek is kell üzeneteket küldenie (`POST /api/messages`), add meg az azonosítóját az `.env`-ben:

```ini
SYSTEM_SENDER_IDS=cortex
```

---

## Ütemezett feladatok

Az ütemezett feladatok fájl-alapúak: minden feladat egy könyvtárból áll, amely tartalmaz egy `SKILL.md` (instrukciók) és egy `task-config.json` (cron + metaadatok) fájlt.

### Feladat helyek

| Könyvtár | Hatókör |
|----------|---------|
| `~/.claude/scheduled-tasks/` | Globális (minden agensnek) |
| `scheduled-tasks/` (projekt) | Projekt-szintű feladatok |

### task-config.json struktúra

```json
{
  "schedule": "0 8,12,16,20 * * *",
  "agent": "marveen",
  "enabled": true,
  "type": "task",
  "skipIfBusy": true,
  "description": "Leírás (opcionális)",
  "timeoutMs": 30000
}
```

**`type`** értékei:
- `task` -- futás után mindig értesítést küld az eredményről
- `heartbeat` -- csak akkor küld értesítést, ha fontos vagy sürgős esemény van
- `command` -- shell parancsot futtat (nem Claude Code promptot)

### Beépített feladatok

A Marveen telepítéskor seed-feladatokat hoz létre:

| Feladat | Cron | Leírás |
|---------|------|--------|
| `auto-update` | `0 4 * * 3` (szerdánként) | Automatikus frissítés (opt-in, `AUTO_UPDATE_ENABLED=1`) |
| `kanban-audit` | `0 8,12,16,20 * * *` | 4 óránkénti kanban-tisztítás, beakadt taskok detekciója |
| `memory-maintenance` | `0 3 * * *` | Napi memória-karbantartás (tier-átsorolás, verziók prune-olása) |
| `budget-plafon-monitor` | saját cron | Token-felhasználás küszöb-figyelés |
| `bumblebee-hygiene-scan` | saját cron | Bumblebee (Go) service egészség-ellenőrzés |

### Feladat létrehozása és módosítása

A dashboard Ütemezés oldalán grafikusan kezelhető. API-n:

```bash
# Új feladat
POST http://localhost:3420/api/v1/schedules

# Módosítás
PATCH http://localhost:3420/api/v1/schedules/<id>

# Törlés
DELETE http://localhost:3420/api/v1/schedules/<id>
```

Részletes cron-formátum és payload: a `dashboard-schedule-crud` skill tartalmazza.

> Ne írd közvetlenül az SQLite `scheduled_tasks` táblát -- ez egy régi API. Használd a dashboard API-t vagy a fájl-alapú könyvtárakat.

### Időzóna

A cron kifejezések a szerver időzónájában értendők (`SCHEDULER_TZ` az `.env`-ben, alapértelmezés: az OS időzónája). Ellenőrzés:

```bash
grep SCHEDULER_TZ .env || date
```

---

## Föderáció (kísérleti)

A föderáció két önálló Marveen telepítés összekapcsolását teszi lehetővé, anélkül hogy az adatbázisaik közösek lennének. Megbízható üzenetváltás SSH-alagúton keresztül.

### Működési elv

Egy "partnergép" ágens üzenete a helyi `agent_messages` táblán keresztül kerül kézbesítésre, egy SSH forward tunnel biztosítja a kapcsolatot a remote gép dashboardjával. A forrás telepítés sosem lát bele a célgép adatbázisába.

### Kulcs-regisztráció

```bash
# Saját public key megjelenítése (beléptetéshez)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/federation/key

# Partnergép kulcsának regisztrálása
curl -s -X POST http://localhost:3420/api/federation/enroll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"bundle": "<base64-bundle-a-partnertol>"}'
```

A kulcscsere mindkét irányban elvégzendő; a beállítás a dashboard Beállítások > Föderáció oldalán is elvégezhető.

---

*Előző fejezet: [F06 MCP connectorok](F06-mcp.md)*
