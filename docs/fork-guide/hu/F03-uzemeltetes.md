# F03 Üzemeltetés

## Szolgáltatások indítása és leállítása

A Marveen két háttérszolgáltatásból áll: `dashboard` (API + webes felület) és `channels` (csatorna-kapcsolat + ágensek).

### macOS (launchd)

```bash
# Indítás
launchctl start com.<agent-id>.dashboard
launchctl start com.<agent-id>.channels

# Leállítás
launchctl stop com.<agent-id>.dashboard
launchctl stop com.<agent-id>.channels

# Újraindítás
launchctl kickstart -k gui/$(id -u)/com.<agent-id>.dashboard
launchctl kickstart -k gui/$(id -u)/com.<agent-id>.channels

# Állapot
launchctl list | grep <agent-id>
```

> Az `<agent-id>` az `.env` fájl `MAIN_AGENT_ID` értéke (pl. `marveen`).

#### Segéd-launchd feladatok (macOS)

A segéd-telepítők (`install-channel-keepalive-probe.sh`, `install-channel-coordinator.sh`, `install-channel-watchdog.sh`) a launchd-címkét az install saját azonosítójából képezik: `com.<service-id>.channel-keepalive-probe`, `com.<service-id>.channel-coordinator`, `com.<service-id>.channel-watchdog`. Az azonosító az install `.env` fájljának `SERVICE_ID` értéke, ennek hiányában a `MAIN_AGENT_ID`, végül `marveen`. Így két telepítés egy felhasználó alatt nem írja felül egymás segéd-feladatát. Alapértelmezett telepítésnél a címke változatlanul `com.marveen.<név>`, tehát nem mozdul semmi.

- A címke kiolvasása telepítés nélkül: `scripts/install-channel-keepalive-probe.sh --print-label`.
- Bevezetés (kézi lépés, pár perc kiesés a keepalive-ban): egy már átnevezett installnál (a `SERVICE_ID` nem `marveen`) futtasd újra a telepítőt `--load` kapcsolóval. A telepítő kivezeti az install saját régi `com.marveen.<név>` feladatát (csak akkor, ha a plist `WorkingDirectory` értéke ez a fa; másik install `com.marveen.*` feladatához nem nyúl), majd az újat tölti be.
- Visszaút: állítsd vissza a korábbi verziót, futtasd újra a telepítőt `--load` kapcsolóval (újra a régi `com.marveen.<név>` címkét írja), majd az újat told le: `launchctl bootout gui/$(id -u)/com.<service-id>.<név>` és töröld a `~/Library/LaunchAgents/com.<service-id>.<név>.plist` fájlt.
- A `SERVICE_ID` betűből, számból, `_` vagy `-` karakterből állhat; más érték esetén a telepítő figyelmeztet és `marveen`-t használ.

### Linux (systemd)

```bash
# Indítás
systemctl --user start marveen-dashboard
systemctl --user start marveen-channels

# Leállítás
systemctl --user stop marveen-dashboard
systemctl --user stop marveen-channels

# Újraindítás
systemctl --user restart marveen-dashboard
systemctl --user restart marveen-channels

# Állapot
systemctl --user status marveen-dashboard
systemctl --user status marveen-channels

# Naplók
journalctl --user -u marveen-dashboard -f
journalctl --user -u marveen-channels -f
```

### Dashboard újraindítás az API-n keresztül

Ha a dashboard fut, az újraindítás elvégezhető a `/api/updates/apply` végponton is (hívd a `bash scripts/agent-api.sh --token operator POST /api/updates/apply` wrapperen át: a token-fájlt a wrapper olvassa, parancssorba te sosem írod).

Induláskor a dashboard átveszi a `WEB_PORT` portot a saját előző példányától: a portot tartó node folyamatot leállítja. Ez csak ennek az installnak a folyamatára vonatkozik (a parancssora vagy a munkakönyvtára a telepítési fa alatt van). Ha egy másik telepítés vagy másik checkout dashboardja tartja ugyanazt a portot (például azonos `WEB_PORT` egy kipróbálásra előkészített másolatban), azt a dashboard nem bántja: a napló a `Port holder belongs to a different install, leaving alone` sort írja, az indítás pedig `EADDRINUSE` hibával áll le. Ilyenkor adj a másik telepítésnek külön `WEB_PORT` értéket.

## Frissítés

```bash
./update.sh
```

A frissítő elvégzi: `git pull` (fast-forward only), `npm install`, TypeScript fordítás, majd újraindítja a szolgáltatásokat és health-check-kel ellenőrzi az eredményt.

**Automatikus visszaállás (rollback):** ha a fordítás vagy az újraindítás után a dashboard nem válaszol 20 másodpercen belül, a frissítő automatikusan visszaállítja a korábbi commit-ot és újraindít.

### Frissítési opciók

```bash
# Fleet seed-skillek és ütemezett feladatok erőltetett frissítése
# (az egyéni módosításokat NEM érinti -- csak a seed-* mappák tartalmát)
./update.sh --reseed-fleet

# CLAUDE.md újragenerálása a sablonból (az aktuális .env adataival)
# A korábbi CLAUDE.md mentése előtte automatikus
./update.sh --regen-claudemd

# Kényszer-újrafordítás akkor is, ha a kód már aktuális
# (pl. stale dist/ után)
./update.sh --rebuild
```

Az opciók kombinálhatók: `./update.sh --reseed-fleet --rebuild`

### Automatikus frissítés

Az automatikus frissítés alapértelmezetten ki van kapcsolva. Engedélyezés:

```ini
# .env
AUTO_UPDATE_ENABLED=1
```

Engedélyezve, a seedelt `auto-update` ütemezett feladat minden szerdán 04:00-kor futtatja az `update.sh`-t és az eredményről értesítést küld a csatornán.

## Claude Code frissítés

Ez különbözik a fenti Marveen-frissítéstől: magát a `claude` binárist frissíti.

A Claude Code beépített automatikus frissítője **minden sessionben ki van kapcsolva** (`DISABLE_AUTOUPDATER=1` minden indítási helyen és a tmux globális környezetében). Ha egyszerre indul újra sok session, korábban mindegyik ugyanabban a másodpercben indította a frissítőt az egyetlen közös telepítésre (az npm-global telepítések `ENOTEMPTY` hibával buktak a csomagkönyvtár átnevezésén), a binárist pedig egy futó session alatt cserélte ki valaki olyan pillanatban, amit senki sem választott.

Helyette egyetlen command task frissít egyszer:

