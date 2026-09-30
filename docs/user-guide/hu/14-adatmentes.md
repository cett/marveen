# 14 - Adatmentés

Az Adatmentés nézet a rendszer SQLite adatbázisának biztonsági mentéseit kezeli. Innen indíthatsz manuális mentést, ellenőrizheted a mentések épségét, és törölheted a régi fájlokat.

---

## A mentési lista

Az oldal betöltésekor megjelenik a mentések táblázata. Minden sor tartalmazza:

- **Fájlnév** -- a mentési fájl neve (időbélyeggel)
- **Méret** -- fájlméret (B / KB / MB)
- **Idő** -- a mentés készítésének helyi ideje
- **Ellenőrzőösszeg** -- SHA-256 hash (ha rögzítve lett); a hash első 12 karaktere látható, a teljes érték a cella fölé húzva jelenik meg

Az oldal tetején összesítő adatok láthatók: mentések száma és az utolsó mentés időpontja.

---

## Manuális mentés futtatása

A **Mentés futtatása** gomb azonnali biztonsági mentést indít. A mentés elkészülte után (kb. 3 másodperccel) a lista automatikusan frissül.

---

## Ellenőrzőösszeg-ellenőrzés

A **Verify** gomb az adott mentési fájl épségét ellenőrzi: a rendszer újraszámolja az SHA-256 hash-t és összeveti a tárolt értékkel. Az eredmény az oldal alján megjelenő panelen jelenik meg. Ha az ellenőrzőösszeg hiányzik (régi mentések esetén), a cella kötőjelet mutat.

---

## Ütemezett éjszakai mentés

A mentés minden éjjel automatikusan is lefuthat parancs típusú feladatként (lásd [06 - Feladatok](06-feladatok.md)). Egy ilyen feladat a telepítési könyvtár `scripts/backup.sh` szkriptjét futtatja közvetlenül, AI ágens nélkül, így a mentés nem függ attól, hogy elérhető-e egy modell vagy egy ágens-munkamenet. Tipikus beállítás:

- ütemezés: `0 3 * * *` (minden éjjel 03:00, a szerver időzónája szerint)
- típus: `command`, a parancs `bash <telepítési könyvtár>/scripts/backup.sh`
- `timeoutMs`: az adatbázis méretéhez elég hosszú (például 120000)
- `failThreshold`: `1`, így a sikertelen mentés már az első hibánál Telegram-riasztást küld, nem csak a másodiknál; egy későbbi sikeres futás "helyreállt" üzenetet küld

Az egyes futások eredménye a `store/command-task-health.json` fájlban rögzítődik. Friss telepítés nem tartalmazza ezt a feladatot; a Feladatok fejezetben leírtak szerint kell létrehozni. Az általa készített mentések a fenti listában ugyanúgy megjelennek, mint a kézi mentések.

---

## Megőrzési beállítás

A **Megőrzés** legördülő az automatikusan megőrzött mentések számát állítja be. Az ennél régebbi mentések automatikusan törlődnek a következő mentési futtatáskor. A beállítást a **Mentés** gombbal rögzítheted.

---

## Mentés törlése

A **Törlés** gombra kattintva megerősítő ablak jelenik meg. Törlés után a fájl visszaállíthatatlan.

---

## Kapcsolódó fejezetek

- [06 - Feladatok](06-feladatok.md) -- parancs típusú feladatok és ütemezés
- [11 - Beállítások](11-beallitasok.md) -- mentés-megőrzési beállítás
- [13 - Audit napló](13-audit.md) -- rendszeresemények nyomon követése
