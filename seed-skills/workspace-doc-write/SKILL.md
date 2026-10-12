---
name: workspace-doc-write
description: Munkadokumentum (terv, brief, jelentés, jegyzet, piszkozat, checklist) mentése a workspace_docs táblába a scripts/workspace-put.py segítségével, lokális fájl helyett. Akkor használd, ha dokumentumot kell írnod, átadnod vagy delegálnod, vagy ha észreveszed, hogy egy .md/.txt/.csv/.html munkadokumentumot fájlba készülsz írni.
---

# Munkadokumentum írása (workspace_docs)

Szabály: a munkadokumentum CSAK az adatbázisba (workspace_docs) kerül, lokális fájlba soha. Kivétel a bináris fájl (kép, pdf, zip), az maradhat fájl. A tartós példány az SQL sor, a fájl legfeljebb átmeneti törzs.

Nem munkadokumentum, tehát nem erre való: CLAUDE.md, SOUL.md, HANDOFF.md, agent-config.json, skill-fájlok, auto-memória fájlok, és minden, ami git worktree-ben él (kód, docs/, CHANGELOG.md, README.md, tesztfixture).

## Mikor használd

- Tervet, briefet, jelentést, jegyzetet, cikk-piszkozatot, checklistet vagy elemzés-kimenetet írsz.
- Egy másik ágensnek dokumentumot adsz át vagy delegálsz.
- Egy API-hívás törzsébe szánt hosszú dokumentumszöveged van.

## doc_key konvenció

| Típus | doc_key | `--type` |
|-------|---------|----------|
| terv | `plan/<kártya>` | plan |
| brief | `brief/<kártya>` | brief |
| jelentés | `report/<kártya>` | report |
| jegyzet | `notes/<ágens>/<dátum>-<téma>` | notes |
| piszkozat | `draft/<sorozat>/<rész>-vN` | notes |
| sorozat része | `series-<slug>/<rész>` | tetszőleges (alapértelmezés: notes) |

Karakterek: betű, szám, `.`, `_`, `-`; 2-4 szegmens. A `series-<slug>` előtag a többrészes anyagokhoz (pl. cikksorozat) való: a `<slug>` kisbetű, szám, `_`, `-` lehet (betűvel vagy számmal kezdődik, nincs benne pont), és az egész sorozat egy előtag alatt gyűlik (`GET /api/v1/workspace?doc_key_prefix=series-<slug>/`). Ez az előtag nem határoz meg típust: a `--type` (plan, brief, report, notes) szabadon választható, elhagyva notes. Ugyanaz a doc_key ugyanattól az ágenstől felülírja a sort (upsert), tehát egy új verzió ugyanazon a kulcson vagy a `-vN` léptetésével megy.

## Eljárás

1. Írd meg a törzset a Write eszközzel a session scratchpad könyvtárába (a rendszer a környezetleírásban megadja az útját). Ne a projekt, ne az ágens otthona, ne a store/ alá.
2. Töltsd fel és töröld a törzset egy lépésben, az install gyökeréből:
   ```bash
   python3 scripts/workspace-put.py --file <scratchpad-út>/torzs.md \
     --doc-key plan/<kártya> --type plan --task-ref <kártya> --delete-source
   ```
   - `--title` elhagyható: az első markdown címsor lesz, különben a doc_key.
   - `--agent` elhagyható: a saját agent_id-d (MARVEEN_AGENT_ID, BOT_NAME vagy a launch config).
   - `--content-type code` HTML/kód forráshoz (4 MB, a text 2 MB).
   - `--file -` stdinről olvas (ilyenkor nincs `--delete-source`).
3. A script a `scripts/agent-api.sh` wrapperen át küld (a token sosem kerül a parancssorba), visszaolvassa a sort, és csak egyező tartalomhossz esetén törli a forrást. Siker: `workspace-put: ok doc_key=... id=...`.
4. Delegáláskor az üzenet a doc_key-t nevezi meg (és a lekérés módját: `GET /api/v1/workspace?doc_key=<kulcs>`), SOHA nem helyi fájlútvonalat.

## Buktatók

- Heredoc vagy inline törzs a Bash parancsban: több kapu hamis pozitívként blokkolja. A törzset a Write eszköz írja a scratchpadba, a Bash csak a workspace-put-ot hívja.
- Shell `rm` az ágenseknek tiltott (destructive-gate), ezért van a `--delete-source`. Az csak a session scratchpadban lévő, nem symlink, git work tree-n kívüli fájlt töröl, és csak feltöltés-ellenőrzés után; máshol megtagadja, és ilyenkor még NEM tölt fel (az ellenőrzés a feltöltés előtt fut).
- Ha a scratchpad nem a `claude-<uid>/.../scratchpad` konvenciót követi, add meg: `--scratchpad-root <könyvtár>` (a könyvtár neve `scratchpad`).
- A `--type` a doc_key előtagjából következik (`draft/` = notes); ha eltér, hibát kapsz. Kivétel a `series-<slug>/`: annak nincs fix típusa, ott a `--type` bármelyik érvényes érték, alapértelmezés notes.
- Bináris fájl (NUL bájt vagy nem UTF-8) nem munkadokumentum, a script elutasítja.
- Mentés előtt ne tegyél bele titkot, tokent vagy .env értéket.
- Exit 1 = a feltöltés vagy az ellenőrzés bukott: a forrás megmarad, nézd a hibaüzenetet, és futtasd újra (az upsert idempotens). Exit 2 = hibás argumentum vagy megtagadott törlés, nem történt API-hívás.

## Ellenőrzés

- A script `ok` sora kiírja az id-t, a karakter- és bájtszámot: az a visszaolvasott érték.
- Utólag: `bash scripts/agent-api.sh GET "/api/v1/workspace?doc_key=<kulcs>&meta_only=true"` az egy sort adja vissza.
- `--delete-source` után a törlést a `deleted source <út>` sor jelzi; nincs ilyen sor, ha a forrást nem töröltük.
