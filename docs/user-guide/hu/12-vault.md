# 12 - Vault `[ADMIN]`

> Ez a fejezet csak rendszergazdák számára elérhető.

A Vault titkosított titkos kulcsok, jelszavak és SSH-hitelesítő adatok biztonságos tárolására szolgál. A tárolt értékek soha nem kerülnek nyers szövegként a naplókba vagy a felhasználói felületre -- az értékek egyirányúan titkosítva vannak, megjelenítésük nem lehetséges.

---

## Mit tartalmaz a Vault?

A Vault három tárolási típust kezel:

**Titkos kulcsok (általános)** -- szövegalapú titkos értékek, pl. API-kulcsok, jelszavak. Azonosítójuk és egy emberi olvashatóságú cimkéjük van; az érték a mentés után nem olvasható vissza.

**SSH-kulcspárok** -- generált vagy importált SSH privát kulcsok. A nyilvános kulcs letölthető és másolható; a privát kulcs soha nem jelenik meg a felületen.

**SSH-szerverek** -- kapcsolatvégpontok, amelyek egy SSH-kulcspárhoz vannak rendelve. Az ágensek ezeket használják szerver-hozzáféréshez.

---

## Titkos kulcs hozzáadása

1. Kattints a **+ Hozzáadás** gombra.
2. Add meg az azonosítót (pl. `openai-api-key`) és az értéket.
3. Globális admin esetén kiválaszthatod, melyik tenanthoz tartozzon a bejegyzés.
4. Mentés után az értéket a rendszer titkosítja -- visszaolvasni nem lehet.

A bejegyzés törléséhez kattints a sor végén lévő **×** gombra.

---

## SSH-kulcs létrehozása

Az **SSH-kulcs generálása** gomb új ED25519 kulcspárt hoz létre a szerveren:

1. Adj meg egy azonosítót és egy opcionális megjegyzést.
2. Globális admin esetén meghatározhatod a tenant-hatókört.
3. A generálás után a **nyilvános kulcs** megjelenik és kimásolható (pl. `~/.ssh/authorized_keys`-be illesztéshez).

Meglévő kulcs nyilvános felét a lista sorára kattintva érheted el.

---

## SSH-szerver bejegyzése

Az **SSH-szerver hozzáadása** gombbal rögzítheted, hova csatlakozzon egy ágens:

- **Hoszt** -- IP-cím vagy domain
- **Port** -- alapértelmezett: 22
- **Felhasználónév** -- a kapcsolódási user
- **SSH-kulcs** -- a fent létrehozott vagy importált kulcspár azonosítója

A szerkesztési ablakban a tenant-hatókör nem módosítható a bejegyzés létrehozása után.

---

## Tenant-nézet (globális admin)

Globális adminként az oldal tetején megjelenik egy tenant-választó. A kiválasztott tenant Vault-bejegyzéseit látod és kezeled; az alapértelmezés a `default` tenant.

---

## Kapcsolódó fejezetek

- [15 - Felhasználók](15-felhasznalok.md) -- tokenek és tenant-kezelés
- [04 - Ágensek](04-agensek.md) -- ágensek SSH-konfigurációja
