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

### Ágens API tokenek és az API wrapper

Minden ágens a saját tokenjével hívja a dashboard API-t (`agents/<id>/.agent-token`; a fő ágensé a projekt gyökerében van), nem a közös `store/.dashboard-token`-nel, amelyet már egyetlen script, wrapper vagy hook sem olvas. Az üzemeltetőnek is van sajátja (`store/.operator-token`). Kezelésük a telepítést futtató gépen megy, a dashboard állhat:

```bash
npm run agent-tokens -- issue [--rotate] [--dry-run] [<ágens>...]   # alapból a fő ágens és minden ágens
npm run agent-tokens -- issue-operator [--rotate]
npm run agent-tokens -- check [<ágens>...]   # csak olvas: minden token-fájl egyezik-e egy aktív tokennel? 1-es kilépés, ha nem
npm run agent-tokens -- list
npm run agent-tokens -- revoke <ágens>
npm run agent-tokens -- rotate-shared   # mindig új közös tokent állít elő, a régi sort visszavonja; nem fut, amíg a DASHBOARD_TOKEN be van állítva
```

A fájlok `0600` jogúak, a parancs a fájlt írja ki, tokent soha, a mentés szándékosan kihagyja őket (a közös token fájlját is). Visszaállítás után kövesd az F03 "Visszaállítás után: API tokenek" lépéseit (a `doctor.sh` és az `agent-tokens check` jelzi a hiányzó vagy elavult fájlt).

A dashboardot megnyitó ember sem a közös tokent használja: az `npm run dashboard-url` (operátor-aláírású, a dashboardnak futnia kell) `<origin>/?enroll=<egyszer használható kód>` linket ír ki, amit a böngésző a saját, nevesített, visszavonható admin tokenjére cserél (`POST /api/auth/enroll-browser`; a kódot a `POST /api/admin/browser-enroll-codes` adja, csak globális admin, egyszer használható, 10 perc, memóriában él). A telepítők a végén ilyen linket írnak ki.

A receptek, hookok és scriptek az API-t a `scripts/agent-api.sh`-n át hívják: az választja ki a megfelelő tokent és stdin-en adja a curl-nek, így nem látszik se a folyamatlistában, se a transzkriptben:

```bash
bash scripts/agent-api.sh [--agent ID] [--token agent|operator|admin|main] METHOD /api/... [BODY | - | @fájl]
```

- `agent` (alapértelmezett) a hívó ágens saját tokenje; az ágens a `--agent`, a `MARVEEN_AGENT_ID` vagy a munkakönyvtár (`agents/<id>/`, a projekt gyökere a fő ágens) alapján dől el.
- `operator` az üzemeltető tokenje. `admin` az olyan hívásra való, amihez admin szerep kell bárki hívja: a fő ágens a sajátját használja, mindenki más elutasítást kap (3-as kilépés), és a fő ágenstől kér az `/api/messages` végponton. `main` a fő ágensként lép fel (rendszerscriptek).
- Azokra a végpontokra, ahol egy sima ágens-tokent elutasítanak (ágens start/stop/restart, vault, egress-engedélyezőlista írás, globális skill írás), a fő ágens vagy az üzemeltető jogosult: használj `--token admin` (fő ágens) vagy `--token operator` kapcsolót. A saját skilljét (`agent/<id>/<név>`) az ágens a saját tokenjével is írhatja; a globális skillhez admin kell.
- Közös-token fajta és arra való visszaesés nincs. A `--token shared` használati hiba (2-es kilépés). Az ágens hiányzó vagy üres token-fájlja 3-as kilépés, és **kérés nem megy ki**; ugyanez igaz a `scripts/hooks/agent_token.py`-ra (`none` forrás hibával) és a `scripts/agent-api.mjs`-re. Ha a token megvan, de elutasítják (visszavont, elavult), nincs újrapróba másik tokenen: az elfedné a hibát.
- Kilépési kód: 0 2xx-nél, 22 bármilyen más HTTP státusznál (a státusz stderr-re megy, a törzs továbbra is kiíródik), 2 használati hibánál, 3 ha nincs token, amit küldeni lehetne.

A dashboard a közös tokent a rotálásig még elfogadja (`agent-tokens rotate-shared`); utána a régi érték 401-et kap, amit a shadow-számláló `shared_token_refused` néven számol, így látszik a lemaradó, a régi tokent még birtokló folyamat.

#### Identitás-érvényesítés (`TOKEN_IDENTITY_MODE`)

A `TOKEN_IDENTITY_MODE` (`src/config.ts`, induláskor a környezetből vagy az `.env`-ből olvasódik) `shadow`, hacsak nem pontosan `enforce`. `shadow`-ban a fenti számláló csak számol. `enforce`-ban ugyanez az osztályozás elutasít: az a kérés, amelynek hívója nem a főágens, és másik ágenst nevez meg, 403-at kap (`forbidden`, "A token may only act as its own agent" tanács), még az útvonal lefutása előtt. A hívó az az ágens, akit a fleet-agent token megnevez, vagy a közös-tokenes kérés `X-Agent-Id`-ja; az a közös-tokenes kérés, amely senkit nem deklarál, hívó nélküli és átmegy, ezt csak a közös token nem-főágensektől való elvétele zárja. Akkor kapcsold be, ha a fenti közös-token kapu PASS-t ad és a közös token rotálva van. Visszaállítás: `TOKEN_IDENTITY_MODE=shadow` és a dashboard újraindítása.

Hogy mi számít ágens megnevezésének, a jogosultsági mátrixot követi (`WATCHED` a `src/web/token-shadow.ts`-ben, `enforce` mező): az ágensenkénti végpontokon (ledger, agent state, task state, daily log, spans, hook audit, tool log, skill usage, artifacts, approvals, messages, schedules, recall, és a névvel címzett ágens-erőforrások a `/api/agents/:name/` alatt) minden metódus; a memories végponton minden metódus, kivéve hogy a `shared` szint ágensek között olvasható; a workspace és blackboard végpontokon csak az írás (más ágens sorainak olvasása marad engedélyezett); a kanbanon soha (tenant szerint szűkített). Az útvonalat, a lekérdezést és a JSON törzset ellenőrzi; a törzset méretétől függetlenül és a köteg minden elemét, és elutasítja az ágens-kulcs alatti nem-string értéket. Az a végpont is elutasítást kap, amely ágens nélkül a főágensként cselekszik (memories, ütemezés-írás, közös-tokenes hívó daily-logja): nem-főágens hívónál a "senkit nem nevez meg" jelentése "a főágenst nevezi meg". Az inter-agent `from` a `/api/messages` ágens-kulcsa, tehát a közös-tokenes üzenetnek attól az ágenstől kell jönnie, aki magát deklarálta.

Hogyan olvassa a számláló. A `foreign_row_access` csak azt a kérést számolja, amelyet az enforce elutasítana; az az idegen olvasás, amelyet az enforce átenged (egy workspace-dokumentum vagy kanban-kártya id szerint, egy megosztott emlék, a blackboard), `foreign_row_read`: tájékoztató, nem része a kapunak; minden kérés, amelyet az enforce ténylegesen elutasított, `identity_refused` (cél = az ágens, akit megnevezett), a követő héten megmagyarázandó: minden sor hiba vagy kísérlet. A `shared` emlék-szint az egyetlen ágensek között olvasható emlék: az a listázás, amely pontosan ezt a kategóriát kéri, vagy egy megosztott sor id szerint, `include`, `agent` és `agent_id` nélkül. Enforce alatt az a fleet-ágens, amely emlék-listán vagy keresésen, az emlék-gráfon vagy a `/api/recall`-on nem nevez meg ágenst, a saját soraihoz és a megosztott szinthez fér hozzá (SQL-ben szűrve és számolva), nem a tenant minden ágenséhez. A főágens tokenjével küldött üzenet, amelynek `from` mezője nem a saját ágense, `declared_from` mezős audit-sort ír (a platform-feladók kivételek).

Az a vizsgálat, amelyet nem lehet elvégezni, elutasít. Ahol az enforce-nak döntenie kell (olyan végpont, amelyen elutasít, és olyan hívó, amely ágens és nem a fő ágens), és a döntés meghiúsul, a kérés nem megy át, hanem 500-at kap (`internal_error`, hint "The token identity check could not be completed"), és `identity_refused`-ként számolódik `_undecided` céllal. Számító hibák: az azonosító alapján címzett sor tulajdonosának lekérdezése adatbázis-hibát dob (workspace dokumentum, blackboard sor, ütemezés, memória), hiba a kérés besorolásában, és olyan írás törzse, amely nem olvasható, és amelyen az enforce elutasít. A nem létező sor nem hiba (a route 404-et ad), és az sem, ha a hiba olyan végponton vagy olyan hívónál történik, amelyet az enforce soha nem utasít el (kanban, a fő ágens, workspace dokumentum olvasása). A vizsgálat melletti számlálás (a tenant-kontextus számlálók) nem rántja magával a vizsgálatot.

