# Beállítások

A Beállítások nézet a Marveen rendszer konfigurációs kulcsait csoportosítja 9 fülre. A változtatások egy piszkos-állapot-sávon keresztül menthetők; a mentés csak a ténylegesen módosított kulcsokat írja a szervernek.

---

## A beállítások elérése

A felső navigációban a fogaskerék ikonra, vagy a navigációs menüben a **Beállítások** elemre kattintva nyílik meg a nézet.

A nézet tetején egy sárga sáv jelenik meg, ha valamelyik kulcs értéke módosítva lett, de még nincs elmentve. A sávon látható a módosított kulcsok száma; a **Mentés** gomb az összes változást egyszerre elküldi. A lap elhagyásakor böngészős figyelmeztetés jelenik meg, ha van mentetlen módosítás.

---

## 1. Rendszer

Az alap rendszerkonfiguráció: ágens-azonosítók, hálózati beállítások és üzemmód.

| Kulcs | Leírás |
|-------|--------|
| `BOT_NAME` | A rendszer megjelenített neve |
| `MAIN_AGENT_ID` | A fő koordinátor-ágens azonosítója |
| `OWNER_NAME` | A rendszer tulajdonosának neve |
| `WEB_PORT` | A dashboard HTTP portja (alapértelmezett: 3420) |
| `DASHBOARD_PUBLIC_URL` | A dashboard publikusan elérhető URL-je (pl. Tailscale-en) |
| `DASHBOARD_LANG` | Az alapértelmezett dashboard-nyelv (`hu` vagy `en`) |
| `SCHEDULER_TZ` | Az ütemező időzónája (pl. `Europe/Budapest`) |
| `ALERT_THRESHOLD_MS` | Az API-válasz lassúság-riasztás küszöbértéke milliszekundumban |
| `DEFAULT_REVERT_AFTER_MINUTES` | Hány perc után állítsa vissza automatikusan az autonómia-szintet a legalacsonyabbra |

---

## 2. Csatornák

A kommunikációs csatorna és a biztonsági beállítások. A fül alján helyezkedik el a **Bejelentkezési kártya**.

| Kulcs | Leírás |
|-------|--------|
| `CHANNEL_PROVIDER` | Az üzenetcsatorna típusa (pl. `telegram`) |
| `TELEGRAM_BOT_TOKEN` | A Telegram bot API-tokene |
| `ALLOWED_CHAT_ID` | Az engedélyezett Telegram chat-azonosítók (vesszővel elválasztva) |
| `MAIN_AGENT_ISOLATED_CONFIG` | A fő ágens izolált konfigurációs könyvtára |
| `MAIN_AGENT_CONFIG_DIR` | A fő ágens `.claude-config` könyvtárának elérési útja |

### Bejelentkezési kártya

A kártya a dashboard böngészős bejelentkezési módját kezeli:

- **Bejelentkezés beállítása** - felhasználónév + jelszó páros rögzítése a tokennel együtt
- **Aktív session-ök** - a jelenleg bejelentkezett session-ök listája és kijelentkeztetési lehetőség
- **Eszközkulcsok** - visszavonható per-eszköz kulcsok generálása (pl. Bridge-hez, telefonhoz); az új kulcs egyszeri megjelenítés után nem kérdezhető le újra
- **Bridge-párosítás** - a Claude Code Bridge SSH-alagút engedélyezési folyamata

---

## 3. Ágensek

Az ágensek viselkedési paraméterei és a heartbeat-konfiguráció.

### Modell

| Kulcs | Leírás |
|-------|--------|
| `DEFAULT_AGENT_MODEL` | Az ágensek által alapértelmezetten használt Claude-modell |
| `MESSAGE_LOG_RETENTION_DAYS` | Hány napig őrizze az inter-agent üzenet-előzményeket |

### Heartbeat

| Kulcs | Leírás |
|-------|--------|
| `HEARTBEAT_ENABLED` | Engedélyezi-e a csendes háttérellenőrzéseket |
| `HEARTBEAT_INTERVAL_MINUTES` | Heartbeat-futtatások közötti intervallum percben |
| `HEARTBEAT_CALENDAR` | Naptár-ellenőrzés engedélyezve a heartbeat-ben |
| `HEARTBEAT_EMAIL` | E-mail-ellenőrzés engedélyezve a heartbeat-ben |
| `HEARTBEAT_KANBAN` | Kanban-állapot ellenőrzése a heartbeat-ben |
| `HEARTBEAT_FULL_CHECK` | Teljes rendszer-átvilágítás a heartbeat-ben |

---

## 4. Kanban

A kanban-tábla és az ötletláda finomhangolása. A szekció alszekciókra van bontva:

### WIP-korlátok

A `KANBAN_WIP_*` kulcsok meghatározzák, hány kártya lehet egyszerre adott státuszban vagy ágenshez rendelve.

### WIP-színek

A `KANBAN_WIP_*_COLOR` kulcsok az egyes státuszok oszlopfejlécének figyelmeztetési színét állítják be, ha a WIP-limit közel van vagy túllépve.

### Archiválás

| Kulcs | Leírás |
|-------|--------|
| `KANBAN_ARCHIVE_DONE_DAYS` | Hány nap elteltével archiválja a done-kártyákat automatikusan |
| `KANBAN_ARCHIVED_MAX_ROWS` | Az archivált kártyák maximális tárolási száma |

### Elévülés

A `KANBAN_AGING_*` kulcsok szabályozzák az elévülési vizualizációt (kártyák elszínezése, ha régóta nem változtak).

