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

**Agent** -- egy tenant adataihoz teljes olvasási és írási hozzáférés (memóriák, kanban, üzenetváltások, blackboard). Nincs hozzáférés más tenantok adataihoz és az admin felülethez. B2B partnerek alapértelmezett jogköre.

**Read-only** -- csak olvasás: memóriák, kanban, ágensek és blackboard listázása. Sem létrehozás, sem törlés.

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
- A dashboardon a feladatok létrehozása, szerkesztése, másik tenantba áthelyezése és aktiválása admin művelet: más felhasználónak a **+ Feladat** gomb rejtett, a sorműveletek pedig le vannak tiltva. A tenant felhasználója a csevegésben kéri az ágensét a feladatra. Az ágens vázlatként hozza létre a felhasználó tenantjában, egy admin pedig aktiválja, miután látta, melyik tenanthoz tartozik.
- A feladat csak olyan ágensen fut, amely kiszolgálja a tenantját. Ha az ágenst kikapcsolják a tenantnál, vagy a tenantot letiltják, a feladat nem tüzel tovább, és minden kimaradt előfordulás `skipped_tenant_mismatch` állapottal kerül a futási előzményeibe.
- A tenant törlése a feladatait, azok függő újrapróbálkozásait és a tükrözött fájljaikat is törli.

> **Shadow mód és az ütemezés végpontjai.** Amíg az RBAC shadow módban fut (az `RBAC_MODE` nincs `enforce`-ra állítva), az ütemezés végpontjai még nem csak adminnak szólnak: az RBAC csak naplózza azt az elutasítást, amelyet az enforce mód kiadna, ezért egy tenant-felhasználó egyszerű kérését maga az RBAC nem állítja meg. Az alábbi feladat-szabályok az ütemezés útvonalainak részei, és mindkét módban érvényesek. A tenant felhasználója nem olvashatja és nem módosíthatja másik tenant feladatait (404-gyel válaszolnak); nem aktiválhat feladatot (403, az aktiválás bejelentkezett adminé); nem változtathatja a feladat státuszát, tenantját és a futtató szkript-opciókat (a szerkesztés egyszerűen eldobja ezeket a kulcsokat; másik tenant kérése 403-at ad); nem irányíthatja át a feladatot másik ágensre (számára a kulcs figyelmen kívül marad); és az általa létrehozott feladat mindig vázlat a saját tenantjában. Amit a shadow mód **nem** állít meg: az API-t közvetlenül hívó tenant-felhasználó a saját tenantja feladataival többet tehet, mint amit a dashboard megenged. Amíg az enforce mód nincs bekapcsolva, ne adj tenant-felhasználóknak API-t elérő belépést; csak az `RBAC_MODE=enforce` teszi úgy, hogy ezek a végpontok az adminokon kívül mindenkinek 403-at adnak.

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
