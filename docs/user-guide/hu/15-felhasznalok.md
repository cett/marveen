# 15 - Felhasználók `[ADMIN]`

> Ez a fejezet csak rendszergazdák számára elérhető.

A Felhasználók nézet a hozzáférés-kezelés központja: innen kezelheted a tenantokat, a dashboard-felhasználókat, az eszközkulcsokat, az API-tokeneket, a partner-küldőket és a skill-hozzáféréseket. A teljes nézet csak globális adminok számára érhető el (admin szerepkör, globális tenant-hatókör nélkül).

---

## Fülek

Az oldal hat fülre tagolódik:

- **Tenantok** -- B2B adatszigetek kezelése
- **Felhasználók** -- dashboard-belépési fiókok, szerepkörök, mátrixok
- **Eszközkulcsok** -- párosított mobileszközök és Bridge-kapcsolatok
- **Tokenek** -- API-tokenek létrehozása, rotálása, visszavonása
- **Partner-küldők** -- föderált ágensek allowlist-kezelése
- **Skill-hozzáférés** -- melyik skill melyik ágens számára érhető el

---

## Szerepkörök és jogosultságok

A rendszer négy hozzáférési szintet különböztet meg.

**Admin** -- teljes hozzáférés minden tenant adatához és az adminisztrációs felülethez. A futó ágensek bearer tokenje admin jogosultsággal fut.

**Agent** -- egy tenant adataihoz teljes olvasási és írási hozzáférés (memóriák, kanban, üzenetváltások, blackboard, ütemezett feladatok). Nincs hozzáférés más tenantok adataihoz és az admin felülethez. B2B partnerek alapértelmezett jogköre.

**Read-only** -- csak olvasás: memóriák, kanban, ágensek, blackboard és ütemezett feladatok listázása. Sem létrehozás, sem törlés.

**Viewer** -- dashboard megtekintés: memóriák, kanban és ágensek olvasása, blackboard nélkül. Új felhasználó alapértelmezett szerepköre.

### Jogosultsági összefoglaló

| Funkció | admin | agent | read_only | viewer |
|---------|:-----:|:-----:|:---------:|:------:|
| Memóriák olvasása | X | X | X | X |
| Memóriák írása/törlése | X | X | | |
| Kanban olvasása | X | X | X | X |
| Kanban írása/törlése | X | X | | |
| Ágensek listázása | X | X | X | X |
| Üzenet küldése ágensnek | X | X | | |
| Jóváhagyások olvasása | X | X | X | X |
| Jóváhagyások írása | X | | X | X |
| Blackboard olvasása | X | X | X | X |
| Blackboard írása | X | X | | |
| Ütemezett feladatok olvasása | X | X | X | X |
| Ütemezett feladatok létrehozása/szerkesztése/szüneteltetése/futtatása/törlése | X | X | | |
| Ütemezett feladatok aktiválása (jóváhagyás) | X | | | |
| Ágens-beállítások (context-guard, auto-restart) | X | X | | |
| Föderáció olvasása | X | X | | |
| Föderáció írása | X | X | | |
| Admin felület | X | | | |

A dashboard Felhasználók fülének "Szerepkör-jogosultság mátrix" nézete a tényleges forráskódból tükrözött adaton fut -- ez a táblázat a kódot kövesse, nem fordítva.

---

## Token-kezelés

### Az alap bearer token

A telepítéskor generált `store/.dashboard-token` fájl egy admin szerepkörű, globális hatókörű tokent tartalmaz. A futó ágensek ezt a tokent használják -- ez változatlan marad.

### API-tokenek (Tokenek fül)

A **Tokenek** fülön további tokeneket hozhatsz létre. Minden tokennek van:

- **neve** -- emberi olvashatóságú azonosító
- **szerepköre** -- admin / agent / read_only / viewer
- **tenant-hatóköre** -- melyik tenant adataihoz fér hozzá (globális admin esetén üres)
- **lejárati ideje** -- opcionális; ha nincs beállítva, a token nem jár le
- **visszavonási állapota** -- visszavont token azonnal érvénytelen, az adatok nem törlődnek

