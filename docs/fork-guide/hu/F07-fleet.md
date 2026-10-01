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

A végrehajtó a `PUT /api/messages/<id>` hívással zárja le a kiosztott üzenetet (`status`: `done`, `failed` vagy `refused`, opcionális `result`). A delegáló ezután egy `[Eredmény]` kezdetű teljesítési értesítőt kap; ez az értesítő az eredeti üzenet tenantjába kerül, így a tenant-hatókörű delegáló látja a saját kérésének az eredményét.

Tenant-szabály erre a végpontra: nem-admin hívó csak a saját tenantjának üzenetét módosíthatja (a tenant nélküli üzenet `default`-nak számít). Másik tenant üzenete pontosan úgy válaszol, mint egy nem létező azonosító (`404 not_found`), így az üzenet-azonosítók tenantok között nem tapogathatók végig; az elutasított kísérlet bekerül az audit-naplóba. Az admin hívót nem korlátozza.

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

### Ütemezett feladatok és tenantok

Az ütemezett feladatoknak tenant a tulajdonosa (`schedules.tenant_id`, sosem üres; lásd lejjebb az "Ütemezett feladatok tenant-tulajdonlása" szakaszt). A hozzáférési modellre ez azt jelenti:

- A nem-admin hívó csak a saját tenantja feladatait, a választható ágenseket (`GET /api/v1/schedules/agents`) és a függő újrapróbálkozásokat kapja; másik tenant feladata `404 not_found` választ ad, mint egy nem létező név.
- Az `ENDPOINT_PERMISSION_TABLE`-ben nincs `/api/v1/schedules` sor, ezért a végpontokra az alapértelmezett `admin:all` érvényes. **Shadow módban ez az alapértelmezés csak naplózódik, nem kényszerül ki**: egy tenant-viewer egyszerű `PUT`-ját (vagy toggle, törlés, azonnali futtatás, létrehozás hívását) maga az RBAC nem állítja meg, és csak az `RBAC_MODE=enforce` teszi úgy, hogy az egész csoport 403-at ad a nem-adminoknak. A tenant-szabályok az útvonal-kezelőkben vannak, és mindkét módban érvényesek: más tenantok láthatatlanok (404), az aktiválás bejelentkezett admint kér (403), a szerkesztés `status`, `tenantId` és futtató szkript kulcsai eldobódnak, a nem-admin `agent` kulcsa figyelmen kívül marad, a más `tenant_id`-t megnevező nem-admin 403-at kap, és a nem-admin által létrehozott feladat a saját tenantjában `draft`. Amit a shadow mód nyitva hagy, az minden más a hívó saját tenantján belül: a feladatai többi mezőjének szerkesztése (egy aktív feladat promptja és ütemezése is, újabb jóváhagyás nélkül), ki- és bekapcsolás, törlés és futtatás. Amíg az enforce mód nincs bekapcsolva, ne adj tenant-felhasználóknak dashboard-belépést vagy az ütemezés útvonalaira API-hozzáférést adó tokent, hacsak ez a kitettség nem elfogadható.
- A dashboard a nem-adminoknak elrejti a **+ Feladat** gombot és letiltja a sorműveleteket (kliens oldalon, `admin:all`), mindkét módban. A tenant-felhasználók az ágensükön át kérnek feladatot: az ágens `draft` feladatot hoz létre annak a kérésnek a tenantjában, amelyet kiszolgál, és bejelentkezett admin aktiválja.

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
  "timeoutMs": 30000,
  "tenantId": "default"
}
```

**`type`** értékei:
- `task` -- futás után mindig értesítést küld az eredményről
- `heartbeat` -- csak akkor küld értesítést, ha fontos vagy sürgős esemény van
- `command` -- shell parancsot futtat közvetlenül (nincs ágens-session, nincs prompt); lásd lejjebb a "Command feladatok" szakaszt

A `tenantId` a feladat tulajdonos tenantját nevezi meg. A tükör minden írása rögzíti, a `tenantId` nélküli `task-config.json` (régi fájl, vagy olyan seed, amely nem nevez meg tenantot) pedig `default` alá kerül, amikor az üres schedules táblát a fájlokból seedelik (`seedSchedulesFromFilesIfEmpty`, `scripts/migrate-schedules-to-db.ts`), így egy újraseedelés sosem hoz létre tenant nélküli feladatot.

Az `enabled` igazságforrása az adatbázis-sor; a `task-config.json` csak a tükre. Az ütemező az eltérő `enabled` értéket a fájlban indításkor, majd óránként visszahúzza az adatbázis értékére (csak adatbázisból fájlba, soha fordítva). Csak ez az egy kulcs íródik át, a többi kulcs megtartja az értékét, a `SKILL.md`-hez nem nyúl, a hiányzó vagy nem értelmezhető fájlt kihagyja (a tükröt a szinkron sosem hozza létre). Minden javítás figyelmeztetésként naplózódik, a feladatok nevével.

### Beépített feladatok

A Marveen telepítéskor seed-feladatokat hoz létre:

| Feladat | Cron | Leírás |
|---------|------|--------|
| `auto-update` | `0 4 * * 3` (szerdánként) | Automatikus frissítés (opt-in, `AUTO_UPDATE_ENABLED=1`) |
| `kanban-audit` | `0 8,12,16,20 * * *` | 4 óránkénti kanban-tisztítás, beakadt taskok detekciója |
| `nightly-backup` | `0 3 * * *` | Napi adatmentés (`scripts/backup.sh`), LLM nélküli command feladat |
| `memory-maintenance` | `15 3 * * *` | Napi memória-karbantartás (tier-átsorolás, verziók prune-olása, link-gráf karbantartás), LLM nélküli command feladat |
| `budget-plafon-monitor` | saját cron | Token-felhasználás küszöb-figyelés |
| `bumblebee-hygiene-scan` | saját cron | Bumblebee (Go) service egészség-ellenőrzés |

### Feladat létrehozása és módosítása

A dashboard Ütemezés oldalán grafikusan kezelhető. API-n:

```bash
# Új feladat
POST http://localhost:3420/api/v1/schedules

