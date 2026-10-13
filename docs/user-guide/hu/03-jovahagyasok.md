# Jóváhagyások

A Jóváhagyások nézet azokat a kéréseket sorolja fel, amelyeket az ágensek a rendszergazdától vagy a tulajdonostól várnak a folytatáshoz. Az ágensek egyes műveleteket - pl. fájlok törlése, külső üzenetek küldése, erőforrás-módosítások - csak jóváhagyás után hajtanak végre.

---

## Autonómia-szintek

Minden művelet-kategóriához konfigurált autonómia-szint van:

| Szint | Leírás |
|-------|--------|
| **1 - Csak jelez** | Az ágens értesíti a rendszergazdát, de nem cselekszik |
| **2 - Jóváhagyás szükséges** | Az ágens megvárja a döntést, mielőtt folytat |
| **3 - Autonóm** | Az ágens elvégzi, majd utólag jelenti |

A Jóváhagyások nézet a 2. szintű kéréseket mutatja.

---

## A táblázat oszlopai

| Oszlop | Leírás |
|--------|--------|
| **Időpont** | A kérés beérkezési ideje |
| **Ágens** | Melyik ágens küldte |
| **Kategória** | A művelet típusa (pl. `file_write`, `external_message`) |
| **Tevékenység** | Rövid leírás, hogy mit szeretne végrehajtani |
| **Státusz** | Várakozó / Jóváhagyott / Elutasított / Lejárt |
| **Határidő** | Meddig vár a kérés döntésre; alapesetben 60 perc a létrehozástól, ha a kategóriának nincs saját értéke, legfeljebb 24 óra. Lejárat után automatikusan `Lejárt` státuszba kerül |
| **Döntés** | Jóváhagyás vagy Elutasítás gomb (csak Várakozó kéréseknél aktív) |

---

## Kérés elbírálása

1. Keresd meg a **Várakozó** státuszú sort.
2. Olvasd el a **Tevékenység** oszlopban a kérés leírását.
3. Ha szükséges, kattints a sorra a részletes leíráshoz.
4. Döntsd el: **Jóváhagyás** vagy **Elutasítás**.

A döntés után az ágens folytatja (jóváhagyás esetén) vagy leállítja (elutasítás esetén) a műveletet.

---

## Szűrők

- **Státusz** - Összes / Várakozó / Jóváhagyott / Elutasított / Lejárt
- **Ágens** - szűrés egy adott ágensre
- **Kategória** - szűrés művelet-típusra

---

## Részlet-panel

Egy sorra kattintva megnyílik a részlet-panel, amely tartalmazza:

- A kérés teljes szöveges leírását
- A kérő ágens azonosítóját
- A beérkezési időpontot és a döntési határidőt
- A döntést és a döntéshozó azonosítóját (ha már elbírálták)

---

## Email jóváhagyása

Az email küldése csak-ember kategória (`email_send`): kizárólag te hagyhatod jóvá, a dashboardba bejelentkezve. Az email-jóváhagyás nem általános küldési engedély. Egyetlen, pontosan meghatározott levélre szól, és egyszer használható fel.

1. **A kérés.** A főágens küldés előtt kérdez. `email_send` kérést csak a főágens nyithat, al-ágens `403`-at kap, mert az al-ágens levele a főágensen keresztül megy ki. A kérés magát a levelet hordozza (címzettek, tárgy, törzs, a mellékletek ujjlenyomata).
2. **Amit olvasol.** A **Tevékenység** oszlop szövegét a szerver írja a levélből, nem az ágens, így az ágens nem tudja a saját javára átfogalmazni a levelet. Mezőnként tartalmazza: a feladót, a `to`, `cc` és `bcc` címzetteket (a titkos másolatot is, mezőnként legfeljebb 10-et, a többi darabszámával), a tárgyat (legfeljebb 120 karakter), a törzs elejét (legfeljebb 200 karakter, a teljes hosszal), a mellékleteket név, méret és a sha256 eleje szerint, valamint a levél ujjlenyomatának (sha256 hash) első 12 karakterét. A teljes levél a kéréssel együtt tárolódik, és a `GET /api/approvals/<id>` hívással olvasható (`action_payload`). Mezőnkénti nézet a dashboardon tervezett.
3. **A döntésed.** Jóváhagyás vagy Elutasítás, dashboard-sessionben. Token, a főágens saját tokenje is, nem dönthet róla, amíg az `APPROVAL_HUMAN_ONLY_ENFORCE=1` kapcsoló be van kapcsolva (lásd az F02 fork-útmutatót). Ha a kapcsoló ki van kapcsolva, a tokennel hozott döntés nem számít: a jóváhagyás nem használható fel.
4. **Felhasználás 30 percen belül.** A jóváhagyás után az ágensnek 30 perce van a levél elküldésére (`APPROVAL_CONSUME_WINDOW_S`, alapértelmezetten 1800 másodperc). A jóváhagyás felhasználása és a küldés az ágens oldalán egy lépés; a jóváhagyáson rögzül, ki, mikor és milyen hivatkozással használta fel.
5. **Egyszer.** Ugyanaz a levél ugyanazzal a jóváhagyással nem küldhető el másodszor. Ha ugyanaz a hivatkozás közvetlenül egy felhasználás után ismétlődik (elveszett válasz, újrapróbálás), azt a rendszer felismeri, és nem éget el újabb jóváhagyást.
6. **Ha az ablak lejár.** A sor `Jóváhagyott` marad, de már nem használható fel: az ágensnek újra kérnie kell, és te újra döntesz. Az ablak lejártakor nem megy értesítés. Ez szándékos: egy régi jóváhagyás ne küldjön el olyan levelet, amire már nem emlékszel.
7. **Másik levélhez új jóváhagyás kell.** A jóváhagyás a pontos levélhez kötött. Ha a tárgyban vagy a törzsben egyetlen karaktert változtatsz, címzettet adsz hozzá vagy mellékletet cserélsz, az ujjlenyomat más lesz, és a régi jóváhagyás nem érvényes rá.

Ha ugyanarra a levélre újra kérnek, miközben a kérés még nyitott, nem keletkezik második sor, és második értesítést sem kapsz. Egy ágensnek legfeljebb 10 nyitott email-kérése lehet; ágensenként és óránként legfeljebb 5 új értesítést kapsz, a többi ezen az oldalon vár.

Amit ez még nem tud: az a kapu, amely a főágens levélküldő eszközeit addig megállítja, amíg nincs jóváhagyás (a küldési kapu), tervezett, és nincs telepítve. Addig a jóváhagyás, az ujjlenyomat-kötés és az egyszeri felhasználás az API-ban megvan, de a levélküldés olyan módját, amely nem kér jóváhagyást, semmi nem állítja meg. A határokat a `SECURITY.md` biztonsági jegyzetei mondják ki.

---

## Tippek

- Ha egy kérés lejár (timeout), az ágens nem hajtja végre a műveletet; nem kell külön elutasítani. A lejárt kérést már sem jóváhagyni, sem elutasítani nem lehet: ha a művelet még kell, az ágensnek új kérést kell indítania. Lejáratkor nem megy Telegram-értesítés, az előzményekben a `Lejárt` státusz látszik.
- Sürgős kérések az autonómia-konfiguráció alapján megjelenhetnek Telegramon is - a dashboard az összes előzményt mutatja.
- Az autonómia-szintek konfigurálása a Beállítások nézetben érhető el.
