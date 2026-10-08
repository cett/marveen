---
name: kanban-audit
description: 4 óránkénti kanban-tábla audit. Tisztítás (7+ napos done archiválás) + beakadt task-ok számon kérése (előző audit óta nem mozdult in_progress -> ping az assignee-nek).
---

# Kanban 4 órás audit

## Mikor fut
- 8:00, 12:00, 16:00, 20:00 (kanban-audit cron 0 8,12,16,20)

## Autonómia-szint (config-vezérelt, KÖTELEZŐ ELŐSZÖR)

Olvasd be az API-ból (a szintek az `autonomy_categories` táblában élnek): `curl -s -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" http://localhost:{{WEB_PORT}}/api/autonomy | python3 -c "import sys,json; [print(c['key'], c['level']) for c in json.load(sys.stdin)['categories'] if c['key'] in ('kanban_archive_done','kanban_stuck_nudge')]"`.

A két kategória szintje szabályozza a 2. és 4. lépést:
- **`kanban_archive_done`** (2. lépés): level 3 → archiváld magától (alapért). level 2 → NE archiválj magadtól; POST /api/approvals (Bearer token, kötelező `agent_id`: "{{MAIN_AGENT_ID}}", category "kanban_archive_done", action_description pl. "X db 7+ napos done kártya archiválásra vár") -- ez MEGJELENIK a Jóváhagyások képernyőn ÉS értesít (notifyMainAgent). Kérdezd le a döntést GET /api/approvals/<id>-vel: approved → archiválj, rejected/timeout → ne, naplózd. level 1 → csak jelezd a számot.
- **`kanban_stuck_nudge`** (4. lépés): level 3 → pingeld az assignee-t magától, és CSAK 2 eredménytelen audit-kör után eszkalálj a tulajdonoshoz ({{OWNER_NAME}}) (a komment-történetből látod hányszor pingelted). level 2 → ne pingelj magadtól; POST /api/approvals (Bearer token, kötelező `agent_id`: "{{MAIN_AGENT_ID}}", category "kanban_stuck_nudge", action_description a beakadt kártyák listájával) -- a Jóváhagyások képernyőn látszik + értesít. approved → pingeld az assignee-ket, rejected/timeout → ne. level 1 → csak listázd a beakadt taskokat.

Két külön hiba-eset, ne keverd össze:
- **Az API nem érhető el** (hálózati hiba, timeout, nem 200-as válasz) → default **level 1** (biztonságos alapállapot: csak jelez, nem cselekszik).
- **Az API válaszol, de a `kanban_archive_done`/`kanban_stuck_nudge` kulcs hiányzik** a `categories` listából (a kategória még nincs felvéve az `autonomy_categories` táblába) → default **level 3** (régi viselkedés: a hiányzó kategóriát úgy kezeld, mintha még sosem lett volna korlátozva).

## Eljárás

1. **State beolvasás**: az `agent_state` tárolóban, `agent_id='{{MAIN_AGENT_ID}}'` és `state_key='kanban_audit_last_audit_at'` kulcson van a `last_audit_at` Unix timestamp (lásd 3. lépés, ugyanaz a lekérdezés). Ha nincs (a végpont 404-et ad, első futás) -> ne pingelj senkit, csak állítsd be a state-et.

2. **Tisztítás**: 7+ napos done kártyák archiválása. A kanban lista a nem archivált kártyákat adja, az `updated_at` Unix másodperc:
   ```bash
   TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
   curl -s -H "Authorization: Bearer $TOKEN" http://localhost:{{WEB_PORT}}/api/kanban | python3 -c "
   import sys, json, time
   week_ago = time.time() - 7 * 86400
   for c in json.load(sys.stdin):
       if c['status'] == 'done' and c['updated_at'] < week_ago:
           print(c['id'])
   "
   ```
   Minden kapott `<id>`-re: `curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:{{WEB_PORT}}/api/kanban/<id>/archive`.

3. **Beakadt task detection** (előző audit óta nem mozdult): in_progress kártyák amik `updated_at < last_audit_at`:
   ```bash
   TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
   LAST=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:{{WEB_PORT}}/api/agent-state/{{MAIN_AGENT_ID}}/kanban_audit_last_audit_at | python3 -c "import sys,json; print(int(json.load(sys.stdin).get('value', 0)))" 2>/dev/null)
   [ -z "$LAST" ] && LAST=0
   curl -s -H "Authorization: Bearer $TOKEN" http://localhost:{{WEB_PORT}}/api/kanban | LAST="$LAST" python3 -c "
   import sys, json, os, time
   last = int(os.environ['LAST'])
   rows = [c for c in json.load(sys.stdin) if c['status'] == 'in_progress' and c['updated_at'] < last]
   for c in sorted(rows, key=lambda c: c['updated_at']):
       print(c['id'], c['title'], c.get('assignee') or '-', round((time.time() - c['updated_at']) / 3600.0, 1), sep='\t')
   "
   ```