**Token létrehozása:** kattints az **+ Token hozzáadása** gombra, töltsd ki az adatokat. A token nyers értéke csak egyszer jelenik meg -- mentsd biztonságos helyre.

**Token rotálása:** a sor végén lévő gombbal új tokent generálhatsz. A régi token azonnal érvénytelen lesz.

**Token visszavonása:** a visszavonás azonnali hatályú. A visszavont tokennel érkező kérés 401-es hibát kap.

---

## Tenant-kezelés `[tervezett]`

> A tenant-kezelési API következő fejlesztési fázisban élesedik.

Egy tenant egy önálló adatszigetet jelent. Minden adat (memóriák, kanban, üzenetek, import-tartalmak) egy konkrét tenanthoz tartozik. Más tenant tokenjével ezek az adatok nem láthatók és nem módosíthatók.

**Tenant felvétele:** a **Tenantok** fülön az **+ Tenant hozzáadása** gombbal. Az azonosító (slug) a mentés után nem módosítható.

**Tenant letiltása:** a PATCH endpoint a tokent visszavonja és a tenant hozzáférést megszünteti -- az adatok megmaradnak.

### Tenant-izoláció `[tervezett]`

Az enforce fázis bekapcsolása után (`RBAC_MODE=enforce`) a rendszer minden lekérdezésbe automatikusan beleszűr a token tenant-hatóköre alapján. Jelenleg az izoláció naplózó (shadow) módban fut -- minden kérés átmegy, de a rendszer rögzíti, mit utasítana el.

**Ami tudatosan nem izolált:**
- Az ágensek listája (`/api/v1/agents`) tenant-független -- minden hitelesített felhasználó látja, mely ágensek futnak.
- A blackboard szintén tenant-független olvasással rendelkezik agent és admin szerepkörök számára.

### Ütemezett feladatok és tenantok

Az ütemezett feladatoknak tenant a tulajdonosa (részletek: [06 - Feladatok](06-feladatok.md)):

- Minden feladat pontosan egy tenanthoz tartozik. A rendszer saját feladatai (adatmentés, karbantartás, figyelők) és minden feladat, amelynek létrehozásakor nem neveztek meg tenantot, a `default` tenanthoz tartoznak.
- A tenant felhasználója csak a saját tenantja feladatait, a választható ágenseket és a függő újrapróbálkozásokat kapja. Másik tenant feladata úgy válaszol, mintha nem létezne.
- A hozzáférést két jogosultság szabályozza: a `schedules:read` (a feladatok, futásaik és a függő újrapróbálkozások listázása) és a `schedules:write` (létrehozás, szerkesztés, szüneteltetés vagy folytatás, futtatás és törlés). Az `admin` és az `agent` szerepkör mindkettővel rendelkezik, így minden tenant-felhasználó kezelheti a saját tenantja feladatait a dashboardon: a **+ Feladat** gomb, a szerkesztő ablak és a Futtatás most, Szüneteltetés és Törlés művelet az övé. A `read_only` és a `viewer` csak `schedules:read` jogot kap: látja a feladatokat, a **+ Feladat** gomb rejtett, a sorműveletek le vannak tiltva. Tenantonkénti kapcsoló nincs; a jogot a szerepkör adja.
- Az aktiválás és az ütemező-szívverés jelző admin-only marad (`admin:all`), az aktiváláshoz ráadásul bejelentkezett admin kell. A feladat másik tenantba áthelyezése szintén admin művelet. Az a feladat, amelyet a tenant felhasználója (vagy a nevében az ágens a csevegésen át) létrehoz, vázlat a felhasználó tenantjában, egy admin pedig aktiválja, miután látta, melyik tenanthoz tartozik. Egy tenantnak egyszerre legfeljebb 20 jóváhagyásra váró feladata lehet.
- Ha a tenant felhasználója megváltoztatja, amit egy jóváhagyott feladat végrehajt (prompt, parancs, ütemezés és így tovább), a feladat visszakerül jóváhagyásra: addig nem fut, amíg egy admin újra nem aktiválja. A részletek a pontos mezőkkel: [06 - Feladatok](06-feladatok.md).
- A `default` tenant a rendszer saját feladatait tartalmazza. Azon a nem admin semmit nem módosíthat, a tenant nélküli nem admin fiókot pedig az ütemezés minden végpontja elutasítja.
- A feladat csak olyan ágensen fut, amely kiszolgálja a tenantját. Ha az ágenst kikapcsolják a tenantnál, vagy a tenantot letiltják, a feladat nem tüzel tovább, és minden kimaradt előfordulás `skipped_tenant_mismatch` állapottal kerül a futási előzményeibe.
- A tenant törlése a feladatait, azok függő újrapróbálkozásait és a tükrözött fájljaikat is törli.

