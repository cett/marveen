# Beállítások

A Beállítások nézet a Marveen rendszer konfigurációs kulcsait csoportosítja fülekre. A változtatások egy piszkos-állapot-sávon keresztül menthetők; a mentés csak a ténylegesen módosított kulcsokat írja a szervernek.

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
| `DEFAULT_REVERT_AFTER_MINUTES` | Alapértelmezetten hány perc után tér vissza a fallback modellen lévő ágens a beállított modelljére (alapérték: 330); a Modell fallback fülön elmentett érték elsőbbséget élvez |

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

Az `OTEL_*` kulcsok a telemetria-exportert konfigurálják. Az exportőr 30 másodpercenként OTLP/HTTP JSON-ban küldi a lezárt trace-eket és a token-használat metrikát a collectornak.

| Kulcs | Leírás |
|-----|-------------|
| `OTEL_EXPORT_ENABLED` | Bekapcsolja a push exportőrt (alapból ki) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | A collector bázis-URL-je, `http://` vagy `https://` (például `http://localhost:4318`), hitelesítő adat nélkül; a trace-ek a `/v1/traces`, a metrikák a `/v1/metrics` útvonalra mennek |
| `OTEL_EXPORTER_OTLP_HEADERS` | További kérés-fejlécek, általában hitelesítés, az OpenTelemetry formátumában: `név1=érték1,név2=érték2`, az értékek százalék-kódolva (`Authorization=Bearer%20abc`). Csak a `.env` fájlban add meg: titok, a dashboard sem mutatja, sem nem írja. Amíg be van állítva, az `OTEL_EXPORTER_OTLP_ENDPOINT`-ot is a `.env`-ből olvassa (a dashboardon megadott érték nem számít), így a hitelesítő adat csak arra a hostra mehet, amit mellé írtál; ha a fejléc a `.env`-ben van, de ott nincs endpoint, nem exportál |
| `OTEL_SERVICE_NAME` | A `service.namespace` resource attribútum értéke |
| `OTEL_EXPORT_INPUT_SUMMARY` | A tool-hívások rövid leírását (mit kapott a tool) is kiexportálja (alapból ki, lásd lent) |

Az exportőr OTLP-t beszél HTTP-n, JSON törzzsel, mást nem: nincs gRPC és nincs protokoll-választó. A fejlécek `https`-en mennek ki, vagy sima `http`-n privát hálózaton belül (localhost, privát cím, `.local` vagy egyszavas hostnév); beállított fejléceknél a nyilvános hoston lévő `http` endpointot egyáltalán nem használja. Az átirányítást nem követi, így a fejléc sosem jut más hostra.

Ha a collector hibázik, az exportőr 30 másodpercet, aztán 60-at, 120-at és így tovább legfeljebb 10 percet vár a következő próbáig (a collector `Retry-After` értékét tiszteletben tartja), jelenként külön, és közben megtartja az adatot. Ha a válasz azt mondja, hogy maga a törzs hibás (400, 413, 415, 422), a köteget eldobja ahelyett, hogy örökké újrapróbálná. Ha a collector csak egy köteg egy részét fogadja el, a többit megszámolja, nem próbálja újra. A számok a collectornak, amint újra válaszol, két számlálóként mennek el: `marveen.otel.export.failures` (kérések) és `marveen.otel.export.rejected` (elemek), `marveen.otel.signal` szerint (`traces` vagy `metrics`) bontva, és minden hiba figyelmeztetés a dashboard logjában.

A trace-eken és a token-használat metrikán túl a dashboard folyamat saját metrikákat is küld (resource: `marveen-dashboard`), mind csak számokkal, állapotokkal és nevekkel, soha üzenet- vagy feladatszöveggel: `marveen.schedule.runs` (minden ütemezett előfordulás ütemezés és kimenet szerint) és `marveen.schedule.run.duration` (csak command feladatokra, mert csak ezeket futtatja maga az ütemező; az LLM feladat egy ágens munkamenetébe gépelt prompt, a végét az ütemező nem látja, ezért annak nincs időtartama), `marveen.agent_messages.pending` és `.oldest_pending_age` (a sor mélysége és a legrégebbi elem kora), az ágensek közti üzenetekre `.delivered`, `.delivery.duration` és `.failed` (ok szerint: abandoned, inject_failed, error, invalid_sender), `marveen.channel.events` (a Telegram események állapot szerint) és `marveen.channel.handoff.oldest_pending_age`, valamint az exportőr saját `marveen.otel.export.failures` és `.rejected` számlálója. A command feladat `schedule.run` trace-et is hagy, és az a sikertelenül végződő ágens-üzenet, amit eddig nyitva hagyott a span, most hibával zárja.

Csak egy rögzített attribútumkészlet hagyja el a gépet: a tool neve, az MCP szerver és tool, az üzenetazonosító, a feladó és a címzett, a modell és a token-számok. Minden más, ami egy spanen van, eldobódik. A tool-hívás input_summary mezője (egy parancs eleje, fájlútvonal, URL) nem exportálódik, hacsak az `OTEL_EXPORT_INPUT_SUMMARY` nincs bekapcsolva, és akkor is 120 karakterre rövidítve, a felismert hitelesítő adatok (`user:password@`, `curl -u`, Authorization, Bearer és Basic értékek, `password=` vagy `token=` jellegű értékadások) és a home-könyvtár nélkül. Ez a szűrés heurisztika, nem garancia: tartsd kikapcsolva, hacsak a collector nem olyan helyen van, ahol a parancssorok megbízhatóak. Minden span és resource hordozza a `marveen.tenant.id` (`unresolved`, ha a tenant nem volt megállapítható) és a `service.instance.id` attribútumot (egy hash, ami sem a gépnevet, sem a telepítési útvonalat nem árulja el).

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

## 10. Modell fallback

A Modell fallback szekció szintetikus, és csak rendszergazdának érhető el. Azt a flotta-szintű szabályt állítja be, amely egy ágenst olcsóbb modellre tesz át, amikor kifogy a csomag használati kerete (a működését az [04 - Ágensek](04-agensek.md) fejezet írja le).

| Mező | Leírás |
|------|--------|
| **Engedélyezve** | Alapból ki van kapcsolva; amíg nincs bejelölve, egyetlen ágens sem vált automatikusan modellt |
| **Modell lánc** | Az első elem az elsődleges modell; minden további elem a következő lépcső lefelé. Legalább 2 elem kell |
| **Visszaállási idő (perc)** | A lefokozás után mennyi idővel térhet vissza az ágens a beállított modelljére, ha a limit üzenet már eltűnt |

Az **Engedélyezve** kikapcsolása csak az új lefokozásokat állítja le. Az az ágens, amely már a fallback modellen van, a visszaállási idő leteltével (a mentett érték érvényes) továbbra is visszatér a beállított modelljére, így nem kell visszakapcsolnod a funkciót a felszabadításához. A részletek a [04 - Ágensek](04-agensek.md#modell-fallback-használati-limit-esetén) fejezetben vannak.

---

## Tippek

- A piszkos-állapot-sávon a módosított kulcsok száma látható; a változtatások mentés nélkül elvesznek, ha elhagyod az oldalt.
- Az eszközkulcsok egyszeri megjelenítés után nem kérhetők le újra; a generálásuk után azonnal mentsd biztonságos helyre.
- Az autonómia-szinteket szükség esetén bármikor visszaállíthatod 1-re, hogy megóvd az érzékeny kategóriákat az autonóm végrehajtástól.