#### Go-live kapu: használja-e még valaki a közös tokent?

A `python3 scripts/token-shadow-gate.py --window-start <ÉÉÉÉ-HH-NN>` egy mérési ablakon olvassa a shadow-számlálót, és PASS (0), FAIL (1) vagy INCONCLUSIVE (2) választ ad. A közös token rotálása PASS-ra vár. Az ablak az utolsó, hívási utat érintő deploy utáni első 00:00 UTC-kor indul (maga a deploy-nap a deploy előtti és utáni hívásokat keveri), és 7 teljes UTC napot plusz a mai napot kéri.

- **FAIL**: bármely hívó közös-token használata (kivétel csak a kapu saját canary hívása: a főágensnek és a dashboard saját oldalának már saját tokenje van, ezért a korábbi kivételeik megszűntek), vagy bármilyen `agent_id_mismatch`, `foreign_row_access`, `missing_tenant_context`, `shared_agent_memories_no_tenant` sor. A jelentés kilistázza a sorokat és az utolsó találatot; az ablak utána újraindul. Minden hívási utat módosító deploy újraindítja az órát.
- **INCONCLUSIVE** (soha nem PASS): az ablak túl rövid; egy legfeljebb heti ütemezés nem futott az ablakban; egy havi vagy ritkább ütemezésnek nincs kézi futása az ablakban vagy tiszta recept-dry-runja (`--manual-run NÉV`, `--dry-run-clean NÉV` igazolja); a dashboard üzemideje nincs megerősítve (`--uptime-confirmed`: egyetlen ablak-napon sem állhatott több mint 24 órát); a canary nem mozdította a számlálót; egy lekérdezés elérte a sorlimitet, vagy a számláló `_overflow` / `_invalid` sort tartalmaz. A nulla csak akkor számít, ha a számláló bizonyítottan él: a kapu egy közös-token hívást tesz `gate-canary` néven, és a számnak nőnie kell.
- Jelentett, de soha nem blokkoló: `fleet_skill_write_denied`, `foreign_row_read`, `identity_refused`, `channel_credential_drift` (egy csatornafájl eltér az elfogadott alapállapottól: nem identitás-hívás, van saját riasztása, azért listázva, hogy ne némuljon el), `unscoped_read` és `shared_token_refused` (a rotálás után: melyik folyamat kopog még a régi tokennel, a 7 napos utóellenőrzéshez).
- A kapu az operátor saját tokenjével olvas, és megtagadja az olvasást a közös tokenen át (az olvasásai abba a számlálóba esnének, amit épp elbírál). Az `.env`-ben a `TOKEN_SHADOW_WINDOW_START=ÉÉÉÉ-HH-NN` beállítással a `doctor.sh` tájékoztató sorban kiírja a kapu állapotát.

### Ágens indítása és leállítása

Az ágenseket a dashboard kezeli automatikusan. Kézzel:

```bash
# Indítás
bash scripts/agent-api.sh --token operator POST /api/agents/<name>/start

# Leállítás
bash scripts/agent-api.sh --token operator POST /api/agents/<name>/stop
```

Vagy közvetlenül a tmux session-t is kezelheted:

```bash
tmux attach -t agent-<name>     # rácsatlakozás
tmux kill-session -t agent-<name>  # leállítás
```

### Fleet blackboard

A flotta-ágensek a `fleet_blackboard` táblában jelzik egymásnak az aktuális állapotukat. A blackboard lekérdezhető az API-n:

```bash
bash scripts/agent-api.sh GET /api/blackboard
```

Egy ágens munka közben frissíti a saját sorát (`status: active/done/blocked`), így a többi ágens és a dashboard látja, ki mivel foglalkozik.

**A sor életciklusa és az elavulás-jelzés.** Ágensenként egy sor van. Hogy ki írja, a munka fajtájától függ:

- Ütemezett feladat vagy heartbeat: az ütemező (schedule runner) írja az `active` sort (summary = a feladat neve) a prompt beküldése előtt, és a `done`-t, amikor a session újra üresjáratba kerül; az ágensnek nem kell. Ha az ágens közben átírta a sort (saját summary, `blocked`), a runner visszalép, és az ágens zárja le maga.
- Interaktív munka (3 vagy több tool-hívás): az ágens a végén `done`-ra vagy `blocked`-re állítja a sort, az elején `active`-ra. Az újraindítás vagy egy friss session soha nem zár le sort (a sor megmarad az adatbázisban, a munka lehet, hogy nem kész), ezért a kontextus-őr HANDOFF-ja ezt kimondja az `Aktualis feladat` alatt, amikor az ágens saját sora `active` vagy `stale`.

Az elavulás-figyelő (5 percenként) `stale`-re állítja az `active` sort, ha az ágens tier-jének küszöbénél régebben nem frissült (`BB_STALE_ORCHESTRATOR_MIN` 120, `BB_STALE_INTERACTIVE_MIN` 90, `BB_STALE_SHORT_RUNNING_MIN` 30, `BB_STALE_DEFAULT_MIN` 60; az `assigned` sor a `BB_STALE_ASSIGNED_MIN`-t használja, 120). A Beállítások képernyőn vagy az `.env`-ben állítható, az érték perc. Két szabály védi az élő munkát:

- Az az ágens, akinek az ütemezett futása még követés alatt van, kimarad (az `active` sora a runneré). A tényleg beragadt futást a feladat-időtúllépés riasztás fogja meg.
- Ha egy `stale` sor még a runner sajátja (azonos summary és feladat-hivatkozás), a runner a futás végén akkor is `done`-t ír. Az ágens által átírt `stale` sorhoz nem nyúl.

A hygiene-monitor (`scripts/blackboard-hygiene.py`, óránkénti parancs-feladat) a biztonsági háló mindkettő mögött: figyelmezteti azt az ágenst, amelyik dolgozik, de nem tartja naprakészen a sorát, azt az üresjáratos ágenst, amelynek `blocked` sora több mint 1 órás, és azt az üresjáratos ágenst, amelynek `active`/`stale` sora több mint 30 perces (hogy zárja le). A figyelmeztetést visszatartja a koordinátor karbantartó köre vagy egy friss figyelmeztetés, két egymás utáni kör a koordinátorhoz eszkalál, és magát a koordinátort sosem figyelmezteti.

### Inter-agent kommunikáció

Az ágensek az `agent_messages` tábla üzenetsoron keresztül kommunikálnak:

```bash
bash scripts/agent-api.sh POST /api/messages '{"from":"kuldo-agent","to":"cimzett-agent","content":"Feladat leírása"}'
```

Az üzenet a cél-ágens tmux session-jébe kerül injektálásra; az ágens feldolgozza és a saját csatornáján válaszol.

A végrehajtó a `PUT /api/messages/<id>` hívással zárja le a kiosztott üzenetet (`status`: `done`, `failed` vagy `refused`, opcionális `result`). A delegáló ezután egy `[Eredmény]` kezdetű teljesítési értesítőt kap; ez az értesítő az eredeti üzenet tenantjába kerül, így a tenant-hatókörű delegáló látja a saját kérésének az eredményét. Egy ágens saját tokenje csak az ahhoz az ágenshez címzett üzeneteket zárhatja le (idegen üzenet 403, másik tenanté 404); az admin tokenek bármelyiket. Az üzenet egyszer zárul: egy már `done` vagy `failed` üzenet újabb `PUT`-ja `409` `status_conflict` és `current_status` mezővel, nem változtat semmit és nem küld második értesítőt. Ez nem hiba, amit ismételni vagy jelenteni kell; az első lezárás érvényes (a hint is ezt mondja). Kártya státuszát a `POST /api/kanban/<id>/move` hívással változtasd (`status`, `actor` a body-ban; az opcionális `expected_status` csak akkor mozgatja a kártyát, ha még abban a státuszban van, különben `409` `status_conflict` a `current_status`-szal és semmi sem íródik; az ismeretlen body-kulcs `400`), ez az assignee-t is felébreszti és a szülő kártyát is frissíti; a `PUT /api/kanban/<id>` a többi mezőre való (cím, leírás, prioritás, assignee, projekt), és egyiket sem teszi. Az ébresztő üzenet nem hordoz kártyaszöveget: megnevezi a kártyát (azonosító, felelős, prioritás) és az olvasó parancsot, a `GET /api/kanban/<id>` hívást az ágens saját tokenjével (a nem-admin hívó csak a saját tenantja kártyáját olvassa, idegen azonosító 404). A kártya szövege a szerzőjéé, ezért az ágens adatként kezeli, nem utasításként; az a kártya, amelynek az azonosítója nem sima token (betű, számjegy, `.`, `_`, `-`, legfeljebb 80), senkit nem ébreszt.

