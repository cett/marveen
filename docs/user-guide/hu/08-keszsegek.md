# Készségek

A Készségek (Skills) az ágensek újrafelhasználható utasítás-fájljai. Egy készség egy SKILL.md fájl, amely leírja, mikor és hogyan kell elvégezni egy adott feladattípust. A dashboardon az Ágensek nézet részletlapjáról érhetők el.

A forrás a készség-adatbázis: a lemezen lévő SKILL.md fájlok (és a `scripts/`, `references/` kísérő fájlok) az ebből generált cache, amit a frontmatter utáni `GENERATED from the skills DB` sor jelöl. Az ágensek a `PUT /api/skills/sql/<URL-kódolt id>` hívással hoznak létre és módosítanak készséget (`global/<név>` vagy `agent/<ágens>/<név>`, a `/` helyén `%2F`); a közvetlen fájlszerkesztést egy hook még visszaszinkronizálja az adatbázisba, de eltérésnél az adatbázis nyer.

---

## Készség-típusok

| Típus | Leírás |
|-------|--------|
| **Globális** | A `~/.claude/skills/` könyvtárból töltődik be; minden ágens örökli |
| **Egyéni** | Az adott ágens `.claude/skills/` könyvtárában van; csak az az ágens látja |

A globális készségek "Globális" jelvénnyel jelennek meg a listában, és nem törölhetők a dashboardról (az ágens nem törölheti a megosztott állományokat).

---

## A készségek listája

Az Ágensek nézet részletlapján, a **Készségek** fülön az ágens összes elérhető készsége listázva van:

- Készség neve
- Rövid leírás (ha a SKILL.md frontmatter-ben meg van adva)
- Forrás-jelvény (Globális, ha öröklött)
- Törlés gomb (csak egyéni készségeknél aktív)

---

## Új készség hozzáadása

1. Az Ágensek részletlap **Készségek** fülén kattints a **+ Készség** gombra.
2. Két módszer közül választhatsz:

### Létrehozás (manuális)

- Add meg a készség nevét (egyedi, szóközök nélkül ajánlott)
- Add meg a leírást (opcionális, de ajánlott)
- Kattints a **Mentés** gombra

Ez létrehozza a készséget; a tartalmat ezután az ágens a készség-API-n keresztül tölti ki (`PUT /api/skills/sql/<id>`).

### Importálás (fájl feltöltés)

- Húzd a SKILL.md fájlt a feltöltési területre, vagy kattints rá a tallózáshoz
- Kattints a **Feltöltés** gombra

Hasznos, ha egy másik rendszerről vagy korábbi munkából kész készség-fájlt akarsz átvinni.

---

## Készség törlése

Az egyéni (nem globális) készségeknél a lista sorban megjelenik a törlés gomb. Törlés előtt megerősítést kér a rendszer. Globális készség csak a fájlrendszerről törölhető.

---

## Tippek

- A globális készségek az összes ágensnek elérhetők; projekt-specifikus készségeket inkább egyéni helyre tegyél.
- A SKILL.md fájl frontmatter `name` és `description` mezői határozzák meg a listában megjelenő adatokat; ezeket érdemes kitölteni.
- A készségek fájl-alapúak; a dashboard csak a feltöltést és a törlést végzi, a tartalom szerkesztéséhez a fájlrendszert vagy az ágenseket kell használni.
