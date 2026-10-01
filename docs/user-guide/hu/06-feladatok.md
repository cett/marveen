# Feladatok

A Feladatok nézet az ütemezett feladatokat kezeli. Minden feladat egy meghatározott ágenshez van rendelve, és cron-ütemezés szerint automatikusan fut - az ütemező futtatja, amely 15 másodpercenként ellenőrzi az esedékes feladatokat. Kivétel a parancs típus, amely közvetlenül futtat egy shell-parancsot, és nem von be ágenst (lásd lent).

---

## Feladattípusok

| Típus | Leírás |
|-------|--------|
| **Feladat** | Minden futás után értesítés érkezik az eredményről |
| **Szívdobogás** | Csak akkor értesít, ha fontos vagy sürgős eseményt talál; csendes futásnál nincs visszajelzés |
| **Parancs** | Közvetlenül futtat egy shell-parancsot, AI ágens nélkül; ismételt hiba után Telegram-riasztást küld |

A szívdobogás típus folyamatos háttér-ellenőrzésre való (pl. naptár, e-mail, kanban figyelés), míg az egyszerű feladat típus mindig jelenti az eredményt. A parancs típus az AI-t nem igénylő infrastruktúra-feladatokra való, például az éjszakai adatmentésre.

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
| **Típus** | Feladat, Szívdobogás vagy Parancs |
| **Név** | Egyedi azonosító (módosítás után nem változtatható) |
| **Leírás** | Opcionális rövid szöveg |
| **Ütemezés** | Cron-kifejezés emberi olvasható formában |
| **Ágens** | Melyik ágens futtatja (a parancs típusú feladatok futtatásához nem használja) |
| **Státusz** | Aktív (live) vagy Vázlat/Jóváhagyás alatt |
| **Műveletek** | Aktiválás (csak vázlatnál) / Futtatás most / Szüneteltetés / Folytatás / Futási előzmények / Törlés; szerkeszteni a sorra kattintva lehet |

---

## Új feladat létrehozása

