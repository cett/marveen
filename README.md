# Marveen

![Marveen Banner](banner.png)

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5+Vector-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Anthropic-D97757?logo=anthropic&logoColor=white)](https://claude.ai/code)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed-000000?logo=ollama&logoColor=white)](https://ollama.com/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Slack](https://img.shields.io/badge/Slack-Socket_Mode-4A154B?logo=slack&logoColor=white)](https://api.slack.com/)
[![GitHub stars](https://img.shields.io/github/stars/cett/marveen?style=social)](https://github.com/Szotasz/marveen)

> AI csapatod, ami fut amíg te alszol.

> **Fork.** Ez a repó a [Szotasz/marveen](https://github.com/Szotasz/marveen) önálló forkja, amely `fork-point` (2026-07-26, baseline: upstream `55ecbc6`) óta függetlenül fejlődik. Az upstream javításokat szelektíven vesszük át (`git fetch upstream` + cherry-pick). Hozzájárulásokat ehhez a forkhoz várunk PR-ként. Az AI által generált monolitikus kódot felhagyva, modularizált verzió alkotása a célom, amelyben nagyságrendekkel kisebb tokenhasználatot emészt fel magának a keretrendszernek a használata és robosztusabb kialakítása révén hosszútávon stabilabb működést biztosít.
>
> Állapot: upstream `5e51bf28` vs fork `92451c56`, 2026-10-05

## Jónás Gergő (cett) hozzájárulásai az eredeti Marveen repóhoz

A [Szotasz/marveen](https://github.com/Szotasz/marveen) upstream repóba Jónás Gergő (cett) 56 commitot küldött be. Az alábbiakban funkcionális csoportosításban:

- **Elosztott nyomkövetés** -- OpenTelemetry trace-waterfall az inter-agent üzenetekhez: teljes kérés-lánc követhetővé válik a dashboardon (#705)
- **Prompt-injection védelem** -- quarantine sub-ágens, egress-gate, from-auth azonosítás, content-nonce; a fleet automatikusan elkülöníti az ismeretlen forrásból érkező utasításokat (#633)
- **HITL (human-in-the-loop) jóváhagyás** -- jóváhagyási primitív autonóm műveletekhez (#644), autonómia-szint beállítások per-kategória (#627)
- **Skills rendszer** -- Skills-oldal újratervezés, ágens-lokális skillek megjelenítése, `skill_usage` követési tábla PostToolUse hook-kal, per-ágens merged skill-index (#604, #649, #607, #643)
- **Dashboard -- Agents & Team** -- Agents és Team képernyők egyesítése egyetlen nézetté view toggle-lal (#669); központi Beállítások-felület v2 config-registry + override API-val (#393, #398); konfig-változás/idea-státusz/eseménynapló audit-tartalom a "Teljes audit trail" oldalon érhető el, a konfig-változások külön Napló-oldal nélkül, a Teljes audit trail oldalon követhetők (#400); HU/EN nyelvváltó teljes UI-lokalizációval (#419)
- **Kanban bővítések** -- Gantt/timeline nézet határidős kártyákhoz (#497); címkék és szűrők (#392); archivált kártyák dedikált nézet visszaállítással (#406); swimlane-nézet (#389); oszloponkénti WIP-limit badge (#388); card-aging vizuális jelzés (#386); alfeladat-beágyazás (#381)
- **Ideabox** -- comment-threadek, impact/effort pontozás, státuszszűrő, életciklus (audit, stale, reversal, definition-of-done) (#397)
- **Token- és költségmonitor** -- per-modell pontos költség, MCP-szerver/eszköz oszlopok, model-backfill upsert (#573)
- **Fleet-infrastruktúra** -- `/.well-known/fleetq` capability manifest Bearer auth-tal (#569); fleet-roster scaffold automatikus generálása a CLAUDE.md-be (#584); `DASHBOARD_PUBLIC_URL` elosztott ágensekhez (#600); dual worker sessions (#602)
- **Ütemezés és megbízhatóság** -- scheduled-task fire-timeout (#665); heartbeat-precheck (#482); per-tool kimenő HTTP-határidő (#561); watchdog restart-flapping javítás (#483); Dream Engine skill-flotta bucket a valós használati naplóból mér, nem becsül
- **Tool-call audit metadata** (#667); plugin-id centralizálás (#673); telepítő: Go + bumblebee auto-install (#432); frontend smoke-test + syntax-gate CI (#423)

## Változások/bővítések, amelyek a forkban megvannak, az upstreamben nincsenek:

**Biztonság és hozzáférés-szabályozás**

- **Hitelesítés és hálózati védelem:** a bejelentkezett session elsőbbséget élvez a legacy tokennel szemben, így a felhasználó mindig a tényleges szerepkörével azonosul. A dashboard alapból loopbackre köt, és minden kérés Host fejlécét engedélyezőlistával veti össze (DNS-rebinding ellen). A konfigurációs bemenetek (modell, port) validáltak a command-injection ellen, production alatt hibás konfiguráció leállít, a titkok fájl-mountból is érkezhetnek (Docker/k8s kompatibilis).
- **Prompt-injekció elleni védelem:** az ismeretlen forrásból érkező szöveget a flotta elkülöníti: karanténozott al-ágens, egress-allowlist, partner-küldő allowlist és kézbesítési szándék-regiszter. A külső szöveg untrusted-keretet kap; egy opt-in hook ugyanezt adja a böngésző-MCP és a WebSearch kimenetére, teljes naplózással és találat esetén audit-rekorddal (upstream #1426 alapján). A memória-szűrő csak a prompt-injekciós mintákat blokkolja, jogos üzemeltetési emlékeket nem.
- **Pusztító parancsok kapuja:** egy fail-closed PreToolUse hook blokkolja a törlést, a `sudo`-t, a `git push`-t és a hitelesítő-fájlok olvasását, engedélyezési módtól függetlenül; a `git push` csak a koordinátor saját munkamenetéből megy át, mert a PR-munkafolyamat igényli. Kontextus-érzékeny szűréssel (kommentek és fájlba írt törzsek kimaradnak) alacsony a hamis pozitív arány, flotta-szinten be van drótozva (upstream #1357 alapján).
- **Kimenő hálózati kapu:** az al-ágensek Bash-hívásaiból kiszűri a külső hálózati kilépést (letöltők, hálózati kliensek, értelmező-egysorosok, burkolók és aliasok mögött is), a helyi hálózat átmegy, a megengedett külső hostok telepítésenként vezetett listán vannak. Hiba esetén megtagad, a főágens szándékosan kimarad (upstream bash-egress kapuk alapján).
- **Védett kapu- és konfigfájlok:** az al-ágens nem szerkesztheti a kapu-, hook- és allowlist-fájlokat, sem a saját beállításfájljait (kerülő útvonalak és rekurzív másolás ellen is). Az allowlist-változásokról alapvonal, teljes másolat és rendszerüzenet készül. Minden profil flotta-szintű tiltási alapot kap, ágensenként bővíthető eszköz-tiltólistával.
- **Titkok (vault):** a titkok env-változóként, fájlként (opcionális visszaírással) vagy HTTP-MCP fejlécként injektálódnak, soha nem kerülnek logba vagy parancssorba. A vault-olvasás naplózott, a hozzáférési lista audit-módban működik, az SSH-kulcs titkok nem adhatók ki az általános útvonalakon, a visszavont eszközkulcs az SSH-bejegyzést is törli.
- **Szöveg-higiénia:** a tartós írási utak és az inter-agent üzenetek homoglifa-figyelmeztetést kapnak (üzenetküldésnél blokkol, a közvetlen adatbázis-írásokat trigger naplózza). Az inter-agent üzenetsoron PII-szűrő fut, a bypass csak admin session-ből fogadható el és auditált. Az ágensek önazonosító fejléce csak jelzés, sosem jogosultság.
- **Függőségek:** az ismert sérülékenységű npm-csomagok (lekérdezés- és ZIP-feldolgozás) felülbírálva, az Excel-import sérülékenység-mentes könyvtárral fut.
- **Tenant-izoláció:** a memória, a vektoros keresés, az üzenet-szálak, az áttekintő, a naplók, az ötletláda, a trace-ek, a jóváhagyások és a munkadokumentumok SQL-szinten tenantra szűrtek; az admin globális képet lát és tenantra szűkíthet. Az idegen tenant erőforrása pontosan úgy válaszol, mint a nem létező. A tenant törlése minden hozzá kulcsolt adatot visz, a több tenantot kiszolgáló ágens beállításai megmaradnak, és teszt őrzi, hogy új tenant-tábla ne maradhasson besorolás nélkül.
- **RBAC:** a jogosultsági tábla éles (enforce) módban fut, minden döntés tartós shadow-naplóba kerül, napi parancs-feladat riaszt a gyanús elutasításokra. A nem-admin hívó engedélyezőlistás nézetet kap a márkáról és a nyelvről, az ágens-lista és a szervezeti ábra a saját tenantjára szűkül. A dashboard elrejti a szerepkör által nem használható vezérlőket és oldalakat (kezelőfelületi réteg, a szerver dönt). Elfogadott kockázatok: a flotta tokenje admin-szintű, a főágens szándékosan kívül van a tenant-skill kapun, és MCP-szinten nincs tenant-szűrés.
- **B2B admin felület:** tenantok, felhasználók, eszközkulcsok, API-tokenek (létrehozás, rotálás, visszavonás), partner-küldők és skill-hozzáférés kezelése egy oldalon. Az ágens-elérhetőség tenantonként állítható (alapból tiltott), magas kockázatú MCP-szervernél megerősítést kér. A bejelentkezett felhasználó saját profil-oldalt kap (jelszócsere, munkamenetek kiléptetése).
- **Beépített súgó:** a felhasználói és az üzemeltetési kézikönyv a dashboardból, hitelesítés mögött olvasható magyarul és angolul, így repó-hozzáférés nélkül is elérhető.
- **Jóváhagyások és autonómia:** az emberi jóváhagyás kategóriánként állítható autonómia-szinttel működik. A kérések mindig lejárnak (alapból 60 perc, ismeretlen kategóriára 24 órás plafon), tenantra szűrtek, a nem-admin felhasználó csak a sajátját látja.

**Memória, keresés és adatkezelés**

- **Memória és keresés:** az embeddingek tömör bináris formában tárolódnak, a keresés HNSW-alapú (teljes-vizsgálatos tartalékkal). A hibrid találatok szöveges és vektoros keresést fuzionálnak, majd újrarangsorolnak recency-vel, az emlékek között irányított kapcsolati gráf van.
- **Életciklus:** az olvasások és a tartalom-változatok követettek, a régóta olvasatlan emlékek hidegre süllyednek, a cache-jellegű lekérések nem frissítik az olvasási időbélyeget. A token-naplók rövid ideig, a napi és havi összesítők években megmaradnak.
- **Munkadokumentumok:** az ágensek tervei, riportjai és bináris fájljai tenant-izoláltan és vektorosan kereshetően tárolódnak. Lejárati idejük van (a nyitott kanban-kártyához kötöttek védettek), a memória-keresés alapból ezeket is visszaadja.
- **Artifact store és import:** az ágensek által generált tartalom SQLite-ban él (szöveges és vektoros kereséssel, hitelesített sandbox-megnyitással). Az importált emlékek forrásai a fájlrendszer, Google Drive és SharePoint mellett Confluence Cloud is (inkrementális szinkron, a hozzáférés a vaultból).
- **Skillek SQL-ben:** a skillek tenant-izoláltan, auditálhatóan, hozzáférés-kezeléssel az adatbázisban élnek, a fájlrendszeri másolat (kísérő fájlokkal) belőlük generálódik. A dashboard-szerkesztő és az ágensek közvetlen fájl-szerkesztése is az adatbázisba tükröződik, a frissített alap-skillek nem íródnak vissza régire.
- **Tenant-skillek:** a tenant-skillek fájl-másolatát csak az egyetlen tenantnál engedélyezett ágensek kapják, a több tenant között megosztott ágensek nem, nehogy tenanthatáron átszivárogjon.
- **Konfiguráció és állapot SQLite-ban:** a rendszerbeállítások (maszkolt titkokkal, audit-naplózva), az autonómia-szintek, a modell-fallback, a föderáció, a költségkeretek, a vault-kötések és az ágensek futásidejű állapota adatbázisban tárolódik, fájl-alapú konfig nélkül.
- **Flotta export/import:** az egész flotta (ágens-konfigok, memória, kanban, ötletláda, skillek, ütemezések, import-források, SSH kulcs-metaadatok) hordozható JSON-ba exportálható. Az ütemezések és források letiltva érkeznek, a privát kulcs csak titkosított exporttal utazik, az efemer állapot és a felhasználói fiókok kimaradnak.
- **Megőrzés és mentés:** a napi takarítás az audit-, hook-, trace- és üzenetnaplókat konfigurálható megőrzéssel vágja. A nightly mentés ellenőrzött visszaállítással és ellenőrző összeggel megy, a vault-kulcsot az archívumtól külön tárolja.

**Üzemeltetési megbízhatóság**

- **Automatikus helyreállás:** újraindítás vagy crash után az ágensek 60 másodpercen belül visszaállnak, a lefagyott sessiont is beleértve.
- **Modell-fallback:** limit esetén konfigurálható lánc lép életbe (pl. opus, sonnet, haiku). A lefokozás tartós, az operátor beállítását nem írja felül, a visszaállás az ágens saját modelljére történik, újraindítás után is. A limit-észlelés szűk, hogy a pane-ben idézett szöveg ne váltson ki cserét.
- **Kontextus-védelem:** a proaktív watchdog hook minden tool-hívásnál figyeli a kontextus telítettségét, közvetlenül frissíti a token-használati adatot, és küszöbnél rolling HANDOFF-összefoglalót injektál. A fail-closed restart-kapu csak élő munkát jelző jelzésekre blokkol (aktív gyermekfolyamat, kézbesítetlen kimenet, megválaszolatlan kérdés), az elavult jelek elévülnek.
- **Ágens-futtatás:** a provider-dispatch (Claude/Ollama/Deepseek/OpenRouter) háttér-workerben fut (így a kanban AI-bontás helyi modellen is futhat), a session végén az auto-skillify hook skill-vázlatot generál.
- **Audit:** a flotta-műveletek, a kapuk elutasításai és a hook-események egységes "Teljes audit trail" oldalon böngészhetők (szűrés, lapozás, részlet-nézet, JSON-export).
- **Lapozás:** a közös lapozó komponens és a szerver-oldali lapozás a listanézeteken is él (kanban oszloponként, jóváhagyások, artifactok, ötletláda, memóriák, importált emlékek, munkadokumentumok).
- **Ütemezés, kézbesítés:** a hosszú feladat-prompt hash-sel ellenőrzött fájlon át jut az ágenshez, a rendkívül hosszú promptokra méret-figyelmeztetés van. A parancs-típusú feladatok aszinkron futnak, így nem blokkolják a dashboardot, időtúllépéskor a teljes folyamatfát leállítják. Az MCP előellenőrzés a felhasználói szerverekre is kiterjed.
- **Ütemezés, jóváhagyás és tenant:** minden feladat egy tenanthoz tartozik, a tenant-felhasználó a saját feladatait létrehozhatja és kezelheti, de az új feladat piszkozat, csak admin aktiválhatja, a nem-admin módosítás újra-jóváhagyást kér. A tenant-ágens páros érvényességét futáskor is ellenőrzi az ütemező, a nem-default tenant eredménye csak a saját csatorna-kötéseire megy.
- **Feladatok oldal:** a futás kimenetelét (időben, késve, kvóta vagy előellenőrzés miatt kimaradva) és a scheduler életjelét is mutatja. A kézi futtatás a parancs-feladatot közvetlenül futtatja.
- **Tenant kezdőcsomag:** minden nem-default tenant egy kész napi összefoglaló feladatot kaphat (admin-művelet, piszkozatként és szüneteltetve indul, csak a tenant saját memóriáját összegzi).
- **Heartbeat és monitorok:** a flotta memória-heartbeat kvóta-őre csak friss használati adatra cselekszik, és kihagyja a kizárólag nem-default tenantot kiszolgáló ágenseket. A blackboard-hygiene monitor determinisztikus parancs-feladat, amely az elakadt vagy a blackboardot nem frissítő ágenseket noszogatja, majd a koordinátorhoz eszkalál.

**Fleet koordináció és láthatóság**

- **Blackboard:** ágensenként egy élő sor (aktív, kész, blokkolt) előzményekkel, elavulás-jelzéssel és a delegált, de fel nem vett feladatok követésével. Az üzenet a küldő sorát a befejezéssel egy hívásban zárhatja, a blokkolt állapotok okuk szerint követettek.
- **Inter-agent üzenetek:** opcionális strukturált handoff-boríték, tenant-helyes eredmény-értesítés a delegálónak, tenant-ellenőrzés az üzenetek lezárásakor.
- **Overview:** admin-only kvóta-csík az 5 órás és heti keretről, az ablak-arányos felhasználási referencia-vonallal (upstream ötlet alapján), Szolgáltatások rács, skill-használati jelvények, a várakozó jóváhagyások számlálója.
- **Ágens-nézetek:** tenant főügynök-jelvény és (admin-only) tenant-chip az ágens-kártyákon és a szervezeti ábrán.
- **Kanban:** egységes kereső az aktív és archivált kártyák között (sorszám- és hash-keresés), oszloponkénti lapozott betöltés.
- **Flotta-szabály:** a sub-ágens sablon rögzíti, hogy feladat-delegálást és QA-t kizárólag a koordinátor ad ki.

**API és integrációs szerződés**

- **OpenAPI és SDK:** az API-felület egyetlen referenciája egy OpenAPI 3.1 spec (70+ végpont, három részletességi szinttel), a generált kliens szinkronját és az inkompatibilis változások kiszűrését CI-lépések őrzik.
- **Verziózás:** a kanonikus útvonalak verziózottak (v1), a régi aliasok Deprecation és Sunset fejlécekkel élnek a minimum 6 hónapos ablak végéig.
- **Egységes hibaszerződés:** minden API-hiba gépi-olvasható, kanonikus hibakóddal, magyar leírással és a hibás mező nevével érkezik (az upstream nem tartalmazza).
- **Megfigyelhetőség:** OpenTelemetry trace-waterfall az inter-agent üzenetekhez, Tempo/Jaeger kompatibilis JSON-export és push-alapú OTLP-export trace-ekkel és token-metrikákkal.

**Fejlesztői alapinfrastruktúra**

- **Kódszerkezet:** a frontend ES-modulokból áll lazy-loaddal (becsülten 85-90%-kal kevesebb token-terhelés egy módosításhoz), a backend route-modulokból és egy dispatcherből; a skillek hordozható placeholderekkel hivatkoznak az ágensekre és a tulajdonosra. Az SQLite-beállítások kis memóriaigényűek, a kapcsolatkezelés versenyhelyzet-mentes.
- **CI és minőség:** checksum-ellenőrzött, tranzakciós migráció-futtató; Node 22 és Python 3.12 teljes tesztkészlet, ratchetelt coverage-gate, frontend smoke-teszt, commit-üzenet ellenőrzés a belső azonosítók ellen.
- **Telepítés és dokumentáció:** idempotens, újraindítható telepítők (macOS, Linux, Windows), kétnyelvű felhasználói és üzemeltetési kézikönyv.

## A fork létrehozása óta átvett - cherry-pick - javítások:
#720, #727, #729, #738, #739, #740, #741, #742, #743, #744, #746, #747, #749, #751, #752, #753, #756, #757, #758, #763, #760, #765, #768, #769, #771, #772, #776, #777, #778, #779, #780, #781, #782, #783, #784, #785, #786, #789, #790, #791, #793, #795, #797, #799, #800, #801, #802, #803, #805, #821, #822, #826, #828, #829, #832, #838, #866, #833, #933, #934, #942, #943, #938, #854, #855, #871, #879, #888, #889, #906, #911, #926, #929, #940, #936, #973, #877, #964, #842, #857, #861, #885, #895, #896, #843, #876, #957, #1001, #1000, #982, #899, #939, #955, #992, #988, #985, #1007, #1010, #1013, #995, 

Állapot: upstream `5e51bf28` vs fork `92451c56`, 2026-10-05

<!-- ONGOING: Minden jövőbeli fork-PR leadásakor (fejlesztő -> koordinátor) frissítsd ezt a szakaszt
     a friss git log alapján:
       git fetch upstream && git fetch origin
       git log upstream/develop..origin/develop --oneline   # fork többlet
     Az "Állapot:" sorban frissítsd az SHA-kat és a dátumot. -->

## Minden másban - telepítés, használat - a fork megegyezik az eredetivel.