# Módosítás (csak a szerkeszthető mezők, lásd lejjebb)
PUT http://localhost:3420/api/v1/schedules/<name>

# Törlés
DELETE http://localhost:3420/api/v1/schedules/<name>
```

Továbbá elérhető: `POST .../<name>/toggle`, `POST .../<name>/activate` (csak bejelentkezett admin), `POST .../<name>/run`, `GET .../<name>/runs`, `GET /schedules/agents`, `GET /schedules/pending` és `DELETE /schedules/pending/<id>`; mind szerepel a `docs/openapi.yaml`-ban.

Részletes cron-formátum és payload: a `dashboard-schedule-crud` skill tartalmazza.

> Ne írd közvetlenül az SQLite `scheduled_tasks` táblát -- ez egy régi API. Használd a dashboard API-t vagy a fájl-alapú könyvtárakat.

### Ütemezett feladatok tenant-tulajdonlása

Minden feladat pontosan egy tenanthoz tartozik: a `schedules.tenant_id` értéke `'default'` vagy egy tenant azonosító, sosem üres. Az oszlop nullable marad az SQLite-ban (helyben nem lehet `NOT NULL`-ra állítani), az alkalmazás tartja kitöltve. A 0066-os migráció a tenant nélküli sorokat a `default` tenantba tette (`UPDATE schedules SET tenant_id = 'default' WHERE tenant_id IS NULL`, idempotens, a már tenantot megnevező sorokhoz nem nyúl). A tenant-context hook a hiányzó tenantot és a `default`-ot eddig is ugyanúgy olvasta, így futásidőben semmi nem változott, és egyetlen feladat sem költözött. A tenant nélküli "flotta" hatókör megszűnt: a `?tenant=fleet` semmit nem talál, a tárolt NULL (a migráció előtti sor) pedig mindenhol `default`-nak olvasódik (`rowToTask`, a lista tenant-szűrője).

Frissítés előtt készíts mentést (`scripts/backup.sh`); az újraindítás után a `SELECT tenant_id, count(*) FROM schedules GROUP BY 1` nem mutathat NULL-t.

**Melyik tenantot kapja az új feladat** (`POST /api/v1/schedules`, az első egyezés nyer):

1. nem-admin hívó: a saját tenantja (a törzsben küldött `tenant_id`-t figyelmen kívül hagyja);
2. `tenant_id`-t küldő admin: az a tenant (a megosztott ágens-token adminnak számít);
3. bejelentkezett emberi admin, aki nem küld ilyet: `default`;
4. egyébként (a megosztott token `tenant_id` nélkül): az `X-Agent-Id` fejlécből levezetett tenant. A fejléc önbevallott, nem hitelesítés. A tenant annak a kérésnek a tenantja, amelyet az ágens éppen kiszolgál: az `agent_tenant_context` friss `bound` sora, amelynek tenantját az ágens még kiszolgálja, vagy egy friss `default` sor (kötetlen forrás). A "friss" a `TENANT_CONTEXT_MAX_AGE_SECONDS` (alapból 43200, 12 óra). Használható kontextus nélkül az ágens saját tenantja számít, de csak ha pontosan egy van (engedélyezett `tenant_agent_availability` sor nélkül ez `default`). A több tenantra engedélyezett, kontextus nélküli ágens nem egyértelmű.

Ha ebből nem jön ki tenant (nincs `X-Agent-Id`, vagy nem egyértelmű a megosztott ágens), a válasz `400 tenant_required` (mező: `tenant_id`) néma `default` helyett. A feladat sosem kerül sorra találgatás alapján, és nem emberi hívónál `draft` marad, így egy ember aktiválja, látva a tenantot (jelvény és súgószöveg a dashboardon). A generált ágens-`CLAUDE.md` fájlok létrehozási példája küldi az `X-Agent-Id`-t; az e változás előtt generált utasításokban nincs ilyen, és az azokból indított létrehozás `tenant_required` választ kap, amíg a fejléc nem kerül bele.

Miután a tenant ismert: léteznie kell, és nem lehet letiltva (`400 invalid_value`, mező: `tenant_id`).

**A (tenant, ágens) páros.** A feladat ágensének ki kell szolgálnia a feladat tenantját, mert a hook a tenantot az ágens munkamenetéhez köti, amikor a feladat tüzel. Létrehozáskor és minden olyan szerkesztésnél ellenőrzi, amely a tenantot vagy az ágenst mozgatja (`400 invalid_value`, mező: `agent`, vagy `tenant_id`, ha maga az áthelyezés törte meg a párost); nem-default tenantnak nincs alapértelmezett ágense, ezért ott az `agent` kötelező (`400 required`):

| Tenant | Érvényes ágensek |
|--------|------------------|
| `default` | a flotta fő ágense, `all`, minden ismert ágens, amely nincs engedélyezett tenant-sorral, vagy engedélyezve van a `default`-ra |
| bármely más | a fő ágense vagy egy rá engedélyezett ágens (`tenant_agent_availability.enabled = 1`), amíg a tenant nincs letiltva; sosem a flotta fő ágense (nincs tenant-hookja, így nincs izoláció) és sosem az `all` (a szétosztás nem köthető egyetlen tenanthoz) |

Az ismeretlen ágensnév minden tenantnál érvénytelen.

**Szerkesztés (`PUT`).** A kezelő csak ezeket írja: `description`, `prompt`, `schedule`, `enabled`, `type`, `skipIfBusy`, `forceSend`, `targetSession`, `command`, `timeoutMs`, `failThreshold`. Minden más kulcs eldobódik, különösen a `status` (egy szerkesztés már nem tehet éles feladattá egy vázlatot: az aktiválás a bejelentkezett admin lépése marad), a `tenantId`, és a futtató szkript kulcsai: `preCheck`, `catchUpMaxAgeMinutes`, `stuckAfterMinutes`, `requires`. Az `agent` csak adminnak szól (másoknál figyelmen kívül marad), és az eredő párosnak érvényesnek kell lennie. A `tenant_id` áthelyezi a feladatot: csak bejelentkezett admin (mindenki másnak `403`, a megosztott tokennek is, ha más tenantot nevez meg), a célnak léteznie kell és engedélyezettnek kell lennie, a páros újra ellenőrzött, a feladat visszakerül `draft` állapotba, a válasz `{ ok: true, tenant_id, status: "draft" }`. Az aktuálissal egyező `tenant_id` nem csinál semmit. A nem-admin csak a saját tenantja feladatait éri el (egyébként `404`), a `PUT`, `DELETE`, toggle, azonnali futtatás és `runs` hívásoknál.

**Olvasás.** A `GET /schedules` minden feladatot `tenantId`-vel ad vissza: az adminok az összeset vagy a `?tenant=` szerintieket, mindenki más a saját tenantját. A `GET /schedules/agents` `{ name, label, avatar }` objektumokat ad: a nem-admin csak a tenantját kiszolgáló ágenseket, az admin az összeset vagy a `?tenant=` szerintieket (a dashboard-ablak ezzel szűkíti a választót). A `GET /schedules/pending` és a `DELETE /schedules/pending/<id>` az újrapróbálkozás feladatának tenantját követi; az a függő újrapróbálkozás, amelynek a feladata már nincs, csak adminnak szól.

**Futtató.** Minden ütemben az az engedélyezett, éles, nem `command` típusú feladat, amelynek a párosa már nem áll fenn, nem tüzel, bármi is az ok (az ágenst kikapcsolták a tenantnál, a tenantot letiltották, a tenant fő ágense megváltozott, az ágenst törölték). Az ellenőrzés egy ütem erejéig páronként memoizált, a sikertelen lekérdezés érvényesnek számít, így egy adatbázis-hiba sosem állítja le a feladatokat. Minden esedékes előfordulás `skipped_tenant_mismatch` állapottal kerül a `task_runs` táblába, ugyanabban a kihagyási főkönyvben, mint a `skipped_not_live` (lásd "Visszatartott előfordulások"). Hibánként egy értesítés megy ki: egy hiba-naplósor, egy audit sor (ágens: `scheduler`, entitás: `schedule`, művelet: `skip_tenant_mismatch`, entitás-azonosító a feladat neve, részlet a tenant és az ágens) és egy Telegram-üzenet a tulajdonosi chatre, ha be van állítva (a szöveg jelenleg mindig magyar). A jelző memóriában él: a páros újra érvényessé válásakor törlődik, és egy hibán belüli újraindítás újra értesít. A `command` feladatok nem futtatnak ágenst, ezért nincsenek ellenőrizve.

**A hook-kapcsolat.** A `scripts/hooks/tenant_context_lib.py` a `<scheduled-task source="scheduled-task:NAME">` promptot a `SELECT tenant_id FROM schedules WHERE id = ? AND agent = ?` lekérdezéssel oldja fel: a hiányzó vagy `default` érték az alapértelmezett tenant, más azonosító akkor `bound`, ha az ágens kiszolgálja, különben `unknown` (a skill-kapu ilyenkor megtagadja a tenant skilljeit), a más ágenst nevező (vagy `all`) sor pedig `unknown`. Vagyis a `tenant_id` beállítása elég egy ütemezett futás tenant-skill izolációjához, a fenti páros-szabály pedig érvényesen tartja ezt a kötést. A főágensnek nincs tenant-hookja, ezért nem lehet neki nem-default tenant feladatát adni. Lásd F03, "Tenant skill gate".

**A szélek.**
- A tenant törlése (`DELETE /api/v1/admin/tenants/<id>`; a `default` nem törölhető) eltávolítja a feladatait, azok `pending_task_retries` sorait és fájl-tükrüket (`~/.claude/scheduled-tasks/<name>`, amelyet egy üres-tábla újraseedelés különben visszahozna); az `admin.tenant.delete` audit sor tartalmazza a `schedules_deleted` és `schedule_mirrors_removed` értéket.
- A flotta-import a `default`-ba teszi azt az ütemezést, amelynek exportált `tenant_id`-ja nem engedélyezett tenant ezen a gépen (a tenantok gépenként helyiek). Az ütemezések továbbra is letiltva érkeznek, a próbafuttatás és az alkalmazási jelentés megszámolja, hányat tettek át.
- Az Áttekintés `tasksToday` értéke tenant-nézetben a tenant ütemezéseinek `task_runs` sorait számolja (feladatnév alapján), nem a tenant ágenseinek futásait, így a több tenant által megosztott ágens már nem tűnik el minden tenant-nézetből. Az a futás, amelynek az ütemezése azóta törlődött, nem tartozik tenanthoz, és csak a flottaszintű számban látszik.
- A `tenant_required` API hibatoken (`400`), dashboard-üzenettel.

### Command feladatok

A `type: command` feladat a `command` mezőt `bash -lc`-vel futtatja a dashboard folyamatán belül, ágens-session és modellhívás nélkül. A cron-ciklus és a kézi futtatás ugyanazt a kódutat használja.

| Mező | Alapérték | Jelentés |
|------|-----------|----------|
| `command` | -- | Shell parancs; parancs nélküli feladat kimarad |
| `timeoutMs` | `10000` | Futásidő-korlát |
| `failThreshold` | `2` | Hány egymás utáni hiba után jön az első riasztás |

- A parancs **aszinkron** fut, így a dashboard közben is kiszolgálja a kéréseket. A dashboard saját API-ját hívó parancs (`curl http://localhost:<port>/api/...`) ezért kap választ.
- Időtúllépéskor a **teljes folyamatfa** leáll (SIGTERM, 2 másodperc után SIGKILL), nem csak a shell, és a futás hibának számít.
- Az az előfordulás, amely még fut, amikor a következő esedékes (vagy egy kézi futtatás) megérkezik, kimarad, sosem indul kétszer.
- Az állapotot feladatonként a `store/command-task-health.json` tartja (hibasorozat, utolsó státusz, utolsó futás). Telegram-riasztás egyszer megy, amikor a sorozat eléri a `failThreshold`-ot, és helyreállás-üzenet, amikor a feladat újra sikeres. `failThreshold: 1` mellett már az első hiba riaszt. A riasztáshoz be kell állítani a Telegram tokent és a chat azonosítót, különben csak naplózódik.