- A `claude-update` ütemezés (telepítésenként egyszer seedelve, hétfő 06:00 a szerver időzónájában) a `scripts/claude-update.sh`-t futtatja. Zárat vesz, összeveti a telepített verziót a legfrissebb kiadottal, egyszer frissít (natív telepítésnél `claude update`, npm-global telepítésnél egyetlen `npm install -g`), ellenőrzi, hogy a bináris még fut, és az eredményt a `store/claude-update.json`-ba írja. Hibánál az első előfordulásra Telegram-riasztás megy, és semmi sem indul újra.
- Valódi verzióváltás után a dashboard újraindítja a váltás előtt indult sessionöket: **csak idle sessionöket, egyenként, legalább 45 másodperc eltéréssel, a fő-agenst utoljára**. A sub-agentek `--continue`-val folytatják, a fő-agens friss beszélgetéssel jön vissza (a memória megmarad). A távoli agentek a saját telepítésüket használják, őket nem érinti.
- A **Frissítések** nézet mutatja a telepített és a legfrissebb verziót, az utolsó ellenőrzést, hogy van-e függő újraindítás, és figyelmeztet, ha az utolsó ellenőrzés 10 napnál régebbi (a heti feladat nem fut).

Vezérlés:

```bash
# Ellenőrzés változtatás nélkül (kiírja a telepített/legfrissebb verziót)
bash scripts/claude-update.sh --check

# A flotta tartása egy verzión (a heti feladat ilyenkor csak "pinned"-et rögzít)
echo 2.1.300 > store/claude-pin        # vagy: CLAUDE_UPDATE_PIN=2.1.300 a környezetben
rm store/claude-pin                    # a tartás feloldása
```

- Az AVX nélküli x86 gépeket mindig tartjuk: a rögzített Node-alapú buildet (`install-linux.sh`) nem szabad a legfrissebb Bun binárisra cserélni, ami AVX nélkül összeomlik.
- A `CLAUDE_UPDATE_AUTO_RESTART=0` (Beállítások, system modul) megtartja a frissítést, de a futó sessionöket a régi buildön hagyja a következő újraindulásukig; a Frissítések nézet ilyenkor függőben levőként mutatja az újraindítást.
- A frissítés azonnal futtatható a Feladatok oldalon (a `claude-update` "futtatás most" gombja). A frissítés leállításához tiltsd le az ütemezést; a törlést a rendszer megjegyzi, a feladatot nem hozza létre újra.
- Visszalépés: telepítsd kézzel a régebbi verziót, majd rögzítsd a `store/claude-pin` fájllal.

## Egészség-ellenőrzés

```bash
bash scripts/doctor.sh
```

A `doctor.sh` ellenőrzi:
- a launchd/systemd szolgáltatások futnak-e
- a dashboard HTTP végpont válaszol-e
- a tmux munkamenet él-e
- az `.env` alapvető mezői kitöltöttek-e
- a Node.js és npm elérhető-e
- minden ágens token-fájlja egyezik-e egy aktív tokennel (`agent-tokens check`; a hiányzó vagy elavult fájl figyelmeztetés)

Kilépési kód: 0 = minden rendben, 1 = valamilyen hiba.

A dashboard HTTP health végpont közvetlen ellenőrzése:

```bash
curl -f http://localhost:3420/
```

## Skill-használat naplózás

Az ágensek skill-használatát egy hook naplózza, ebből dolgozik a Dream Engine skill-egészség vizsgálata és a Skillek oldal jelvényei. A hook a dashboard indításakor kerül be minden sub-ágens beállításába (a főágensé a repo követett beállításaiban van); a már beállított, régebbi matchert is kiszélesíti, de a futó session csak újraindítás után olvassa újra a beállítást.

Minden sor a használat módját is tárolja (`source`): `skill_tool` (Skill eszköz), `read_tool` (Read a skill-könyvtár bármely fájlján), `bash_read` (olvasó parancs egy konkrét skill-fájlon), `bash_script` (interpreter vagy `./` a skill `scripts/` fájlján), `api_read` (GET a skill-adatbázis API-ra), `slash` (perjeles hívás). A `trigger_type` a régi kétértékű marad, a korábbi sorok `source`-a NULL, olvasáskor a `trigger_type`-ból származik; visszamenőleges kitöltés nincs. Egy azonos ágens, skill, munkamenet és `source` hármas 60 másodpercen belüli ismétlése egy sor.

Korlátok (best-effort): futásidőben összeállított útvonal, `bash -c "..."` belsejében futó parancs és szóközt tartalmazó shell-útvonal kimarad; a perjeles hívás csak akkor számít, ha a bevitel elején áll, a `plugin:skill` alakú nevek nem; a dashboard felületének saját lekérdezései nem számítanak.

---

## Mit tehet egy PreToolUse hook

Egy PreToolUse hook csak **tilthat** (`permissionDecision: "deny"` vagy 2-es kilépési kód) vagy **kontextust adhat**. A hívás bemenetét nem írhatja át, és nem engedélyezhet, nem kérdezhet, nem halaszthat. Az ok a kimenő levél: az `scripts/hooks/email-approval-gate.py` a hívásból kiolvasott levél hash-ére foglal jóváhagyást, és az MCP-úton ez a hash az egyetlen kötés (az MCP-szerver nem ellenőrzi újra). Egy második hook, amely ugyanannak a hívásnak a bemenetét átírná, azt eredményezhetné, hogy a kimenő levél eltér a jóváhagyottól. Az email-kapu ezért az egyetlen PreToolUse hook, amely bármit eldönt egy küldésről; a többi csak elutasíthat. Az `updatedToolOutput` (az eszköz EREDMÉNYÉT cseréli, nem a bemenetet) csak a ratchet által felsorolt fájlokban engedett (ma a browser content notice).

A `scripts/__tests__/hook-input-rewrite.test.py` (a CI Python lépése futtatja) elbukik minden hook-szkripten, kapun vagy forrásfájlon, amely a bemenet-átíró kulcsot használja, a `permissionDecision` értékét `deny`-tól eltérőre állítja, vagy az `updatedToolOutput`-ot az engedélylistán kívül használja. Ha átírás vagy engedélyezés tényleg kell, az email-hash-t a hatásnál újra ellenőrizni kell (a küldő a saját maga számolta hash-re foglal), és az engedélylista kap egy átnézett bejegyzést az indoklással. A repo saját hookjai és a telepített plugin-ek közül ma egyik sem csinál ilyet, ezért a szabály most semmibe sem kerül.

## Megszakadt turn jelzése

Az a session, amely egy turn közepén hal meg (összeomlás, watchdog-respawn, gép-újraindulás), eddig vakon hagyta az utódját: a Claude Code nem futtatja újra a megszakadt turnt, és a halál előtt beinjektált ágensek közötti üzenet vagy csatorna-prompt nyomtalanul eltűnt. A `scripts/hooks/inflight-turn.py` ezt a rést zárja ágensenként egy sorral az `agent_inflight_turns` táblában (0085-ös migráció, API: `/api/agent-inflight-turn/:agent/{begin,end,replay,consume}`):

