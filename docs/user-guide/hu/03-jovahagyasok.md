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
| **Határidő** | Meddig vár a kérés döntésre; lejárat után automatikusan `Lejárt` státuszba kerül |
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

## Tippek

- Ha egy kérés lejár (timeout), az ágens nem hajtja végre a műveletet; nem kell külön elutasítani.
- Sürgős kérések az autonómia-konfiguráció alapján megjelenhetnek Telegramon is - a dashboard az összes előzményt mutatja.
- Az autonómia-szintek konfigurálása a Beállítások nézetben érhető el.
