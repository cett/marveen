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

## Föderált ágensek

Ha a flottában föderált (másik szerveren futó) társrendszer is konfigurálva van, azok ágenseinek kártyái szintén megjelennek egy "Föderált" jelvénnyel, és a kapcsolatuk állapotát is mutatják. Ezeknek az ágenseknek az Üzenetek nézetben is lehet üzenni.

---

## Tippek

- A kártya-rácson belüli tmux-parancs másolása gyors hozzáférést ad a munkamenethez, ha a webes terminál nem elérhető.
- A folyamat-jelző valós időben frissül; ha egy ágens leáll, a kártya azonnal mutatja.
- Az automatikus újraindítás és a tétlenség-kiürítés egymástól függetlenül konfigurálható; az ütemezett feladatokkal való kölcsönhatásra a részletlapon figyelmeztetés jelenik meg.
