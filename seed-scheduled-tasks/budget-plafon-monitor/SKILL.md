---
name: budget-plafon-monitor
description: 6 óránkénti budget-plafon ellenőrzés a costops-config.json-ban beállított, token-mennyiség alapú budgetekre. Csak warning/hard szint elérésekor küld Telegram-üzenetet.
---

# Budget-plafon ellenőrzés (6 óránként)

## Mikor fut
Cron `0 */6 * * *` (naponta 4x, 6 óránként).

## Eljárás

1. Futtasd:
   ```bash
   cd {{INSTALL_DIR}} && npm run budget-alert-check
   ```
2. A parancs maga dönt: betölti a `store/costops-config.json`-t, kiszámolja a
   folyó havi tokenfogyasztást minden konfigurált budgetre, és CSAK akkor küld
   Telegram-üzenetet (`notifyChannel()`-en keresztül), ha egy budget elérte a
   `warning_threshold`-ot vagy a `hard_threshold`-ot ÉS a cooldown (warning
   24h, hard 6h -- `store/budget-alert-state.json`-ban tárolva) lejárt.
3. Ha a parancs nem ír semmit stdout-ra és 0-val tér vissza -> minden budget
   `ok` szinten van vagy nincs konfigurált budget, nincs teendő.
4. Ha a parancs hibával áll le (nem 0 exit code), jelezd Telegramon
   (heartbeat-stílus: csak akkor írj, ha valóban hiba volt, ne minden
   futásnál).

## Buktatók
- A budget `amount` mezője TOKEN MENNYISÉG, nem pénzösszeg -- ha valaki HUF-ban
  ír be egy számot a configba, az félrevezető riasztásokat okoz. A
  `store/costops-config.json.example` a helyes formátumot mutatja.
- A folyó hónap tokenfogyasztása a `token_usage` (nyers) ÉS a
  `token_usage_monthly` (aggregált) táblák összegéből jön -- a nyers tábla
  csak `TOKEN_USAGE_RETENTION_DAYS` (alapért. 30 nap) után aggregálódik, tehát
  a hónap nagy része szinte mindig a nyers táblában van.
- `block_on_hard: true` egy budgeten JELENLEG csak a riasztás szövegébe kerül
  bele (nincs tényleges blokkolási akció implementálva) -- ez szándékos, nyitott
  design-kérdés.

## Ellenőrzés
- `npm run budget-alert-check` hibamentesen lefut (exit code 0).
- Ha van konfigurált, warning/hard szintű budget: a `store/budget-alert-state.json`
  frissül a futás után, és Telegram-üzenet érkezik.