> **Az ütemezett feladatok szabályai és az RBAC-mód.** Két réteg dönti el, ki mit tehet az ütemezés végpontjain, és csak az egyik függ a módtól.
>
> - **Útvonal-szabályok, mindkét módban** (shadow módban is). Az a nem admin hívó (nem admin dashboard-belépés vagy API-token), akinek a fiókjához nincs tenant rendelve, 403-at kap, olvasásnál is. A nem admin nem módosíthat feladatot a `default` tenanton (a rendszer saját feladatai az adminoknál maradnak), eszközkulcs és föderációs principal pedig semmilyen feladatot nem módosíthat (403). Másik tenant feladata 404-gyel válaszol, mintha nem létezne. Az aktiváláshoz bejelentkezett admin kell (mindenki másnak 403, a megosztott ágens-tokennek is). Egy szerkesztés nem változtathatja a feladat státuszát, tenantját és a futtató szkript-opciókat (ezeket a kulcsokat eldobja; másik tenant kérése 403-at ad), a feladat ágensét csak admin változtatja, a nem admin által létrehozott feladat pedig mindig vázlat a saját tenantjában, tenantonként legfeljebb 20 jóváhagyásra váró feladat keretén belül. Ha egy nem admin azt módosítja, amit egy élő feladat végrehajt, a feladat visszakerül jóváhagyásra (lásd [06 - Feladatok](06-feladatok.md)).
> - **A jogosultsági tábla, enforce módban.** A `schedules:read`, a `schedules:write` és az aktiváláshoz, valamint az ütemező-szívverés jelzőhöz az `admin:all` jogot az RBAC-kapu csak `RBAC_MODE=enforce` esetén ellenőrzi. Amíg a mód shadow, a kapu csak naplózza, mit utasítana el, ezért a szerepkörök közti különbségek (például hogy a `read_only` és a `viewer` nem írhat) az enforce mód bekapcsolásakor lépnek életbe.
>
> Amíg az enforce mód nincs bekapcsolva, ne adj tenant-felhasználóknak API-t elérő belépést vagy tokent.

### Tenant alapcsomag