4. **Beakadt task -> ping**: minden beakadt kártyához küldj inter-agent message-t az assignee-nek (kivéve {{MAIN_AGENT_ID}}-nek és üres assignee-nek):
   ```
   "Kanban-audit: a {card_id} ({title}) {hours_stale}h-ja in_progress mozgás nélkül (előző audit óta). Frissítsd a státuszt (done/waiting) vagy adj komment-et hogy mit blokkol."
   ```

5. **State frissítés** (a futás VÉGÉN), upsert az `agent_state` tárolóba:
   ```bash
   curl -s -X PUT -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" -H "Content-Type: application/json" -d "{\"value\": $(date +%s)}" http://localhost:{{WEB_PORT}}/api/agent-state/{{MAIN_AGENT_ID}}/kanban_audit_last_audit_at
   ```

6. **Delegálatlan kártyák**: in_progress/waiting/planned amiknek assignee NULL/üres -> log + Telegram csak akkor ha 3+ ilyen van.
   - A "planned" státuszú delegálatlan kártyák ÖNMAGUKBAN NEM jelzésre valók: egy egészséges backlog természetes állapota, hogy több tervezett kártyának nincs még felelőse. Ha ezt minden körben jelentenénk, a heartbeat zajjá válna és elnyomná a valódi jelzéseket (beakadt task, új blokker). Csak akkor jelezz, ha a delegálatlan kártya `in_progress` vagy `waiting` állapotú -- azaz elvileg folyamatban van, de senki nem felel érte. A `planned` halmazt csak akkor említsd, ha a tulajdonos rákérdez, vagy ha feltűnően megnő (pl. >30).

7. **Telegram csak akkor írj ha**:
   - 3+ beakadt task van (kritikus)
   - Új blokker (waiting > 48h)
   - Egyébként csendben (heartbeat-stílus)

## Buktatók
- Az "előző audit óta nem mozdult" feltétel azt jelenti: `updated_at < last_audit_at`. NE használj abszolút 24h-os küszöböt.
- Ne archiválj done-t ha <7 nap (a felhasználó még látni akarja).
- A `GET /api/kanban` maga is archiválja a done kártyákat a dashboard saját ablaka (`KANBAN_ARCHIVE_DONE_DAYS`) után, ez nem a te lépésed; a 2. lépés a 7 napos audit-szabályt érvényesíti, ha az ablak hosszabb.
- NE pingelj saját magadat (skip ha assignee='{{MAIN_AGENT_ID}}').
- Ne re-pingelj 4 órán belül ugyanazt: az `agent_state`-ben tárolt `last_audit_at` automatikusan kezeli ezt.
- Első futáskor (nincs sor az `agent_state`-ben) -> ne pingelj, csak inicializáld a state-et.
- A státuszváltozás (in_progress -> done) is updated_at frissítést jelent, így a következő audit nem fogja megfogni a most-még-aktív taskokat.

## Ellenőrzés
- Az `agent_state` kulcs (`agent_id='{{MAIN_AGENT_ID}}'`, `state_key='kanban_audit_last_audit_at'`) frissült a futás végén (`GET /api/agent-state/{{MAIN_AGENT_ID}}/kanban_audit_last_audit_at` az új időt adja).
- Inter-agent message-ek sikeresek (200 response).

## Ismert false-positive: NE kérdezz duplikáltan ugyanarra a kártyára
MIELŐTT új `kanban_stuck_nudge` approval-t kérsz egy kártyára, nézd meg az approval-history-t (`GET /api/approvals?category=kanban_stuck_nudge`) -- ha UGYANARRA a card_id-re már volt `rejected` státuszú kérés ugyanazzal az indoklással, NE kérj újra, csak jelezd csendben (napi napló / hot memória), ne generálj új approval-t. Tipikus eset: egy kártya munkája git-branch/PR szinten fut, ezért a kártya `updated_at`-je nem mozdul, de ez NEM valódi elakadás -- ha a tulajdonos ezt már egyszer explicit elutasította mint false-positive-ot, tekintsd tartósan ismertnek. Csak akkor kérdezz újra, ha a staleness drasztikusan nőtt (pl. megduplázódott) VAGY a kártya állapota/assignee-je változott azóta.