- `UserPromptSubmit` az `inflight-turn.py begin`-t futtatja: feljegyzi a forrást (csatorna, ágens-üzenet, ütemezett feladat, közvetlen prompt), a `msg_id:N`-t ha a prompt megnevez egyet, egy 200 karakteres előnézetet és egy hash-t. Semmit nem ír ki.
- `Stop` az `inflight-turn.py end`-et futtatja: a turn befejeződött, a feljegyzés törlődik.
- `SessionStart` (`startup`, `resume`, `clear`; soha nem `compact`, mert az egy ép turn közben is tüzel) az `inflight-turn.py replay`-t futtatja: a még meglévő, 6 óránál fiatalabb, még fel nem ajánlott feljegyzésből `additionalContext` jelzés lesz, majd felajánlottnak jelölődik. A második indulás már semmit nem ajánl.

A jelzés tanács, soha nem újrafuttatás: megnevezi a forrást, az üzenetazonosítót és az indulás idejét, az előnézetet idézett adatként közli, és azt kéri az ágenstől, hogy döntse el, kell-e újra elvégezni a munkát, és ismétlés előtt ellenőrizze a mellékhatásokat (levél, push, törlés, delegálás, kártya-mozgatás). A két vagy több tenantot kiszolgáló ágens a jelzést előnézet nélkül kapja, és a prompt szövegét nem is tároljuk (az ellenőrzés replay-kor újra lefut, így a később második tenantra engedélyezett ágens is védett).

Ismert hamis pozitív: a felhasználói megszakítás (Esc) nem futtat `Stop` hookot, így a feljegyzés megmarad, és a következő újraindításnál egy fölösleges jelzés jöhet; a TTL és az egyszeri felajánlás korlátozza.

A hookok sosem blokkolnak: minden út 0-s kilépéssel ér véget, a leállt dashboard csendes no-op, és az ágens saját token-fájlja nélkül nem hívnak semmit. Bekötés (hookonként egy parancs, matcher csak a `SessionStart`-on kell):

```json
"UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "python3 <install>/scripts/hooks/inflight-turn.py begin", "timeout": 10 }] }],
"Stop":             [{ "hooks": [{ "type": "command", "command": "python3 <install>/scripts/hooks/inflight-turn.py end", "timeout": 10 }] }],
"SessionStart":     [{ "matcher": "startup|resume|clear", "hooks": [{ "type": "command", "command": "python3 <install>/scripts/hooks/inflight-turn.py replay", "timeout": 15 }] }]
```

## Tenant skill-kapu

A több tenantot kiszolgáló ágensek a tenantok skilljeit a saját tenantjuk kéréseihez kötik. Két hook végzi (mindkettő a dashboard indításakor kerül be minden sub-ágens `settings.json`-jába; a főágens nincs kapu alatt; a futó sessionök újraindítás után veszik fel):

- `tenant-context.py` (UserPromptSubmit): ágensenként rögzíti, hogy a most kiszolgálandó kérés melyik tenanthez tartozik (`agent_tenant_context`).
- `tenant-skill-gate.py` (PreToolUse: `Skill`, fájl-eszközök, `Bash`): a tenant-skillt, annak könyvtárát és a companion scriptjeit letiltja a tenant kérésein kívül. A fleet-skilleket sosem érinti.

**Forrás tenanthez kötése** (chat, dashboard-felhasználó vagy inter-agent feladó, ágensenként) az admin API-val:

```bash
bash scripts/agent-api.sh --token operator PUT /api/v1/admin/channel-bindings '{"agent_id":"<ágens>","channel":"telegram","external_id":"<chat id>","tenant_id":"<tenant>"}'
# GET listáz (?tenant_id= / ?agent_id=), DELETE megszünteti (?agent_id=&channel=&external_id=)
```

- A kötés nélküli forrás a `default` tenanthez tartozik: tenant-skill nem használható hozzá.
- Az ágens által egy tenant kérésének kiszolgálása közben küldött üzenet megkapja a tenant bélyegét, így a koordinátor delegálása a fogadó ágenshez is elviszi. Az ilyen üzenetet az adott tenant dashboard-felhasználói és az adminok látják, más tenant nem.
- Az ágensnek engedélyezettnek kell lennie a tenantnál (vagy annak főágensének), a tenant nem lehet letiltva; különben a forrás "ismeretlen", és tenant-skill nem használható.
- Az ütemezett feladat a tenantját a saját sorában hordozza (`schedules.tenant_id`, hiányában `default`), nem csevegés-kötésben: a hook a feladat promptjából olvassa. A feladat ágensének ki kell szolgálnia ezt a tenantot. Az ütemezés API ezt létrehozáskor és szerkesztéskor kikényszeríti, a futtató pedig minden ütemben újra ellenőrzi, és nem tüzeli azt a feladatot, amelynek a párosa megtörött (futási előzmény: `skipped_tenant_mismatch`); lásd F07, "Ütemezett feladatok tenant-tulajdonlása".
- Kötés módosítása vagy törlése, ágens letiltása egy tenantnál, tenant letiltása vagy a főágens cseréje azonnal törli az érintett kontextust; a tenant-skillek a következő promptig tiltottak, amíg az újra nem oldja a forrást.
- Fail-closed: hiányzó tábla, adatbázis-hiba, elavult kontextus (`TENANT_CONTEXT_MAX_AGE_SECONDS`) vagy kapu-hiba esetén a tenant-skill tiltott. A prompt-hook elutasítja a promptot, ha nem tudja rögzíteni a kontextust. Táblát sosem hoz létre: az `agent_tenant_context`-et a 0065 migráció birtokolja, ezért a dashboardnak előbb migrálnia kell.

A bevezetés ellenőrzéséhez (a hookokat bekötő dashboard-restart előtt és után) futtasd: `python3 scripts/tenant-gate-rollout-check.py`; csak olvas, és jelenti a migrációkat, a hook-scripteket, az ágensenkénti bekötést, az élő hook-bizonyítékot és a csatornakötés nélküli több-tenantos ágenseket. A migrációk, a hook-bizonyíték és a csatornakötés adatai a futó dashboardtól jönnek (`GET /api/admin/tenant-gate-status`); az endpointot még nem ismerő dashboard WARN-t ad, így a restart előtti első futás a fájl-oldali ellenőrzéseket így is jelenti.

A főágens szándékosan nincs a kapu alatt: a fail-closed prompt-hook adatbázis-hibánál elutasíthatná a promptjait, és leállítaná a teljes flotta koordinációját, tenant-skillre pedig nincs szüksége.

Korlátok: ez a tenant-skillek **használatát** kényszeríti ki, a shell oldalán best-effort (a változókból összeállított útvonalat nem fogja meg). Nem adat-izoláció: az ágens közös sessionje az előző tenant üzeneteit továbbra is tartalmazza.

### Alapcsomag egy meglévő tenantra

Az alapcsomag (egy napi összefoglaló ütemezett feladat, részletek: F07 "Tenant alapcsomag") magától csak az azt bevezető kiadás után létrehozott tenantnál jön létre (lásd F07 "Tenant alapcsomag", automatikus létrehozás); a már meglévő tenant nem kapja meg automatikusan. Ezeknél és javításhoz az admin kéri, tenantonként, bármikor; a kérés idempotens, ismétlése sosem ír felül semmit. A dashboardon a Tenantok fül **Alapcsomag** gombja végzi, API-n:

