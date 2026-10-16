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

A `BB_STALE_*` kulcsok azt szabályozzák, mennyi idő elteltével minősít a monitor egy ágens-sort elavultnak a blackboardon. Az érték perc, és az ágens tier-jétől függ: `BB_STALE_ORCHESTRATOR_MIN` (alapérték 120), `BB_STALE_INTERACTIVE_MIN` (90), `BB_STALE_SHORT_RUNNING_MIN` (30, tartomány 5-60; heartbeat és ütemezett ágensek), `BB_STALE_DEFAULT_MIN` (60) és `BB_STALE_ASSIGNED_MIN` (120, delegált, de még el nem kezdett feladatok). Az az ágens, akinek az ütemezett futása éppen tart, futás közben sosem lesz elavult.

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | A collector bázis-URL-je, `http://` vagy `https://` (például `http://localhost:4318`), hitelesítő adat nélkül; a trace-ek a `/v1/traces`, a metrikák a `/v1/metrics` útvonalra mennek. Amíg az `OTEL_EXPORTER_OTLP_HEADERS` az env fájlban be van állítva, az endpointot is onnan veszi, az itt mentett érték nem hat (a mentés ettől még bekerül a konfig-változásnaplóba) |
| `OTEL_EXPORTER_OTLP_HEADERS` | További kérés-fejlécek, általában hitelesítés, az OpenTelemetry formátumában: `név1=érték1,név2=érték2`, az értékek százalék-kódolva (`Authorization=Bearer%20abc`). Csak a `.env` fájlban add meg: titok, a dashboard sosem mutatja, és a `POST /api/settings` megtagadja az írását (adminnak is; a tárolt értéket az exportőr úgysem olvasná). Amíg be van állítva, az `OTEL_EXPORTER_OTLP_ENDPOINT`-ot is a `.env`-ből olvassa (a dashboardon megadott érték nem számít), így a hitelesítő adat csak arra a hostra mehet, amit mellé írtál; ha a fejléc a `.env`-ben van, de ott nincs endpoint, nem exportál |
| `OTEL_SERVICE_NAME` | A `service.namespace` resource attribútum értéke |
| `OTEL_EXPORT_INPUT_SUMMARY` | A tool-hívások rövid leírását (mit kapott a tool) is kiexportálja (alapból ki, lásd lent) |
| `OTEL_EXPORT_LOGS` | Az audit-eseményeket OTLP naplóként is elküldi a `/v1/logs` útvonalra (alapból ki; az `OTEL_EXPORT_ENABLED` is kell hozzá, lásd lent) |
| `OTEL_EXPORT_APP_LOGS` | A dashboard saját warn, error és fatal naplósorait is elküldi OTLP naplóként (alapból ki; az `OTEL_EXPORT_ENABLED` is kell hozzá, az `OTEL_EXPORT_LOGS`-tól független, lásd lent) |

Az exportőr OTLP-t beszél HTTP-n, JSON törzzsel, mást nem: nincs gRPC és nincs protokoll-választó. A fejlécek `https`-en mennek ki, vagy sima `http`-n privát hálózaton belül (localhost, privát cím, `.local` vagy egyszavas hostnév); beállított fejléceknél a nyilvános hoston lévő `http` endpointot egyáltalán nem használja. Az átirányítást nem követi, így a fejléc sosem jut más hostra.

Ha a collector hibázik, az exportőr 30 másodpercet, aztán 60-at, 120-at és így tovább legfeljebb 10 percet vár a következő próbáig (a collector `Retry-After` értékét tiszteletben tartja), jelenként külön, és közben megtartja az adatot. Ha a válasz azt mondja, hogy maga a törzs hibás (400, 413, 415, 422), a köteget eldobja ahelyett, hogy örökké újrapróbálná. Ha a collector csak egy köteg egy részét fogadja el, a többit megszámolja, nem próbálja újra. A számok a collectornak, amint újra válaszol, két számlálóként mennek el: `marveen.otel.export.failures` (kérések) és `marveen.otel.export.rejected` (elemek), `marveen.otel.signal` szerint (`traces` vagy `metrics`) bontva, és minden hiba figyelmeztetés a dashboard logjában.

