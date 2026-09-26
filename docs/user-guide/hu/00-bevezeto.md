# Bevezetés

Ez a kézikönyv a Marveen dashboard használatát mutatja be. A Marveen egy AI-asszisztens-rendszer webes kezelőfelülete: innen konfigurálhatod az ágenseket, nyomon követheted a feladatokat, kezelheted a memóriát és felügyelheted a rendszer működését.

---

## A dashboard felépítése

A bal oldali navigációs sávban találod az összes nézetet. A sáv hat csoportba rendezi a funkciókat:

| Csoport | Mit tartalmaz |
|---------|---------------|
| **Csapat** | Áttekintés, Ágensek, Üzenetek, Feladatok |
| **Tudásbázis** | Memória, Készségek, Ötletek, Munkaterület-dok. |
| **Statisztikák** | Token-használat, Frissítések |
| **Rendszer** | Beállítások, Adatmentések |
| **Kapcsolatok** | Külső integrációk, Föderáció, Importálás |
| **Felhasználó** | Profil, Felhasználókezelés `[ADMIN]` |

A **Kanban** és a **Jóváhagyások** a sáv felső részén, önállóan jelenik meg, mert a leggyakrabban használt nézetek.

---

## Navigálás

- Kattints bármelyik sávbejegyzésre az adott nézet megnyitásához.
- Az aktuális nézet neve a böngészőablak fejlécében is megjelenik.
- A legtöbb nézet automatikusan frissül; manuális újratöltésre általában nincs szükség.

---

## Nyelv

A dashboard jobb felső sarkában lévő nyelvváltóval váltani lehet a magyar és az angol felület között. A dokumentáció mindkét nyelven elérhető (a `hu/` és `en/` könyvtárban).

---

## Hozzáférési szintek

Egyes nézetek és funkciók csak rendszergazdák számára láthatók (pl. Vault, Audit, Felhasználókezelés). Ezeket a kézikönyvben `[ADMIN]` jelzés azonosítja.

Ha egy nézet nem látható a navigációban, valószínűleg nem rendelkezel a szükséges jogosultságokkal. Az adminisztrátori hozzáférésről lásd: [Felhasználókezelés](19-felhasznalok.md).

---

## Bérlői rendszer

Ha a rendszer több bérlővel (tenanttal) működik, egyes nézetekben (pl. Áttekintés, Memória, Kanban) a jobb felső sarokban egy bérlő-szűrő jelenik meg. Ez lehetővé teszi, hogy egyazon dashboardon több, egymástól elkülönített adatkészletet kezelhess.