Példa: éjszakai mentés, amely az első hibánál riaszt (adj neki bőséges időkorlátot, az alapértelmezett 10 másodperc kevés egy mentéshez):

```json
{
  "schedule": "0 3 * * *",
  "agent": "marveen",
  "enabled": true,
  "type": "command",
  "description": "Éjszakai mentés",
  "command": "cd /path/to/marveen && bash scripts/backup.sh",
  "timeoutMs": 600000,
  "failThreshold": 1
}
```

### Feladat kézi futtatása

A `POST /api/v1/schedules/<name>/run` azonnal elindít egy feladatot, figyelmen kívül hagyva a cron-egyezést, a catch-up ablakot és a `skipIfBusy`-t. A letiltott feladat `409 disabled`, a vázlat (draft) státuszú `409 not_live` választ ad (emberi admin a vázlatot is lefuttathatja, hogy az aktiválás előtt megnézze).

- Prompt-feladatok (`task`, `heartbeat`): a prompt a cél-ágens session-jébe kerül, mint egy cron-indításnál. A leállt ágenst elindítja, a foglalt session pedig sorba állított újrapróbálkozást kap. A válasz ágensenként egy eredményt sorol fel, például `<agent>: fired`.
- Command feladatok: a shell parancs közvetlenül fut, ahogy a cron-ciklusban is, és rögzítődik az utolsó futás ideje. A hívás nem várja meg a parancsot, azonnal `command: started (outcome in store/command-task-health.json)` választ ad.

