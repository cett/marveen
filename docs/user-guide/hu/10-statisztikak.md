# Statisztikák

A Statisztikák nézet az ágensek Claude API token-használatát és becsült költségeit mutatja valós idejű összesítésben. Az adatok ágensenkénti bontásban, idővonallal és modell-eloszlással is elérhetők.

---

## Időszak és szűrők

A nézet tetején két szelektor szabályozza a megjelenített adatokat:

- **Időszak** - 1h / 24h / 7d / 30d (alapértelmezett: 7d)
- **Ágens** - az összefoglalóra kattintva vagy a legördülőből szűrhetsz egyetlen ágensre

Az **Adatgyűjtés** gomb manuálisan indít egy gyűjtési futást, amely az aktuálisan futó ágensektől beolvassa a legfrissebb token-statisztikákat; a rendszer rendszeres időközönként automatikusan is gyűjt.

---

## Összefoglaló kártyák

Minden ágenshez egy kártya jelenik meg a bal oldali felső területen. A kártyán látható:

- Az ágens neve és egyedi színe
- Összes bevitt token (input + gyorsítótár-olvasás + gyorsítótár-írás)
- Hívásszám és kimeneti tokenek
- Becsült USD-költség
- Session-szám, token/session és cost/session mutatók

Egy kártyára kattintva az egész nézet az adott ágensre szűr; ismételt kattintásra feloldódik a szűrés.

### Árképzési referenciatábla

| Modell | Input ($/M) | Output ($/M) | Cache-írás ($/M) | Cache-olvasás ($/M) |
|--------|-------------|--------------|-----------------|---------------------|
| claude-sonnet-4-x / sonnet-5 | $3.00 | $15.00 | $3.75 | $0.30 |
| claude-opus-4-x | $15.00 | $75.00 | $18.75 | $1.50 |
| claude-haiku-4-5 | $0.80 | $4.00 | $1.00 | $0.08 |
| claude-fable-5 | $3.00 | $15.00 | $3.75 | $0.30 |

---

## Claude kvóta-ablakok

A Claude API két visszagörgetési ablakot alkalmaz a tokenkorlátokra:

| Kártya | Leírás |
|--------|--------|
| **5 órás ablak** | Az elmúlt 5 óra kumulatív bevitele az aktuális session-időtárcsán |
| **Heti ablak** | Az elmúlt 7 nap kumulatív bevitele hétfői éjféltől |

Az egyik kártyára kattintva az idővonal-diagram a megfelelő ablak kumulatív görbéjét emeli ki.

---

## Idővonal-diagram

A diagram az egyes ágensek token-felhasználását mutatja időben. Vezérlők:

- Ágensre kattintva a diagram csak az adott ágens vonalát jeleníti meg
- Az idővonalban függőleges jelölők mutatják a Claude API visszagörgetési pontjait:
  - **5h** - 5 órás ablak határa
  - **Nap** - éjféli visszaállítás
  - **Hét** - hétfői éjféli visszaállítás
- Az egér ráhúzásával tooltip jelenik meg az adott ponthoz tartozó részletekkel

---

## Modell-eloszlás

A nézet egy kördiagram és egy táblázat formájában mutatja, hogy az összes hívás között melyik Claude-modellt milyen arányban használták. A táblázat oszlopai:

| Oszlop | Leírás |
|--------|--------|
| Modell | A modell azonosítója |
| Hívások | Az adott modellel indított API-hívások száma |
| % | Az összes híváshoz viszonyított arány |
| Becsült USD | A modell becsült összköltsége az időszakban |

---

## Eszköz-statisztikák

Az eszközhívás-statisztikák táblázata az időszakban leggyakrabban hívott eszközöket (tool-okat) mutatja, legfeljebb 50 sort. Az MCP-eszközök szerver szerint csoportosítva jelennek meg.

| Oszlop | Leírás |
|--------|--------|
| Eszköz | Az eszköz neve (`mcp__szerver__nev` vagy belső eszköznév) |
| Hívások | Az időszakban hívott alkalmak száma |
| Arány-sáv | Vizuális arány a legtöbbször hívott eszközhöz képest |
| Szerver | Az MCP-szerver neve, vagy "belső" beépített eszköznél |
| Becsült USD | Az eszközhívásokhoz társított becsült költség |

Az **Ágensenkénti bontás** jelölőnégyzet engedélyezésével egy extra oszlop jelenik meg, amely megmutatja, melyik ágensek használták az adott eszközt.

---

## Részletes napló

A nézet alján egy kereshető, rendezhető táblázat mutatja az egyedi API-hívásokat.

### Szűrők

- **Min. tokenek** - csak a megadott értéknél több beviteli tokennel rendelkező hívások jelennek meg (alapértelmezett: 50 000)
- **Keresés** - szöveg szerinti keresés a hívás tartalmában (legalább 400 ms szünet után aktiválódik)

### Táblázat oszlopai

| Oszlop | Leírás |
|--------|--------|
| Időpont | A hívás időbélyege (helyi idő) |
| Ágens | Az ágensazonosító a hozzá tartozó színnel |
| Input | Összes beviteli token (input + gyorsítótár) |
| Output | Kimeneti tokenek száma |
| Tartalom | Az első eszköz neve és a kontextus-előnézet (max. 80 karakter) |

Az oszlopfejlécekre kattintva a táblázat az adott oszlop szerint rendezhető; ismételt kattintásra megfordul a sorrend.

---

## Costops költségkeretek

Ha az adminisztrátor costops-konfigurációt állított be, a nézet tetején megjelenik egy **Költségkeretek** panel is (csak adminisztrátori jogkörrel látható).

| Elem | Leírás |
|------|--------|
| Keret neve | A konfigurált budget azonosítója |
| Felhasznált / Limit | Aktuális elköltött tokenek a korláthoz képest |
| Hatókör | Globális, ágensspecifikus vagy bérlő-szintű keret |
| Százalék | A limit telítettségének aránya |
| Blokkolt | Ha a hard-limit elérése miatt az ágensek hívásai le vannak állítva |

Az állapotsáv zölden jelenik meg a tűréshatár alatt, sárgán figyelmeztetésnél, pirossal hard-limit elérésekor.

---

## Tippek

- Az összefoglaló kártyákon a cost/session mutató segít megítélni, hogy egy-egy ágens átlagos munkamenetje mennyibe kerül.
- A 7 napos nézet a leggyakoribb kiindulópont; az 1 órás nézet aktuális futtatás diagnosztikájára hasznos.
- Az eszköz-statisztikák rávilágítanak, ha egy MCP-szerver aránytalanul sok hívást generál, ami optimalizálható.
