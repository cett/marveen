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
| **Tenant** | Melyik tenanthoz tartozik a feladat, kis jelvényként az ágens mellett (csak globális adminnak, lásd [Tenantok és feladatok](#tenantok-és-feladatok)) |
| **Műveletek** | Aktiválás (csak vázlatnál) / Futtatás most / Szüneteltetés / Folytatás / Futási előzmények / Törlés; szerkeszteni a sorra kattintva lehet |

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
| `skipped_not_live` | A feladat engedélyezett, de még Vázlat vagy Jóváhagyás alatt van, ezért a jóváhagyási kapu visszatartja. Minden esedékes előfordulás rögzítődik. |
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

Egy feladatra kattintva, vagy a sor szerkesztés-ikonját választva megnyílik a szerkesztő-modális. A feladat neve nem módosítható szerkesztés során; minden más mező igen. Globális adminként itt a tenantot is megváltoztathatod, aminek következménye van: lásd [Feladat áthelyezése másik tenantba](#feladat-áthelyezése-másik-tenantba).

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

A feladatok létrehozása és szerkesztése a dashboardon admin művelet: mindenki másnak a **+ Feladat** gomb rejtett, a sorműveletek pedig le vannak tiltva. A tenant felhasználója ehelyett a csevegésben kéri az ágensét, az ágens pedig az API-n hozza létre a feladatot. Az ilyen feladat:

- annak a tenantnak a része, amelynek a kérését az ágens abban a pillanatban kiszolgálja (amelyikhez a csevegés kötve van), vagy az ágens egyetlen tenantjáé, ha csak egyet szolgál ki;
- mindig **Vázlat** állapotban jön létre: addig nem fut, amíg egy bejelentkezett admin nem aktiválja. A soron ott a tenant-jelvény, az Aktiválás gomb súgószövege pedig megnevezi a tenantot, így az admin jóváhagyás előtt látja, kié a feladat;
- 400-as hibával elutasítódik ("A feladathoz tenant kell", token: `tenant_required`), ha a tenant nem állapítható meg, például ha több tenantot kiszolgáló ágensnek éppen nincs folyamatban lévő kérése. Ilyenkor az admin a dashboardon hozza létre a feladatot, vagy kérd újra az ágenst egy tenant csevegéséből.

A tenantot az ágens saját bejelentéséből veszi a rendszer, ezért a feladat sosem lesz magától aktív: az aktiválás lépése az, ahol egy téves tenant kiderül.

### Mit változtathat egy szerkesztés

A tenant-áthelyezésen kívül egy szerkesztés ezeket a mezőket változtathatja: leírás, prompt, ütemezés, engedélyezett állapot, típus, a foglaltsági és küldési opciók, valamint a parancs beállításai. A jóváhagyási állapot (Vázlat, Aktív), a tenant és a futtató szkript-opciók csak a megfelelő műveletekkel módosíthatók (Aktiválás, az admin tenant-áthelyezése), a szerkesztésben egyszerű elküldésükkel soha. Egy meglévő feladat ágensét csak admin változtathatja, és csak olyanra, amely kiszolgálja a feladat tenantját. Ez akkor is így van, ha a szerepkör-kikényszerítés nincs bekapcsolva; hogy mit ad hozzá csak a kikényszerítés, azt a [15 - Felhasználók](15-felhasznalok.md) fejezet írja le.

---

## Tippek

- A szívdobogás típusú feladatoknál a prompt fogalmaz meg konkrét döntési feltételt ("ha X, szólj Telegramon; ha nincs semmi, ne írj semmit"), hogy ne legyen felesleges értesítési zaj.
- Az automatikus újraindítási tétlenség-kiürítés és az ütemezett feladatok kölcsönhathatnak; ha egy feladat sűrűbben fut, mint az ágens tétlenségi ablaka, az ágens soha nem kerül kiürítésre. Erről az Ágensek nézet részletlapján figyelmeztetés jelenik meg.
- Egyéni cron-kifejezés megadásánál a rendszer a szerver időzónáját (Europe/Budapest) használja.