### Visszatartott előfordulások és a tömeges kihagyás riasztása

Egy engedélyezett feladat esedékes előfordulása nem fogyhat el nyom nélkül. Az ütemező minden ütemben négy állapotba sorolja a feladatokat:

| Állapot | Feltétel | Hatás |
|---------|----------|-------|
| futtatható (runnable) | engedélyezett és éles (live) | normál indítás és catch-up |
| letiltott (disabled) | az `enabled` ki van kapcsolva | általában az operátor saját kapcsolója: nincs futás, nincs sor, a catch-up sosem játssza újra |
| nem éles (not live) | engedélyezett, de a jóváhagyási kapu visszatartja (`draft` / `pending_review`) | nem fut; minden esedékes előfordulás `skipped_not_live` állapotú sorként kerül a `task_runs` táblába |
| tenant-eltérés (tenant mismatch) | engedélyezett és éles, de a (tenant, ágens) párosa már nem áll fenn | nem fut; minden esedékes előfordulás `skipped_tenant_mismatch` állapotú sor, hibánként egy értesítés (lásd "Ütemezett feladatok tenant-tulajdonlása") |

Az ütemben talált minden esedékes előfordulásról egy sor készül, minden célágensre külön (a feladat ágense; ha nincs megadva, a főágens; `all` feladatnál a főágens és minden futó ágens). A sorok a futási előzményekben látszanak (`GET /api/v1/schedules/<name>/runs`, legutóbbi 10), a dashboard a nyers állapotnevet mutatja.

