# Áttekintés

Az Áttekintés az irányítópult főoldala. Egy pillantásra megmutatja a rendszer aktuális állapotát: az aktív ágenseket, a mai üzenetforgalmat, a feladatokat és az API-kvóta kihasználtságát.

---

## Mit látsz az oldalon

### Statisztika-csíkok

Az oldal tetején kompakt számpanelen jelenik meg:

- **Aktív ágensek** - hány ágens fut éppen
- **Mai üzenetek** - az ágensek között elküldött üzenetek száma a mai napon
- **Frissítések** - elérhető verziófrissítések száma (részletek a Frissítések nézetben)

A számok melletti alcím kontextust ad: pl. "ugyanaz mint tegnap" vagy "+3 a tegnapihoz képest".

### Figyelmet igénylő dolgok `[ADMIN]`

Ha valami beavatkozást kér, a statisztika-csík alatt egy "Figyelmet igényel" panel jelenik meg a teendőkkel: függő jóváhagyások, kézbesítetlen üzenetek, elakadt ütemezett feladatok, nem futó ágensek. Minden sor mellett link vagy gomb visz a megfelelő nézetre.

Az **N hiba az elmúlt 4 órában** sor mellett a **Részletek** gomb kinyitja a hibás futások listáját (a legfrissebb 20, időrendben visszafelé): mikor történt, mi volt (művelet és az ütemezett feladat neve, vagy a HTTP-metódus, útvonal és státusz), és melyik ágenshez tartozik. Ha ennél több hiba van, a lista alján a többi száma látszik. Ha az Áttekintés újra felépül (például másik nézetről visszatérve vagy bérlőváltáskor), a megnyitott lista nyitva marad.

Nem számít hibának az a parancs típusú ütemezett feladat, amely a `42`-es "lelet" kilépési kóddal ér véget (ellenőrzés, amely jelentést készített, lásd a Feladatok fejezetet), és az sem, ha egy kérés hibás JSON-nal érkezik (az 400-as választ kap).

### Csapattábla

A csapattábla az összes konfigurált ágens élő állapotát mutatja. Soronként látható:

- Az ágens neve és az aktuális aktivitása
- Az utolsó tevékenység időpontja (relatív, pl. "5 p")
- A Blackboard állapota - mit csinál éppen az ágens (ha jelezte)

Az ágens nevére kattintva az Ágensek nézet megnyílik az adott ágensnél.

### Friss események

Az oldal alján a rendszer legutóbbi eseményei jelennek meg - üzenetek, memória-mentések, ütemezett futások. Ha nincs friss esemény, "Nincs friss esemény." felirat jelenik meg.

### Kvóta-csík `[ADMIN]`

Rendszergazdáknak megjelenik egy kvóta-csík, amely az API-használatot mutatja két időablakon (5 óra / 7 nap). A csík szürke (normál), narancs (60-80%) vagy piros (80%+) lehet a kihasználtság alapján.

---

## Bérlői szűrő

Ha a rendszer több bérlővel (tenanttal) működik, a jobb felső sarokban található szűrővel váltani lehet a bérlők között. Az áttekintő mindig a kiválasztott bérlő adatait mutatja.

---

## Tippek

- Az Áttekintés 30 másodpercenként automatikusan frissül.
- A Blackboard-sor melletti állapotkód (`active` / `done` / `blocked`) jelzi, hogy az ágens éppen dolgozik-e.
- Ha egy ágens "blocked" állapotban van, a Blackboard-sorban szerepel a blokkoló ok is.