A trace-eken és a token-használat metrikán túl a dashboard folyamat saját metrikákat is küld (resource: `marveen-dashboard`), mind csak számokkal, állapotokkal és nevekkel, soha üzenet- vagy feladatszöveggel: `marveen.schedule.runs` (minden ütemezett előfordulás ütemezés és kimenet szerint) és `marveen.schedule.run.duration` (csak command feladatokra, mert csak ezeket futtatja maga az ütemező; az LLM feladat egy ágens munkamenetébe gépelt prompt, a végét az ütemező nem látja, ezért annak nincs időtartama), `marveen.agent_messages.pending` és `.oldest_pending_age` (a sor mélysége és a legrégebbi elem kora), az ágensek közti üzenetekre `.delivered`, `.delivery.duration` és `.failed` (ok szerint: abandoned, inject_failed, error, invalid_sender), `marveen.channel.events` (a Telegram események állapot szerint) és `marveen.channel.handoff.oldest_pending_age`, valamint az exportőr saját `marveen.otel.export.failures` és `.rejected` számlálója. A command feladat `schedule.run` trace-et is hagy, és az a sikertelenül végződő ágens-üzenet, amit eddig nyitva hagyott a span, most hibával zárja.

A spanek és a token-metrika az OpenTelemetry GenAI konvenciót követik. Egy modellválasz `chat <modell>` span (CLIENT, `gen_ai.operation.name=chat`, `gen_ai.provider.name=anthropic`, a `gen_ai.request.model` és a `gen_ai.response.model` egyaránt a Claude Code által jelentett modell, mert az nem különbözteti meg a kért és a válaszoló modellt, valamint `gen_ai.usage.input_tokens`, `.output_tokens`, `.cache_read.input_tokens`, `.cache_creation.input_tokens`), egy tool-hívás `execute_tool <tool>` (`gen_ai.tool.name`; az MCP szerver és tool `marveen.mcp.server` és `marveen.mcp.tool` néven marad), egy ágens-kör `invoke_agent <ágens>` (`gen_ai.agent.id`, `gen_ai.agent.name`). Az ágensek közti üzenet PRODUCER span, minden más INTERNAL. Az a span, amely hibával vagy időtúllépéssel ért véget, `error.type` attribútumot (`timeout`, különben `_OTHER`, mert a pontos ok nincs rögzítve) és státuszüzenetet visel. A spannevek és attribútumkulcsok ezzel megváltoztak: aki `model.call`, `tool.<név>`, `agent.turn`, `tool_name`, `model` vagy `input_tokens` szerint szűrt, az újakat használja. A `gen_ai.client.token.usage` mostantól hisztogram egy modellválasz token-számáról, a `gen_ai.token.type` csak `input` vagy `output`, a konvenció vödörhatáraival (1, 4, 16, ... 67108864). A cache-olvasás, a cache-létrehozás és a thinking tokenek külön összegként mennek, `marveen.gen_ai.client.token.usage.other` néven (`marveen.token.type`). Mindkettő DELTA (minden export az előző óta eltelt időt fedi); a metrika első változata tévesen CUMULATIVE címkét kapott, így a backend minden ablakot folyó összegnek olvasott. Egy Prometheus-szerű backend elé a collector `deltatocumulative` processzora kell az exportőr előtt, hogy a tárolt kumulatív sorozatot előállítsa.

A `gen_ai.client.operation.duration` (másodperc, a konvenció szerinti vödörhatárokkal, delta hisztogram) KÖZELÍTÉS. A Claude Code nem rögzíti, mennyi ideig tartott egy válasz, ezért a context-watchdog hook a transcript időbélyegeiből becsli: a modell által megválaszolt sor és a válasz utolsó blokkja közötti idő. Az ilyen becslést hordozó `model.call` span `marveen.duration.source=transcript` attribútumot kap, és a metrika minden adatpontja is. Ha a becslés nem készíthető el (a szülő sor kívül esik a transcript utolsó 512 KB-ján, olvashatatlan sor, nulla, negatív vagy 30 percnél nagyobb különbség), a válasznak nincs időtartama: a span kezdete egyenlő a végével, kimarad a metrikából, és semmi nem hibázik. A metrika a `model.call` spanekből készül, ahogy az exportőr elküldi őket, memóriában: ami még nem ment el a dashboard leállásakor, elvész, a gyűjtő által véglegesen elutasított küldés eldobódik, a sikertelen küldés újrapróbálódik.

