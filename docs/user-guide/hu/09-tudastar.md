# Tudástár

A Tudástár három aloldalból áll: Ötletláda (fejlesztési javaslatok), Artifaktek (ágensek által mentett fájl-kimenetek) és Munkadokumentumok (ágensek között megosztott dokumentumok).

---

## Ötletláda

Az Ötletláda a fejlesztési ötletek, visszajelzések és javaslatok gyűjtőhelye. Az ötletek életciklust járnak be: az új ötlettől az áttekintésen át a kanban-kártyává alakításig.

### Státuszok

| Státusz | Leírás |
|---------|--------|
| **Új** | Frissen beérkezett, még nem áttekintett |
| **Áttekintett** | Valaki megnézte, döntés előkészítés alatt |
| **Kanban** | Az ötletből kanban-kártya lett; aktívan fejlesztés alatt |
| **Elutasított** | Nem kerül megvalósításra |

Az alapértelmezett lista az aktív ötleteket mutatja (Új + Áttekintett).

### Az ötletek listája

Az ötletek kategóriák szerint csoportosítva jelennek meg. Minden kártyán látható:

- Cím
- Státusz-jelvény
- Pontszám-jelvény (Impact - Effort, ha meg van adva)
- Elavult-jelvény (ha régóta nem változott)
- Rövid leírás (az első 120 karakter)
- Műveleti gombok

### Pontszám (Impact / Effort)

Minden ötlethez megadható egy hatás (Impact) és egy ráfordítás (Effort) érték 1-10 skálán. A pontszám kiszámítása: `Impact - Effort`. Pozitív szám zölddel, negatív pirossal jelenik meg.

### Szűrők

- **Státusz** - Aktív / Összes / Új / Áttekintett / Kanban / Elutasított
- **Kategória** - az elérhető kategóriák listájából
- **Bérlő** - bérlő-szintű szűrés

### Új ötlet felvitele

1. Kattints az **+ Ötlet** gombra.
2. Add meg a címet (kötelező) és az opcionális leírást.
3. Válaszd ki a kategóriát.
4. Opcionálisan add meg az Impact és Effort értékeket.
5. Kattints a **Mentés** gombra.

### Ötlet részletei és státuszváltás

Egy ötlet nevére kattintva megnyílik a részlet-panel: teljes leírás, Impact/Effort szerkesztés, megjegyzések. A lista gombjain közvetlenül váltható: **Áttekintve** / **Elutasít** / **Újra megnyit** / **Szerkeszt**.

### AI-alapú kanban-bontás

Az **AI bontás** gombra kattintva a rendszer az ötletből automatikusan kanban-alfeladatokat generál. A létrehozás előtt megadható a sikerkritérium (Definition of Done) is.

---

## Artifaktek

Az Artifaktek aloldal az ágensek által mentett fájl-kimeneteket listázza - pl. generált riportok, exportált adatok, szkriptek.

### A lista oszlopai

| Oszlop | Leírás |
|--------|--------|
| **Cím** | Az artifakt neve |
| **Ágens** | Melyik ágens hozta létre |
| **Típus** | Az artifakt típusa (pl. `text`, `markdown`, `json`) |
| **Módosítva** | Az utolsó módosítás időpontja |

### Szűrők

- **Ágens** - szűrés ágens szerint
- **Típus** - szűrés artifakt-típus szerint
- **Dátum** - szűrés létrehozás dátuma szerint
- **Bérlő** - bérlő-szintű szűrés

### Műveletek

- **Előnézet** - megnyitja a tartalom-előnézet panelt; szöveg, markdown és JSON formátum olvasható, bináris fájlok letölthetők
- **Átnevezés** - az artifakt címének módosítása
- **Törlés** - az artifakt véglegesen törlődik

---

## Munkadokumentumok

A Munkadokumentumok (Workspace Docs) aloldal az ágensek által a közös munkaterületre mentett dokumentumokat listázza. Ezek jellemzően ágensek közötti átadáshoz, feladatkontextus megosztásához vagy hosszabb életű kimenetek tárolásához használt fájlok.

### A lista oszlopai

| Oszlop | Leírás |
|--------|--------|
| **Cím** | A dokumentum neve (és feladathivatkozás, ha van) |
| **Ágens** | Melyik ágens hozta létre |
| **Típus** | A dokumentum típusa (pl. `dream`, `digest`, `report`) |
| **Tartalom** | A tartalomtípus (pl. `text`, `markdown`, `code`, `binary`) |
| **Méret** | A dokumentum mérete |
| **Módosítva** | Az utolsó módosítás időpontja |

### Szűrők

- **Ágens** - szűrés ágens szerint
- **Típus** - szűrés dokumentum-típus szerint
- **Tartalom** - szűrés tartalomtípus szerint
- **Bérlő** - bérlő-szintű szűrés

### Megtekintés és törlés

A **Megtekint** gombra kattintva megnyílik az előnézet-panel, amelyen a tartalom markdown-ként vagy egyszerű szövegként, bináris fájl esetén letöltési hivatkozásként jelenik meg. A **Törlés** gomb véglegesen eltávolítja a dokumentumot.

---

## Tippek

- Az elavult jelvény az ötletláda kártyáin jelzi, ha egy ötlet régóta nem változott; érdemes áttekinteni, hogy még aktuális-e.
- Az artifakt-előnézet markdown-tartalmat formázva jelenít meg, kódot szintaxissal.
- A munkadokumentumok ágensek által automatikusan íródnak; manuálisan általában nem szükséges módosítani őket, de a dashboard-ból törölhetők, ha elavultak.
