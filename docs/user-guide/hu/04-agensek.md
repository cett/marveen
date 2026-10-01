# Ágensek

Az Ágensek nézet az összes futó és leállított ágensét megjeleníti kártya-nézetben. Innen nyitható meg minden ágens részletlapja, indítható terminál-munkamenet, és hozható létre új ágens.

---

## A kártya-rács

Minden ágens egy kártyán jelenik meg, amelyen látható:

| Elem | Leírás |
|------|--------|
| **Avatar / névbetű** | Az ágens képe vagy nevének kezdőbetűje |
| **Név** | Az ágens megjelenítési neve |
| **Leírás** | Rövid, egy soros leírás |
| **Modell-jelvény** | A konfigurált AI modell neve |
| **Folyamat-jelző** | Fut / Leállva - a tmux munkamenet állapota |
| **Csatorna-jelző** | Online / Offline - a csatorna kapcsolat állapota |
| **Bérlői chip** | Melyik bérlőhöz tartozik az ágens (csak rendszergazda-nézetben) |

A fő ágens kártyája mindig az első helyen jelenik meg, egy külön "Fő" jelvénnyel.

---

## Nézetváltás

A kártya-rács és a szervezeti ábra (hierarchia-fa) között a jobb felső sarokban lévő gombokkal válthat.

---

## Ágens-részletlap

Egy kártyára kattintva megnyílik a részletlap, amelyen hat fül érhető el:

### Áttekintés

- Fut-e az ágens, mióta indul
- Csatorna-kapcsolat állapota
- Kontextus-token-használat
- Automatikus újraindítás beállításai (napi időpont vagy intervallum alapján)
- Tétlenség-kiürítés konfigurációja (context guard)

### Beállítások

- AI modell kiválasztása
- CLAUDE.md szerkesztése (az ágens utasítás-fájlja)
- Személyiség-fájl (soul.md) szerkesztése
- MCP konfigurációs JSON szerkesztése
- Hitelesítési mód és MCP hatókör

A fő ágens beállításai csak olvashatók a dashboardról; szerkesztésük fájlrendszeren vagy Telegramon keresztül lehetséges.

### Csatorna

Az ágens Telegram / Discord / Slack kapcsolatainak állapota, bot-felhasználónév, párosítás kezelése.

### Készségek

Az ágenshez elérhető készség-fájlok (skills) listája.

### Csapat

Az ágens helye a flotta-hierarchiában: szerepkör (vezető / tag), főnök, és delegált ágensek. A fő ágensnél ez a fül nem jelenik meg.

### Tevékenység

Az ágens legutóbbi eszközhívásainak naplója (trace/waterfall nézet).

---

## Új ágens létrehozása

1. Kattints a **+ Ágens** gombra (jobb felső sarok).
2. Add meg a nevet, leírást és a modellt.
3. Válassz avatart a galériából, vagy tölts fel saját képet.
4. Kattints a **Létrehozás** gombra.

A rendszer létrehozza az ágens konfigurációs könyvtárát; az ágens a következő újraindításkor aktiválódik.

---

## Terminál és Társalgás gombok

Minden futó ágens kártyáján két gyors-művelet gomb jelenik meg:

- **Terminál** - megnyitja az ágens tmux munkamenetét a webes terminálban; a gomb zölden jelenik meg, ha az ágens aktívan dolgozik
- **Társalgás** - megnyitja az ágens korábbi üzeneteinek olvasható átiratát

A `⧉ tmux` gomb az ágens tmux-csatoló parancsát másolja a vágólapra.

---

## Modell-fallback használati limit esetén

A modell-fallback funkció akkor tartja munkában az ágenst, amikor kifogy a csomag használati kerete. Alapértelmezetten ki van kapcsolva; a **Beállítások > Modell fallback** fülön kapcsolható be, ugyanitt adható meg a modell-lánc és a visszaállási idő (csak rendszergazdának; lásd [11 - Beállítások](11-beallitasok.md)).

Bekapcsolt állapotban a rendszer percenként ellenőrzi az összes futó ágenst (és a fő ágenst is). Egy ágens lejjebb kerül, ha az élő terminálján ezt látja:

- kimerült csomag-használati limit üzenetet (az általános rate-limit vagy API-túlterheltség hiba és az "approaching usage limit" figyelmeztetés nem számít), vagy
- "a kiválasztott modell már nem elérhető" hibát, amelyet két egymást követő ellenőrzés is megerősít.

Ekkor az ágens egy lépéssel lejjebb lép a modell-láncban, és a munkamenete újraindul, hogy az olcsóbb modell vegye át a munkát (az al-ágensek a beszélgetésüket folytatják). A váltás csak tétlen ágensnél történik meg; ha az ágens éppen dolgozik, a következő ellenőrzésre halasztódik.