A dashboard a saját HTTP szerverét is jelenti, ahogy az OpenTelemetry HTTP konvenció definiálja: `http.server.request.duration` (másodperc, kumulatív hisztogram, a konvenció vödörhatáraival 5 ms-tól 10 s-ig) `http.request.method`, `http.route` és `http.response.status_code` szerint. A `http.route` SABLON, soha nem az útvonal: csak az erőforrás és a dashboard saját útvonalai által használt fix szavak maradnak meg (`/api/kanban/{id}`, `/api/memories/{id}/versions`, `/api/schedules/tick-status`), minden azonosító, név vagy keresőszó `{id}` lesz, a lekérdezés-szöveget soha nem olvassa, ami nem API, az `static`, a nemleges válasz (4xx) csak az erőforrás nevét kapja (`/api/kanban`), így idegen kitalált útvonalai sem töltik fel a sablonkorlátot, sem nem mutatják meg, mely útvonalak léteznek, és 300 különböző sablon után az újak `/other` alá kerülnek. A kliens által megszakított kérést és az eseményfolyamokat nem méri. Az a kérés, amely szerveroldalon hibázott (5xx) vagy legalább egy másodpercig tartott, spant is kap (`GET /api/overview`, SERVER fajta, ugyanaz a három attribútum, 5xx-nél hibás státusz); a gyorsabb sikerek csak a hisztogramban vannak, hogy kevesebb adatbázis-írás legyen. A `traceparent` fejléc (W3C trace context) a span-t a hívó trace-ébe teszi, de csak ha a kérés hitelesítéssel érkezett (idegen fejléce figyelmen kívül marad), és a `w3c-` kezdetű azonosítók foglaltak: a `POST /api/spans` elutasítja őket, és csak a dashboard saját kérés-spanjei mennek ki ilyen azonosítóval változatlanul; a tool-log hook a session azonosítójából képzett fejlécet küld, ugyanazt a trace azonosítót, amelyet az exportőr a session spanjeihez használ. A span nem veszi át a hívó span azonosítóját szülőként.

Csak egy rögzített attribútumkészlet hagyja el a gépet: a tool neve, az MCP szerver és tool, az üzenetazonosító, a feladó és a címzett, a modell és a token-számok. Minden más, ami egy spanen van, eldobódik. A tool-hívás input_summary mezője (egy parancs eleje, fájlútvonal, URL) nem exportálódik, hacsak az `OTEL_EXPORT_INPUT_SUMMARY` nincs bekapcsolva, és akkor is 120 karakterre rövidítve, a felismert hitelesítő adatok (`user:password@`, `curl -u`, Authorization, Bearer és Basic értékek, `password=` vagy `token=` jellegű értékadások) és a home-könyvtár nélkül. Ez a szűrés heurisztika, nem garancia: tartsd kikapcsolva, hacsak a collector nem olyan helyen van, ahol a parancssorok megbízhatóak. Minden span és resource hordozza a `marveen.tenant.id` (`unresolved`, ha a tenant nem volt megállapítható) és a `service.instance.id` attribútumot (egy hash, ami sem a gépnevet, sem a telepítési útvonalat nem árulja el).