Tenant-szabály erre a végpontra: nem-admin hívó csak a saját tenantjának üzenetét módosíthatja (a tenant nélküli üzenet `default`-nak számít). Másik tenant üzenete pontosan úgy válaszol, mint egy nem létező azonosító (`404 not_found`), így az üzenet-azonosítók tenantok között nem tapogathatók végig; az elutasított kísérlet bekerül az audit-naplóba. Az admin hívót nem korlátozza.

---

## Tenant-kezelés (RBAC)

A Marveen többfelhasználós működésre is alkalmas: az egyes tenantok adatai (memóriák, kanban, ágensek) egymástól elkülönítve tárolódnak.

> **Megjegyzés:** a tenant-enforcement **él** (`RBAC_MODE=enforce`): a kapu elutasítja, amit a szerepkör nem engedélyez, az `enforce` beállítás nélkül is az alapértelmezés, a shadow mód csak név szerint választott visszaállítási állapot. A megfigyelés, a visszaállítás és a kapuhoz nyúlás szabályai: "RBAC-mód, shadow-napló és visszaállítás" lent.

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
bash scripts/agent-api.sh --token operator POST /api/v1/admin/tokens '{
    "name": "partner-token",
    "role": "agent",
    "tenant_id": "acme-corp",
    "expires_at": "2027-01-01T00:00:00Z"
  }'