1. Kattints az **+ Feladat** gombra.
2. Add meg a nevet (egyedi, utólag nem módosítható) és az opcionális leírást.
3. Válaszd ki a feladattípust (Feladat / Szívdobogás / Parancs). A parancs típusú feladat prompt helyett egy shell-parancsot, egy opcionális időkorlátot és azt a számot kéri, ahány egymás utáni hiba után riasztás megy; lásd [Parancs típusú feladatok](#parancs-típusú-feladatok).
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

## Feladat futtatása azonnal

A lista sorában a **Futtatás most** gomb azonnal, az ütemezéstől függetlenül futtatja a feladatot. Még nem aktív feladatnál a gomb le van tiltva, szüneteltetett feladatot pedig nem lehet futtatni.

- Feladat vagy szívdobogás esetén az utasítás a hozzárendelt ágenshez kerül. Ha az ágens éppen dolgozik, a kézbesítés félre kerül, és újrapróbálódik.
- Parancs típusú feladatnál a shell-parancs közvetlenül lefut, és a kérés azonnal `command: started` válasszal tér vissza (ezt a megerősítő üzenet is mutatja). Az eredmény nem része ennek a válasznak, aszinkron módon rögzítődik (lásd [Parancs típusú feladatok](#parancs-típusú-feladatok)). Ugyanez elérhető a `POST /api/schedules/{name}/run` végponton is.

---

## Parancs típusú feladatok

A parancs típusú feladat egy nyers shell-parancsot (`bash -lc`) futtat a szerveren. Nincs benne AI modell és ágens-munkamenet, ezért nem fogyaszt tokent, és akkor is működik, ha az ágens le van állítva vagy éppen dolgozik. Olyan ellenőrzésekre és munkákra való, amelyek nem függhetnek AI-tól: éjszakai adatmentés, token-frissítés, lemez-ellenőrzés.

| Beállítás | Jelentés |
|-----------|----------|
| `command` | A futtatandó shell-parancs |
| `timeoutMs` | Időkorlát ezredmásodpercben (alapértelmezetten 10000) |
| `failThreshold` | Hány egymás utáni hiba után megy riasztás (alapértelmezetten 2) |

Működése:

- **Siker és hiba** - a 0-s kilépési kód siker. Bármilyen más kilépési kód, az indítás sikertelensége vagy az időkorlát elérése hiba. A standard kimenet elvész; a hibakimenet első 200 karaktere a hiba részleteként megmarad.
- **Nincs visszatartás** - a parancs típusú feladat figyelmen kívül hagyja az ágens-feladatokra érvényes "kihagyás, ha foglalt" opciót, a használati-keret miatti visszatartást és az előellenőrzést.
- **Aszinkron** - a parancs a háttérben fut, és soha nem blokkolja a dashboardot, így akár a dashboard saját API-ját is hívhatja. Az időkorlát elérésekor a parancs által indított teljes folyamatfa leáll (először szelíd leállítás, 2 másodperc után kényszerített), nem csak a shell.
- **Nincs átfedés** - ha az előző futás még tart, amikor a következő esedékes lenne, vagy amikor a Futtatás most gombot nyomod, az új futás kimarad ahelyett, hogy kétszer indulna.
- **Leállás után** - ha a dashboard le volt állva, amikor egy parancs típusú feladat esedékes lett, a futás a következő induláskor pótlódik, amíg alapértelmezetten legfeljebb 24 órás (a feladatoknál 3 óra, a szívdobogásoknál 30 perc). A régebbi esedékességek kihagyottként kerülnek rögzítésre.

### Állapotfájl és hiba-riasztások

Minden futás frissíti a `store/command-task-health.json` fájlt, amely parancs típusú feladatonként egy bejegyzést tartalmaz: az egymás utáni hibák számát, hogy ment-e már riasztás, az utolsó állapotot (`ok` vagy `fail`) és az utolsó futás idejét (ezredmásodperc az epoch óta).

- Egy sikeres futás nullázza a hibaszámlálót.
- Amikor a számláló eléri a `failThreshold` értékét, egyetlen Telegram-riasztás megy a tulajdonosnak a hiba részleteivel. A további hibák nem ismétlik a riasztást.
- A riasztás utáni első sikeres futás egyetlen "helyreállt" üzenetet küld, és törli a riasztási állapotot.
- A riasztáshoz be kell állítani a Telegram bot tokent és a tulajdonos csevegését; ennek hiányában a riasztás kimarad, és csak a naplóba kerül. A riasztás szövege jelenleg mindig magyar.

Minden lefutott futás bekerül a feladat futási előzményeibe is. A listában látható `parancs lefutott` jelvény csak azt jelzi, hogy a futás elindult; az eredményt az állapotfájlból lehet kiolvasni.

### Beállítás

Az Új feladat ablakban válaszd a **Parancs (shell, LLM nélkül)** típust. Az ablak ilyenkor a **Parancs** mezőt (kötelező), az **Időkorlát (ms)** és a **Riasztás ennyi egymás utáni hiba után** értékét kéri, a prompt nem kötelező, és nem kerül elküldésre. A Szerkesztés ablak a meglévő parancs típusú feladatot ugyanígy mutatja, letiltott típusválasztóval, és mentéskor megtartja a típusát.

Az API-n a `POST /api/schedules` hívás `command` típussal `command` értéket kér, `prompt` nélkül; a `timeoutMs` és a `failThreshold` opcionális pozitív egész szám.

A szerver elutasítja azt a módosítást, amely a parancs típusú feladatot másik típusra váltaná, hacsak a kérés kifejezetten nem küldi az `allowTypeChange: true` értéket, így egy régebbi kliens nem alakíthatja át véletlenül.

---

## Szükséges MCP szerverek

Az a feladat, amely MCP szerveren keresztül dolgozik (például e-mail vagy naptár), a konfigurációjában a `requires.mcp_servers` mezővel megadhatja a szükséges szervereket. Az utasítás kézbesítése előtt az ütemező ellenőrzi, hogy minden megnevezett szervernek van-e élő folyamata az ágens munkamenete alatt.

- Ha egy szükséges szerverről bizonyosan kiderül, hogy hiányzik, az utasítás nem kerül kézbesítésre. A futás várakozik, és a későbbi ellenőrzéseken újrapróbálódik, amíg a szerver vissza nem tér; a dashboard naplója megnevezi a hiányzó szervert.
- Az ellenőrzés látja a felhasználói szinten, a projektben és az ágens saját konfigurációjában beállított szervereket (ebben a precedencia-sorrendben). Az `npx`, `bunx` vagy `pnpm dlx` segítségével indított szervereket a csomagnevük alapján ismeri fel.
- Az olyan szerverek, amelyeket folyamat alapján nem lehet azonosítani (távoli, URL-alapú szerverek, olvashatatlan konfiguráció), valamint a távoli gépen futó munkamenetek nincsenek ellenőrizve, és elérhetőnek számítanak.
- A parancs típusú feladatoknál nincs MCP-követelmény ellenőrzés.

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
