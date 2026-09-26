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

## Megőrzési beállítás

A **Megőrzés** legördülő az automatikusan megőrzött mentések számát állítja be. Az ennél régebbi mentések automatikusan törlődnek a következő mentési futtatáskor. A beállítást a **Mentés** gombbal rögzítheted.

---

## Mentés törlése

A **Törlés** gombra kattintva megerősítő ablak jelenik meg. Törlés után a fájl visszaállíthatatlan.

---

## Kapcsolódó fejezetek

- [11 - Beállítások](11-beallitasok.md) -- automatikus mentési ütemezés
- [13 - Audit napló](13-audit.md) -- rendszeresemények nyomon követése