### Fedő-állapot, nem konfig-módosítás

A lefokozás soha nem írja át az ágens beállított modelljét. Ideiglenes felülbírálásként tárolódik a `store/model-fallback-state.json` fájlban (ágensenként: a beállított modell, a fallback modell és a lefokozás ideje). Az ágens minden indításakor, a fő ágens indító szkriptjénél is, először ezt a felülbírálást használja, amíg létezik; egyébként a beállított modellt.

Mivel a felülbírálás lemezen van:

- a dashboard vagy a szerver újraindítása nem veszíti el, a visszaállási időzítő pedig a tárolt lefokozási időponttól számol tovább;
- ha az új modellt érvényesítő újraindítás nem sikerül, a felülbírálás visszaáll az előző állapotára.

### Szünet, lánc és visszaállás

- Minden váltás után 10 perc szünet van új lefokozás előtt, így egy frissen újraindított munkamenet, amely még a régi üzenetet mutatja, nem tudja végigléptetni az ágenst az egész láncon.
- Minden ágens a saját beállított modelljétől indulva, egyesével lépked a láncon. A lánc alján nem történik több semmi.
- Ha a lefokozás óta eltelt a visszaállási idő (alapértelmezetten 330 perc), és a limit üzenet eltűnt, a felülbírálás megszűnik, és az ágens a beállított modelljén indul újra. Ha a limit üzenet még látszik, az ágens a fallback modellen marad. A visszaállás is megvárja, hogy az ágens tétlen legyen.

### Megtekintés és visszaállítás

- Az ágens-kártya modell-jelvénye mindig a beállított modellt mutatja. Lefokozás alatt a részletlap fejléce azt a modellt mutatja, amelyen az élő munkamenet fut (a fallback modellt), mellette `fallback aktív: <modell>` jelzéssel. A Beállítások fül modell-választója továbbra is a beállított modellt mutatja, ugyanazzal a jelzéssel és egy rövid tanáccsal alatta.
- Ha a Beállítások fülön másik modellt választasz és elmented, az lecseréli a felülbírálást: a felülbírálás megszűnik, az ágens pedig az általad választott modellen indul újra. A kiválasztás módosítása nélküli mentés nem csinál semmit: nem megy ki kérés, az ágens nem indul újra, a felülbírálás megmarad, így az ágens a visszaállási idő lejártakor tér vissza a beállított modelljére.
- Ha az ágenst a konfiguráció módosítása nélkül, kézzel szeretnéd visszaküldeni a beállított modelljére, töröld az ágens bejegyzését a `store/model-fallback-state.json` fájlból, és indítsd újra az ágenst. Így állítható vissza a fő ágens is, amelynek modellje a dashboardról nem szerkeszthető.
- A funkció kikapcsolása csak az új lefokozásokat állítja le. Az az ágens, amely már a fallback modellen van, továbbra is visszatér a beállított modelljére: amíg létezik felülbírálás, a rendszer percenként ellenőrzi az ágenst, és ha a lefokozás óta eltelt a visszaállási idő, törli a felülbírálást, és ugyanúgy újraindítja az ágenst, mint bekapcsolt funkciónál (csak tétlen ágenst; a fő ágens újraindul). Kikapcsolt funkciónál a terminálon látszó limit üzenet már nem tartja vissza a visszaállást, és a felülbírálás nélküli ágensekhez nem nyúl a rendszer. A mentett visszaállási idő továbbra is érvényes, így a visszatérés addig tarthat, amíg ez az idő a lefokozás óta el nem telik; ha nem akarsz várni, használd a fenti kézi visszaállítást.
- Ha egy ágens le van állítva, amikor a felülbírálása esedékessé válik, a felülbírálás újraindítás nélkül egyszerűen megszűnik, és az ágens következő indítása a beállított modellt használja. Ez bekapcsolt funkciónál is így van.

---

## Föderált ágensek

Ha a flottában föderált (másik szerveren futó) társrendszer is konfigurálva van, azok ágenseinek kártyái szintén megjelennek egy "Föderált" jelvénnyel, és a kapcsolatuk állapotát is mutatják. Ezeknek az ágenseknek az Üzenetek nézetben is lehet üzenni.

---

## Tippek

- A kártya-rácson belüli tmux-parancs másolása gyors hozzáférést ad a munkamenethez, ha a webes terminál nem elérhető.
- A folyamat-jelző valós időben frissül; ha egy ágens leáll, a kártya azonnal mutatja.
- Az automatikus újraindítás és a tétlenség-kiürítés egymástól függetlenül konfigurálható; az ütemezett feladatokkal való kölcsönhatásra a részletlapon figyelmeztetés jelenik meg.