```bash
bash scripts/agent-api.sh --token operator POST /api/v1/admin/tenants/<tenant>/starter-pack '{"agent_id":"<ágens>"}'
# a törzs elhagyható: az ágens a tenant fő ágense, ennek hiányában az egyetlen engedélyezett ágens
# GET ugyanezen az útvonalon csak olvas: az állapotot és azt az ágenst adja, amelyet a létrehozás választana
```

A lépések:

1. Az ágensnek engedélyezettnek kell lennie a tenantnál (vagy annak fő ágensének kell lennie), és nem szolgálhat ki más tenantot is. Ha ez nem teljesül, a kérés `409`-et ad; ha nincs egyértelmű ágens, `400 required` (ilyenkor add meg az `agent_id`-t).
2. A kérés `draft` és letiltott feladatot hoz létre. Aktiválni egy bejelentkezett adminnak kell (Feladatok oldal), utána a **Folytatás** engedélyezi.
3. Csatornaüzenet csak akkor megy a tenant felhasználóinak, ha van Telegram csatorna-kötésük az ágenshez (a fenti `channel-bindings` hívás, magánbeszélgetés), és ugyanez a chat az ágens `access.json` `allowFrom` listájában is szerepel. Legfeljebb 3 címzett kap üzenetet, a csoportos csevegések kimaradnak. Kötés nélkül a feladat csak a napi naplóba ír.
4. Ha később a tenant ágense megváltozik, az ágens-hozzáférés módosítása automatikusan újracélozza a feladatot (és visszateszi `draft` és letiltott állapotba). Ágens törlése vagy átnevezése után, illetve a tenant fő ágensének SQL-es cseréjekor nincs automatika: a kérés ismétlése (vagy a gomb) javítja.

## Watchdog

A csatorna-kapcsolatot egy független watchdog felügyeli (`scripts/channel-watchdog.sh`), amely a dashboard folyamattól függetlenül fut (systemd timer, 5 percenként). Ha a csatorna-munkamenet elakad vagy leáll, a watchdog `tmux respawn-pane`-nel állítja helyre -- kizárólag a csatorna-munkamenetet, a többi ágenst nem érinti.

Két érzékelési jel:

| Jel | Leírás |
|-----|--------|
| STALE | `store/.channel-keepalive` fájl időbélyege: ha 3 percnél régebbi, a csatorna-munkamenet valószínűleg leállt |
| AUTHDEAD | A futó munkamenetben Claude bejelentkezési hibaüzenet (pl. "Please run /login", 401) -- csak a dashboard nélküli esetekre: ha a dashboard fut, az saját reauth-folyamata kezeli előbb |

A watchdog türelmes: csak `AUTH_DEAD_THRESHOLD_TICKS` egymást követő negatív jelzés után avatkozik be (kb. 10-15 perc), hogy ne indítson felesleges újraindítást egy rövid hálózatkimaradás után.

### Alvás és ébredés (macOS)

Az alvó Mac nem futtat időzítőt: a keepalive-próba és a watchdog is leáll, az elmaradt tickek ébredés után azonnal, megállapított sorrend nélkül lőnek. Védelem nélkül a watchdog érhetett oda előbb, az alvás korú keepalive-fájlt látta, és újraindított egy egészséges főágens-munkamenetet (két nap alatt kétszer, mindkétszer elveszett egy élő beszélgetés). Ezért a watchdog kiolvassa az utolsó ébredés idejét (`sysctl -n kern.waketime`, ez DarkWake-re, azaz karbantartó ébredésre is lép), és az ébredés után `WAKE_GRACE_SECONDS` (600) másodpercig:

- ebben a tickben nem tesz semmit, és ezt naplózza: `recently woken (<n>s ago, grace 600s) -- skipping this tick`; a halott-token ág is vár, mert a hálózat ilyenkor gyakran még nincs vissza;
- utána a keepalive életkorát legkorábban az ébredéstől számolja, így egy alvás előtti fájl addig sem "elavult", amíg a keepalive-próba le nem futott a tickjeivel.

Ez csak késleltet: az ébredés után is halott munkamenetet egy későbbi tick újraindítja. Ha az ébredés ideje nem olvasható (nem macOS, nincs `sysctl`), a watchdog a régi módon működik. Akkun, 15 percenként ébredő gépen (Maintenance Sleep) a watchdog emiatt többnyire szünetel; a gép ilyenkor nem szolgál ki semmit, és az első teljes ébredés 10 perc türelmi időt kap. A `pmset -c sleep 0` csak hálózaton tartja ébren a gépet; akkun az ébredés-kapu védi a munkamenetet. A context-guardnak ugyanez a gondja a handoff-határidőivel: ha egy sweep az előzőt több mint három intervallummal korábban látja, a többletet alvásnak veszi, és a futó határidőket ennyivel tolja (`context-guard: the machine slept between sweeps, running deadlines moved`).

A Telegram progress-őrszem (`scripts/hooks/telegram_progress_watchdog.py`, a "Dolgozom rajta" placeholder watchdogja) ugyanezt a kaput kapta: a placeholder korát a falióráról méri, ezért alvás után minden élő placeholdert öregnek látott, és egy egészséges turn placeholderét átírta a hibaszövegre. Az ébredés idejét ugyanazzal a `portable_wake_epoch` segédfüggvénnyel olvassa, ébredés után 600 másodpercig nem csinál semmit (`recently woken (<n>s ago, grace 600s) -- skipping this run` a progress könyvtár `debug.log`-jában), utána pedig a placeholder korát és a takarított dedup-jelölők korát a fájl módosítási ideje és az ébredés közül a későbbitől számolja. Ismeretlen ébredési idő (nem macOS, nincs `sysctl`, a szkript kóbor másolata `scripts/lib/portable.sh` nélkül, jövőbeli ébredési idő) esetén a viselkedés a régi. A `scripts/__tests__/telegram-watchdog-wake.test.sh` fedi.

## Modell-fallback használati limitnél

Ha egy ágens eléri a csomag használati limitjét, vagy a modellje elérhetetlenné válik, a model-fallback futtató egy beállítható láncon (például opus, majd sonnet, majd haiku) lejjebb léptetheti, később pedig visszaléptetheti. Alapból ki van kapcsolva. Adminként a Beállítások "Modell fallback" fülén, vagy a `GET` / `PUT /api/model-fallback` végponttal állítható (`enabled`, `chain`, `revertAfterMinutes`; az alapértelmezett visszaállási idő 330 perc, a `DEFAULT_REVERT_AFTER_MINUTES`-szel felülírható). A konfiguráció az adatbázisban van (`system_config`).

Működés:

