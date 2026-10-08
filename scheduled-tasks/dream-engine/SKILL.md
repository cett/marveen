---
name: dream-engine
description: Éjszakai analízis-loop az aznapi memóriákról, naplóról és kanban-állapotról. Generál 4 priorizált akció-javaslatot reggelre.
last_synced: 2026-09-01
# last_synced konvenció: lásd scheduled-tasks/reggeli-napindito/SKILL.md
---

Te most a "Dream Engine" éjszakai analízis-loopot futtatod. 02:07-kor vagy, {{OWNER_NAME}} alszik, NE küldj üzenetet a beállított csatornára.

A cél: az aznapi tudást átkonszolidálni és reggelre (07:30 Reggeli Napindító) felkészülni 4 priorizált javaslattal.

## Mit kell csinálnod

Az öt bucket kimenetét írd a workspace_docs API-ba (`doc_key: "dream/YYYY-MM-DD"`). A formátum és az API-hívás a fájl alján van.

### Bucket 1 — 💡 Skill-javaslatok (flotta-szintű)

Nézz végig MINDEN agent (a fő-ágens és az összes sub-agent) tegnapi (24h) memóriáit és napi naplóját. Kerítsd ki:
- Volt-e 3+ szor visszatérő, manuálisan ismételt művelet ami skill-be illeszthető?
- Új, NEM lefedett pattern amit érdemes lenne skillbe önteni?

Lekérdezés (a dashboard API-n át; agent_id, content, keywords, minden ágens, ágensenként időrendben):
```bash
CLAW_DIR={{INSTALL_DIR}} python3 ~/.claude/skills/fleet-helper/scripts/fleet.py mem-recent 24
```

Output: 0-2 konkrét skill-javaslat. Mindegyikhez: cím + 1 mondat indoklás + "flotta-szintű" vagy "agent: <név>".

### Bucket 2 — 🧹 Memória-egészség (NE delete, COLD-tier-be mozgatás)

```bash
# Vektorizálás ellenőrzés: {"total": N, "with_emb": M}
# A /api/memories/stats withEmbedding mezője az embedding_blob-ot (és a régi embedding oszlopot) számolja.
# A backfill {"count":0} = NINCS mit backfillelni (minden kész), NEM 0 vektorizált.
CLAW_DIR={{INSTALL_DIR}} python3 ~/.claude/skills/fleet-helper/scripts/fleet.py mem-health
# Ha NEM 100%, hívd meg a backfill endpoint-ot (Ollamaval embeddeli a hiányzó ID-kat):
curl -s -X POST http://localhost:{{WEB_PORT}}/api/memories/backfill -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)"

# Antikvált hot-tier (>7 napos hot: az utolsó hozzáférés, ennek hiányában a létrehozás ideje régebbi 7 napnál)
CLAW_DIR={{INSTALL_DIR}} python3 ~/.claude/skills/fleet-helper/scripts/fleet.py mem-stale-hot 7
```

### ⚠️ Buktató: COALESCE + strftime = mindig igaz (2026-07-13, a SQL-es változatnál)
A korábbi `COALESCE(accessed_at, created_at) < strftime('%s','now','-7 days')` SQL-alak SQLite-ban MINDIG igazat adott (a `strftime` TEXT, a COALESCE-kifejezésnek nincs típus-affinitása), ezért minden hot memóriát antikváltnak mutatott; a javítás `CAST(... AS INTEGER)` volt. A `mem-stale-hot` ezt a lekérdezést már számként, a helperben hasonlítja össze, de a mozgatás előtt továbbra is nézd meg a találatok `accessed_at` értékét (unix másodperc), hogy tényleg régiek-e.

Műveletek:
1. Vektorizálatlan memóriák: jelezd hányat találtál (a fire-and-forget embedding-job amúgy megcsinálja, de itt ellenőrzöd).
2. Antikvált hot/warm → COLD-tier-be PUT (a `mem-to-cold` helper a `PUT /api/memories/:id`-t hívja category='cold'-dal). Sosem törlés.
3. Pontos dupla-content: jelezd, mozgass cold-ba.

A változtatásokat a helperrel csináld (a `mem-stale-hot` által adott id-kkal; a kimenet a `moved` és `not_found` listát adja):
```bash
CLAW_DIR={{INSTALL_DIR}} python3 ~/.claude/skills/fleet-helper/scripts/fleet.py mem-to-cold 1425 1426
```
Figyelem: a PUT a `accessed_at`-et is ráírja a mozgatás idejére és verziósort (memory_versions) hagy maga után, a régi nyers UPDATE egyiket sem tette.

Output: rövid statisztika ("X memória cold-tier-be áthelyezve, Y vektorizálatlan rendezve").

### Bucket 3 — 🎯 Project-priorítás (top-3 holnapi javaslat)

```bash
# Nyitott kanban-kártyák project + priority szerint (planned / in_progress / waiting, nem archivált)
CLAW_DIR={{INSTALL_DIR}} python3 ~/.claude/skills/fleet-helper/scripts/fleet.py kanban-open

# Magas impact, alacsony effort ötletek az ötletládából (score = impact - effort, magasabb = jobb; top 5)
CLAW_DIR={{INSTALL_DIR}} python3 ~/.claude/skills/fleet-helper/scripts/fleet.py ideas-top 5
```

Csoportosíts project szerint. A daily naplóban (utolsó 7 nap) nézd hogy melyik projekten van aktív mozgás (commit, PR, kanban-átmozgás). A top-3 javaslatba a kanban kártyák mellé vehetsz be max 1 magas-score (score>=2) ötletlada-tételt is, ha van ilyen -- jelöld `[Ötletláda]` prefixszel.

