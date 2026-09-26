# F04 Architektúra

## Áttekintés

A Marveen két önálló folyamatból áll, amelyek egy közös SQLite adatbázison keresztül koordinálnak:

| Folyamat | Indítás | Feladat |
|----------|---------|---------|
| `dashboard` | launchd/systemd `dashboard` service | REST API, web UI, adatbázis-adminisztráció |
| `channels` | launchd/systemd `channels` service | Claude Code CLI csatorna-kapcsolat, ágens orchestráció |

A `dashboard` Node.js/TypeScript alapú, HTTP szerveren fut (alapértelmezett port: 3420). A `channels` service a `scripts/channels.sh` szkript, amely elindítja a főágens Claude Code folyamatát egy dedikált tmux munkamenetben.

## Folyamatok és tmux layout

### Főágens munkamenet

A `channels` service indulásakor létrejön egy `<MAIN_AGENT_ID>-channels` nevű tmux munkamenet (pl. `marveen-channels`). Ebben fut a főágens Claude Code folyamata, amely a csatorna-pluginen (Telegram/Slack/Discord) keresztül fogadja a felhasználó üzeneteit.

```
tmux attach -t marveen-channels
```

### Ágens munkamenetek

Minden egyes flotta-ágens a dashboard indítja saját tmux munkamenetben, `agent-<agent_id>` névkonvencióval:

```
tmux attach -t agent-<agent_id>
```

Az ágensek izolált `CLAUDE_CONFIG_DIR` könyvtárban futnak, és a `store/.claude-oauth-token` fleet-tokent használják hitelesítésre (nem az interaktív Keychain/credentials login forgatja).

### Összefoglaló

```
tmux ls
  marveen-channels    -- főágens (channels service)
  agent-<name1>       -- flotta-ágens 1 (dashboard indítja)
  agent-<name2>       -- flotta-ágens 2
  ...
```

## Könyvtárstruktúra

```
marveen/
  install.sh              -- telepítő (macOS + Linux)
  install-windows.ps1     -- Windows telepítő (WSL2)
  update.sh               -- frissítő
  .env                    -- fő konfiguráció (0600)
  package.json
  tsconfig.json

  src/                    -- TypeScript forrás
    index.ts              -- dashboard belépési pont
    channel-coordinator/  -- ágens orchestráció, spawn, auth
    db/                   -- adatbázis CRUD modulok
    web/                  -- API route-ok, web szerver
    migrations/           -- SQL migrációk (0001..N.sql)

  dist/                   -- TypeScript build kimenet (gitignored)

  web/                    -- frontend statikus fájlok (SPA)

  store/                  -- futásidejű állapot (gitignored)
    claudeclaw.db         -- SQLite adatbázis
    .dashboard-token      -- Bearer token (0600)
    .claude-oauth-token   -- Fleet OAuth token (0600)
    autonomy-config.json  -- autonómia-szintek
    model-profile-map.json

  agents/                 -- flotta-ágensek könyvtára
    <name>/
      CLAUDE.md           -- ágens instrukciók
      .mcp.json           -- MCP konfiguráció
      .claude/channels/   -- csatorna token + párosítás

  scripts/                -- shell segédeszközök
    channels.sh           -- channels service belépési pont
    backup.sh
    doctor.sh
    channel-watchdog.sh
    auth.sh
    vault-*.sh

  seed-config/            -- telepítő alapkonfigurációk
  seed-skills/            -- alapértelmezett skill könyvtár
  seed-scheduled-tasks/   -- alapértelmezett ütemezett feladatok
  config-examples/        -- .env.example, model-profile-map.example.json

  backups/                -- mentési archívumok (gitignored)
  scheduled-tasks/        -- projekt-szintű ütemezett feladatok
```

A `~/.claude/` (felhasználói home) a Claude Code globális konfigurációit tartalmazza:

```
~/.claude/
  skills/                 -- globális skill könyvtár
  scheduled-tasks/        -- fájl-alapú ütemezett feladatok
  channels/<provider>/    -- csatorna token + párosítás (főágens)
    .env                  -- bot token
    access.json           -- párosított chat ID-k
```

## Adatbázis

Az adatbázis SQLite fájl: `store/claudeclaw.db`. A séma az `src/migrations/` könyvtárban lévő sorszámozott SQL fájlokból épül fel; minden indításkor a dashboard automatikusan futtatja az elvégzetlen migrációkat.

### Táblacsoportok

**Memória**

| Tábla | Tartalom |
|-------|---------|
| `memories` | Memória bejegyzések (hot/warm/cold/shared tier) |
| `memory_links` | Bejegyzések közötti hivatkozások |
| `memory_versions` | Szerkesztési előzmények |
| `daily_logs` | Napi összefoglalók |
| `workspace_docs` | Munkaterület-dokumentumok (shared workspace storage) |
| `import_sources` | Importált külső memóriaforrások |
| `import_memories` | Importált memória bejegyzések |

