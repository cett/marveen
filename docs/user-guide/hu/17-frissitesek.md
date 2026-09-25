# 17 - Frissítések

A Frissítések nézet a rendszer verziókövetését, a változásnaplót és a hitelesítési visszaállítási eszközöket foglalja össze.

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

## Hitelesítési visszaállítás

Ez a szekció a belépési visszautakat írja le. Alapelv: aki a gazdagépen parancsot tud futtatni, az a gyökér-hitelesítő -- minden visszaút erre épül.

### `npm run dashboard-user` -- a break-glass eszköz

A CLI közvetlenül az adatbázist írja (nincs HTTP, nincs auth-kapu), ezért akkor is működik, ha a webes belépés félre van konfigurálva vagy nem érhető el:

```bash
npm run dashboard-user -- list                           # kik léteznek
npm run dashboard-user -- reset-password <felhasznalo>   # elfelejtett jelszó visszaállítása
npm run dashboard-user -- remove <felhasznalo>           # user törlése
npm run dashboard-user -- sessions:clear [<felhasznalo>] # böngésző-sessionök törlése
npm run dashboard-user -- security:reset                 # vészhelyzeti reset (lásd lent)
```

A `reset-password` nem kéri a régi jelszót -- minden futásáról audit-bejegyzés készül és értesítés megy a csatornán.

### `security:reset` -- a pánikgomb

Egy lépésben:

- **minden eszközkulcsot visszavon** (Bridge, telefon -- újra kell párosítani),
- **minden böngésző-munkamenetet töröl** (mindenki újra bejelentkezik).

Amihez nem nyúl: a jelszavak és a felhasználói fiókok megmaradnak, a dashboard-token tovább működik. Ez a "kiadott hozzáférések valamelyike elszabadult, vágjuk el most mindet" kar -- nem gyári visszaállítás.

A futó szerver legfeljebb 60 másodpercen belül érvényesíti a resetet; restart nem szükséges.

### HTTP break-glass (token birtokában)

A dashboard-token birtokosa a `POST /api/auth/password` végponton `current_password` nélkül, `username` megadásával állíthat át jelszót. Csak `token` hitelesítéssel érhető el -- session, eszközkulcs vagy föderált principal 403-at kap.

### Audit

Minden visszaállítási művelet a `config_change_log` táblába ír (`security.*` kulcsokkal, kizárólag metaadat: felhasználónév és darabszámok, soha hitelesítő anyag). Az események az Audit napló nézetben a `config` forrás alatt kereshetők.

---

## Kapcsolódó fejezetek

- [13 - Audit napló](13-audit.md) -- visszaállítási bejegyzések keresése
- [15 - Felhasználók](15-felhasznalok.md) -- dashboard-felhasználók és eszközkulcsok
