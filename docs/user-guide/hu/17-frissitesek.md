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

## Kapcsolódó fejezetek

- [18 - Profil](18-profil.md) -- jelszó-visszaállítás, break-glass, security:reset
- [13 - Audit napló](13-audit.md) -- rendszeresemények nyomon követése
