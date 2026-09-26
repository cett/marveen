# Feladatok

A Feladatok nézet az ütemezett feladatokat kezeli. Minden feladat egy meghatározott ágenshez van rendelve, és cron-ütemezés szerint automatikusan fut - az ágens ütemező futtatja, amely percenként ellenőrzi az esedékes feladatokat.

---

## Feladattípusok

| Típus | Leírás |
|-------|--------|
| **Feladat** | Minden futás után értesítés érkezik az eredményről |
| **Szívdobogás** | Csak akkor értesít, ha fontos vagy sürgős eseményt talál; csendes futásnál nincs visszajelzés |

A szívdobogás típus folyamatos háttér-ellenőrzésre való (pl. naptár, e-mail, kanban figyelés), míg az egyszerű feladat típus mindig jelenti az eredményt.

---

## Nézetek

A feladatok háromféle nézetben tekinthetők meg:

- **Lista** - táblázatos nézet az összes feladattal
- **Idővonal** - napi bontás, vízszintes csávban mutatja a futásokat
- **Hét** - heti naptár-szerű megjelenítés

---

## A lista oszlopai

| Oszlop | Leírás |
|--------|--------|
| **Típus** | Feladat vagy Szívdobogás |
| **Név** | Egyedi azonosító (módosítás után nem változtatható) |
| **Leírás** | Opcionális rövid szöveg |
| **Ütemezés** | Cron-kifejezés emberi olvasható formában |
| **Ágens** | Melyik ágens futtatja |
| **Státusz** | Aktív (live) vagy Vázlat/Jóváhagyás alatt |
| **Műveletek** | Szüneteltetés / Folytatás / Szerkesztés / Törlés |

---

## Új feladat létrehozása

1. Kattints az **+ Feladat** gombra.
2. Add meg a nevet (egyedi, utólag nem módosítható) és az opcionális leírást.
3. Válaszd ki a feladattípust (Feladat / Szívdobogás).
4. Ha szívdobogást választottál, a beépített sablonok közül egyet kiválaszthatod kiindulópontnak:
   - **Naptár** - közeli esemény figyelése (15 percenként)
   - **E-mail** - sürgős levél figyelése (30 percenként)
   - **Kanban** - lejáró kártyák figyelése (2 óránként)
   - **Teljes** - naptár + e-mail + kanban együtt (15 percenként)
5. Írd meg az utasítást (prompt), amelyet az ágens kap.
6. Állítsd be az ütemezést:
   - **Naponta** / **Hétköznapokon** / **Hétfőnként** / **Péntekeken** - időponttal
   - **Óránként** / **2 óránként** / **4 óránként** / **30 percenként** - fix intervallum
   - **Egyéni** - tetszőleges cron-kifejezés
7. Válaszd ki a célágensét.
8. Kattints a **Mentés** gombra.

---

## Szüneteltetés és folytatás

A lista sorában a szünet- vagy lejátszás-gombbal az adott feladat ideiglenesen szüneteltethető, majd folytatható. Szüneteltetett feladat nem fut, de a konfigurációja megmarad.

---

## Szerkesztés

Egy feladatra kattintva, vagy a sor szerkesztés-ikonját választva megnyílik a szerkesztő-modális. A feladat neve nem módosítható szerkesztés során; minden más mező igen.

---

## Bérlő-szűrő

A nézet tetején bérlő-szelektor érhető el:

- **Csak flotta-szintű** - az összes bérlőhöz nem kötött feladatot mutatja
- Egy adott bérlő kiválasztásával csak az ahhoz tartozó feladatok jelennek meg

---

## Tippek

- A szívdobogás típusú feladatoknál a prompt fogalmaz meg konkrét döntési feltételt ("ha X, szólj Telegramon; ha nincs semmi, ne írj semmit"), hogy ne legyen felesleges értesítési zaj.
- Az automatikus újraindítási tétlenség-kiürítés és az ütemezett feladatok kölcsönhathatnak; ha egy feladat sűrűbben fut, mint az ágens tétlenségi ablaka, az ágens soha nem kerül kiürítésre. Erről az Ágensek nézet részletlapján figyelmeztetés jelenik meg.
- Egyéni cron-kifejezés megadásánál a rendszer a szerver időzónáját (Europe/Budapest) használja.
