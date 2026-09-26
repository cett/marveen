# 16 - Kapcsolatok

A Kapcsolatok nézet az összes külső integrációt egy helyen kezeli: MCP connectorok, föderált peer-kapcsolatok és memória-import forrásokat.

---

## MCP connectorok

Az MCP (Model Context Protocol) connectorok az ágensek számára elérhetővé tett külső eszközöket jelölik -- pl. fájlrendszer, GitHub, Hetzner, Gmail, Google Drive. A nézet két fülre tagolódik.

### Telepített connectorok

A **Telepített** fülön a rendszeren regisztrált MCP szerverek listája látható. Minden kártyán megjelenik:

- A connector neve és ikonja
- Az aktuális állapot (aktív / hibás / ismeretlen)
- Az ágenshez rendelt parancs és argumentumok (ha beállított)

A **Frissítés** gomb lefuttatja a szerver-oldali health-check-et és frissíti az állapotokat. A frissítés manuális, mert minden futás elindítja a konfigurált szervereket -- ezt kerüld sűrűn futtatni, ha sok stdio-típusú connector van telepítve.

### Connector katalógus (Galéria)

A **Galéria** fülön a telepíthető MCP connectorok böngészhető katalógusa látható. Szűrhetsz kategória szerint. Egy kártya kiválasztása megnyitja a telepítési ablakot, ahol megadhatod a szükséges konfigurációt (pl. API-kulcsok, elérési utak).

---

## Föderáció

A Föderáció lehetővé teszi, hogy egymástól független rendszerek ágenseihez kapcsolódj. A föderált peer-kapcsolatokon keresztül az ágensek kölcsönösen látják egymás állapotát és üzeneteket küldhetnek egymásnak.

### Master-konfiguráció

Az oldal tetején a saját rendszer föderációs konfigurációja látható: a rendszer neve, a föderált hozzáférési URL és az aktuális összekapcsolt peer-ek száma.

### Peer-lista

A peer-ek táblázatban jelennek meg. Minden sor tartalmazza:

- A peer nevét és URL-jét
- Az aktuális kapcsolati állapotot (ok / hibás / ismeretlen)
- Az utolsó sikeres ping idejét

**Peer hozzáadása:** kattints a **+ Peer hozzáadása** gombra, add meg a nevet és az URL-t. A rendszer automatikusan próbál csatlakozni.

**Peer szerkesztése / törlése:** a sor végén lévő gombokkal.

---

## Import

Az Import forrásokból rendszeres időközönként tölt be tartalmakat a memória-adatbázisba. Támogatott forrástípusok:

- **Helyi fájl** -- a szerveren elérhető könyvtárból
- **Google Drive** -- Drive-fájlok szinkronizálása
- **SharePoint** -- SharePoint dokumentumkönyvtárak
- **Confluence** -- Confluence oldalak

### Import-forrás kezelése

A források táblázatban jelennek meg. Minden soron látható a típus, a név, a szinkronizálási időköz, az utolsó szinkronizálás ideje és az állapot (aktív / inaktív).

**Forrás hozzáadása:** kattints a **+ Forrás hozzáadása** gombra.

**Manuális szinkron:** a **Szinkronizálás** gombbal azonnali szinkront indíthatsz.

**Szinkronnapló:** a **Napló** gombbal az adott forrás szinkronizálási előzményei tekinthetők meg.

**Letiltás / engedélyezés:** a forrás szüneteltetéséhez, az adatok törlése nélkül.

**Törlés:** az **Adatok törlése** gomb eltávolítja a forrásból betöltött összes memóriát; a **Törlés** gomb magát a forrás-bejegyzést is törli.

Globális adminként az oldalon megjelenik egy tenant-választó, amellyel a kiválasztott tenant import-forrásait kezelheted.

---

## Kapcsolódó fejezetek

- [12 - Vault](12-vault.md) -- connector hitelesítő adatok tárolása
- [04 - Ágensek](04-agensek.md) -- ágensekhez rendelt MCP connectorok
- [07 - Memória](07-memoria.md) -- importált tartalmak keresése
