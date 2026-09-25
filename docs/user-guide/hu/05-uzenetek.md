# Üzenetek

Az Üzenetek nézet az ágensek közötti üzenetváltásokat és az ágens-tulajdonos kommunikációt mutatja csevegő-stílusú felületen. Innen üzenetet küldhet bármely ágensnek, és áttekintheti a korábbi üzenetszálakat.

---

## Az oldal felépítése

Az oldal két részre oszlik:

- **Bal oldalsáv** - az ágensek listája az utolsó üzenet előnézetével és időbélyegzőjével
- **Jobb panel** - a kiválasztott ágenshez tartozó üzenetszál és az üzenet-összeállító

---

## Oldalsáv

Az oldalsávban az összes ágens megjelenik, a következő sorrendben:

1. A tulajdonos saját szálai (legfelül, "(te)" jelzéssel)
2. Aktív szálak, a legutóbbi üzenet szerint rendezve
3. Egyéb ágensek, névsorban

Ha egy szál olvasatlan üzenetet tartalmaz, kék pont jelzi a neve mellett.

---

## Üzenetszál

A kiválasztott ágenshez tartozó szálban megjelennek az üzenetek buborék-formában:

| Elem | Leírás |
|------|--------|
| **Avatar** | Küldő képe vagy monogramja |
| **Üzenet tartalma** | A szöveg tartalma |
| **Időbélyeg** | Mikor küldte az ágens vagy a tulajdonos |
| **Státusz** | Várakozó / Kézbesítve / Kész / Sikertelen |

Görgetve a szálban korábbi üzenetek tölthetők be (lapozás).

---

## Nyomkövetés (Trace)

Az üzenetszál alatt egy összecsukható panel mutatja az adott üzenethez tartozó eszközhívás-nyomkövetést (trace waterfall). Ez segít megérteni, mit csinált az ágens az üzenet feldolgozása közben.

---

## Üzenet küldése

1. Kattints az ágensre az oldalsávban.
2. Írd be az üzenetet a szövegmezőbe.
3. Kattints a **Küldés** gombra, vagy használd a Ctrl+Enter billentyűkombinációt.

Az üzenet az ágens bejövő üzenetsorába kerül, és a kijelölt munkamenetben jelenik meg.

---

## Bérlő-szűrő

A nézet tetején bérlő-szelektor érhető el, amellyel egy adott bérlő ágenseinek üzenetei szűrhetők.

---

## Föderált ágensek

Ha a flottában föderált ágensek is vannak, azok szintén megjelennek az oldalsávban (`peer/agensnev` formátumban). Az üzenetküldés azonos az egyéb ágensekével.

---

## Tippek

- A szál automatikusan olvasottnak jelölődik, amikor megnyitod; a kék pont eltűnik.
- A Trace panel különösen hasznos a hosszú, többlépéses feladatoknál, ahol pontosan látható, milyen eszközöket hívott meg az ágens.
- Az üzenetszál olvasáshoz az Ágensek nézetből is elérhető, az egyes kártyák **Társalgás** gombjával.