- 60 másodpercenként lefut egy sweep a főágensen és minden futó al-ágensen. Beolvassa a panelt, és csak akkor cselekszik, ha a panel tétlen.
- A használati-limit banner egy észlelés. A "model unavailable" üzenetet két egymás utáni sweepben kell látnia, így egy chatben idézett hibaszöveg nem okoz váltást. Az "approaching usage limit" figyelmeztetés nem számít kimerült keretnek.
- A lefokozás **tartós fedő-állapotként** kerül a `store/model-fallback-state.json` fájlba (ágensenként: `primary`, `current`, `downgradedAt`). A modell-feloldók, a főágensnél a `scripts/channels.sh` is, az aktív fedő-állapotot nézik először. A saját konfigurációd (`MAIN_AGENT_MODEL` az `.env`-ben, vagy az ágens `model` mezője az `agent-config.json`-ban) sosem íródik felül.
- Az al-ágens a beszélgetése megtartásával indul újra (`--continue`). A főágens frissen indul újra, így a beszélgetése nem marad meg; ott a modellcsere a lényeg.
- A fedő-állapot túléli a dashboard újraindítását, így a visszaállás is megtörténik. `revertAfterMinutes` limitmentes idő után az ágens a **saját konfigurált modelljére** tér vissza (nem a lánc első tagjára), és a fedő-állapot törlődik.
- Minden váltás után 10 perc szünet van új lefokozás előtt, mert egy újraindított panelen még látszhat a régi banner, és az ágens percek alatt végigmenne a teljes láncon.
- Ha az ágens konfigurált modelljét pont arra állítod, amit a fedő-állapot rögzít, a következő sweep elavultként eldobja.
- Az ágens modelljének szándékos átállítása (dashboard, vagy `PUT /api/agents/<name>` a konfiguráltól eltérő `model`-lel) törli a fedő-állapotát, így a te döntésed erősebb az automatikus lefokozásnál. Az a mentés, amely csak a változatlan modellt ismétli, nem szünteti meg az aktív lefokozást.
- Az ágens-összegzés (`GET /api/v1/agents`, `GET /api/v1/agents/<name>`) mindkét modellt jelenti: a `model` a beállított modell, a `fallback` az aktív fedő-állapot (`{ primary, current, downgradedAt }`, vagy `null`), az `effectiveModel` pedig az, amivel az ágens indul (aktív fedő-állapotnál a fallback modell). A dashboard modell-választója a `model` értéket tartja, és `fallback aktív: <modell>` jelzést mutat; a változatlan mentés nem küld kérést és nem indítja újra az ágenst, így a fedő-állapot megmarad. Az a kliens, amely saját modellválasztót épít, a `model` értéket használja a választó értékének. Az `effectiveModel` vagy az élő modell változatlan visszaküldését operátori módosításnak olvasná a rendszer, és eldobná a fedő-állapotot.
- **A funkció kikapcsolása** csak az új lefokozásokat tiltja. A sweep továbbra is meglátogat minden olyan ágenst, amelynek van fedő-állapota (és csak azokat), és ugyanazon az úton állítja vissza, mint bekapcsolt funkciónál: ha a `downgradedAt` óta eltelt a `revertAfterMinutes`, előbb törlődik a fedő-állapot, majd újraindul a session (al-ágens `--continue`-val, a főágens frissen), és ha az újraindítás nem sikerül, a fedő-állapot visszakerül. A panelnek olvashatónak és tétlennek kell lennie, különben a visszaállás egy későbbi sweepre vár. Kikapcsolt funkciónál a használati-limit és a model-unavailable észlelés nem fut, így a panelben látszó banner nem késleltetheti a visszaállást, és a 10 perces szünet (amely csak az új lefokozást védi) nem érvényes. Mivel a sweep 60 másodpercenként fut (az első a dashboard indulása után 50 másodperccel), az esedékes visszaállás nagyjából egy percen belül megtörténik. Az az ágens, amely nem fut, amikor a fedő-állapota esedékessé válik, újraindítás nélkül csak a fedő-állapotát veszíti el, így a következő indítása a beállított modellt használja; ez bekapcsolt funkciónál is így van. Gyorsabb felszabadításhoz töröld az ágens bejegyzését a `store/model-fallback-state.json` fájlból, és indítsd újra.
- A főágens indítója, a `scripts/channels.sh` a fedő-állapotot `jq`-val olvassa. Ehhez a `jq`-nak a `PATH`-on kell lennie, és figyelmen kívül hagyja azt a fedő-állapot értéket, amely nem sima modellazonosító (betűk, számjegyek, `.`, `_`, `:`, `/`, `-`, szögletes zárójelek, legfeljebb 128 karakter), mert az érték az indító parancsba kerül. Mindkét esetben a főágens a `MAIN_AGENT_MODEL`-lel vagy a `.claude/settings.json` modelljével indul, mintha nem lenne fedő-állapot.
- A `scripts/channels.sh` nem vizsgálja, hogy a fedő-állapot visszaállítása esedékes-e. Az a főágens, amelyet a következő model-fallback sweep előtt indítanak újra (például a watchdog), ezért akkor is a fedő-állapot modelljén indul, ha a visszaállítási ideje már lejárt, és ott marad, amíg a következő sweep vissza nem állítja (a sweep 60 másodpercenként fut).

## Context-restart kapu

A context-restart kapu egészségesen tartja a hosszú session-öket anélkül, hogy félbeszakítaná a folyamatban lévő munkát. Ha az ágens kontextusa egy token-küszöb fölé nő, puha `/clear`-t küld, hogy a SessionStart hookok átvigyék az ágenst egy friss session-be, de csak akkor, ha semmi sincs folyamatban. Nem használ modell-tokent: minden ellenőrzés adatbázis-lekérdezés, fájlolvasás vagy panel/folyamat pillanatkép.

Ágensenként opt-in (alapból kikapcsolt). Az ágensenkénti beállítások az `agent_settings` táblában vannak (`context_restart_gate` kulcs), a futás-állapot az `agent_state` táblában; HTTP végpont nincs hozzájuk. Alapértékek: küszöb 400000 token, elévülési határ 2 óra, újraellenőrzés 5 percenként, tartós-blokk riasztás 2 óra után, kényszerített `/clear` 4 óra blokk után.

A kapu fail-closed: egy nem mérhető jel blokkol. Blokkol, amíg ezek bármelyike fennáll: a panel nem igazoltan tétlen vagy használati-limit bannert mutat, a kemény kontextus-őr kezeli a session-t, a claude folyamatnak élő gyermeke van (Task-tool al-ágens, háttérben futó shell parancs), az ágensnek kiküldött, még eredményre váró üzenete van, az utolsó bejövő csatorna-üzenetre nincs későbbi válasz, vagy egy strukturált feladat-állapot folyamatban van. Az órákig blokkoló kapu riasztást küld, és a kényszerített-újraindítási ablak után, ha semmi sincs folyamatban és a panel tétlen, mégis elküldi a `/clear`-t.

Azok a jelek, amelyek már nem élő munkát írnak le, figyelmen kívül maradnak, így a kapu nem ragadhat be elavult adat miatt:

