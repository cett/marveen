# Ötletek

Az Ötletek nézet a fejlesztési ötletek, visszajelzések és javaslatok gyűjtőhelye. Az ötletek életciklust járnak be: az új ötlettől az áttekintésen át a kanban-kártyává alakításig.

---

## Státuszok

| Státusz | Leírás |
|---------|--------|
| **Új** | Frissen beérkezett, még nem áttekintett |
| **Áttekintett** | Valaki megnézte, döntés előkészítés alatt |
| **Kanban** | Az ötletből kanban-kártya lett; aktívan fejlesztés alatt |
| **Elutasított** | Nem kerül megvalósításra |

Az alapértelmezett lista az aktív ötleteket mutatja (Új + Áttekintett).

---

## Az ötletek listája

Az ötletek kategóriák szerint csoportosítva jelennek meg. Minden kártyán látható:

- Cím
- Státusz-jelvény
- Pontszám-jelvény (Impact - Effort, ha meg van adva)
- Elavult-jelvény (ha régóta nem változott)
- Rövid leírás (az első 120 karakter)
- Műveleti gombok

---

## Pontszám (Impact / Effort)

Minden ötlethez megadható egy hatás (Impact) és egy ráfordítás (Effort) érték 1-10 skálán. A pontszám kiszámítása: `Impact - Effort`. Pozitív szám zölddel, negatív pirossal jelenik meg.

---

## Szűrők

- **Státusz** - Aktív / Összes / Új / Áttekintett / Kanban / Elutasított
- **Kategória** - az elérhető kategóriák listájából

---

## Statisztikák

A nézet tetején státuszonként megjelenik az ötletek száma.

---

## Új ötlet felvitele

1. Kattints az **+ Ötlet** gombra.
2. Add meg a címet (kötelező) és az opcionális leírást.
3. Válaszd ki a kategóriát.
4. Opcionálisan add meg az Impact és Effort értékeket.
5. Kattints a **Mentés** gombra.

---

## Ötlet részletei

Egy ötlet nevére kattintva megnyílik a részlet-panel, ahol:

- A teljes leírás olvasható
- Az Impact / Effort értékek szerkeszthetők és menthetők
- Megjegyzések fűzhetők az ötlethez

---

## Státuszváltás

Minden kártya sorában gombokkal közvetlenül változtatható a státusz:

- **Áttekintve** - Új -> Áttekintett
- **Elutasít** - bármely státuszból Elutasított
- **Újra megnyit** - Áttekintett vagy Elutasított -> Új
- **Szerkeszt** - megnyitja a szerkesztő-modálist

---

## AI-alapú kanban-bontás

Az **AI bontás** gombra kattintva a rendszer az ötletből automatikusan kanban-alfeladatokat generál. Az AI javaslatot ad a szükséges lépésekre, amelyek ezután kanban-kártyaként vehetők fel. A létrehozás előtt megadható a sikerkritérium (Definition of Done) is.

---

## Bérlő-szűrő

A nézet tetején bérlő-szelektor érhető el a bérlő-szintű szűréshez.

---

## Tippek

- Az elavult jelvény azt jelzi, hogy az ötlet régóta nem változott; érdemes áttekinteni, hogy még aktuális-e.
- A kategóriák automatikusan bővülnek az új ötletek besorolásával; következetes elnevezések segítik az átláthatóságot.
- A pontszám csak tájékoztató jellegű; a döntést a státuszváltás és az AI-bontás rögzíti.
