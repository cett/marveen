Készíts napi összefoglalót a(z) {{TENANT_ID}} tenant számára. Te a(z) {{AGENT_ID}} ágens vagy.

Szabályok:
- Az egyetlen adatforrás a tenant memóriája, az 1. lépés lekérdezésével. Emlékezetből, más beszélgetésből vagy másik tenant adataiból SOHA ne dolgozz.
- Magyarul, sima szöveggel írj, formázás nélkül.

1. Kérdezd le a tenant memóriáját:
bash {{INSTALL_DIR}}/scripts/agent-api.sh --agent {{AGENT_ID}} GET '/api/memories?agent={{AGENT_ID}}&tenant={{TENANT_ID}}&limit=50&include_docs=0'
   Csak azokat a sorokat használd, amelyek created_at értéke (unix másodperc) az elmúlt 24 órába esik.
2. Ha nincs ilyen sor, ne írj és ne küldj semmit, fejezd be a feladatot.
3. Ismétlés elleni védelem: kérdezd le a mai napi naplót:
bash {{INSTALL_DIR}}/scripts/agent-api.sh --agent {{AGENT_ID}} GET "/api/daily-log?agent={{AGENT_ID}}&date=$(date +%F)"
   Ha valamelyik bejegyzés tartalmazza a "## Napi összefoglaló" fejlécet a mai dátummal, fejezd be a feladatot.
4. Írj 5-8 mondatos összefoglalót az 1. lépés sorairól, és told be a napi naplóba ezzel a fejléccel (a dátum a mai nap, ÉÉÉÉ-HH-NN):
bash {{INSTALL_DIR}}/scripts/agent-api.sh --agent {{AGENT_ID}} POST /api/daily-log '{"agent_id":"{{AGENT_ID}}","content":"## Napi összefoglaló ÉÉÉÉ-HH-NN\n<az összefoglaló szövege>"}'
5. Csatornaüzenet CSAK akkor megy, ha ennek a feladatnak az elején a futtató megadott egy Telegram kézbesítési utasítást (chat_id). Ilyenkor ugyanezt a szöveget küldd el sima szövegként, legfeljebb 1500 karakterben, a reply eszközzel, kizárólag a megadott chat_id-kre. Ha nincs ilyen utasítás, ne küldj üzenetet: az eredmény csak a napi naplóba kerül, és erről hallgass.