```

```bash
# Token visszavonása
bash scripts/agent-api.sh --token operator PATCH /api/v1/admin/tokens/<id> '{"revoked": true}'
```

### B2B partner beléptetése

Egy külső partner (B2B tenant) alapvetően az `agent` szerepkörrel kap tokent, és a saját `tenant_id`-jére szűrt adatokat lát. A beléptetési folyamat:

1. Tenant felvétele az admin felületen (Beállítások > Tenantok)
2. `agent` token generálása a partner számára (lejárattal, `expires_at`)
3. A tokent biztonságos csatornán kell átadni (nem emailben nyílt szövegként)
4. Izolációs teszt: az új tokennel egy `default` tenant memória lekérdezésének üres listát kell adnia
5. Rotációs folyamat egyeztetése: új token igénylése lejárat előtt legalább 2 héttel

### RBAC-mód, shadow-napló és visszaállítás

**A mód.** Az `RBAC_MODE` (`src/config.ts`) induláskor olvasódik be a folyamat környezetéből vagy az `.env`-ből; az alapértelmezett az `enforce`, a `shadow`-t névvel kell kérni: `RBAC_MODE=shadow`; minden más (elírás, üres érték) `enforce`. Módváltás után a dashboard újraindítása kell. Rollback: `RBAC_MODE=shadow` és újraindítás. A kapu (`applyRbacGate`, `src/web/authz.ts`) a jogosultsági táblát (`ENDPOINT_PERMISSION_TABLE`, `src/web/rbac.ts`) kérdezi le; a táblában nem szereplő útvonal `admin:all`. Enforce módban elutasít, shadow módban átenged és `would-deny` sort ír.

**A napló.** A 0068-as migráció `rbac_shadow_log` táblája tartósan rögzíti a kapu döntéseit mindkét módban (idő, tenant, hívó fajtája és címkéje, szerepkör, metódus, útvonal, a megkövetelt jog, döntés, indok). A döntés `would-deny` (shadow átengedte, enforce elutasítaná), `denied` (enforce elutasította) vagy `permitted` (nem admin kérés átment; az admin forgalmat nem rögzíti). Az író legfeljebb óránként törli a 30 napnál régebbi sorokat, a tenant törlése a tenant sorait; a sikertelen beszúrás naplózódik, és soha nem változtatja meg a kapu döntését, nem bukik el miatta a kérés. Olvasás: `GET /api/v1/rbac/shadow-log` (admin-only, az útvonal is ellenőrzi a szerepkört, és az `/api/rbac/` sor is explicit `admin:all`), szűrők: `decision`, `tenant`, `principal`, `role`, `permission`, `route` (részlet), `from`/`to`/`since_hours`, `limit`, `offset`; `summary=1` döntésenkénti számokat és a leggyakoribb elutasítási alakokat ad.

**A figyelő.** A `rbac-shadow-monitor` `type: command` ütemezett feladat (`30 7 * * *`, `scripts/rbac-shadow-summary.py`, LLM nélkül) az elmúlt 24 órát kérdezi le `summary=1`-gyel. Kilépési kód: `0` ha nincs `would-deny` és `denied` sor, `42` (a command-task lelet kódja) ha van (lehetséges hamis pozitív, a stderr első sora a riasztás szövege), `2` ha az összesítés nem olvasható. Mindkét nem nulla kód riaszt a command-task health-en; a lelet nem hibás span és nem számít bele a hibasorozatba, a `2` viszont valódi hiba (`failThreshold` 1). A riasztás a lelet vagy hiba elején és egy tiszta nap után szól, nem minden reggel. Üres ablakot a stdout jelez ("nincs bizonyíték"), az nem tiszta nap. Enforce módban a `denied` sor lehet jogos elutasítás is, ezért a találatot át kell nézni, nem automatikusan hiba.

**A nem admin nézet.** Az `/api/marveen` és az `/api/settings` minden szerepkörnek olvasható (`memories:read`), de a nem admin (és a feloldott szerepkör nélküli) hívó engedélyezőlistás nézetet kap (`src/web/non-admin-views.ts`): az `/api/marveen`-ből `name`, `brandName`, `agentId`, `role`, `channelProvider` és a kanban megjelenítési beállítások, az `/api/settings`-ből csak a `DASHBOARD_LANG` (`key`, `type`, `value`, `default`); a szűrő az értékek feloldása előtt fut, így titkos vagy nem listázott beállítás sosem oldódik fel. **Szabály:** egy később hozzáadott mező alapból admin-only marad, amíg valaki fel nem veszi az engedélyezőlistára. Az ágens-olvasók (`/api/agents`, `/api/team/graph`, az utóbbi `agents:read`) a hívó tenantjának ágenseire szűrnek, az ágens-export (`export-all`, `<név>/export`) admin-only, a route maga is ellenőrzi.

**A dashboard kapuzása.** A menüpontok és fülek `data-rbac-perm` attribútumot kapnak az `index.html`-ben, és egyetlen router-őr (`web/modules/nav-gate.js`, a `can()`/`roleHas()` a `rbac-client.js`-ből) irányít át az áttekintőre. Szerepkör nélküli hívó (régi bearer token) mindent lát, az őr sosem old fel olyat, amit más kód elrejt. Csak UX-réteg, a szerver 403-a dönt. Új admin-only oldalnál vegyél fel `data-rbac-perm`-et; a kliens szerepkör-tükör drift-tesztje (`rbac-client` vs `rbac.ts`) bukik, ha egy jog hiányzik belőle.

**Elfogadott kockázatok.** (1) A flotta tokenje admin, a futó ágensek nem tenant-korlátosak; a tenant-határ a tenant-felhasználók saját tokenjére és belépésére vonatkozik. (2) A főágens szándékosan kívül van a tenant-skill kapun (a fail-closed hook leállíthatná a flotta koordinációját), a többi ágensnél a hook él. (3) Nincs Marveen által üzemeltetett MCP-szerver, ezért nincs MCP-szintű tenant-szűrés; ha valaha lesz, a tenant-szűrés kötelező (lásd F06). (4) A megosztott ágens API-n át a flotta tokenjével más tenant skill-soraihoz is hozzáfér; a használati kapu a `Skill` eszközt és a fájlhozzáférést fedi, a shellből induló `curl`-t nem (lásd F02).

### Ütemezett feladatok és tenantok

Az ütemezett feladatoknak tenant a tulajdonosa (`schedules.tenant_id`, sosem üres; lásd lejjebb az "Ütemezett feladatok tenant-tulajdonlása" szakaszt). A hozzáférési modellre ez azt jelenti:

- A nem-admin hívó csak a saját tenantja feladatait, a választható ágenseket (`GET /api/v1/schedules/agents`) és a függő újrapróbálkozásokat kapja; másik tenant feladata `404 not_found` választ ad, mint egy nem létező név.
- Két jogosultság fedi a csoportot: a `schedules:read` (admin, agent, read_only, viewer) és a `schedules:write` (admin, agent). Minden tenant-felhasználó automatikusan megkapja a `schedules:write` jogot az `agent` szerepkörön át; tenantonkénti kapcsoló és új szerepkör nincs. Az `ENDPOINT_PERMISSION_TABLE` sorai (az útvonalak már normalizálva, `/api/v1`-ről `/api`-ra alakítva érnek a táblához, ezért `/api/v1/schedules` sor nincs):

| Kérés | Szükséges jog | Hol |
|-------|---------------|-----|
| `GET /api/schedules/tick-status` | `admin:all` | pontos sor, a GET prefix-sor előtt, hogy a prefix ne fedje |
| `GET /api/schedules` (prefix: lista, `agents`, `pending`, `<name>/runs`) | `schedules:read` | prefix-sor |
| `POST /api/schedules/<name>/activate` | `admin:all` | regex-tábla; a prefix-tábla előtt kérdezi le a rendszer, így a POST prefix-sor nem fedheti az aktiválást |
| `POST /api/schedules` (prefix: létrehozás, toggle, run, `expand-questions`, `expand-prompt`) | `schedules:write` | prefix-sor |
| `PUT /api/schedules` (prefix) | `schedules:write` | prefix-sor |
| `DELETE /api/schedules` (prefix: egy feladat, `pending/<id>`) | `schedules:write` | prefix-sor |

- **Sorrend és útvonal-szabályok.** Két sorrendi szabály érvényes, ha a csoporthoz nyúlsz: a `tick-status` sor a GET prefix-sor előtt marad, az aktiválás sora pedig a regex-táblában (azt kérdezi le a rendszer először); egy új, admin-only ütemezés-útvonalat a metódusa prefix-sora előtt kell illeszteni. Az `RBAC_MODE`-tól **függetlenül** érvényes útvonal-szabályok a `src/web/routes/schedules.ts`-ben vannak (`nonAdminRefusal`, minden `/api/schedules*` útvonalon, bármely más ellenőrzés előtt fut), és azokra a hívókra vonatkoznak, akiknek a szerepköre nem `admin`: a tenant nélküli fiók minden kérésre 403-at kap, az olvasást is beleértve; az íráshoz `auth.kind` `session` vagy `token` kell (az eszközkulcs és a föderációs principal 403-at kap); a `default` tenanton végzett írás 403-at ad. A megosztott dashboard-token és a bejelentkezett admin `admin` szerepkört hordoz, ezért kivétel a függvény alól; hogy mit írhatnak, azt az alábbi jóváhagyási kapu dönti el. A jogosultsági sorok ezzel szemben csak `enforce` módban döntenek valamit (ez az élő mód): ott a szerepkörök közti különbségek (például a `read_only` és a `viewer` írása) elutasításként jelennek meg. Visszaállított shadow módban az `applyRbacGate` would-deny bejegyzést naplóz (`rbac:shadow` a naplóban, és egy sor a `rbac_shadow_log` táblában), és átengedi a kérést; amíg így áll a mód, ne adj tenant-felhasználóknak API-t elérő belépést vagy tokent.
- A tenant-szabályok többi része az útvonal-kezelőkben van, és mindkét módban érvényes: más tenantok láthatatlanok (404), az aktiválás bejelentkezett admint kér (403), a szerkesztés `status`, `tenantId` és futtató szkript kulcsai eldobódnak, a nem-admin `agent` kulcsa figyelmen kívül marad, a más `tenant_id`-t megnevező nem-admin 403-at kap, és a nem-admin által létrehozott feladat a saját tenantjában `draft`.
- **Jóváhagyási kapu és újabb jóváhagyás.** A státusz `draft` (még sosem hagyták jóvá), `pending_review` (jóváhagyott, majd egy nem bejelentkezett admin hívó módosította) vagy `live`; az ütemező mindkét nem éles állapotot egyformán visszatartja (lásd "Visszatartott előfordulások"). A `PUT /api/v1/schedules/<name>` bárki által, aki nem bejelentkezett admin (`isHumanAdmin`: `admin` szerepkör és `auth.kind` `session`; a megosztott token hordozza a szerepkört, de nem ember), egy `live` feladatot `pending_review` állapotba tesz, ha megváltoztatja a `prompt`, `command`, `type`, `schedule`, `agent`, `targetSession`, `timeoutMs`, `failThreshold`, `skipIfBusy` vagy `forceSend` mezők valamelyikét. A `description` és az `enabled` sosem váltja ki. Az összehasonlítás mezőnként történik, az írás pillanatában tárolt sorral szemben (`reviewTriggerFields`, `src/web/schedule-review.ts`): a sztringek trimmelve vannak, az üres sztring, a null és a hiányzó érték ugyanaz, a `false` a két logikai opciónál a beállítatlannal egyenlő, a számok és a sztringek típus szerint térnek el. A tárolt értékek újraküldése (a dashboard minden mentéskor ezt teszi) ezért műveletmentes: a feladat `live` marad, és a válasz sima `{ ok: true }`. A nem éles feladat szerkesztéskor megtartja a státuszát, az admin tenant-áthelyezése sima `draft` marad, és nem megy át ezen a szabályon; a szabály az útvonalban és a tiszta segédfüggvényben él, nem a `writeScheduledTask`-ban, mert a seed, a flotta-import és a toggle fájl-tükre közvetlenül azt az írót hívja. Az írás előbb megtörténik; a kiváltó szerkesztés válasza `{ ok: true, status: "pending_review", review_required: true, changed: [mező, ...] }`.
- **Aktiválási protokoll.** A `GET /api/v1/schedules` minden feladathoz hozzáadja a `contentHash` mezőt: a jóváhagyott mezők (`REVIEWED_FIELDS`: prompt, schedule, agent, type, skipIfBusy, forceSend, targetSession, command, timeoutMs, failThreshold) rögzített sorrendű, normalizált alakjának SHA-256 lenyomata, így a leírás vagy az engedélyezett állapot változása nem mozdítja. A `POST /api/v1/schedules/<name>/activate?expected_hash=<contentHash>` összeveti a jelenlegi lenyomattal, és eltérésnél `409 stale_revision` választ ad, a törzsben a `content_hash` mezővel (a jelenlegi érték); semmi sem aktiválódik, a dashboard pedig újratölti a listát, hogy az admin az aktuális tartalmat nézze meg, majd azt aktiválja. A paraméter opcionális: a képernyő nélküli hívó (szkript, a `dashboard-schedule-crud` recept) elhagyja, és az aktiválás ellenőrzés nélkül megy. Az útvonal mindkét esetben bejelentkezett admint kér (egyébként 403). A `stale_revision` hibatoken szerepel a katalógusban (`src/api-error-catalog.ts`, 409-hez engedélyezett), az OpenAPI enumban és mindkét dashboard-nyelven.
- **Piszkozat-korlát.** Egy tenantnak legfeljebb 20 nem éles ütemezése lehet (draft vagy `pending_review`), ez az útvonalban a `MAX_OPEN_REVIEW_PER_TENANT`. A 21. piszkozat létrehozása `400 limit_exceeded` választ ad (mező: `name`, a hintben a darabszámmal), és semmit sem ír. Az éles feladatok nem számítanak, a törlés helyet szabadít fel, a tenant már meglévő feladatának szerkesztését sosem akadályozza, a bejelentkezett admin által létrehozott `live` feladat mentes; a megosztott tokenes ágens által egy tenantnak létrehozott piszkozat beleszámít. Ki hozhat létre: bárki, akit az útvonal-szabályok átengednek, `draft` feladatot hoz létre; `live` feladatot csak a bejelentkezett admin.
- **Audit és értesítés.** Minden ütemezés-írás egy `agent_audit_log` sort ír (entitás: `schedule`; akció: `create`, `update`, `delete`, `toggle`, `activate`, `review_requested` vagy `retarget`, utóbbi a tenant alapcsomagjának újracélozása; az entitás azonosítója a feladat neve). A részletben ott a tenant, az `actor_kind` (`session`, `token`, `device`, `other`), az önbevallott `X-Agent-Id` külön `claimed_agent` néven (nem hitelesítés), szerkesztésnél pedig a megváltozott mezők neve előtte-utána SHA-256 lenyomattal és az új érték rövid (200 karakteres) előnézetével, soha nem a teljes értékkel. Az `agent_id` a munkamenet felhasználója, scoped tokennél `token:<név>`, fejléces megosztott tokennél `claimed:<id>`. Az elutasított írás (másik tenant feladata, 403) nem hagy sort. A jóváhagyásra visszaküldött feladat, és a nem admin által létrehozott piszkozat is rendszerüzenetet küld a főágensnek (`createAgentMessage('system', MAIN_AGENT_ID, ...)`) ilyen alakban: `[SCHEDULE_REVIEW] task=<név> tenant=<id> reason=edited|created|retargeted [changed=[...]] by=<végrehajtó>`. A `retargeted` ok csak az alapcsomag újracélozásánál fordul elő, és csak akkor, ha a kiváltó nem bejelentkezett admin (lásd "Tenant alapcsomag"). Feladatonként és okonként óránként legfeljebb egy üzenet megy, a visszatartás a memóriában él (újraindítás után egy többlet-üzenet mehet), az audit vagy az értesítés hibája sosem buktatja el az írást (best effort). Hogy a főágens mit kezd vele, a saját utasításain múlik.
- **Dashboard.** A Feladatok oldal a `can('schedules:write')` jogra kapuz: a **+ Feladat** gombra, a szerkesztő ablak mentésére, valamint a Futtatás most, Szüneteltetés és Törlés műveletre. Az aktiválás és az ütemező-szívverés jelző a `can('admin:all')` jogra kapuz. A visszatartott feladaton a `tasks.status.pending_review` jelvény látszik ("jóváhagyásra vár" / "awaiting review"), a `review_required` választ adó mentés után pedig a `tasks.toast.review_required` üzenet. Az Aktiválás kérés viszi az `expected_hash`-t. A Felhasználók fül szerepkör-jogosultság mátrixa és a képernyő-hozzáférési mátrixa felsorolja a két jogot, a Feladatok képernyő sora pedig követi őket.
- **Új jogosultság felvétele.** A jogosultságok egyetlen tuple-ben vannak, `ALL_PERMISSIONS` a `src/web/rbac.ts`-ben, és a `Permission` típus ebből származik. A dashboard kézzel írt tükröket tart, amelyek nem importálhatják: `web/modules/rbac-client.js` (a `can()` szerepkör-térképe), `web/modules/rbac-permission-matrix-data.js` és `web/modules/rbac-screen-access-data.js`, valamint az i18n-címkék (`admin.b2b.perm.<erőforrás>.<akció>.label` / `.desc` és a kategória-címke, a `hu.js`-ben és az `en.js`-ben egyaránt). A `src/__tests__/rbac-permission-matrix-data.test.ts` az `ALL_PERMISSIONS`-t veti össze a mátrix-tükörrel, és elbukik a sor nélküli jogosultságon, az `rbac-screen-access-data.test.ts` pedig azt ellenőrzi, hogy a Feladatok képernyő sora követi a `schedules:read` és `schedules:write` jogot. Az `rbac-client.js` szerepkör-térképét (`ROLE_PERMISSIONS`, a teszt kedvéért exportálva) az `rbac-client-mirror.test.ts` veti össze az `rbac.ts`-sel szerepkörönként, így egy lemaradt jogosultság ott bukik el; a térképet ettől még az `rbac.ts`-sel együtt módosítsd.

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
| `memory-maintenance` | `15 3 * * *` | Napi memória-karbantartás (tier-átsorolás, verziók prune-olása, link-gráf karbantartás), LLM nélküli command feladat, a `scripts/memory-maintenance.sh`-t futtatja: egy sikertelen hívás, vagy ha a link-karbantartás a memóriák többségénél elbukik, hibás futás; az összekötni nem tudott memóriák lelet (42-es kilépési kód) |
| `daily-log-summary` | `30 22 * * *` | Esti napi napló összefoglaló, LLM nélküli command feladat, a `scripts/daily-log-summary.py`-t futtatja a fő agent nevében. Telepítésenként egyszer seedeli az `ensureDailyLogSummaryTask` (`src/web/daily-log-summary-task.ts`, marker: `store/daily-log-summary.seeded`, mint a `claude-update`): a meglévő telepítés is megkapja, a törölt feladatot nem hozza vissza, a módosított sort nem írja felül. `catch_up_max_age_minutes` 85 (az elmaradt futás csak 23:55-ig pótlódik, mert a bejegyzés arra a napra kerül, amelyen fut), `fail_threshold` 2. A script csak az API-t olvassa (`--token main`): a `default` tenant aznapi memóriáit (`limit=200`, agensenként számolva, csak kulcsszavakkal), kanban kártyáit és munkadokumentumait, plusz a saját checkoutja first-parent merge commitjait (a `DAILY_LOG_SUMMARY_GIT=0` kikapcsolja), és egyetlen `## Napi összefoglaló ÉÉÉÉ-HH-NN` bejegyzést POST-ol a `/api/daily-log`-ra. A memória szövege sosem kerül idézésre (a tulajdonos döntése: szabad, privát szöveg, és semmilyen szűrő nem garancia); csak a kulcsszavai, a leggyakoribb 8, kisbetűsítve, mindegyik a szűrőn át, és kimaradnak, ha titkot vagy e-mail címet, 4-nél több számjegyet tartalmaznak, vagy 40 karakternél hosszabbak. Minden más idézett szöveg (kártya- és dokumentumcímek, merge-tárgyak) először a `scrub()`-on megy át, a teljes szövegen és a 90 karakteres vágás előtt: a `src/otel-scrub.ts` kulcsalakzatainak (`KEY_SCRUBS`, `SCRUBS`, `BLOB_SCRUB` és a `TEXT_SCRUBS` e-mail szabálya; az útvonal- és id-szabályai kimaradnak) Python-portja, plusz a PEM blokkok és a magyar `jelszó` / `titok` / `kulcs` értékadások. Az eredetivel szemben a hosszú blob-szabály egész futásokon dolgozik (`[A-Za-z0-9+/_-]{32,}`, egy lineáris menet), és békén hagy egy futást, ha az azonosító: vannak benne elválasztók (`-` `_` `/`; a `+` csak base64-ben fordul elő, és a darabon belül marad), minden köztes darab kisbetűs, betű és számjegy, legfeljebb 16 karakter, és legalább egy darabban van a-f-en kívüli betű, így a kötőjellel vagy aláhúzással összefűzött hex-töredékeket nem veszi névnek (`report/<id>-workspace-search-delta-qa`, `hot_1017_phase0_prep`). A kanonikus UUID az egyetlen kivétel, az olvasható marad. A hosszú vagy vegyes kis-nagybetűs darabot tartalmazó futás (`sk_test_51Hx...`, base64url token, hex digest, `secret_<28 hex>`) csillagra cserélődik; a Stripe-szerű kulcsoknak külön szabályuk is van. Minden szöveg a szűrés előtt 4000 karakterre vágódik (a szabályok, az eredetihez hasonlóan, egyetlen nagyon hosszú futáson négyzetesek), és a vágott szöveg utolsó 200 karaktere eldobódik, így a vágás által kettévágott titok nem kerülhet a 90 karakteres részletbe. A két szűrőt együtt kell tartani, ha az egyik változik. A tenant-szűrés a scriptben van (`in_default_tenant()`, az admin token minden tenant sorát visszaadja), ezért egy új adatforrást ugyanígy szűrni kell, ahogy a script tetején lévő komment írja. Naponta egyszer ír (ha a nap naplójában már ott a fejléc, 0-s kilépés írás nélkül), az üres napot egy sorral rögzíti, és 1-gyel lép ki, ha egy hívás elbukik. A tesztekben a `DAILY_LOG_SUMMARY_API` váltja ki az API-wrappert |
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

