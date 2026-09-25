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