Az alapcsomag egy kész ütemezett feladat (napi összefoglaló) egy tenantnak. Hogy mit csinál a feladat, hogyan kell aktiválni és kinek megy a csatornaüzenet: [06 - Feladatok](06-feladatok.md#tenant-alapcsomag). Ez a szakasz azt írja le, hol van a gomb, és kinek mi érhető el.

**A gomb helye.** A **Tenantok** fülön minden tenant sorában, az **Agentkezelés** gomb mellett van az **Alapcsomag** gomb (a `default` tenantnál nincs). A gombra kattintva a tenant-lista alatt megnyílik az Alapcsomag panel, amely megmutatja:

- a feladat állapotát: még nincs létrehozva, rendben van, újracélozásra vár (az ágens megváltozott), vagy parkol (a feladat ágense már nem szolgálja ki a tenantot);
- a feladat nevét, ágensét, státuszát (piszkozat vagy aktív) és hogy engedélyezett-e;
- melyik ágenst választaná a rendszer automatikusan (a tenant fő ágense, ennek hiányában az egyetlen engedélyezett ágens).

Az ágens-választó csak akkor jelenik meg, ha a rendszer nem tud egyedül választani (nincs vagy több jelölt van). Olyan ágens nem választható, amely más tenantot is kiszolgál. A gomb neve **Alapcsomag létrehozása**, ha a feladat még nincs meg, egyébként **Ellenőrzés / újracélozás**.

**Ismételt megnyomás.** A gomb idempotens: létező feladatot sosem ír felül, és ha semmi nem változott, nem csinál semmit ("Nincs változás"). Ha az ágens megváltozott, újracélozza a feladatot, és visszateszi piszkozat és szüneteltetett állapotba. Ha a feladatot időközben törölték, újra létrehozza.

**Ki mit lát és tehet.**

| | admin (globális) | agent | read_only | viewer |
|---|:---:|:---:|:---:|:---:|
| Alapcsomag gomb és panel a Tenantok fülön | X | | | |
| Alapcsomag létrehozása és állapotának lekérdezése (API) | X | | | |
| Az alapcsomag feladata a Feladatok listában (saját tenant) | X | X | X | X |
| Szerkesztés | X | X | | |
| Aktiválás (piszkozatból aktívvá) | X | | | |
| Folytatás, szüneteltetés, törlés | X | X | | |

A táblázat mellé:

- A tenant-felhasználó nem látja a gombot és a panelt: nem csak rejtve van, a lap felépítésében sincs ott. Az alapcsomag API-ját is csak admin szerepkör éri el; más szerepkör, az eszközkulcs és a föderációs principal 403-at kap. Ez shadow módban is így van, mert az admin-ellenőrzés az útvonalban is él, nem csak a jogosultsági táblában.
- A tenant-felhasználó a saját tenantja alapcsomag-feladatát a Feladatok listában látja, piszkozat jelvénnyel, amíg nincs aktiválva. Nem aktiválhatja (az aktiváláshoz bejelentkezett admin kell). Az aktiválás utáni Folytatásra az `agent` szerepkör is jogosult, ahogy bármelyik másik feladat szüneteltetésére és folytatására.
- Ha a tenant-felhasználó szerkeszti az alapcsomag feladatát, rá is a szokásos szabály vonatkozik: élő feladatnál a módosítás újabb jóváhagyást kér (lásd [06 - Feladatok](06-feladatok.md)).
- A tenant nélküli nem admin fiókot az ütemezés minden végpontja elutasítja, így az alapcsomag feladatát sem látja.
- A csatornaüzenet címzettjeit nem a felhasználó adja meg: a Telegram csatorna-kötéseket csak admin hozhatja létre (lásd [F03 - Üzemeltetés](../../fork-guide/hu/F03-uzemeltetes.md#tenant-skill-kapu)). Aki nem szerepel a tenant kötései között, az az összefoglalót csatornán nem kapja meg, még ha látja is a feladatot.
- Az alapcsomag feladata és a napi összefoglaló bejegyzése csak a tenant saját adatait használja és írja, a tenant memóriáját a tenant hatókörével olvassa.

### Külső MCP-szerverek és tenant-izoláció

Külső MCP-szervernek (pl. GitHub, Hetzner, fájlrendszer) nincs tenant-fogalma. Ha egy ilyen szervert hordozó ágenshez B2B tenant-tokent rendelnek, az a tenant a hitelesítő adat TELJES hatókörét látja -- ezt adatréteg-szűréssel nem lehet korlátozni, csak policy-val.

A magas kockázatú MCP-szerverek (`hetzner`, `github`, `gitlab`, `filesystem`, `ga4`-osztály) esetén a rendszer megerősítő dialógust jelenít meg a tenant-hozzárendeléskor.

---

## B2B partner bevezetési lépések `[tervezett]`

> Az alábbi lépések a tenant-enforcement bekapcsolása után válnak elvégezhetővé.

1. **Tenant-azonosító meghatározása** -- egyedi, URL-biztos slug (pl. `acme-corp`).
2. **Tenant létrehozása** a Tenantok fülön.
3. **Agent token generálása** a partnernek (Tokenek fül), 90 napos lejárattal.
4. **Izolációs teszt** -- az új tokennel lekérdezni a `default` tenant memóriát: üres listát kell kapni.
5. **Rotációs folyamat egyeztetése** a partnerrel (legalább 2 héttel lejárat előtt).

---

## Kapcsolódó fejezetek

- [12 - Vault](12-vault.md) -- titkosított hitelesítő adatok
- [13 - Audit napló](13-audit.md) -- token-használat naplózása
- [17 - Frissítések](17-frissitesek.md) -- break-glass jelszó-visszaállítás