Továbbá elérhető: `POST .../<name>/toggle`, `POST .../<name>/activate[?expected_hash=<contentHash>]` (csak bejelentkezett admin, lásd "Ütemezett feladatok és tenantok"), `POST .../<name>/run`, `GET .../<name>/runs`, `GET /schedules/agents`, `GET /schedules/pending` és `DELETE /schedules/pending/<id>`; mind szerepel a `docs/openapi.yaml`-ban.

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

**Szerkesztés (`PUT`).** A kezelő csak ezeket írja: `description`, `prompt`, `schedule`, `enabled`, `type`, `skipIfBusy`, `forceSend`, `targetSession`, `command`, `timeoutMs`, `failThreshold`. Minden más kulcs eldobódik, különösen a `status` (egy szerkesztés már nem tehet éles feladattá egy vázlatot: az aktiválás a bejelentkezett admin lépése marad), a `tenantId`, és a futtató szkript kulcsai: `preCheck`, `catchUpMaxAgeMinutes`, `stuckAfterMinutes`, `requires`. Az `agent` csak adminnak szól (másoknál figyelmen kívül marad, de a megosztott token admin szerepkörű, így az azon hívó ágens beállíthat egyet), és az eredő párosnak érvényesnek kell lennie. Az a nem bejelentkezett admin hívó, aki egy `live` feladat végrehajtott mezőjét megváltoztatja, a feladatot `pending_review` állapotba is teszi (lásd fent a "Jóváhagyási kapu és újabb jóváhagyás" pontot). A `tenant_id` áthelyezi a feladatot: csak bejelentkezett admin (mindenki másnak `403`, a megosztott tokennek is, ha más tenantot nevez meg), a célnak léteznie kell és engedélyezettnek kell lennie, a páros újra ellenőrzött, a feladat visszakerül `draft` állapotba, a válasz `{ ok: true, tenant_id, status: "draft" }`. Az aktuálissal egyező `tenant_id` nem csinál semmit. A nem-admin csak a saját tenantja feladatait éri el (egyébként `404`), a `PUT`, `DELETE`, toggle, azonnali futtatás és `runs` hívásoknál.