- Az elévülési határnál régebbi megválaszolatlan bejövő üzenet elhagyottnak számít, ahogy az ugyanilyen korú kiküldött üzenet is.
- A teljesítési jelentések (`[Eredmény]` üzenetek) és az al-ágens főágensnek küldött üzenetei (státuszjelentések, válaszok) nem számítanak függő kimenő üzenetnek, mert rájuk soha nem érkezik eredmény. A főágens saját kimenő üzenetei valódi delegálások, ezek továbbra is számítanak.
- A jelenlegi session indulása előtt kezdődött blokkolási sorozat eldobásra kerül: az újraindított ágens nem örökli a régi session blokk-óráját, riasztását és kényszerített-újraindítási jogosultságát.
- A kontextus-méretet csak az **aktív** session átiratából méri. A session indulása előtt utoljára írt átirat az előző session-é; az új session, amelynek még nincs saját átirata, 0 tokennek számít, nem a régi session méretének.

## Mentés és visszaállítás

### Mentés futtatása

```bash
bash scripts/backup.sh
```

Az archívum a `backups/` könyvtárba kerül (`claudeclaw-YYYYMMDD-HHMMSS.tar.gz`) SHA-256 sidecar fájllal együtt (`.sha256`). Ha van vault, a vault mesterkulcsa külön fájlba kerül (`claudeclaw-YYYYMMDD-HHMMSS.vault-key`, 0600 mód) -- lásd lentebb.

**Megőrzés:** az utolsó 30 archívum marad meg (alapértelmezés). Felülírható:

```bash
BACKUP_KEEP=14 bash scripts/backup.sh
```

Az éjszakai futtatáshoz ütemezd `type: command` feladatként (lásd F07, "Command feladatok"): ágens-session nélkül fut, és `failThreshold: 1` mellett már az első hiba Telegram-riasztást küld.

### Az archívum tartalma

Az archívum két csoportból áll:

**`repo/` csoport** (a projekt könyvtárához képest relatív):
- `store/claudeclaw.db` (+ `-shm`/`-wal`) -- az adatbázis (WAL-checkpoint után)
- az `api_tokens` sorok (token-hash-ek) az adatbázisban
- `store/vault.json` -- a *titkosított* titokvault (a kulcs nincs az archívumban)
- `.env` -- fő konfiguráció
- `agents/*/CLAUDE.md`, `SOUL.md`, `.mcp.json` -- ágens-identitások
- `agents/*/.claude/channels/*/` -- csatorna-konfiguráció
- `agents/*/memory/` -- ágensenkénti memória-könyvtár

**`home/` csoport** (a `$HOME`-hoz képest relatív):
- `.claude/skills/` -- skill könyvtár
- `.claude/scheduled-tasks/` -- fájl-alapú ütemezett feladatok
- `.claude/projects/*/memory/` -- a fő ágens, a workerek és az al-ágensek auto-memóriája (a `projects` könyvtáraik erre az egy közös helyre mutató symlinkek, ezért egyszer kerül mentésre)
- `.claude/channels/*/` -- csatorna-tokenek és párosítási állapot
- `Library/LaunchAgents/com.<agent-id>.*.plist` -- launchd jobs (macOS)

**Szándékosan NINCS az archívumban:** az ágensenkénti token-fájlok (`agents/<ágens>/.agent-token`), a fő ágens projekt-gyökérbeli `.agent-token` fájlja, a `store/.operator-token` és a közös dashboard-token fájl, a `store/.dashboard-token` (egy archivált közös token a már lecserélt tokent élesztené újra). Visszaállítás után újra ki kell adni vagy rotálni kell őket.

### Vault mesterkulcs

A `store/vault.json` titkosított; a mesterkulcs a macOS Keychainben van (`com.marveen.vault` / `master-key` elem), tartaléknak a `store/.vault-key` fájlban. A kulcs szándékosan **nincs** az archívumban: aki az archívumot és a kulcsot is birtokolja, feloldja a vaultot. A `backup.sh` a `backups/claudeclaw-YYYYMMDD-HHMMSS.vault-key` fájlba írja (0600). **Ezt a fájlt az archívumtól máshol tárold** (másik lemez vagy jelszókezelő). Ha a mentéskor nem található kulcs, a mentés lefut és figyelmeztet -- az abban az archívumban lévő vault nem fejthető vissza. Kulcs visszaállítása: másold a fájlt `store/.vault-key` néven (`chmod 600`), vagy importáld a Keychainbe úgy, hogy a kulcs ne kerüljön parancssorba (az argumentumok `ps`-sel más folyamatoknak is látszanak): futtasd a `security add-generic-password -U -s com.marveen.vault -a master-key -w` parancsot `-w` utolsó kapcsolóval, érték nélkül, és a kérésre illeszd be a kulcsot.

A `scripts/verify-restore.sh` hibát jelez, ha egy archívumban kulcsfájlt talál, és figyelmeztet, ha a `vault.json` benne van, de a `.vault-key` sidecar nincs mellette. Hibát jelez akkor is, ha az archívumban ágens-, operátor- vagy közös dashboard-token fájl van (a mentés hatóköre megváltozott), figyelmeztet, ha az archívum közös-token sora régebbi az élőnél (az archívum a rotálás előtti), és a végén kiírja az alábbi token-lépéseket; a `restore_log` jegyzete ilyenkor `token-step pending`.

### Visszaállítás

```bash
# 1. Ellenőrzés
tar -tzf backups/claudeclaw-20260101-120000.tar.gz | head -20

# 2. Ideiglenes könyvtárba kicsomagolás (ellenőrzéshez)
mkdir /tmp/restore
tar -xpzf backups/claudeclaw-20260101-120000.tar.gz -C /tmp/restore

# 3. Visszaállítás a projekt könyvtárba
tar -xpzf backups/claudeclaw-20260101-120000.tar.gz \
  -C /tmp/restore && \
  cp -a /tmp/restore/repo/. ./ && \
  cp -a /tmp/restore/home/. ~/
```

> A `-p` (preserve modes) opció gondoskodik arról, hogy a `0600` jogosultságú token-fájlok ne legyenek világ-olvashatók visszaállítás után.

### Visszaállítás után: API tokenek

Minden ágens a saját token-fájljával írja alá a dashboard-hívásait, az operátor-scriptek pedig a `store/.operator-token` fájlt használják; egyik sincs az archívumban, ezért egy visszaállított telepítésben az ágensek nem tudnak API-t hívni, amíg a fájlokat újra ki nem adod. Közös-token tartalék nincs: ha egy ágens saját tokenje hiányzik, a wrapper nem küld kérést (az `agent-api.sh` 3-as kóddal lép ki, az `agent_token.py` és az `agent-api.mjs` `none` forrást jelez). A közös dashboard-token (`store/.dashboard-token`) szintén kimarad az archívumból, de az adatbázis sorai benne vannak, ezért azt is rotáld: az archívum egy korábbi rotálást megelőzhet, és a visszaállítás nem hozhatja vissza a lecserélt közös tokent. A token-lépéseket a dashboard és az ágensek indítása **előtt** futtasd (a 2-5. lépés leállított dashboarddal is megy: közvetlenül az adatbázissal dolgozik):

