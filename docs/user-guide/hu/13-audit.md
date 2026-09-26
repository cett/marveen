# 13 - Audit napló `[ADMIN]`

> Ez a fejezet csak rendszergazdák számára elérhető.

Az Audit napló a rendszerben végbement eseményeket rögzíti időrendben. Két adatforrásból épül fel, amelyek egységes, időrendben rendezett nézetben jelennek meg.

---

## Adatforrások

**Ágens-esemény (`agent`)** -- ágensek által végrehajtott írások: memória-mentés, kanban-módosítás, üzenetküldés, blackboard-frissítés, jóváhagyás-kezelés. Ezeket a műveletek végrehajtásakor maga a rendszer naplózza.

**Hook-esemény (`hook`)** -- a hook-rendszer döntései: PreToolUse, PostToolUse, PreCompact, Stop. Minden hook-futtatás eredménye (allow/deny) és a kiváltó kontextus megjelenik.

Az oldal betöltésekor mindkét forrás aktív. A jobb felső sarokban lévő jelölőnégyzetekkel szűrhetsz forrás szerint.

---

## Szűrés

- **Ágens** -- legördülőből kiválaszthatod, melyik ágens eseményeit szeretnéd látni.
- **Keresés** -- szabad szövegkeresés az esemény tartalmában.
- A forrás-jelölőnégyzetek (Agent / Hook) kombinálhatók.

A szűrők az oldalváltáskor is megmaradnak.

---

## Lapozás

Az audit napló lapozható, oldalanként 200 bejegyzéssel. A lapozó a lista alján jelenik meg. Az exportált fájl legfeljebb 10 000 bejegyzést tartalmaz.

---

## Esemény részletei

Egy sorra kattintva megnyílik a részletablak, amely az esemény teljes nyers adatát mutatja JSON formátumban. A nézet különösen hasznos hook-döntések visszakeresésénél (pl. melyik gate blokkolta az adott műveletet és miért).

---

## Export

Az **Exportálás** gomb JSON-fájlként tölti le az aktuális szűrési feltételnek megfelelő bejegyzéseket (maximum 10 000). A fájl neve tartalmazza az export időpontját.

---

## Security-visszaállítási bejegyzések

A `npm run dashboard-user security:reset` parancs és a HTTP break-glass végpont futtatása is itt keresi a `config_change_log` táblában rögzített eseményeket (`config` forrás alatt, `security.*` kulcsokkal). A bejegyzések metaadatot tartalmaznak (felhasználónév, darabszámok), hitelesítő anyagot soha.

Részletek a visszaállítási eljárásról: [17 - Frissítések](17-frissitesek.md).

---

## Kapcsolódó fejezetek

- [17 - Frissítések](17-frissitesek.md) -- break-glass és security:reset
- [15 - Felhasználók](15-felhasznalok.md) -- tokenek naplózása