**Olvasás.** A `GET /schedules` minden feladatot `tenantId`-vel ad vissza: az adminok az összeset vagy a `?tenant=` szerintieket, mindenki más a saját tenantját. A `GET /schedules/agents` `{ name, label, avatar }` objektumokat ad: a nem-admin csak a tenantját kiszolgáló ágenseket, az admin az összeset vagy a `?tenant=` szerintieket (a dashboard-ablak ezzel szűkíti a választót). A `GET /schedules/pending` és a `DELETE /schedules/pending/<id>` az újrapróbálkozás feladatának tenantját követi; az a függő újrapróbálkozás, amelynek a feladata már nincs, csak adminnak szól.

**Futtató.** Minden ütemben az az engedélyezett, éles, nem `command` típusú feladat, amelynek a párosa már nem áll fenn, nem tüzel, bármi is az ok (az ágenst kikapcsolták a tenantnál, a tenantot letiltották, a tenant fő ágense megváltozott, az ágenst törölték). Az ellenőrzés egy ütem erejéig páronként memoizált, a sikertelen lekérdezés érvényesnek számít, így egy adatbázis-hiba sosem állítja le a feladatokat. Minden esedékes előfordulás `skipped_tenant_mismatch` állapottal kerül a `task_runs` táblába, ugyanabban a kihagyási főkönyvben, mint a `skipped_not_live` (lásd "Visszatartott előfordulások"). Hibánként egy értesítés megy ki: egy hiba-naplósor, egy audit sor (ágens: `scheduler`, entitás: `schedule`, művelet: `skip_tenant_mismatch`, entitás-azonosító a feladat neve, részlet a tenant és az ágens) és egy Telegram-üzenet a tulajdonosi chatre, ha be van állítva (a szöveg jelenleg mindig magyar). A jelző memóriában él: a páros újra érvényessé válásakor törlődik, és egy hibán belüli újraindítás újra értesít. A `command` feladatok nem futtatnak ágenst, ezért nincsenek ellenőrizve.

**A hook-kapcsolat.** A `scripts/hooks/tenant_context_lib.py` a `<scheduled-task source="scheduled-task:NAME">` promptot a `SELECT tenant_id FROM schedules WHERE id = ? AND agent = ?` lekérdezéssel oldja fel: a hiányzó vagy `default` érték az alapértelmezett tenant, más azonosító akkor `bound`, ha az ágens kiszolgálja, különben `unknown` (a skill-kapu ilyenkor megtagadja a tenant skilljeit), a más ágenst nevező (vagy `all`) sor pedig `unknown`. Vagyis a `tenant_id` beállítása elég egy ütemezett futás tenant-skill izolációjához, a fenti páros-szabály pedig érvényesen tartja ezt a kötést. A főágensnek nincs tenant-hookja, ezért nem lehet neki nem-default tenant feladatát adni. Lásd F03, "Tenant skill gate".

**A szélek.**
- A tenant törlése (`DELETE /api/v1/admin/tenants/<id>`; a `default` nem törölhető) eltávolítja a feladatait, azok `pending_task_retries` sorait és fájl-tükrüket (`~/.claude/scheduled-tasks/<name>`, amelyet egy üres-tábla újraseedelés különben visszahozna); az `admin.tenant.delete` audit sor tartalmazza a `schedules_deleted` és `schedule_mirrors_removed` értéket.
- A tenant törlése a feladatokon túl a tenant többi kulcsolt sorát is viszi (költségkeretek, egress engedélyezőlista, ötletek, vault-kötések, import-források és auditnaplójuk, nyers token-használat, blackboard-előzmények); az ágens-kulcsolt sorok (`agent_settings`, `agent_state`, `fleet_blackboard`) csak a tenant kizárólagos ágenseitől törlődnek, a megosztott ágens sora `default` címkét kap. A válasz `purged` és `exclusive_agents` mezői és az audit bejegyzés ezt mutatják; részletek: [F04](F04-architektura.md).
- A flotta-import a `default`-ba teszi azt az ütemezést, amelynek exportált `tenant_id`-ja nem engedélyezett tenant ezen a gépen (a tenantok gépenként helyiek). Az ütemezések továbbra is letiltva érkeznek, a próbafuttatás és az alkalmazási jelentés megszámolja, hányat tettek át.
- Az Áttekintés `tasksToday` értéke tenant-nézetben a tenant ütemezéseinek `task_runs` sorait számolja (feladatnév alapján), nem a tenant ágenseinek futásait, így a több tenant által megosztott ágens már nem tűnik el minden tenant-nézetből. Az a futás, amelynek az ütemezése azóta törlődött, nem tartozik tenanthoz, és csak a flottaszintű számban látszik.
- A `tenant_required` API hibatoken (`400`), dashboard-üzenettel.

### Tenant alapcsomag

Egy tenant alapcsomagja jelenleg egyetlen kész ütemezett feladat, a napi összefoglaló: `<tenant>-starter-daily-summary` (a tenant azonosítója `sanitizeScheduleName`-en átfuttatva, plusz a `-starter-daily-summary` végződés). A kód a `src/web/tenant-starter-pack.ts`-ben van, a sablon a `templates/tenant-starter-pack/daily-summary/` alatt (`SKILL.md` és `task-config.json`), az útvonalak a `src/web/routes/admin-b2b.ts`-ben. Heartbeat-feladatot a csomag nem tartalmaz: a flotta memória-heartbeat sweepjét ez nem érinti, a kettő nem fedi át egymást.

**Automatikus létrehozás új tenantnál.** A `POST /api/admin/tenants` megjelöli az új tenantot, hogy jár neki alapcsomag-feladat (`markStarterPackPending`: üres fájl a `store/starter-pack-pending/<tenant>` helyen), és azonnal megpróbálja létrehozni (`autoCreateStarterPack`, ami a `createStarterPack`-et hívja, tehát ugyanaz a piszkozat + letiltott sor, ugyanazokkal az ágens-szabályokkal). Az új tenantnak még nincs ágense, ezért ez rendszerint `ambiguous` miatt elutasítódik; a jelölés ilyenkor megmarad, és a `PUT /api/admin/agent-availability` a reconcile után újra próbálja. A jelölés akkor törlődik, amikor a feladat létezik (vagy a nevét másik tenant feladata foglalja, amin a várakozás nem segít), így az admin által törölt feladat nem jön vissza. A jelölés nélküli tenanthoz, vagyis minden ez előtt a kiadás előtt létrehozotthoz, ez nem nyúl: azoknak a gomb (`POST .../starter-pack`) marad a módja. A csomag szándékosan egy tenant-hatókörű LLM feladat, nem a telepítés-szintű `daily-log-summary` command feladat: az csak a `default` tenantot olvassa, a tenant-feladatnak viszont a tenant ágensének nevében, a tenant saját memóriájából kell futnia.

**Sablon.** Magyar nyelvű, egyetlen fájl, négy helyettesítő: `{{TENANT_ID}}`, `{{AGENT_ID}}`, `{{INSTALL_DIR}}` és `{{WEB_PORT}}` (`renderStarterPrompt`, tiszta függvény). A tenant megjelenítési neve nem kerül a promptba, és a sablon tenant-semleges (a `tenant-starter-pack-template.test.ts` ellenőrzi). Ütemezés `30 21 * * *` (a szerver időzónájában), típus `task`, `skipIfBusy` és `forceSend` hamis. A típus azért `task`, mert a futtató csak a nem-heartbeat típusnál ad kézbesítési utasítást (lásd lent). A feladat egyetlen adatforrása a `GET /api/memories?agent=<ágens>&tenant=<tenant>&limit=50&include_docs=0` elmúlt 24 órás sora; a napi napló az ismétlés elleni védelemre (`## Napi összefoglaló ÉÉÉÉ-HH-NN` fejléc) és az eredmény írására szolgál, adatforrásként nem. A napi napló nem tenant-kulcsú, ezért kell a memória tenant-szűrt lekérdezése.