```bash
# 1. archívum kicsomagolása és visszamásolása (lásd "Visszaállítás"), majd a vault-kulcs visszaállítása
# 2. a token-fájlok újra kiadása; az érvényes fájl marad, az adatbázis által nem ismert fájl cserélődik
npm run agent-tokens -- issue
npm run agent-tokens -- issue-operator
# 3. a közös token rotálása, mindig: új tokent állít elő, beírja a store/.dashboard-token fájlba és
#    visszavonja a visszaállított sort, így a régi érték elutasítást kap (401, shared_token_refused-ként
#    számolva). Nem fut, amíg a DASHBOARD_TOKEN be van állítva az .env-ben vagy a környezetben (a változó
#    felülírja a fájlt). Az a böngésző, amelyik még a régi tokent használja (?token= link), az
#    `npm run dashboard-url` linkkel újra beiratkozik.
npm run agent-tokens -- rotate-shared
# 4. minden fájl ellenőrzése az adatbázissal szemben
npm run agent-tokens -- check
bash scripts/doctor.sh
# 5. csak most indítsd a dashboardot és az ágenseket
```

Az `agent-tokens check` csak olvas és tokent soha nem ír ki. Fájlonként egy sor (`alany  állapot  szerep  útvonal`), a kilépési kód 1, ha bármi nem `ok`:

| Állapot | Jelentés | Javítás |
|---------|----------|---------|
| `ok` | a fájl olyan tokent tartalmaz, amit az adatbázis az adott alanyra elfogad | nincs |
| `missing` | nincs fájl, vagy üres | `agent-tokens -- issue` (operátornál `issue-operator`) |
| `unknown_hash` | az adatbázis ezt a tokent soha nem látta (régebbi adatbázis újabb fájlok alatt, vagy fordítva) | az `issue` lecseréli |
| `revoked` | a tokent visszavonták vagy lejárt | az `issue` lecseréli |
| `wrong_role` | a fájlban más alany vagy más szerep érvényes tokenje van | az `issue` lecseréli |
| `multiple_active` | a fájl tokenje érvényes, de a névhez egynél több aktív sor tartozik (az ötödik oszlop a token nevét és a darabszámot adja); a többi sort senki nem birtokolja | `issue --rotate` (`issue-operator --rotate`): a sima `issue` meghagyja az érvényes fájlt és az extra sorokat |
| `shared_mismatch` | a `store/.dashboard-token` nem az aktív `dashboard` sor hash-ét adja | `rotate-shared` (3. lépés) |
| `shared_in_env` | `DASHBOARD_TOKEN` van az `.env`-ben vagy a környezetben; az archívum viszi az `.env`-et, a változó pedig felülírja a token-fájlt | töröld az `.env`-ből, majd `rotate-shared` |

A `doctor.sh` az "Agent tokens" szakaszában ugyanezt az ellenőrzést futtatja. A hiányzó vagy elavult ágens- vagy operátor-token ott FAIL (nem figyelmeztetés): a közös tokenre már semmi nem esik vissza. Az operátor-scriptek (`fleet-safe-start`, `pre-pr-review`, `settings-verify`, `doctor.sh` és társaik) a hiányzó `store/.operator-token` esetén az `agent-tokens issue-operator` futtatását kérik: más tokent nem fogadnak el.

### Visszaállítás után: a skill-fájlok újragenerálása

A forrás a készség-adatbázis; a `~/.claude/skills/` és `agents/*/.claude/skills/` alatti `SKILL.md` fájlok és a `scripts/`, `references/` kísérőik az ebből generált cache (az archívum a `.claude/skills` mappát is tartalmazza, teljes visszaállításnál ezek is visszajönnek). Ha az adatbázis fájlok nélkül lett visszaállítva, vagy a fájlok régebbiek az adatbázisnál:

```bash
# 0. Lemezen lévő, de még nem DB-beli fájlok (pl. újabb fájl-visszaállítás): insert-if-absent, sort sosem ír felül
npx tsx scripts/materialize-skills.ts

# 1. Ami a DB-ben van, de a lemezről hiányzik (skill, kísérő fájl, tenant-másolat); hiány esetén exit 1
npx tsx scripts/regen-skills.ts --check

# 2. Minden kiírása a DB-ből (fleet + ágens-lokális skillek, kísérő fájlok, tenant-skillek a tenant saját ágensei alá)
npx tsx scripts/regen-skills.ts --force
```

A dashboard minden indulásnál ugyanezt teszi, hacsak `SKILL_SQL_REGEN=0`; kikapcsolt kapcsolónál egy `Skills exist in the DB but their files are missing` figyelmeztetést naplóz. A DB-sortól eltérő fájl a sorból áll vissza (figyelmeztetéssel), tehát egy kézzel szerkesztett, de a DB-be sosem jutott fájl felülíródik: ha számít, előbb mentsd el.

A futó ágens-sessionök induláskor töltik be a skilleket, ezért utána indítsd újra őket (a ciklus az alágenseket fedi; a fő ágenst ugyanígy a `POST /api/agents/<MAIN_AGENT_ID>/restart` indítja újra, ami a channels szolgáltatáson át megy):

```bash
for a in $(bash scripts/agent-api.sh --token operator GET /api/agents | python3 -c 'import sys,json; print(" ".join(x["name"] for x in json.load(sys.stdin)))'); do
  bash scripts/agent-api.sh --token operator POST "/api/agents/$a/restart"; echo " $a"
done
```

### SHA-256 ellenőrzés

```bash
# macOS
shasum -a 256 -c backups/claudeclaw-20260101-120000.sha256

# Linux
sha256sum -c backups/claudeclaw-20260101-120000.sha256
```

## Naplók

### macOS

```bash
# Dashboard
log stream --predicate 'subsystem contains "com.<agent-id>"' --level info

# Vagy a launchd stdout/stderr fájlokból
cat ~/Library/Logs/Marveen/dashboard.log
cat ~/Library/Logs/Marveen/channels.log
```

### Linux

```bash
journalctl --user -u marveen-dashboard --since "1 hour ago"
journalctl --user -u marveen-channels --since "1 hour ago"

# Folyamatos figyelés
journalctl --user -u marveen-dashboard -f
```

### Titkok a folyamat-naplóban

A dashboard saját naplója (`src/logger.ts`) a sor kiírása előtt maszkolja a hitelesítő adatokat: a `token`, `apiKey`, `authorization`, `password` és a telepítés saját nevei (`agent_token`, `dashboard_token`, `session_token`, `device_key`, `bot_token`, ...) mezőneveket a naplózott objektum bármely mélységében, a child logger bindingjait (a később `setBindings()`-szel hozzáadottakat is) és az `Error`-t (üzenet, stack, cause); szabad szövegben a `Bearer <token>`, a `name=value` és a `"name":"value"` alakot ugyanezekre a nevekre, valamint az ismert token-alakokat (eszközkulcs `mvdk_`, `sk-ant-`, OpenAI `sk-`, GitHub, Slack, Google API-kulcs, Telegram bot token, JWT, `vault:<id>`). A maszkolt érték `[REDACTED]`. Az OTLP naplóexport továbbra is minden hívást megkap.