Output: 3 sor, mindegyik formátum `<project/kategória>: <kártya cím / akció> -- <indok 1 mondatban>`.

### Bucket 4 — 🌐 External opportunities (új skill-repo ajánlások)

Hetente 1-2 alkalommal (NEM minden éjszaka — kerüljük a zajos napi javaslatot) végezz WebSearch-öt új Claude Code / agentic AI / produktivitás-skillekért. Szűrés:
- GitHub stars >100
- Recent activity (utolsó 90 napban commit)
- README clarity (skill mit csinál, hogyan kell telepíteni)

Limitáció: ha az utolsó 7 napban már volt ajánlás (keresd a workspace_docs-ban az elmúlt 7 nap `dream/YYYY-MM-DD` doc_key-jeit), skip-eld.

Output (max 1 ajánlás): repo URL + 1 mondat indok hogy MIÉRT releváns {{OWNER_NAME}}nak (figyelembe véve: AI tartalomgyártás, magyar piac, fejlesztési flotta menedzsment, marketing).

### Bucket 5 — 🛠 Skill-flotta health (csak NEM-pinned skillek)

**VAN HASZNÁLATI NAPLÓ** (2026-08-28-i javítás). Korábban ez a szekció azt állította,
hogy "nincs use-log", ezért a Dream Engine minden nap azt írta, hogy nem mérhető. Tévedés volt:
a `skill_usage` tábla LÉTEZIK és MŰKÖDIK (2026-07-15 óta gyűjt, mind a 10 ágens ír bele,
tool_call és skill_read típussal). A bucket kimenete ("utolsó használat >30 nap") épp ezt
igényli -- csak a lekérdezés hiányzott innen.

```bash
# 1) Mit használtak az elmúlt 30 napban (skill_name, n, last_used_at unix másodpercben, a leggyakoribb elöl):
CLAW_DIR={{INSTALL_DIR}} python3 ~/.claude/skills/fleet-helper/scripts/fleet.py skill-usage-30d

# 2) Pinned-védelem (ezeket sosem javasoljuk törlésre):
grep -L "^pinned:" ~/.claude/skills/*/SKILL.md
```

**BUKTATÓ a skill-lista összeállításánál** (2026-08-28, Jarvis saját hibája mérés közben):
a skillek HÁROM helyen élnek, és aki csak egy-két könyvtárat listáz, hamis "antikvált" listát kap:
  `~/.claude/skills/`                      (globális)
  `{{INSTALL_DIR}}/.claude/skills/`        (projekt-szintű)
  plugin- és rendszer-skillek (artifact-design, dataviz, claude-api, docx, pdf, pptx stb.)
Az első mérésnél a `.git` könyvtár is "antikvált skillként" jelent meg, és 20 létező
plugin-skill "már nem létezik" címkét kapott. Ha egy skill a naplóban szerepel, de a
listádban nincs, az valószínűleg a TE listád hiányos, nem a skill tűnt el.
Törlést CSAK akkor javasolj, ha a skill fizikailag megvan és 30 napja nincs használva.

Pinned default (mindig védett): claude-video, frontend-design, docx, skill-creator, skill-factory, skill-install-from-git, init, review, security-review, simplify, fewer-permission-prompts, loop, schedule, claude-api, update-config, keybindings-help, telegram:configure, telegram:access.

Output: 0-3 javaslat: "skill <név> antikvált (utolsó használat >30 nap), törlés vagy frissítés javasolt".

## Output formátum és workspace_docs írás

Az öt bucket kimenetét állítsd össze az alábbi Markdown struktúra szerint, majd írd workspace_docs-ba:

```markdown
# 💭 Dream Engine — YYYY-MM-DD 02:07

## 💡 Skill-javaslatok
- (vagy "Nincs új javaslat")

## 🧹 Memória-egészség
346 / 346 vektorizált, 5 hot→cold mozgatva, 0 duplikátum.

## 🎯 Top-3 holnapi javaslat
1. <project>: <akció> -- <indok>
2. ...
3. ...

## 🌐 External opportunity
- (vagy "Skip -- heti limit elérte" / "Nincs releváns új repo")

## 🛠 Skill-flotta health
- (vagy "Minden skill aktív vagy pinned")

*{{BOT_NAME}}, 02:XX -- most már alszom én is.*
```

Workspace_docs írás (upsert -- ugyanaznap újrafuttatva felülírja):

```python
import json, urllib.request, datetime

TOKEN = open("{{INSTALL_DIR}}/store/.dashboard-token").read().strip()
DATE = datetime.date.today().strftime("%Y-%m-%d")

# content: a fenti Markdown az öt bucket valódi kimenetével kitöltve
payload = json.dumps({
    "agent_id": "jarvis",
    "doc_key": f"dream/{DATE}",
    "title": f"Dream Engine {DATE}",
    "content": content,
    "type": "notes",
    "content_type": "text"
})
req = urllib.request.Request(
    "http://localhost:{{WEB_PORT}}/api/workspace",
    data=payload.encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
    method="POST"
)
with urllib.request.urlopen(req) as r:
    resp = json.loads(r.read().decode())
    print(f"dream/{DATE} workspace doc saved: id={resp.get('id')}")
```

## Szabályok

- NE küldj üzenetet a csatornára. A workspace doc tartalmát a reggeli napindítóból olvassák be (07:30).
- A `Bash` és SQL műveletek mind helyiek -- semmilyen external API hívás (kivéve az Ollama embedding ha kell).
- Ha akadály van (pl. DB lock, missing embedding model), a workspace doc tartalma végén adj hozzá `## ⚠️ Hibák` szekciót -- reggel látom.
- Befejezésként a content utolsó sora legyen: `*{{BOT_NAME}}, 02:XX -- most már alszom én is.*`
