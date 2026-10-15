# 17 - Frissítések

A Frissítések nézet a rendszer verziókövetését és a változásnaplót foglalja össze.

---

## Verzió-állapot

Az oldal betöltésekor a rendszer lekérdezi a telepített verzió és a legfrissebb elérhető verzió viszonyát.

- **Naprakész** -- nincs elérhető frissítés.
- **Elérhető frissítés** -- az elérhető új verziók száma és azonosítója megjelenik. A **Frissítés telepítése** gomb elvégzi a frissítést.
- **Hiba** -- ha a verzió-ellenőrzés nem sikerül (pl. nincs hálózat), a hibaüzenet és a jelenlegi verzió látható.

---

## Changelog -- verzió-csoportosítás

Az elérhető változtatások verzió szerint csoportosítva jelennek meg. Minden verzió-csoport tartalmaz egy emberi olvashatóságú összefoglalót és egy lenyitható részlet-listát az egyedi commit-üzenetekkel.

Ha vannak kiadatlan commitok (verzió-tag nélkül), azok "Közelgő" felirattal jelennek meg.

---

## Ág-eltérés figyelmeztetés

Ha a telepített rendszer nem a `main` ágon van, egy figyelmeztető sáv jelenik meg az oldal tetején. A sáv egy parancssort javasol az ághoz való visszatéréshez:

```bash
git checkout main && bash update.sh
```

A sáv bezárható; a bezárás a böngészőben tárolódik (agonként külön). A Frissítések oldalon az ág-állapot mindig látható, a sáv bezárásától függetlenül.

---

## Claude Code frissítés

A verzióállapot alatt egy **Claude Code** kártya mutatja, hogyan tartja magát naprakészen maga a `claude` bináris. Ez különbözik a fenti Marveen-frissítéstől. A kártya csak adminoknak látható.

- **Telepített / legfrissebb kiadott** -- a gépen futó verzió és a legújabb kiadott.
- **Utolsó ellenőrzés** -- mikor futott utoljára a heti frissítő feladat, és hogyan végződött: frissítve, már a legfrissebb, visszatartva (rögzített verzió) vagy sikertelen.
- **Figyelmeztetések** (a kártya széle borostyánsárga lesz):
  - az utolsó frissítési futás sikertelen volt (semmi sem indult újra, és a feladat az első hibánál Telegramon riaszt);
  - az utolsó ellenőrzés 10 napnál régebbi, vagyis a heti feladat nem fut -- nézd meg a Feladatok oldalt. Ha a feladat a beállítása óta még egyszer sem futott, a figyelmeztetés csak akkor jelenik meg, ha a beállítás is több mint 10 napos; az első futás előtt a kártya csak jelzi, hogy a feladat még nem futott, és mikor esedékes;
  - újabb verzió van kiadva, mint a telepített;
  - **újraindítás függőben** -- a frissítés előtt indult sessionök még a régi buildet futtatják;
  - sessionök, amiket nem sikerült automatikusan újraindítani (indítsd újra kézzel).

Működés: a beépített automatikus frissítés minden sessionben ki van kapcsolva. Hetente egyszer (hétfő 06:00) a `claude-update` feladat egyetlen alkalommal frissíti a Claude Code-ot. Utána a dashboard újraindítja a frissítés előtt indult, futó sessionöket -- csak az idle-ket, egyenként, a fő-agenst utoljára. A sub-agentek folytatják a beszélgetésüket; a fő-agens friss beszélgetéssel jön vissza (a memóriája megmarad).

Azonnali frissítéshez nyisd meg a **Feladatok** oldalt, és futtasd most a `claude-update`-et. Verzió tartásához vagy az automatikus újraindítás kikapcsolásához lásd az üzemeltetési útmutatót ("Claude Code frissítés").

---

## Kapcsolódó fejezetek

- [18 - Profil](18-profil.md) -- jelszó-visszaállítás, break-glass, security:reset
- [13 - Audit napló](13-audit.md) -- rendszeresemények nyomon követése