### Megjelenítés

| Kulcs | Leírás |
|-------|--------|
| `KANBAN_SWIMLANE_DEFAULT_GROUP` | Az alapértelmezett swimlane-csoportosítás (pl. prioritás, ágens) |
| `KANBAN_SWIMLANE_SEPARATOR_COLOR` | A swimlane-határolók háttérszíne |
| `KANBAN_LABEL_COLORS` | Egyedi label-szín-hozzárendelések JSON-objektumként |

### Ötletláda

| Kulcs | Leírás |
|-------|--------|
| `IDEA_BREAKDOWN_MAX_SUBTASKS` | AI-bontásnál legfeljebb hány kanban-alfeladatot generáljon |
| `IDEA_STALE_DAYS` | Hány nap inaktivitás után jelöljön egy ötletet elavultnak |

---

## 5. Memória

A memória-rendszer és az Ollama vektorgenerátor beállításai.

| Kulcs | Leírás |
|-------|--------|
| `OLLAMA_URL` | Az Ollama API URL-je a helyi vektorgeneráláshoz |
| `MEMORY_RERANK_ENABLED` | Engedélyezi-e az újrarangsorolást a keresési eredményeknél |
| `WORKSPACE_DOCS_TTL_DAYS` | Hány nap után törölje automatikusan a workspace-dokumentumokat |
| `WORKSPACE_DOC_RECALL_DEFAULT` | Az alapértelmezett workspace-dokumentum visszahívás bekapcsolva-e |

---

## 6. Fleet monitor

A blackboard-figyelő és a stale-detektáló küszöbértékei.

### BB jelek

| Kulcs | Leírás |
|-------|--------|
| `BB_SIGNAL_A_BB_HOURS` | Hány óra elteltével adja ki az A-jelet, ha nincs blackboard-aktivitás |
| `BB_SIGNAL_A_MSG_HOURS` | Hány óra elteltével adja ki az A-jelet, ha nincs inter-agent üzenet |
| `BB_SIGNAL_B_ACTIVE_HOURS` | Hány óra folyamatos "active" jelzés után adja ki a B-jelet |

### Stale-detektálás

A `BB_STALE_*` kulcsok azt szabályozzák, mennyi idő elteltével minősít a monitor egy ágens-sort elavultnak a blackboardon.

---

## 7. Adatmegőrzés

Naplók, telemetria és mentési politikák.

### Audit-napló

| Kulcs | Leírás |
|-------|--------|
| `AUDIT_LOG_RETENTION_DAYS` | Hány napig őrizze az audit-naplóbejegyzéseket |
| `AUDIT_LOG_MAX_ENTRIES` | Az audit-napló maximális bejegyzésszáma |

### Token-használat megőrzése

| Kulcs | Leírás |
|-------|--------|
| `TOKEN_USAGE_RETENTION_DAYS` | Nyers token-használati rekordok megőrzési ideje napban |
| `TOKEN_USAGE_DAILY_RETENTION_DAYS` | Napi összesítők megőrzési ideje napban |
| `TOKEN_USAGE_MONTHLY_RETENTION_DAYS` | Havi összesítők megőrzési ideje napban |

### OpenTelemetria

Az `OTEL_*` kulcsok a telemetria-exportert konfigurálják (végpont, fejlécek, protokoll).

### Mentések

| Kulcs | Leírás |
|-------|--------|
| `BACKUP_KEEP` | Hány biztonsági mentési fájlt őrizzen meg |

---

## 8. Autonómia

Az autonómia-szekció szintetikus: nem kulcs-érték párokból áll, hanem az `/api/autonomy` végponton tárolt, kategóriánkénti szint-beállítást mutatja.

Minden kategóriához három szint érhető el:

| Szint | Viselkedés |
|-------|-----------|
| **1 - Jelez** | Az ágens csak értesítést küld, a műveletet nem hajtja végre |
| **2 - Jóváhagyás** | A művelet előtt jóváhagyást kér a tulajdonostól |
| **3 - Autonóm** | A műveletet elvégzi, majd utólag jelent |

Egyes kategóriák max-szinttel vannak korlátozva (pajzs-ikon), mások le vannak zárva és nem módosíthatók (lakat-ikon).

A szekció alján az utolsó módosítás dátuma jelenik meg.

---

## 9. Budgetek és Claude csomagok

A kilencedik szekció is szintetikus: a costops-konfigurációban beállított tokenköltség-kereteket és a Claude API-csomag-paramétereket mutatja.

### Claude csomagbeállítások

| Kulcs | Leírás |
|-------|--------|
| `CLAUDE_ROTATION_ENABLED` | Engedélyezi-e a Claude API-kulcsok automatikus körforgását |
| `PLAN_STALE_MIN` | Hány perc elteltével tekinti a rendszer elavultnak a csomag-állapotot |

### Costops költségkeretek

A beállított budgetek listázva jelennek meg; szerkesztésük a konfigurációs fájlban lehetséges. Részletes áttekintésük a [Statisztikák](10-statisztikak.md) nézetben érhető el.

---

## Tippek

- A piszkos-állapot-sávon a módosított kulcsok száma látható; a változtatások mentés nélkül elvesznek, ha elhagyod az oldalt.
- Az eszközkulcsok egyszeri megjelenítés után nem kérhetők le újra; a generálásuk után azonnal mentsd biztonságos helyre.
- Az autonómia-szinteket szükség esetén bármikor visszaállíthatod 1-re, hogy megóvd az érzékeny kategóriákat az autonóm végrehajtástól.