**Végpontok.** Mindkettő `admin:all` az `/api/admin/` prefixből, mind a régi, mind a `/api/v1` írásmódban. Az útvonal ezen felül maga is ellenőrzi, hogy a hívó szerepköre `admin`: a shadow mód (a visszaállítás állapota) sosem tilt, és egy tenant-felhasználó nem juthat át rajta (a `rbac-starter-pack.test.ts` a jogosultsági sorokat, a `tenant-starter-pack.test.ts` az útvonal-szintű ellenőrzést fedi).

- `GET /api/v1/admin/tenants/<id>/starter-pack` csak olvas: `{ tenant_id, name, exists, state, task, resolution }`. A `state` `absent`, `ok`, `retarget_pending` (a következő újracélozás áthelyezné) vagy `needs_agent`; a `task` `{ agent, status, enabled }` vagy `null`; a `resolution` `{ agent, reason }`, vagyis hogy mely ágenst választaná most a létrehozás, vagy miért nem tud választani.
- `POST /api/v1/admin/tenants/<id>/starter-pack` törzse `{ agent_id? }`; `201`, ha létrehozott feladatot, egyébként `200`: `{ ok, tenant_id, agent, state, created, skipped, retargeted, reason? }`, ahol a `state` `created`, `ok`, `retargeted` vagy `needs_agent`.
- Hibák: `default` tenantra `400 invalid_value` (mező: `id`); ismeretlen vagy letiltott tenantra `404 not_found`; nem adminnak `403 forbidden`; `400 required` (mező: `agent_id`), ha nincs egyértelmű ágens; `400 invalid_value` (mező: `agent_id`), ha a megadott ágens nem szolgálja ki a tenantot; `409 conflict`, ha az ágens más tenantot is kiszolgál, vagy ha ilyen nevű feladat már egy másik tenanté. A teljes alakot a `docs/openapi.yaml` rögzíti.
- Audit: egy `admin.tenant.starter_pack` sor, a feladat írásáról pedig egy szokásos ütemezés-audit sor (`create` vagy `retarget`, `starter_pack: true` jelzővel).

**Az ágens kiválasztása** (`resolveStarterAgent`), az első egyezés nyer: (1) a tenant létezik, nincs letiltva és nem `default`; (2) a megadott `agent_id`; (3) a tenant `main_agent_id`-je, ha ismert ágens és nem a flotta főágense; (4) pontosan egy, a tenantra engedélyezett ágens (a flotta főágense kizárva); (5) egyébként nem egyértelmű (nulla vagy több jelölt). A jelöltnek ki kell szolgálnia a tenantot (ugyanaz a (tenant, ágens) páros szabály, mint az ütemezés útvonalán), és nem lehet megosztott: ha egy másik tenantnál is engedélyezett, vagy egy másik tenant fő ágense, elutasítjuk. A megosztott ágens ugyanis a promptot abban a tenant-kontextusban futtatná, amelyet a munkamenete éppen tart.

**Létrehozás.** A feladat `draft` és letiltott (`enabled=false`) állapotban jön létre, a `writeScheduledTask`-kal közvetlenül, nem az ütemezés POST útvonalán: az admin a hívó, ezért a piszkozat-korlát nem akadályozza, és a `[SCHEDULE_REVIEW]` értesítés nem megy ki. A két lépés (aktiválás, majd engedélyezés) szándékos. A piszkozat és engedélyezett kombináció minden esedékességhez `skipped_not_live` sort írna, és beleszámítana a tömeges kihagyás riasztásba; az éles és letiltott kombinációt pedig a tenant-felhasználó is bekapcsolhatná jóváhagyás nélkül. Az aktiválás csak a státuszt állítja, az `enabled` marad hamis, a feladatot a Folytatás (toggle) engedélyezi, amelyhez `schedules:write` elég.

- **Idempotens.** Ha a névvel már van a tenanthoz tartozó (név és `tenant_id` egyezik) sor, a hívás nem ír újra (`skipped: [{ name, reason: "exists" }]`), hanem a lent leírt újracélozást futtatja. A kézzel módosított prompt, ütemezés vagy `enabled` sosem íródik felül. Az admin által törölt feladatot a hívás újra létrehozza.
- **Névütközés.** A tenant-azonosító megengedi a `--`-t, a `sanitizeScheduleName` viszont összevonja, ezért két tenant azonosítója ugyanarra a névre vezethet. Ha a névvel már egy másik tenant feladata van, a hívás `409`-et ad, és semmit nem ír.
- **Piszkozat-korlát.** Az alapcsomag piszkozata egy helyet foglal a tenant 20 nem éles feladatot engedő korlátjából (`MAX_OPEN_REVIEW_PER_TENANT`) az aktiválásig vagy a törlésig. Külön jelölő oszlop nincs (migráció kellene hozzá), a feladatot a pontos név és a `tenant_id` azonosítja; előtag szerint sosem keres, mert a tenant-felhasználó is létrehozhat `<tenant>-starter-...` nevű feladatot az útvonalon.
- **Tenant törlése.** Külön kód nélkül viszi a feladatot, a függő újrapróbálkozásait és a fájl-tükrét, ahogy bármelyik másik feladatét ("Szélső esetek").

**Újracélozás** (`reconcileStarterPack`). A feladat követi az ágenst, amely mögötte áll. Két kiváltója van: (a) minden `PUT /api/v1/admin/agent-availability` után, a `regenTenantSkillFiles` mellett, try/catch-ben, így egy hiba sosem buktatja el a PUT-ot; (b) a POST ismétlése (a gomb egyben kézi javítás). Nincs horog az ágens törlésénél és átnevezésénél, és a tenant `main_agent_id` oszlopának SQL-ből való cseréjénél sem (a `PATCH /admin/tenants/<id>` nem fogadja a mezőt): ezekben az esetekben az élő és engedélyezett feladatot a futtató leállítja és riasztja (`skipped_tenant_mismatch`), a javítás a POST ismétlése. Soronként a szabály:

- Határozott cél (a tenant fő ágense, vagy az egyetlen engedélyezett ágens), amely eltér a feladat jelenlegi ágensétől: az `agent` cserélődik, és a feladat `draft` és letiltott állapotba kerül. Csak ez a három mező változik, a prompt, az ütemezés és a leírás (az emberi szerkesztésekkel együtt) marad. Audit: `retarget`, `from` és `to` értékkel.
- A cél azonos a jelenlegivel, vagy nincs határozott cél, de a jelenlegi ágens még érvényes (kiszolgálja a tenantot és nem megosztott): semmi nem változik. Egy második ágens engedélyezése tehát nem helyezi át és nem demotálja a feladatot.
- A jelenlegi ágens már érvénytelen, és nincs határozott cél: a feladat `draft` és letiltott állapotba kerül (parkol), az ágens változatlan, az állapot `needs_agent`. A futtató ezt már nem riasztja, mert a letiltott feladat `disabled` osztályú.
- Idempotens: a második futás nem ír, nem auditál és nem értesít. Egy másik tenant azonos nevű sorához és egy `<tenant>-starter-...` nevű felhasználói feladathoz sosem nyúl.

Az újracélozás nem az ütemezés PUT útvonalán megy, ezért az ottani visszaminősítés (élő feladat szerkesztése) nem fut: a `draft` állapotot maga a művelet állítja be. Ha a kiváltó nem bejelentkezett admin (`isHumanAdmin` hamis, például a megosztott tokennel hívó ágens), a főágens egy `[SCHEDULE_REVIEW]` üzenetet kap `reason=retargeted` okkal (a meglévő óránkénti korláttal); a bejelentkezett admin a válaszból és a panelből tudja, neki nem megy üzenet.

**A csatornaüzenet címzettjei (futtató).** A `src/web/schedule-runner.ts` `buildTaskDeliveryPrefix` függvénye a nem-heartbeat feladat promptja elé írja a kézbesítési utasítást. A nem `default` tenant feladatánál a címzettek a `resolveTenantDeliveryChats(ágens, tenant)` eredményei: a (tenant, ágens) páros `tenant_channel_bindings` sorai közül azok, amelyek

