# Kanban

A Kanban nézet az összes feladatot és projektet kezeli. A kártyák oszlopokban helyezkednek el a státuszuk szerint, és húzással mozgathatók az oszlopok között.

---

## Oszlopok

| Oszlop | Leírás |
|--------|--------|
| **Tervezett** | Még el nem kezdett feladatok |
| **Folyamatban** | Aktívan dolgoznak rajta |
| **Tesztelés** | Elkészült, ellenőrzés alatt |
| **Várakozik** | Blokkolva, külső feltételre vár |
| **Kész** | Befejezett feladatok |

---

## Kártya létrehozása

1. Kattints az **Új kártya** gombra a jobb felső sarokban.
2. Töltsd ki a kötelező **Cím** mezőt.
3. Opcionálisan adj meg: Projekt, Felelős, Prioritás, Határidő, Leírás, Szülő-kártya.
4. Mentsd el a kártyát.

Az új kártya alapértelmezés szerint "Tervezett" státusszal kerül a táblára.

---

## Prioritások

| Szint | Leírás |
|-------|--------|
| **Alacsony** | Nem sürgős, ráér |
| **Normál** | Alapértelmezett szint |
| **Magas** | Előnyt élvez a normálaknál |
| **Sürgős** | Azonnali figyelmet igényel |

A kártya prioritása az egész kártyán látszik: a **Sürgős** kártya pirosas, a **Magas** kártya kiemelő színű árnyalatot kap (sötét témában erősebbet), a **Normál** és az **Alacsony** sima marad. Ha egy kártya régóta áll, a bal szélén az elavulás-csík megmarad.

A nézetváltó mellett a tábla összegei látszanak: „X nyitott / Y a táblán” (nyitott = minden, ami nem a Kész oszlopban van). Ha projekt-, felelős- vagy címkeszűrő van bekapcsolva, kiegészül: „(Z látszik)”. Az összeg és az oszlopok fejlécében lévő szám a teljes táblát számolja akkor is, ha egy oszlopból még csak az első 20 kártya van betöltve.

---

## Kártya részletei

Egy kártyára kattintva megnyílik a részlet-panel:

- **Cím és leírás** - szerkeszthető
- **Státusz, prioritás, felelős, határidő** - módosítható
- **Folyamatban töltött idő** - mennyi ideig állt a kártya a Folyamatban oszlopban, minden ott töltött szakaszt összeadva (például `3 ó 20 p` vagy `2 nap 4 ó`). A panel a kártya saját állapotváltásaiból számolja, így mindenkinek ugyanaz, aki a kártyát láthatja. Ez falióra szerinti idő az oszlopban, nem munkaidő: az éjszakára Folyamatban hagyott kártya az éjszakát is beleszámolja, ezért felső korlátként olvasd (a súgószöveg is ezt mondja). A `nem mért` azt jelenti, hogy a kártyának még nincs állapot-története (régebbi kártya, amely a napló indítása óta nem mozdult), ez más, mint a `még nem volt folyamatban`, ami mért nulla.
- **Szülő** - megadható szülő-kártya (alfeladatok szervezéséhez)
- **Alfeladatok** - a kártyán belüli kisebb lépések listája; az elvégzett arány látható a kártya-összefoglalón is (`X/Y alfeladat`)
- **Megjegyzések** - időrendben; a saját megjegyzéseid bármikor hozzáadhatók

---

## Szűrők és csoportosítás

**Projekt-szűrő** - csak egy adott projekt kártyái jelennek meg.

**Felelős-szűrő** - csak a kiválasztott felelőshöz rendelt kártyák.

**Saját feladatok** (`Rám vár` gomb) - csak a bejelentkezett felhasználóhoz rendelt kártyák.

**Csoportosítás** - a tábla felbontható felelős vagy prioritás szerint úszósávokba. Az úszósávok fejlécre kattintva összecsukhatók.

**Rendezés** - az oszlopok kártyái sorba rendezhetők: kézi sorrend (alapértelmezett, a húzással beállított), szám szerint növekvő vagy csökkenő, létrehozás szerint vagy frissítés szerint (újabb elöl). A szám vagy időpont nélküli kártya mindig a végére kerül. A választás megmarad az oldal újratöltése után is. Kézi sorrenden kívül a kártyák nem húzhatók (a húzással beállított hely egy rendezett oszlopban nem jelentene semmit), és a tábla teljes egészében betöltődik, nem oldalanként. A keresés változatlanul a meglévő, szerveroldali keresés.

**Szűrők törlése** - visszaállítja az összes szűrőt.

---

## Folyamatos sáv

A **Folyamatos** (vagy **Ongoing**) címkével ellátott, nem Kész státuszú kártyák nem a státusz-oszlopban jelennek meg, hanem a tábla fölötti sávban, egy-egy gombként. Olyan tartós, mindig "folyamatban lévő" teendőknek való, amelyek különben örökre egy oszlopban ülnének. A kártya státusza megmarad (a részletein továbbra is állítható), a sáv nem húzás-célpont, a gombra kattintva a kártya részletei nyílnak. A Kész státuszba tett kártya visszakerül a Kész oszlopba. A sáv az aktív szűrőket követi, és üresen nem látszik. Ha egy ilyen kártyának vannak alfeladatai, azok a saját oszlopukban maradnak, nem tűnnek el vele.

A címkét egyszer létre kell hozni a táblán (a címkékkel egy admin dolgozik; a címke neve kis- és nagybetűre nem érzékeny, és tenantonként külön van). Ha a táblán van ilyen nevű címke, a tábla teljes egészében betöltődik, nem oldalanként, hogy a sáv hiánytalan legyen. A sávba emelt kártyát az oszlopfejléc száma és a WIP-jelvény nem számolja (nincs oszlopban), a nézetváltó melletti tábla-összeg viszont igen, mert a kártya a táblán van.

---

## Kártya húzása (drag and drop)

- Kattints és tartsd lenyomva a kártyát, majd húzd a céloszlopba.
- Az oszlop neve kiemelődik, jelezve, hogy ott ejtsd le.
- Mobilon érintéses húzás is működik.
- Az oszlopon belüli sorrend mindenkinél ugyanaz a kézi sorrend, és minden kártyán látszik a sorszáma (#N), akkor is, ha nem rendszergazdaként jelentkeztél be.

---

## Auto-bontás

A kártya részlet-panelén az **Auto-bontás** gomb az AI alfeladatokra osztja szét a kártya leírását. Az ajánlott alfeladatokat elfogadhatod, módosíthatod vagy elvetheted.

---

## Archiválás és törlés

- **Archiválás** - a kártya eltűnik a táblán, de az adatbázisban megmarad.
- **Törlés** - végleges törlés, nem visszavonható.

---

## Tippek

- A táblán lévő kártyák száma a szűrőktől függ; a szűrők nem befolyásolják a tényleges adatokat.
- A Kanban minden oldalbetöltéskor friss adatokat tölt be; nincs szükség manuális frissítésre.