**Kanban**

| Tábla | Tartalom |
|-------|---------|
| `kanban_cards` | Feladatkártyák (planned/in_progress/waiting/done) |
| `kanban_comments` | Kártya-kommentek |
| `kanban_card_events` | Állapotváltozás naplója |
| `kanban_card_labels` | Kártya-cimke kapcsolótábla |
| `labels` | Cimkék |
| `idea_box` | Ötlet tárca |
| `idea_comments` | Ötlet-kommentek |

**Ágensek és kommunikáció**

| Tábla | Tartalom |
|-------|---------|
| `agent_messages` | Inter-agent üzenetsor |
| `fleet_blackboard` | Flotta-blackboard (aktuális ágens-állapot) |
| `fleet_blackboard_history` | Blackboard bejegyzések előzménye |
| `sessions` | Channel session állapot |
| `pending_channel_requests` | Folyamatban lévő csatorna-kérések |

**Ütemezés**

| Tábla | Tartalom |
|-------|---------|
| `scheduled_tasks` | Ütemezett feladat definíciók |
| `schedules` | Ütemezési bejegyzések |
| `task_runs` | Futás-napló |
| `background_tasks` | Háttérfeladatok (async operációk) |
| `pending_task_retries` | Retry-sorban váró feladatok |

**Modellek és költségek**

| Tábla | Tartalom |
|-------|---------|
| `token_usage` | Token felhasználás (per üzenet) |
| `token_usage_daily` | Napi összesítés |
| `token_usage_monthly` | Havi összesítés |
| `cost_line_items` | Részletes költségsorok |
| `cost_sources` | Költségforrások |
| `otel_spans` | OpenTelemetry span-ek |
| `claude_plans_registry` | Claude előfizetési terv nyilvántartás |

**Hitelesítés és biztonság**

| Tábla | Tartalom |
|-------|---------|
| `api_tokens` | API tokenek |
| `auth_sessions` | Dashboard bejelentkezési munkamenetek |
| `device_keys` | Eszközkulcsok (agent device auth) |
| `vault_ssh_keys` | SSH kulcsok a Vault-ban |
| `vault_ssh_servers` | SSH szerverek a Vault-ban |
| `approvals` | Autonómia-jóváhagyási kérések |

**Konfiguráció**

| Tábla | Tartalom |
|-------|---------|
| `system_config` | Dashboard-on tárolt konfiguráció (felülírja az .env-t) |
| `config_change_log` | Konfigurációs változtatások naplója |

**Skilletek és tenant-kezelés**

| Tábla | Tartalom |
|-------|---------|
| `skills` | Skill-katalógus |
| `skill_usage` | Skill használati napló |
| `skill_tenant_access` | Tenant-szintű skill hozzáférés |
| `tenants` | Tenant definíciók |
| `dashboard_users` | Dashboard felhasználók (per-tenant) |
| `tenant_agent_availability` | Tenant-ágens hozzárendelés |
| `partner_senders` | Külső (nem ágens) üzenetküldők |

**Audit és megfigyelés**

| Tábla | Tartalom |
|-------|---------|
| `agent_audit_log` | Ágens művelet-napló |
| `hook_audit_log` | Hook futási napló |
| `store_file_audit` | Store könyvtár fájlváltozás-napló |
| `import_audit_log` | Import műveletek naplója |
| `artifacts` | Generált artifact metaadatok |

## Konfigurációs rétegek

A konfiguráció háromszintű precedenciát követ (az első találat érvényes):

1. `system_config` adatbázis-tábla (dashboard Beállítások oldalán szerkeszthető)
2. `/run/secrets/<KULCS>` fájlok (Docker/Kubernetes secret-mount)
3. `.env` fájl

Részletesen lásd [F02 Konfiguráció](F02-konfiguracio.md).

## Adatfolyam (egyszerűsített)

```
Felhasználó üzenete (Telegram/Slack/Discord)
         |
         v
  channels service (Claude Code CLI + csatorna-plugin)
         |
         v
  Főágens feldolgozza (CLAUDE.md instrukciók alapján)
         |
         |-- SQLite (memória olvasás/írás, kanban, blackboard)
         |
         |-- Inter-agent üzenet --> sub-ágens (agent-<name> tmux session)
         |
         v
  Válasz visszaküldve a csatornára
```

A dashboard külön folyamat: REST API-t és web UI-t szolgál ki, az adatbázis-adminisztrációt kezeli, és a flotta-ágenseket indítja/leállítja a tmux session-ökön keresztül.

---

*Előző fejezet: [F03 Üzemeltetés](F03-uzemeltetes.md)*
*Következő fejezet: [F05 Csatornák konfigurálása](F05-csatornak.md) (hamarosan)*
