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

---

## Kártya részletei

Egy kártyára kattintva megnyílik a részlet-panel:

- **Cím és leírás** - szerkeszthető
- **Státusz, prioritás, felelős, határidő** - módosítható
- **Szülő** - megadható szülő-kártya (alfeladatok szervezéséhez)
- **Alfeladatok** - a kártyán belüli kisebb lépések listája; az elvégzett arány látható a kártya-összefoglalón is (`X/Y alfeladat`)
- **Megjegyzések** - időrendben; a saját megjegyzéseid bármikor hozzáadhatók

---

## Szűrők és csoportosítás

**Projekt-szűrő** - csak egy adott projekt kártyái jelennek meg.

**Felelős-szűrő** - csak a kiválasztott felelőshöz rendelt kártyák.

**Saját feladatok** (`Rám vár` gomb) - csak a bejelentkezett felhasználóhoz rendelt kártyák.

**Csoportosítás** - a tábla felbontható felelős vagy prioritás szerint úszósávokba. Az úszósávok fejlécre kattintva összecsukhatók.

**Szűrők törlése** - visszaállítja az összes szűrőt.

---

## Kártya húzása (drag and drop)

- Kattints és tartsd lenyomva a kártyát, majd húzd a céloszlopba.
- Az oszlop neve kiemelődik, jelezve, hogy ott ejtsd le.
- Mobilon érintéses húzás is működik.

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
