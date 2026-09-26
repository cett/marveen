# Memória

A Memória nézet az ágensek hosszú távú emlékeit kezeli. Az emlékek három szintű (tier) rendszerben tárolódnak, és kulcsszavas, illetve vektoros kereséssel visszakereshetők. A napi napló az ágensek által aznap elvégzett tevékenységek összefoglalóit tartalmazza.

---

## Tier-rendszer

| Tier | Leírás | Mikor kerül ide |
|------|--------|-----------------|
| **Hot** | Aktív feladatok, folyamatban lévő döntések | Ami most történik |
| **Warm** | Stabil konfiguráció, preferenciák, projekt-kontextus | Ritkán változó dolgok |
| **Cold** | Hosszú távú tanulságok, archív döntések | Amit "emlékezz erre"-ként kell megőrizni |
| **Shared** | Más ágensek számára is releváns információk | Flottaszintű tudás |
| **Import** | Külső forrásból importált emlékek | Tömeges adatbetöltés |

---

## A nézet fülei

### Hot / Warm / Cold / Shared / Import

Az adott tier emlékeinek listája. Minden emlék-kártyán megjelenik:

- A tartalom (első néhány sor)
- Az ágens neve, aki létrehozta
- A létrehozás időpontja
- A kulcsszavak (ha meg vannak adva)
- Szerkesztés és törlés gomb

Egy kártyára kattintva megnyílik a részlet-nézet, ahol a teljes tartalom olvasható és szerkeszthető.

### Napi napló

Az ágensek által generált napi összefoglalók, dátum szerint böngészhetők. A napló az aznap elvégzett feladatokat, döntéseket és eseményeket rögzíti. A dátumnavigációs nyilakkal a korábbi napok naplói is megtekinthetők.

### Gráf / Idővonal

A Gráf fülön az emlékek közötti kapcsolatok interaktív hálózat-gráfon jelennek meg; a csomópontok tier szerint színezve mutatják az összefüggéseket. Az Idővonal fülön az emlékek kronologikus sávdiagramon láthatók.

---

## Keresés

A kereső mező fölött a keresési mód választható:

| Mód | Leírás |
|-----|--------|
| **Hibrid** | Kulcsszavas és vektoros keresés kombinálva (alapértelmezett) |
| **Kulcsszavas** | Pontos szövegegyezés alapján |
| **Vektoros** | Szemantikai közelség alapján (vektorok szükségesek) |

A keresés 300 ms-os késleltetéssel indul, Enter billentyűre azonnal.

---

## Szűrők

- **Ágens** - szűrés egy adott ágens emlékeire
- **Bérlő** - szűrés bérlő szerint (ha bérlő-szelektor aktív)

---

## Statisztikák

A nézet tetején statisztikai kártyák mutatják:

- Összes emlék száma
- Tier-enkénti bontás
- Vektorizált emlékek száma és százaléka
- Importált emlékek száma

A **Vektorok generálása** gomb a hiányzó vektorokat visszatölti; ez szükséges, ha régi emlékek még nem kerültek vektorizálásra.

---

## Új emlék létrehozása

1. Kattints a **+ Emlék** gombra.
2. Válaszd ki a tiert (Hot / Warm / Cold / Shared).
3. Írd be a tartalmat.
4. Opcionálisan add meg a kulcsszavakat (vesszővel elválasztva) és válaszd ki az ágensét.
5. Kattints a **Mentés** gombra.

---

## Emlék szerkesztése és törlése

Egy kártyára kattintva megnyílik a részlet-panel az **Előzmények** és a **Szerkesztés** füllel. Az előzmények fülön az emlék korábbi verziói böngészhetők. A szerkesztés fülön a tartalom, a tier, a kulcsszavak és az ágens módosítható.

---

## Importálás

A **Importálás** gombbal tömeges importálás végezhető JSON formátumból; hasznos, ha egy külső rendszerből kell emlékeket betölteni.

---

## Tippek

- A Hot tier-be kerülő emlékeket a feladat befejezése után érdemes törölni vagy Warm/Cold tier-be áthelyezni, hogy a Hot tier ne tömődjön el.
- A kulcsszavak megadása javítja a kulcsszavas keresés pontosságát.
- A Gráf nézet a csomópontok közötti kapcsolatok vizualizálásához hasznos; a csúszkával a megjelenített csomópontok száma szabályozható.