- Telegram csatornához tartoznak és számjegyes azonosítójúak (magánbeszélgetés; a csoportos csevegés azonosítója negatív, ezért kimarad), és
- az azonosítójuk az ágens Telegram `access.json` fájljának `allowFrom` listájában is szerepel (így a reply eszköz is kézbesíteni tudja), és
- legfeljebb `MAX_TENANT_DELIVERY_CHATS` (3) darab, a kötések sorrendjében.

Ha nincs ilyen címzett, a prompt nem kap Telegram-utasítást (a naplóba `tenant has no deliverable telegram binding` figyelmeztetés kerül), és a feladat csendben fut. Korábban minden feladat az ágens `access.json` `allowFrom` első bejegyzését kapta, tenant-kontextus nélkül; ez a flotta tulajdonosa is lehetett, vagyis egy tenant feladata rossz embernek küldhette az eredményt. Ez a nem `default` tenantoknál megszűnt, és az alapcsomagon kívül minden tenant-feladatra vonatkozik. A `default` tenant feladata továbbra is az ágens kötött chatjét kapja (`resolveBoundChatId`), a heartbeat továbbra sem kap kézbesítési utasítást. A címzetteket kizárólag az admin API-val (`PUT`/`DELETE /api/v1/admin/channel-bindings`, lásd F03 "Tenant skill-kapu") hozott kötések alakítják, felület nincs hozzá. A csatorna egyelőre csak a Telegram.

**Dashboard.** A **Tenantok** fülön minden nem `default` tenant sorában **Alapcsomag** gomb van (`show-starter`), amely az alatta lévő panelt nyitja: a `GET` állapotát mutatja, ágens-választót csak akkor kínál, ha a szerver nem tud választani, és a gomb a `POST`-ot hívja. A panel az ágens-hozzáférés módosítása után frissül. A gomb és a panel csak globális adminnak jelenik meg (`role === 'admin'` és tenant nélküli hatókör, ugyanaz a feltétel, mint a Tenantok fül többi vezérlőjénél), a nem adminnak a DOM-ban sincs; a feltétel csak megjelenítés, a védelmet az útvonal-ellenőrzés adja. Az új sztringek az `admin.b2b.starter.*` kulcsok a `hu.js`-ben és az `en.js`-ben.

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
- Az állapotot feladatonként a `store/command-task-health.json` tartja (hibasorozat, utolsó státusz, utolsó futás). Telegram-riasztás egyszer megy, amikor a sorozat eléri a `failThreshold`-ot, és helyreállás-üzenet, amikor a feladat újra sikeres. `failThreshold: 1` mellett már az első hiba riaszt. A `42`-es kilépési kód **lelet**, nem hiba: a futás span-je `ok` marad (így nem számít hibának az Áttekintésen), a hibasorozatot nem érinti, a lelet kezdetén egy "lelet" riasztás megy, a helyreállás-üzenet az első tiszta futás után jön. A riasztáshoz be kell állítani a Telegram tokent és a chat azonosítót, különben csak naplózódik.

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

A `POST /api/v1/schedules/<name>/run` azonnal elindít egy feladatot, figyelmen kívül hagyva a cron-egyezést, a catch-up ablakot és a `skipIfBusy`-t. A letiltott feladat `409 disabled`, a vázlat (draft) vagy `pending_review` státuszú `409 not_live` választ ad (bejelentkezett admin a nem éles feladatot is lefuttathatja, hogy az aktiválás előtt megnézze).

- Prompt-feladatok (`task`, `heartbeat`): a prompt a cél-ágens session-jébe kerül, mint egy cron-indításnál. A leállt ágenst elindítja, a foglalt session pedig sorba állított újrapróbálkozást kap. A válasz ágensenként egy eredményt sorol fel, például `<agent>: fired`.
- Command feladatok: a shell parancs közvetlenül fut, ahogy a cron-ciklusban is, és rögzítődik az utolsó futás ideje. A hívás nem várja meg a parancsot, azonnal `command: started (outcome in store/command-task-health.json)` választ ad.

### Visszatartott előfordulások és a tömeges kihagyás riasztása

Egy engedélyezett feladat esedékes előfordulása nem fogyhat el nyom nélkül. Az ütemező minden ütemben négy állapotba sorolja a feladatokat:

| Állapot | Feltétel | Hatás |
|---------|----------|-------|
| futtatható (runnable) | engedélyezett és éles (live) | normál indítás és catch-up |
| letiltott (disabled) | az `enabled` ki van kapcsolva | általában az operátor saját kapcsolója: nincs futás, nincs sor, a catch-up sosem játssza újra |
| nem éles (not live) | engedélyezett, de a jóváhagyási kapu visszatartja (`draft`, vagy `pending_review` egy élő feladat nem admin általi szerkesztése után) | nem fut; az újrapróbálkozási sor is eldobja; minden esedékes előfordulás `skipped_not_live` állapotú sorként kerül a `task_runs` táblába |
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

A `scripts/fleet-heartbeat-sweep.sh [stagger_masodperc]` megkéri minden futó al-ágenst (élőben az `/api/agents`-ből, a főágens kivételével), hogy futtassa a saját memória-heartbeatjét, egyesével, köztük szünettel (alapból 60 másodperc). Napló: `store/fleet-heartbeat-sweep.log`. Úgy tervezték, hogy néhány óránként egy ütemezett feladat indítsa. A tenant alapcsomagja nem tartalmaz heartbeat-feladatot (lásd "Tenant alapcsomag"), így nem fed át a sweeppel.

A sweep egy ütemezett döntésből ágensenként egy modell-fordulót csinál, ezért saját kvóta-őre van. A `store/claude-usage.json`-t olvassa, és az egész sweepet kihagyja, ha a `sessionPct` és a `weeklyPct` nagyobbika eléri a `QUOTA_THRESHOLD`-ot (alapból `75`). Az őr csak **friss** pillanatképnek hisz: ha a `fetchedAt` régebbi, mint a `QUOTA_STALE_MINUTES` (alapból `20`), vagy hiányzik, az őr naplózza az okot és átengedi a sweepet (fail-open). Egy megállt használati érték így nem némíthatja el hetekre a sweepet.

**Csak nem `default` tenantot kiszolgáló ágens kimarad.** Az adminként küldött üzenet tenant-bélyege mindig `default`, így a sweep direktívája egy ilyen ágenshez is `default` kontextusban érkezne, és a memóriák, amelyeket az ágens a heartbeat során ment, a `default` tenantba kerülnének: a flotta látná őket, és a tenant törlése nem vinné el őket. A sweep ezért az `/api/agents` mezőiből dönti el, ki marad ki. Egy futó ágens kimarad, ha

- a `tenantIds` listája (a tenantok, amelyekre engedélyezett) nem üres, és nem tartalmazza a `default`-ot, vagy
- a `primaryTenantId` (annak a tenantnak az azonosítója, amelynek ő a fő ágense) nem `default`.

A megosztott ágens, vagyis amelyik a `default` tenantra is engedélyezett, bent marad, kivéve ha egy másik tenant fő ágense is: a második feltétel ilyenkor is kizárja. A tenantot egyáltalán nem kiszolgáló ágens (üres `tenantIds`, nincs `primaryTenantId`) bent marad. Hiányzó mező (régebbi `/api/agents` válasz) is "nem kihagyott": ilyenkor semmi nem marad ki, a sweep a korábbi módon fut. A főágens továbbra is mindig kimarad, és a kvóta-őr előtte dönt, a tenant-szűrés csak azután számít.

Minden kihagyott, futó ágensről egy sor kerül a `store/fleet-heartbeat-sweep.log`-ba (`-- <ágens> : skipped (serves only non-default tenants)`), és nem számít bele a "triggered" darabszámba. Ha a szűrés után nincs futó ágens, a napló `no running sub-agents found, nothing to do` sora zár.

Mellékhatás: a csak nem `default` tenantot kiszolgáló fő ágensnek (például egy tenant koordinátorának) a sweepből nincs automatikus memória-heartbeatje. A tenant memóriájának karbantartása nála az ágens saját munkamenetén múlik; a tenant alapcsomagja ezt nem pótolja (az napi összefoglalót ír, nem heartbeatet).

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
bash scripts/agent-api.sh --token operator GET /api/federation/key

# Partnergép kulcsának regisztrálása
bash scripts/agent-api.sh --token operator POST /api/federation/enroll '{"bundle": "<base64-bundle-a-partnertol>"}'
```

A kulcscsere mindkét irányban elvégzendő; a beállítás a dashboard Beállítások > Föderáció oldalán is elvégezhető.

---

*Előző fejezet: [F06 MCP connectorok](F06-mcp.md)*