A maszkoló biztonsági háló, nem garancia; titkot ne tegyél naplóhívásba. Ismert korlátok:

- A flotta ágens-tokenje 64 hex karakter, megkülönböztethetetlen egy SHA-256-tól, ezért csak a neve vagy a `Bearer` mellett maszkolódik, önmagában soha.
- Más token-alakok (felhő hozzáférési kulcsok, Stripe, npm) és más `Authorization` sémák (Digest, Negotiate, AWS4-HMAC) nem ismerhetők fel; a `Basic` csak az `Authorization: Basic <base64>` alakban.
- A `name=value` érték szóközig, `&`, `#`, idézőjelig, zárójelig, vesszőig és pontosvesszőig tart.
- A naplózott objektumban lévő osztálypéldányokat (`URL`, `Map`, `Set`) a pino kezeli; az ezekben lévő titkot nem találja meg. A 10 szintnél mélyebb objektum `[MaxDepth]`-ként kerül a naplóba, a nem szövegesíthető `%j` argumentum `[Circular]`-ként (semmi nem szivárog, a sor kevésbé részletes).
- Több naplóhívásra szétvágott vagy sima szövegtől eltérő kódolású titkot nem ismer fel.
- Csak ez a folyamat-napló van lefedve, a hook-naplók, a szkriptek és a tmux-kimenet nem.

Költség, egy fejlesztői gépen mérve (macOS, Node 22, null célfolyamat, 7 futás mediánja, futásonként 100 000 hívás): az egyszerű üzenet hívásonként kb. 0,4 mikroszekundumról 1,6-ra, az objektum üzenettel kb. 1,0-ról 8,6-ra (három szint mélyen: 1,5-ről 12,2-re), a naplózott `Error` kb. 31-ről 49-re nő, a naplószint alatti hívás változatlan (kb. 20 nanoszekundum). A beágyazott objektum 10,8 mikroszekundumos növekedéséből a mezőnév-maszkolás kb. 4,0, az üzenet-hook 0,8, az objektum-bejárás 5,5. Másodpercenként ezer objektumos sor kb. egy százalék egy magból.

### Titkok a parancssorban

Egy futó folyamat argumentumait minden helyi felhasználó olvashatja (`ps -ww`). Az a szkript, amely külső API-t hív, ezért a titkot a curlnek stdin-en, konfigként adja át, a `scripts/lib/curl-tok.sh` segédeivel (source-olni kell, telepítési lépés nincs):

```bash
. "$INSTALL_DIR/scripts/lib/curl-tok.sh"
curl_tok "$TOKEN" -s "$URL"                                        # a token Bearer fejlécként, stdin-en
curl_hdr 'x-goog-api-key' "$KEY" -s "$URL"                          # bármely egy titkos fejléc
curl_tok_url "$BOT" 'https://api.telegram.org/bot@TOKEN@/getMe' -s  # a titok az URL része
```

A törzs `-d "$text"` (nem titok) vagy `--data-binary @fájl` lehet, mert az stdin a konfigé. A dupla idézőjelet, backslasht vagy sortörést tartalmazó értéket a segéd visszautasítja (visszatérési kód 2, semmi nem megy ki). A `scripts/set-bot-menu.sh`, a `scripts/smoke-test-slack-channel.sh` és a `scripts/pre-pr-review.sh` ezeket használja. A `scripts/__tests__/curl-tok.test.sh` (a CI Shell tests lépésében) élő `ps`-próbával bizonyítja, hogy a titok nincs a folyamatlistában, és ratchetet tart: shell szkript nem építhet Bearer fejlécet, `bot<token>` URL-t vagy `?key=` lekérdezést a parancssorba, kivéve a tesztben felsorolt örökölt sorokat, amelyek csak csökkenhetnek. Nincs lefedve: más nyelvű szkriptek és az örökölt sorok (a Telegram-értesítők és a telepítők még az URL-ben küldik a bot tokent).

A `scripts/pre-pr-review.sh` a diffet a ChatGPT-nek és a Gemininek küldi, ezért a diff előbb átmegy a titokkapun (`scripts/secret-gate.ts --outbound <base>...<head>`, a pre-commit hook és a CI detektorai, minden módosított fájl diff-szövegén, az eltávolított sorokat is beleértve). Titok-alak, tiltott útvonal (evidence vagy transcript könyvtár) vagy csatornaanyag megállítja: semmi nem megy ki, a szkript 1-gyel lép ki. A kapu azt írja ki, hol van a találat, azt soha, hogy mi.

### Dashboard update log

A frissítések eredménye:

```bash
cat store/update.log
cat store/update.last-result  # JSON: status, phase, old/new verzió
```

## Lemezterület-védelem

A `scripts/disk-space-guard.sh` szintén futhat timer-ként: ha a szabad lemezterület küszöb alá esik, értesítést küld és opcionálisan leállítja az adatbázis-írásokat. A küszöb az `.env`-ben vagy a dashboard beállításaiban konfigurálható.

## Titkosítás

Az érzékeny fájlok jogosultságai:

| Fájl | Jogosultság | Tartalom |
|------|------------|---------|
| `.env` | `0600` | Bot tokenek, auth kulcs |
| `store/.dashboard-token` | `0600` | Közös dashboard Bearer token |
| `store/.operator-token` | `0600` | Az üzemeltető saját admin tokenje |
| `agents/<id>/.agent-token`, `.agent-token` (fő ágens) | `0600` | Az ágens saját API tokenje |
| `store/.claude-oauth-token` | `0600` | Fleet OAuth token |
| `~/.claude/channels/*/.env` | `0600` | Csatorna bot tokenek |
| `~/.claude/channels/*/access.json` | `0644` | Párosítási állapot (nem titkos) |

A Vault titkait az adatbázis titkosítva tárolja -- a tényleges értékek nem kerülnek plaintext fájlba (lásd F02 Konfiguráció, Vault szekció).

**Hálózati kitettség:** alapértelmezetten a dashboard csak a loopback interfészre köt (`WEB_HOST=127.0.0.1`). Ha hálózatról is elérhetővé teszed (`WEB_HOST=0.0.0.0`), állíts be erős Bearer tokent, és helyezd fordított proxy mögé HTTPS-sel.

## Több gépen / multi-node

Ha több gépen futtatod a Marveen-t, minden gép önálló telepítés -- nincsen elosztott adatbázis. A gépenként különálló flottákat a **Föderáció** kötheti össze (lásd F06 Fleet), amely két Marveen-példány között megbízható üzenetváltást biztosít anélkül, hogy az adatbázisuk közös lenne.

---

*Előző fejezet: [F02 Konfiguráció](F02-konfiguracio.md)*
*Következő fejezet: F04 Csatornák konfigurálása (hamarosan)*
