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