A naplók opt-in módon (`OTEL_EXPORT_LOGS`) és kizárólag az audit-táblákból jönnek: jóváhagyás-események (`marveen.approval.*`: felhasznált, elutasított, megtagadott), RBAC elutasítások és would-deny döntések (`marveen.rbac.denied`, `marveen.rbac.would-deny`; a nem-admin hívók engedélyezett kéréseit nem küldi), beállítás-módosítások (`marveen.config.changed`, csak a beállítás kulcsával) az ágens-audit (`marveen.audit.<entitás>.<művelet>`) a blackboard (`marveen.blackboard.<active|done|blocked>`, a blocked bejegyzés WARN; csak az ágens és az állapot, az összefoglaló és a feladat-hivatkozás soha), a kanban tábla kártya-mozgatásai (`marveen.kanban.card.moved`, a két státusz, a kártya és a szereplő kulcsolt hash-e `marveen.kanban.card.hash` és `marveen.actor.hash` néven: egy kártya követhető az oszlopain át, cím, leírás, komment vagy azonosító nem megy ki) és a PreToolUse kapuk elutasításai (`marveen.hook.deny`, a kapu neve a `marveen.gate`-ben és egy okkód; ugyanennek a táblának az engedélyező és a kontextus-átadás sorai nem mennek ki). Egy rekord az esemény nevét, súlyosságot, időt és néhány korlátos azonosítót hordoz (döntés, szerep, jog, beállításkulcs, entitás, művelet, tenant), mást nem. Tartalom nem hagyja el az adatbázist: a beállítások régi és új értékét, az audit-részleteket, a jóváhagyás-hivatkozásokat és a kérés útvonalát ki sem olvassa. Minden szereplő (felhasználó, token, eszköz, ágens) helyett a `marveen.actor.hash` megy, egy kulcsolt hash, amelynek sója az adatbázisban marad: ugyanaz a szereplő minden rekordban ugyanaz az érték, de a név nem fejthető vissza. A bekapcsolás nem játssza vissza a múltat: az első futás a táblák legújabb sora után kezd, onnantól minden sor egyszer megy ki, a legrégebbivel kezdve, és a gyűjtő hibája alatt a következő próbára megmarad. A PreToolUse kapuk maguk számolják a döntéseiket (destructive-gate, secret-read-gate, email-approval-gate, outgoing-copy-gate, auth-admin-gate, tenant-skill-gate), és a dashboard a futó összegeket a `marveen.gate.decisions` kumulatív számlálóként küldi (`marveen.gate`, `marveen.gate.decision` = allow, deny vagy error, deny-nél és error-nál a `marveen.gate.reason` = denied, gate_error vagy exit_code), ebből áll össze az engedélyezési arány. Ez metrika, ezért nem függ az `OTEL_EXPORT_LOGS`-tól. A számot a kapu-folyamat írja, miután döntött; egy sikertelen vagy lassú írás elvész, és soha nem változtatja meg, mit döntött a kapu (hívásonként néhány ezredmásodperc a költsége). Az allow az olyan tool hívását is számolja, amelyet a kapu nem vizsgál, a kapu saját időkorlátjával véget érő deny-t pedig nem. A kapu által vizsgált hívásból (parancs, útvonal, címzett) semmi nem kerül eltárolásra.

A dashboard saját naplósorai külön, második opt-in alá tartoznak (`OTEL_EXPORT_APP_LOGS`), mert szabad szövegek. Csak a warn, error és fatal sorok mennek ki, a `marveen-dashboard` erőforrás `marveen.app` hatókörében, és soronként csak az ÜZENET SABLONJA: a pino által behelyettesített értékeket (`%s` argumentumok) és a híváshoz kötött mezőket, vagyis a hívás adatait, soha nem olvassa. A sablont megtisztítja a hitelesítő adatoktól, a home-útvonaltól, e-mail-címektől, útvonalaktól és hosszú azonosítóktól, és 160 karakterre vágja; ha a sor hibát hordoz, annak osztályneve és szöveges `code` mezője is megy (`exception.type`, `marveen.log.error_code`), az üzenete vagy a stack soha. Ez heurisztika: az üzenet-szövegbe magába sütött értéket (sablon-literál) nem ismeri fel, ezért nem része az `OTEL_EXPORT_LOGS`-nak. A kód emiatt fix üzenetekre van kötve: egy CI-ratchet (`scripts/log-message-literal-ratchet.py`) elbukik, ha egy warn, error vagy fatal hívás üzenete nem fix szöveg (beépített érték vagy változó), ahelyett hogy az adatot mezőként kötné, és az ilyen hívóhelyeket (a homoglifa-figyelmeztetések, a prober stderr-je, az API hibakatalógus, néhány név) átírtam. A tisztítás az önmagában álló szolgáltatói kulcsokat is eltávolítja (Anthropic/OpenAI `sk-`, GitHub, Slack, JSON web token, AWS kulcsazonosító), a naplószövegben pedig a hosszú, betűket és számokat kevert karaktersorokat. Azonos sorok egy rekordba olvadnak a `marveen.log.count` számlálóval, a puffer az utolsó 500 különböző sort tartja memóriában (újraindítás kiüríti), a eldobottak számát a `marveen.log.dropped` számláló adja. Az exportőr saját sorai nem kerülnek bele, így egy elérhetetlen gyűjtő nem naplóz magáról.

A gyűjtőnek kell naplókezelő pipeline (az OpenTelemetry Collector `otlp` receivere ugyanazon a porton fogadja a `/v1/logs`-t); az ilyen pipeline nélküli gyűjtő 404-et ad, amit a szokásos visszalépéssel újrapróbál, és a `marveen.otel.export.failures` számlálóban `marveen.otel.signal=logs` címkével látszik.

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