A letiltott feladatot is rögzíti, `skipped_disabled` állapottal, ha egy **tömeges esemény** része. Tömeges esemény az, amikor legalább 4 feladat van játékban (az előző ütemben futtatható feladatok és minden most engedélyezett feladat), és több mint a felük egyszerre van visszatartva. Visszatartott: a nem éles feladat, a tenant-eltérésű feladat, vagy az a letiltott feladat, amely az előző ütemben még futtatható volt. Ez az ütemező saját feladatainak téves olvasása, nem egy operátor egyetlen kapcsolása, ezért minden visszatartott előfordulás rögzítődik. A feladat addig marad az eseményben, amíg újra futtatható nem lesz, vagy el nem telik 24 óra. Az esemény előtt már letiltott feladatok sosem részei az eseménynek, egy különálló kapcsolgatás pedig sosem éri el a küszöböt.

Amikor egy tömeges esemény elindul, egyetlen riasztás megy ki:

- egy hibasor a dashboard naplójában;
- egy audit sor (ágens `scheduler`, entitás `schedule`, művelet `mass_skip`, részletek: a visszatartott feladatok száma, a feladatok száma, legfeljebb 8 név), amely a dashboard audit naplójában látszik;
- egy Telegram-üzenet a tulajdonos chatjébe a visszatartott feladatok számával és legfeljebb 8 névvel (a többi `+N`), ha a bot token és a tulajdonos chat azonosítója be van állítva. A szöveg jelenleg mindig magyar.

