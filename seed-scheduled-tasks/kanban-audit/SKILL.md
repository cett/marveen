---
name: kanban-audit
description: 4 óránkénti kanban-tábla audit. Tisztítás (7+ napos done archiválás) + beakadt task-ok számon kérése (előző audit óta nem mozdult in_progress -> ping az assignee-nek).
---

# Kanban 4 órás audit

## Mikor fut
- 8:00, 12:00, 16:00, 20:00 (kanban-audit cron 0 8,12,16,20)

## Autonómia-szint (config-vezérelt, KÖTELEZŐ ELŐSZÖR)

Olvasd be: `jq -r '.categories[]|select(.key=="kanban_archive_done" or .key=="kanban_stuck_nudge")|"\(.key) \(.level)"' {{INSTALL_DIR}}/store/autonomy-config.json`

A két kategória szintje szabályozza a 2. és 4. lépést:
- **`kanban_archive_done`** (2. lépés): level 3 → archiváld magától (alapért). level 2 → NE archiválj, Telegramon javasold ("X db 7+ napos done archiválásra vár, mehet?") és várj jóváhagyást. level 1 → csak jelezd a számot.
- **`kanban_stuck_nudge`** (4. lépés): level 3 → pingeld az assignee-t magától, és CSAK 2 eredménytelen audit-kör után eszkalálj a tulajdonoshoz ({{OWNER_NAME}}) (a komment-történetből látod hányszor pingelted). level 2 → ne pingelj magadtól, Telegramon javasold a tulajdonosnak ({{OWNER_NAME}}). level 1 → csak listázd a beakadt taskokat.

Ha a config hiányzik vagy a kulcs nincs benne → default level 3 (régi viselkedés).

## Eljárás

1. **State beolvasás**: az `agent_state` táblában, `agent_id='{{MAIN_AGENT_ID}}'` és `state_key='kanban_audit_last_audit_at'` sorban van a `last_audit_at` Unix timestamp (lásd 3. lépés, ugyanoda kell a lekérdezés). Ha nincs sor (első futás) -> ne pingelj senkit, csak állítsd be a state-et.

2. **Tisztítás**: 7+ napos done kártyák archiválása:
   ```bash
   sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "UPDATE kanban_cards SET archived_at=unixepoch() WHERE status='done' AND archived_at IS NULL AND updated_at < strftime('%s','now','-7 days')"
   ```

3. **Beakadt task detection** (előző audit óta nem mozdult): in_progress kártyák amik `updated_at < last_audit_at`:
   ```bash
   LAST=$(sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT state_value FROM agent_state WHERE agent_id='{{MAIN_AGENT_ID}}' AND state_key='kanban_audit_last_audit_at'" 2>/dev/null)
   [ -z "$LAST" ] && LAST=0
   sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT id, title, assignee, ROUND((strftime('%s','now')-updated_at)/3600.0,1) as hours_stale FROM kanban_cards WHERE status='in_progress' AND archived_at IS NULL AND updated_at < $LAST ORDER BY hours_stale DESC"
   ```

4. **Beakadt task -> ping**: minden beakadt kártyához küldj inter-agent message-t az assignee-nek (kivéve {{MAIN_AGENT_ID}}-nek és üres assignee-nek):
   ```
   "Kanban-audit: a {card_id} ({title}) {hours_stale}h-ja in_progress mozgás nélkül (előző audit óta). Frissítsd a státuszt (done/waiting) vagy adj komment-et hogy mit blokkol."
   ```

5. **State frissítés** (a futás VÉGÉN), upsert az `agent_state` táblába:
   ```bash
   sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "INSERT INTO agent_state (agent_id, state_key, state_value, tenant_id, updated_at) VALUES ('{{MAIN_AGENT_ID}}', 'kanban_audit_last_audit_at', '$(date +%s)', 'default', unixepoch()) ON CONFLICT(agent_id, state_key) DO UPDATE SET state_value=excluded.state_value, updated_at=excluded.updated_at"
   ```

6. **Delegálatlan kártyák**: in_progress/waiting/planned amiknek assignee NULL/üres -> log + Telegram csak akkor ha 3+ ilyen van.

7. **Telegram csak akkor írj ha**:
   - 3+ beakadt task van (kritikus)
   - Új blokker (waiting > 48h)
   - Egyébként csendben (heartbeat-stílus)

## Buktatók
- Az "előző audit óta nem mozdult" feltétel azt jelenti: `updated_at < last_audit_at`. NE használj abszolút 24h-os küszöböt.
- Ne archiválj done-t ha <7 nap (a felhasználó még látni akarja).
- NE pingelj saját magadat (skip ha assignee='{{MAIN_AGENT_ID}}').
- Ne re-pingelj 4 órán belül ugyanazt: az `agent_state`-ben tárolt `last_audit_at` automatikusan kezeli ezt.
- Első futáskor (nincs sor az `agent_state`-ben) -> ne pingelj, csak inicializáld a state-et.
- A státuszváltozás (in_progress -> done) is updated_at frissítést jelent, így a következő audit nem fogja megfogni a most-még-aktív taskokat.

## Ellenőrzés
- Az `agent_state` sora (`agent_id='{{MAIN_AGENT_ID}}'`, `state_key='kanban_audit_last_audit_at'`) frissült a futás végén.
- Inter-agent message-ek sikeresek (200 response).
