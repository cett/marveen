# 18 - Profil

A Profil nézet a saját fiókod kezelésére szolgál: névmegjelenítés, email, jelszócsere és munkamenet-kezelés. A beállítások csak a saját fiókodra vonatkoznak.

---

## Személyes adatok

Az oldal tetején az inicálék alapján generált avatar, a megjelenített név, a felhasználónév és a szerepkör látható.

**Megjelenített név és email szerkesztése:** kattints a mezőre, módosítsd az adatokat, majd mentsd el. Az email-cím opcionális.

---

## Jelszócsere

A **Jelszó módosítása** gombra kattintva felugrik egy ablak:

1. Add meg a jelenlegi jelszót.
2. Add meg az új jelszót (minimum 12 karakter).
3. Ismételd meg az új jelszót.

A mentés után az aktív munkameneteid érvényesek maradnak -- csak az új bejelentkezésekre vonatkozik az új jelszó.

---

## Munkamenetek

A **Munkamenetek** szekció mutatja, hány aktív böngésző-munkamenet van nyitva. A **Kiléptetés minden eszközről** gomb minden aktív munkamenetet érvényteleníti -- beleértve a jelenlegi böngészőt is. Utána újra be kell jelentkezni.

---

## Hitelesítési visszaállítás

Ez a szekció a belépési visszautakat írja le arra az esetre, ha elfelejtettél jelszót, kizártad magad, vagy egy kiadott hitelesítő adat rossz kézbe kerülhetett. Alapelv: aki a gazdagépen parancsot tud futtatni, az a gyökér-hitelesítő.

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

- [15 - Felhasználók](15-felhasznalok.md) `[ADMIN]` -- felhasználók kezelése, eszközkulcsok
- [13 - Audit napló](13-audit.md) `[ADMIN]` -- visszaállítási bejegyzések keresése
