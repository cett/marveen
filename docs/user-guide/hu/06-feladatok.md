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
| **Státusz** | Aktív (live, jelvény nélkül), vagy egy jelvény: **piszkozat** (még sosem hagyták jóvá) vagy **jóváhagyásra vár** (korábban jóváhagyott, azóta módosították; lásd [Élő feladat szerkesztése: újabb jóváhagyás](#élő-feladat-szerkesztése-újabb-jóváhagyás)) |
| **Tenant** | Melyik tenanthoz tartozik a feladat, kis jelvényként az ágens mellett (csak globális adminnak, lásd [Tenantok és feladatok](#tenantok-és-feladatok)) |
| **Műveletek** | Aktiválás (csak vázlatnál és jóváhagyásra váró feladatnál, csak adminnak) / Futtatás most / Szüneteltetés / Folytatás / Futási előzmények / Törlés; szerkeszteni a sorra kattintva lehet |

---

## Új feladat létrehozása

1. Kattints az **+ Feladat** gombra.
2. Globális adminként válaszd ki a **Tenant**et, amelyhez a feladat tartozik (a mező az ablak tetején van; lásd [Tenantok és feladatok](#tenantok-és-feladatok)). Más felhasználónak nincs ilyen mezője, a feladat a saját tenantjához kerül.
3. Add meg a nevet (egyedi, utólag nem módosítható) és az opcionális leírást.
4. Válaszd ki a feladattípust (Feladat / Szívdobogás / Parancs). A parancs típusú feladat prompt helyett egy shell-parancsot, egy opcionális időkorlátot és azt a számot kéri, ahány egymás utáni hiba után riasztás megy; lásd [Parancs típusú feladatok](#parancs-típusú-feladatok).
5. Ha szívdobogást választottál, a beépített sablonok közül egyet kiválaszthatod kiindulópontnak:
   - **Naptár** - közeli esemény figyelése (15 percenként)
   - **E-mail** - sürgős levél figyelése (30 percenként)
   - **Kanban** - lejáró kártyák figyelése (2 óránként)
   - **Teljes** - naptár + e-mail + kanban együtt (15 percenként)
6. Írd meg az utasítást (prompt), amelyet az ágens kap.
7. Állítsd be az ütemezést:
   - **Naponta** / **Hétköznapokon** / **Hétfőnként** / **Péntekeken** - időponttal
   - **Óránként** / **2 óránként** / **4 óránként** / **30 percenként** - fix intervallum
   - **Egyéni** - tetszőleges cron-kifejezés
8. Válaszd ki a célágenst. Ha az ablakban van tenant-mező, a lista csak a kiválasztott tenantot kiszolgáló ágenseket kínálja.
9. Kattints a **Mentés** gombra.

Aktív (live) feladatot csak bejelentkezett admin hoz létre. Amit bárki más hoz létre (tenant-felhasználó a dashboardon, API-tokenes felhasználó, ágens), az **piszkozatként** indul, és addig nem fut, amíg egy bejelentkezett admin nem aktiválja. Egy tenantnak egyszerre legfeljebb **20** jóváhagyásra váró feladata lehet (piszkozatok és jóváhagyásra váró feladatok együtt): a 21. piszkozatot a rendszer 400-as hibával elutasítja (token: `limit_exceeded`, "This tenant already has N schedules waiting for review (max 20); an admin must activate or delete some first"). Az aktív feladatok nem számítanak bele, egy feladat törlése helyet szabadít fel, a tenant már meglévő feladatának szerkesztését a korlát sosem akadályozza, és a bejelentkezett admin által létrehozott aktív feladatra nem vonatkozik.

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

## Futási előzmények és kihagyott futások

A lista sorában a **Futási előzmények** művelet a feladat legutóbbi 10 futását mutatja: az időpontot, az állapotot és a becsült tokenhasználatot. A szokásos állapotok Rendben, Hiba és Kihagyva néven jelennek meg; minden más állapot a tárolt nevén látszik.

Az ütemező nem hagyja nyomtalanul eltűnni egy engedélyezett feladat esedékes előfordulását. Ha egy előfordulás esedékes, de a feladatot visszatartják, a futási előzményekbe egy sor kerül, előfordulásonként egyszer, és minden olyan ágensre külön, amelyen a feladat futott volna:

| Állapot | Jelentés |
|---------|----------|
| `skipped_not_live` | A feladat engedélyezett, de még piszkozat vagy jóváhagyásra vár, ezért a jóváhagyási kapu visszatartja. Minden esedékes előfordulás rögzítődik. |
| `skipped_disabled` | A feladatot a többi feladat többségével egyszerre kapcsolták ki (lásd lent). Amíg kikapcsolva marad, minden esedékes előfordulás rögzítődik, legfeljebb 24 óráig. |
| `skipped_tenant_mismatch` | A feladat engedélyezett és aktív, de a tenantja és az ágense már nem illik össze: az ágenst kikapcsolták a feladat tenantjánál, a tenantot letiltották vagy megváltozott a fő ágense, esetleg az ágens már nem létezik. Amíg a páros újra nem érvényes, minden esedékes előfordulás rögzítődik. |

Ezek a sorok csak azt rögzítik, hogy az előfordulást visszatartották; a feladat nem fut le. Az a feladat, amelyet te magad szüneteltetsz, vagy egy különálló kapcsolgatás a megszokott művelet: nem hagy sort maga után.

A `skipped_tenant_mismatch` azért van, mert egy tenant feladatának olyan ágensen kell futnia, amely kiszolgálja azt a tenantot: az ágens munkamenete a feladatból veszi át a tenantot, és vele a tenant skilljeit. Ez az ellenőrzés előtt az ilyen feladat tovább futott, a skilljei pedig észrevétlenül zárva maradtak. Most nem fut, a tulajdonos pedig egyetlen értesítést kap, amikor a hiba kezdődik (Telegram-üzenet, ha a Telegram bot token és a tulajdonosi chat be van állítva, a feladat, az ágens és a tenant nevével; a szöveg jelenleg mindig magyar; emellett audit naplóbejegyzés). Az értesítés nem ismétlődik, amíg a feladat hibás marad, egy későbbi újabb hibánál viszont újra jön (és a dashboard újraindítása után is, mert a jelzőt a memória tartja). A javításhoz engedélyezd újra az ágenst a tenantnak, vagy szerkeszd a feladatot, és told át egy hozzá illő tenantba és ágenshez. A parancs típusú feladat nem futtat ágenst, ezért ez az ellenőrzés nem tartja vissza. Az ilyen sorok beleszámítanak az alábbi tömeges visszatartás riasztásba.

Ha az engedélyezett feladatok többsége egyszerre van visszatartva (legalább 4 feladat van játékban, és több mint a fele), az ütemező ezt hibának tekinti, nem szándékos szüneteltetésnek. Ilyenkor a tulajdonos egyetlen Telegram-riasztást kap a visszatartott feladatok listájával (ha a Telegram bot token és a tulajdonosi chat be van állítva; a riasztás szövege jelenleg mindig magyar), az esemény pedig az audit naplóba is bekerül. Új riasztás addig nem jön, amíg a helyzet meg nem szűnik. Ha ilyen riasztást látsz, nézd meg a feladatok **Státusz** és engedélyezett állapotát, valamint hogy minden feladat tenantja és ágense még összeillik-e.

---

## Szüneteltetés és folytatás

A lista sorában a szünet- vagy lejátszás-gombbal az adott feladat ideiglenesen szüneteltethető, majd folytatható. Szüneteltetett feladat nem fut, de a konfigurációja megmarad.

---

## Szerkesztés

Egy feladatra kattintva, vagy a sor szerkesztés-ikonját választva megnyílik a szerkesztő-modális. A feladat neve nem módosítható szerkesztés során; minden más mező igen. Globális adminként itt a tenantot is megváltoztathatod, aminek következménye van: lásd [Feladat áthelyezése másik tenantba](#feladat-áthelyezése-másik-tenantba). Aki nem bejelentkezett admin, a saját tenantja feladatait szintén szerkesztheti, élő feladatnál egy következménnyel: lásd a következő szakaszt.

---

## Élő feladat szerkesztése: újabb jóváhagyás

Egy jóváhagyott (live) feladatban csak a jóváhagyott tartalom megbízható. Ha a bejelentkezett adminon kívül más módosítja azt, amit a feladat végrehajt, a módosítás elmentődik, de a feladat visszakerül jóváhagyásra.

**Kire vonatkozik.** Minden hívóra, aki nem bejelentkezett admin: tenant-felhasználó a dashboardon, API-tokenes felhasználó, és a megosztott dashboard-tokennel hívó ágens (a megosztott token admin szerepkört hordoz, de nem egy ember ül a képernyő előtt). A bejelentkezett admin szerkesztése sosem küldi vissza a feladatot jóváhagyásra. Eszközkulcs és föderációs principal egyáltalán nem módosíthat ütemezett feladatot.

**Mely módosítások váltják ki.** Ezek bármelyikének megváltoztatása: prompt, parancs, típus, ütemezés, ágens, célsession, időkorlát, hibaküszöb, valamint a "kihagyás, ha foglalt" és a kényszerített küldés opció. Ezek nem váltják ki: a **leírás** és az **engedélyezett** állapot (szüneteltetés, folytatás). Ha a kérés azokat az értékeket küldi vissza, amelyek a feladatnak már megvannak (a dashboard minden mentéskor ezt teszi), az nem módosítás, és nem vált ki semmit. Az a feladat, amely nem aktív (piszkozat vagy már jóváhagyásra vár), szerkesztéskor megtartja a státuszát, és új értesítés sem megy.

**Mi történik.**

- A módosítás elmentődik, így az admin az új tartalmat nézi át, nem egy elveszettet. A feladat státusza `pending_review` lesz, és a feladat leáll: az ütemező minden esedékes előfordulást kihagy, és mindegyiket `skipped_not_live` állapottal rögzíti a futási előzményekben (lásd [Futási előzmények és kihagyott futások](#futási-előzmények-és-kihagyott-futások)). A dashboardon a Futtatás most és a Szüneteltetés le van tiltva a még nem aktív feladatnál, az API pedig elutasítja a nem admin kézi futtatását (`409 not_live`); csak bejelentkezett admin futtathat még nem aktív feladatot, előnézetként. A feladat így marad, amíg egy admin nem aktiválja.
- A lista a **jóváhagyásra vár** jelvényt mutatja. Mentés után a dashboard ezt írja: "Mentve. A feladat szünetel, amíg egy admin jóvá nem hagyja a változtatást". Az API-n a mentés `{ ok: true, status: "pending_review", review_required: true, changed: [...] }` választ ad a jóváhagyást kiváltó mezők nevével; az a mentés, amely nem vált ki újabb jóváhagyást, sima `{ ok: true }` választ kap.
- A főágens egyetlen üzenetet kap a rendszertől, amely `[SCHEDULE_REVIEW]` előtaggal indul, és megnevezi a feladatot, a tenantot, az okot (`edited`, vagy `created`, ha nem admin hozott létre piszkozatot), a megváltozott mezőket és a módosítót. Feladatonként és okonként óránként legfeljebb egyszer megy, és egy ki nem kézbesíthető üzenet sosem buktatja el a mentést. Hogy a főágens mit kezd vele (például szól-e a tulajdonosnak Telegramon), a saját utasításain múlik.
- Minden feladat-írás (létrehozás, szerkesztés, szüneteltetés vagy folytatás, törlés, aktiválás) bekerül az audit nyomvonalba, a végrehajtó és a megváltozott mezők nevével. A jóváhagyásra visszaküldött feladat `review_requested` néven kerül be.

**Hogyan hagyja jóvá az admin.** A bejelentkezett admin az **Aktiválás** gombra kattint a piszkozat vagy a jóváhagyásra váró feladat sorában; más nem teheti (a nem admin 403-at kap, gombbal vagy gomb nélkül). A dashboard elküldi a megjelenített tartalom ujjlenyomatát is (`contentHash`, amelyet a `GET /api/schedules` minden feladatnál visszaad; a promptot, parancsot, típust, ütemezést, ágenst, célsessiont, időkorlátot, hibaküszöböt és a két foglaltsági opciót fedi, a leírást és az engedélyezett állapotot nem). Ha a feladatot azután szerkesztették újra, hogy az admin betöltötte a listát, az aktiválás `409 stale_revision` válasszal elutasítódik, és semmi sem változik: a dashboard azt írja, hogy "A feladat megváltozott, mióta megnyitottad -- nézd át az aktuális változatot, és aktiváld újra", újratölti a listát, az admin pedig azt aktiválja, ami most látszik. Így a megtekintés és a kattintás között szerkesztett feladatot nem lehet látatlanban jóváhagyni. Képernyő nélküli hívó, például egy admin által futtatott szkript, elhagyhatja az ujjlenyomatot (`expected_hash`, a `POST /api/schedules/{name}/activate` lekérdezési paramétere); ilyenkor az aktiválás ellenőrzés nélkül működik.

**A másik tenantba áthelyezés** külön szabály (a feladat piszkozat lesz, lásd lent), és nem ezen a szabályon megy át.

---

## Tenantok és feladatok

Minden ütemezett feladat pontosan egy tenanthoz tartozik. Tenant nélküli, "flotta-szintű" hatókör nincs: a rendszert működtető feladatok (éjszakai adatmentés, memória-karbantartás, a figyelők) a `default` tenanthoz tartoznak, mint minden feladat, amelynek létrehozásakor nem neveztek meg tenantot.

### Ki mit lát

- **A globális adminok** tenant-szelektort kapnak a nézet tetején, **Tenant** mezőt a feladat ablakában és tenant-jelvényt minden soron. A szelektor az **Összes tenant** vagy egy adott tenant közül enged választani; a "csak flotta-szintű" opció megszűnt.
- **Mindenki más** nem lát szelektort, mezőt és jelvényt sem. Csak a saját tenantja feladatait kapja, és amit létrehoz, az is ehhez tartozik. Másik tenant feladata nem jelenik meg, és ha közvetlenül kérnék el, úgy válaszol a rendszer, mintha nem létezne.

### A tenant-mező az ablakban

A mező az Új feladat és a Feladat szerkesztése ablak tetején van (csak globális adminnak). Az új feladat azon a tenanton indul, amelyre a lista éppen szűrve van, vagy `default`-on, ha a szűrő az összes tenantot mutatja. Ha másik tenantot választasz, az ágenslista a tenantot kiszolgáló ágensekre szűkül; a jelenlegi ágens csak akkor marad kiválasztva, ha még szerepel a listán.

Melyik ágenst nevezheti meg egy feladat:

- **`default` tenant** - a fő ágenst, valamint minden olyan ágenst, amely nincs külön tenantra engedélyezve, vagy kifejezetten engedélyezve van a `default` tenantra.
- **Bármely más tenant** - csak a tenantra engedélyezett ágenst (vagy a tenant saját fő ágensét). A flotta fő ágense itt nem engedett, és az API-n létező `all` érték sem (az összes ágensre szétosztás nem tartozhat egyetlen tenanthoz). Az ilyen tenant feladatának meg kell neveznie az ágensét.

A szerver mentéskor ugyanezt a szabályt ellenőrzi, ezért az érvénytelen kombinációt 400-as hibával elutasítja (adminnak is), ahogy az ismeretlen vagy letiltott tenantot is.

### Feladat áthelyezése másik tenantba

Egy meglévő feladat tenantját csak bejelentkezett globális admin változtathatja meg. Az ablak a következményre azonnal figyelmeztet, amint másik tenantot választasz: **a feladat visszakerül Vázlat állapotba, és újra aktiválni kell**. Mentés után egy üzenet ezt ki is mondja ("Feladat áthelyezve, piszkozat: aktiválni kell"). Az áthelyezést úgy ellenőrzi a rendszer, mint az új feladatot: az ágensnek ki kell szolgálnia az új tenantot, ezért ha a régi ágens nem teszi, a kettőt együtt változtasd. Az a szerkesztés, amely nem érinti a tenantot, nem változtat a feladat tenantján és státuszán.

### Csevegésen át vagy ágens által létrehozott feladat

Az a tenant-felhasználó, aki az ütemezett feladatokhoz írási joggal rendelkezik (az `agent` szerepkör, lásd [15 - Felhasználók](15-felhasznalok.md)), a saját tenantja feladatait a dashboardon is létrehozhatja és szerkesztheti: a **+ Feladat** gomb, a szerkesztő ablak és a Futtatás most, Szüneteltetés és Törlés művelet elérhető számára, és minden általa létrehozott feladat piszkozat. A csak olvasó szerepkörű felhasználók (`read_only`, `viewer`) látják a feladatokat, de a **+ Feladat** gomb rejtett, a sorműveletek pedig le vannak tiltva. Mindenkinek, aki nem admin, az **Aktiválás** gomb le van tiltva, mert az aktiválás maga a jóváhagyási lépés. A felhasználó a csevegésben az ágensét is megkérheti, az ágens pedig az API-n hozza létre a feladatot. Az ágens által létrehozott feladat:

- annak a tenantnak a része, amelynek a kérését az ágens abban a pillanatban kiszolgálja (amelyikhez a csevegés kötve van), vagy az ágens egyetlen tenantjáé, ha csak egyet szolgál ki;
- mindig **Vázlat** állapotban jön létre: addig nem fut, amíg egy bejelentkezett admin nem aktiválja. A soron ott a tenant-jelvény, az Aktiválás gomb súgószövege pedig megnevezi a tenantot, így az admin jóváhagyás előtt látja, kié a feladat;
- 400-as hibával elutasítódik ("A feladathoz tenant kell", token: `tenant_required`), ha a tenant nem állapítható meg, például ha több tenantot kiszolgáló ágensnek éppen nincs folyamatban lévő kérése. Ilyenkor az admin a dashboardon hozza létre a feladatot, vagy kérd újra az ágenst egy tenant csevegéséből.

A tenantot az ágens saját bejelentéséből veszi a rendszer, ezért a feladat sosem lesz magától aktív: az aktiválás lépése az, ahol egy téves tenant kiderül.

### Mit változtathat egy szerkesztés

A tenant-áthelyezésen kívül egy szerkesztés ezeket a mezőket változtathatja: leírás, prompt, ütemezés, engedélyezett állapot, típus, a foglaltsági és küldési opciók, a célsession, valamint a parancs beállításai. Ezek többségének módosítása élő feladaton, nem adminként, visszaküldi a feladatot jóváhagyásra (lásd [Élő feladat szerkesztése: újabb jóváhagyás](#élő-feladat-szerkesztése-újabb-jóváhagyás)). A jóváhagyási állapot (Vázlat, Aktív), a tenant és a futtató szkript-opciók csak a megfelelő műveletekkel módosíthatók (Aktiválás, az admin tenant-áthelyezése), a szerkesztésben egyszerű elküldésükkel soha. Egy meglévő feladat ágensét csak admin változtathatja, és csak olyanra, amely kiszolgálja a feladat tenantját. Ez akkor is így van, ha a szerepkör-kikényszerítés nincs bekapcsolva; hogy mit ad hozzá csak a kikényszerítés, azt a [15 - Felhasználók](15-felhasznalok.md) fejezet írja le.

---

## Tenant alapcsomag

Minden `default`-tól különböző tenantnak létrehozható egy kész ütemezett feladat, az **alapcsomag**. Jelenleg egyetlen feladatból áll, a `<tenant>-starter-daily-summary` nevű napi összefoglalóból. Létrehozni csak globális admin tud, a Felhasználók nézet Tenantok fülén (lásd [15 - Felhasználók](15-felhasznalok.md#tenant-alapcsomag)); a feladat utána a Feladatok listájában is ott van, mint bármelyik másik.

| Beállítás | Érték |
|-----------|-------|
| Típus | Feladat |
| Ütemezés | naponta 21:30 (a szerver időzónájában) |
| Nyelv | magyar |
| Ágens | a tenant fő ágense; ha nincs, az egyetlen a tenantnál engedélyezett ágens; több jelölt esetén az admin választ |
| Kezdő állapot | piszkozat, szüneteltetve |

### Mit csinál a feladat

1. Lekérdezi a tenant memóriáját a tenant hatókörével, és az elmúlt 24 óra bejegyzéseit (legfeljebb 50 sort) használja. Más forrásból nem dolgozik: emlékezetből, másik beszélgetésből vagy másik tenant adataiból nem.
2. Ha nincs új bejegyzés, nem ír és nem küld semmit.
3. Ha az ágens napi naplójában aznapra már van "Napi összefoglaló" bejegyzés, kilép, így naponta legfeljebb egy összefoglaló készül.
4. Egy 5-8 mondatos összefoglalót ír az ágens napi naplójába.
5. Csatornaüzenet csak akkor megy, ha a futtató Telegram-kézbesítési utasítást adott a feladatnak (lásd lent). Ilyenkor ugyanez a szöveg megy ki sima szövegként, legfeljebb 1500 karakterben.

Szívdobogás típusú feladatot az alapcsomag nem hoz létre.

### Aktiválás két lépésben

A feladat azért indul piszkozatként és szüneteltetve, hogy semmi ne menjen ki, mielőtt egy ember megnézte.

1. **Aktiválás.** Egy bejelentkezett admin a Feladatok listában az **Aktiválás** gombra kattint a piszkozat soron, a szokásos jóváhagyási lépéssel (lásd [Élő feladat szerkesztése: újabb jóváhagyás](#élő-feladat-szerkesztése-újabb-jóváhagyás)).
2. **Folytatás.** Az aktiválás után a feladat még szüneteltetett. A **Folytatás** gombbal lesz engedélyezett, ehhez a tenant feladatait kezelni tudó felhasználónak (admin vagy `agent` szerepkör) van joga.

Az első csatornaüzenet legkorábban ezek után, a következő 21:30-kor mehet ki.

A piszkozat addig beleszámít a tenant 20 jóváhagyásra váró feladatot engedő korlátjába (lásd [Új feladat létrehozása](#új-feladat-létrehozása)), vagyis egy hely foglalt, 19 marad. Aktiválás vagy törlés felszabadítja.

### Csatornaüzenet és címzettjei

Az összefoglaló csatornaüzenete csak Telegramon, a tenant saját csevegéseibe megy. Címzett az, akire egyszerre igaz, hogy

- van a tenant és a feladat ágense számára létrehozott Telegram csatorna-kötése (lásd [F03 - Üzemeltetés](../../fork-guide/hu/F03-uzemeltetes.md#tenant-skill-kapu)),
- a kötés magánbeszélgetés (a csoportos csevegések kimaradnak), és
- ugyanez a csevegés az ágens Telegram engedélyezett listáján is szerepel.

Legfeljebb 3 címzett kap üzenetet. Másik tenant kötése sosem címzett. Ha nincs ilyen kötés, a feladat nem küld üzenetet, az eredmény csak a napi naplóba kerül. Kötést csak admin hozhat létre (tenant-felhasználó nem), ezért a címzettek körét az admin dönti el.

Ez a szabály minden `default`-tól különböző tenant feladatára érvényes, nem csak az alapcsomagéra: korábban az ágens engedélyezett listájának első bejegyzése kapta az eredményt, ami a flotta tulajdonosa is lehetett. A `default` tenant feladatai és a szívdobogások nem változtak.

### Ha a tenant ágense megváltozik

A feladat követi az ágenst:

- Az Agent-hozzáférés mátrix minden módosítása után a rendszer újraellenőrzi a tenant alapcsomagját. Ha a tenantnak egyértelműen más ágense lett, a feladat az új ágensre kerül, és **visszakerül piszkozat és szüneteltetett állapotba**: újra kell aktiválni és folytatni. Más mezőhöz (prompt, ütemezés, leírás) nem nyúl, a kézi szerkesztések megmaradnak.
- Ha a feladat ágense már nem szolgálja ki a tenantot, és nincs egyértelmű új, a feladat parkol (piszkozat, szüneteltetve), az ágens változatlan marad, a Tenantok fül Alapcsomag panelje pedig ágens-választást kér.
- Ha az átállítást nem bejelentkezett admin váltja ki (például a megosztott tokennel hívó ágens), a főágens `[SCHEDULE_REVIEW]` üzenetet kap `retargeted` okkal, a szokásos óránkénti korláttal. A bejelentkezett admin a saját műveletéből tudja, neki nem megy üzenet.

### Szerkesztés, törlés, ismételt létrehozás

A feladat szerkeszthető és törölhető, mint bármelyik másik. Az Alapcsomag gomb ismételt megnyomása sosem írja felül a meglévő feladatot (a kézzel módosított prompt vagy ütemezés megmarad); a törölt feladatot viszont újra létrehozza. A tenant törlése az alapcsomag feladatát is viszi.

---

## Tippek

- A szívdobogás típusú feladatoknál a prompt fogalmaz meg konkrét döntési feltételt ("ha X, szólj Telegramon; ha nincs semmi, ne írj semmit"), hogy ne legyen felesleges értesítési zaj.
- Az automatikus újraindítási tétlenség-kiürítés és az ütemezett feladatok kölcsönhathatnak; ha egy feladat sűrűbben fut, mint az ágens tétlenségi ablaka, az ágens soha nem kerül kiürítésre. Erről az Ágensek nézet részletlapján figyelmeztetés jelenik meg.
- Egyéni cron-kifejezés megadásánál a rendszer a szerver időzónáját (Europe/Budapest) használja.