A riasztás duplikátumszűrt, időben nem korlátozott: a jelző addig áll, amíg az esemény tart, és újra élesedik, amint a feltétel megszűnik. A jelző memóriában van, így egy olyan újraindítás, amely még az eseményen belül van, újra riaszt.

Az észlelés túléli az újraindítást. Az "előző ütemben futtatható" alapállapot memóriában van, így egy frissen indult folyamatnak nincs előzménye, és normálisnak vehetné azt az állapotot, amelyben minden feladat már letiltottnak látszik. Az első vizsgálatnál ezért az alapállapotot maguk az adatbázis-sorok adják (engedélyezett és éles, az ütem saját feladatlistájától függetlenül olvasva), így az a folyamat, amely egy tömeges eseményen belül indul, az első ütemtől rögzíti a visszatartott előfordulásokat és elküldi a riasztást. Az adatbázisban letiltott feladatok nincsenek az alapállapotban, és nem hagynak sort. Ha az alapállapot olvasása hibázik, a vizsgálat az ütem saját bizonyítékára támaszkodik. A teljes kihagyási napló hibája figyelmeztetésként naplózódik, és sosem töri meg az ütemet.

### MCP előellenőrzés

A feladat a `task-config.json`-ban megadhatja, mely MCP szerverektől függ:

```json
{ "requires": { "mcp_servers": ["gmail", "google-drive"] } }
```

A prompt kézbesítése előtt a futtató ellenőrzi, hogy minden megnevezett szervernek van-e élő folyamata a cél-session `claude` folyamata alatt. Ha valamelyik bizonyíthatóan hiányzik, a feladat a függő újrapróbálkozások sorába kerül, és egy riasztás megnevezi a hiányzó szervert, ahelyett hogy a prompt egy halott szerver ellen futna le.

A szerver felismerése: a futtató összefésüli a session által látott MCP konfigurációkat, növekvő prioritással: user-scope (`mcpServers` a `~/.claude.json`-ban), a projekt `.mcp.json`-ja, végül az ágens saját `.mcp.json`-ja. A `npx`, `bunx` vagy `pnpm dlx` útján indított szervereknél a keresett minta a csomagnév (a verziótoldalék nélkül); a többinél a szkript útvonala, szkriptútvonal nélküli bináris esetén a parancs és az első argumentuma. Az ellenőrzés **fail-open**: távoli (`sse`/`http`) szerver, csomagnév nélküli futtató, olvashatatlan konfigfájl, távoli session vagy nem feloldható `claude` folyamat sosem blokkol feladatot.

### Flotta memória-heartbeat sweep

A `scripts/fleet-heartbeat-sweep.sh [stagger_masodperc]` megkéri minden futó al-ágenst (élőben az `/api/agents`-ből, a főágens kivételével), hogy futtassa a saját memória-heartbeatjét, egyesével, köztük szünettel (alapból 60 másodperc). Napló: `store/fleet-heartbeat-sweep.log`. Úgy tervezték, hogy néhány óránként egy ütemezett feladat indítsa.

A sweep egy ütemezett döntésből ágensenként egy modell-fordulót csinál, ezért saját kvóta-őre van. A `store/claude-usage.json`-t olvassa, és az egész sweepet kihagyja, ha a `sessionPct` és a `weeklyPct` nagyobbika eléri a `QUOTA_THRESHOLD`-ot (alapból `75`). Az őr csak **friss** pillanatképnek hisz: ha a `fetchedAt` régebbi, mint a `QUOTA_STALE_MINUTES` (alapból `20`), vagy hiányzik, az őr naplózza az okot és átengedi a sweepet (fail-open). Egy megállt használati érték így nem némíthatja el hetekre a sweepet.

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
