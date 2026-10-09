#!/usr/bin/env python3
"""
ClaudeClaw fleet helper - shared, deterministic plumbing so agents don't burn
tokens hand-rolling curl/SQL/escaping in the model.

Covers: dashboard API auth (the calling agent's own token, resolved through the install's
scripts/hooks/agent_token.py; the shared store/.dashboard-token only as its visible fallback;
never hardcoded), memory save/search, daily log, inter-agent messages, agent list,
kanban read helpers, and Telegram MarkdownV2 escaping.

Importable as a module or used from the CLI. See README.md for usage.

Config (no hardcoded paths or secrets):
  CLAW_DIR  - project root (the dir containing `store/`). If unset, the project
              root is auto-detected by walking up from the current directory
              until a `store/.dashboard-token` is found.
  CLAW_BASE - dashboard base url (default http://localhost:3420).
"""
import importlib.util
import json
import os
import sys
import time
from datetime import date, datetime
import urllib.request
import urllib.error


def project_dir():
    env = os.environ.get("CLAW_DIR")
    if env and os.path.isdir(os.path.join(env, "store")):
        return env
    d = os.getcwd()
    while True:
        if os.path.isfile(os.path.join(d, "store", ".dashboard-token")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    raise RuntimeError("project root not found (set CLAW_DIR to the dir containing store/)")


def base_url():
    return os.environ.get("CLAW_BASE", "http://localhost:3420").rstrip("/")


def auth_headers():
    """Authorization (+ X-Agent-Id) for the calling agent: its own token, resolved by the
    install's agent_token module so the contract lives in one place. If that module cannot be
    loaded, the shared token is read directly, as this helper always did."""
    root = project_dir()
    mod = _load_agent_token(root)
    if mod is not None:
        try:
            return mod.auth_headers(install=root)
        except Exception:
            pass
    with open(os.path.join(root, "store", ".dashboard-token")) as f:
        return {"Authorization": "Bearer " + f.read().strip()}


def _load_agent_token(root):
    """Load <root>/scripts/hooks/agent_token.py by explicit path (no sys.path change), and only when
    the file is the current user's and not group/world writable: the root may have been found by
    walking up from the working directory, so it must not be able to plant code that runs here."""
    path = os.path.join(root, "scripts", "hooks", "agent_token.py")
    try:
        st = os.stat(path)
        if st.st_uid != os.getuid() or st.st_mode & 0o022:
            return None
        spec = importlib.util.spec_from_file_location("fleet_agent_token", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def api(method, path, payload=None, timeout=20):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base_url() + path, data=data, method=method)
    for k, v in auth_headers().items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API {method} {path} -> {e.code}: {e.read().decode()[:200]}")
    try:
        return json.loads(body)
    except ValueError:
        return body


def save_memory(agent, content, category="warm", keywords=""):
    return api("POST", "/api/memories", {"agent_id": agent, "content": content,
                                         "category": category, "keywords": keywords})


def search_memory(agent, q, category=None):
    from urllib.parse import quote
    path = f"/api/memories?agent={quote(agent)}&q={quote(q)}"
    if category:
        path += f"&category={quote(category)}"
    return api("GET", path)


def daily_log(agent, content):
    return api("POST", "/api/daily-log", {"agent_id": agent, "content": content})


def send_message(from_agent, to_agent, content):
    return api("POST", "/api/messages", {"from": from_agent, "to": to_agent, "content": content})


def list_agents():
    return api("GET", "/api/agents")


_KANBAN_FIELDS = ("id", "title", "status", "assignee", "priority", "project", "due_date", "updated_at")


def _kanban(keep, sort_key=None, reverse=False):
    """Open (non-archived) cards from GET /api/kanban, filtered and ordered here."""
    cards = api("GET", "/api/kanban")
    rows = [{k: c.get(k) for k in _KANBAN_FIELDS} for c in cards if keep(c)]
    if sort_key:
        rows.sort(key=sort_key, reverse=reverse)
    return rows


def kanban_due_today():
    today = date.today()
    return _kanban(
        lambda c: c.get("due_date") is not None and c.get("status") != "done"
        and datetime.fromtimestamp(c["due_date"]).date() <= today,
        sort_key=lambda c: c["due_date"])


def kanban_stuck(idle_seconds=14400):
    cutoff = int(time.time()) - idle_seconds
    return _kanban(lambda c: c.get("status") == "in_progress" and c.get("updated_at") < cutoff,
                   sort_key=lambda c: c["updated_at"])


def kanban_by_status(status):
    return _kanban(lambda c: c.get("status") == status,
                   sort_key=lambda c: (c.get("priority") or "", c.get("updated_at") or 0), reverse=True)


def _memory_agents():
    """Every agent_id that owns a memory (the stats endpoint knows them all)."""
    return sorted(api("GET", "/api/memories/stats").get("byAgent", {}))


def _agent_memories(agent, category):
    """All of one agent's memories in a tier, paged. Shared-tier rows of other
    agents come back in the same listing and are dropped (each row belongs to
    exactly one agent here, so nothing is counted twice)."""
    from urllib.parse import quote
    out, offset = [], 0
    while True:
        page = api("GET", f"/api/memories?agent={quote(agent)}&category={category}&limit=200&offset={offset}")
        rows = page if isinstance(page, list) else page.get("memories", [])
        out += [m for m in rows if m.get("agent_id") == agent]
        if len(rows) < 200:
            return out
        offset += 200


def memories_recent(hours=24):
    """hot/warm memories created in the last `hours`, every agent, oldest first per agent."""
    cutoff = int(time.time()) - hours * 3600
    rows = [m for a in _memory_agents() for c in ("hot", "warm") for m in _agent_memories(a, c)
            if m["created_at"] > cutoff]
    rows.sort(key=lambda m: (m["agent_id"], m["created_at"]))
    return [{k: m.get(k) for k in ("agent_id", "content", "keywords")} for m in rows]


def memory_health():
    """Total memories vs memories with an embedding (the stats endpoint counts both
    embedding columns; a backfill count of 0 means nothing is missing, not 0% vectorised)."""
    st = api("GET", "/api/memories/stats")
    return {"total": st["total"], "with_emb": st["withEmbedding"]}


def memories_stale_hot(days=7):
    """hot memories whose last touch (accessed_at, else created_at) is older than `days`."""
    cutoff = int(time.time()) - days * 86400
    rows = [m for a in _memory_agents() for m in _agent_memories(a, "hot")
            if (m.get("accessed_at") or m["created_at"]) < cutoff]
    return [{k: m.get(k) for k in ("id", "content", "accessed_at")} for m in rows]


def memories_to_cold(ids):
    """Move hot/warm memories to the cold tier through PUT (content is resent unchanged).
    Unlike a raw UPDATE this also stamps accessed_at and writes a memory_versions row."""
    wanted, moved = set(int(i) for i in ids), []
    for a in _memory_agents():
        for c in ("hot", "warm"):
            for m in _agent_memories(a, c):
                if m["id"] in wanted:
                    api("PUT", f"/api/memories/{m['id']}", {"content": m["content"], "category": "cold"})
                    moved.append(m["id"])
    return {"moved": sorted(set(moved)), "not_found": sorted(wanted - set(moved))}


def kanban_open():
    """Planned / in_progress / waiting cards, ordered by project, then priority descending."""
    rows = _kanban(lambda c: c.get("status") in ("planned", "in_progress", "waiting"))
    rows.sort(key=lambda c: c["priority"] or "", reverse=True)
    rows.sort(key=lambda c: c["project"] or "")
    return [{k: c.get(k) for k in ("id", "title", "status", "project", "priority", "assignee")} for c in rows]


def ideas_top(n=5):
    """new/reviewed ideas that carry impact and effort, best (impact - effort) first."""
    items = []
    for status in ("new", "reviewed"):
        offset = 0
        while True:
            page = api("GET", f"/api/ideas?status={status}&limit=100&offset={offset}")
            items += page["ideas"]
            offset += 100
            if offset >= page["total"]:
                break
    scored = [dict(i, score=i["impact"] - i["effort"]) for i in items
              if i.get("impact") is not None and i.get("effort") is not None]
    scored.sort(key=lambda i: (i["score"], i["impact"]), reverse=True)
    return [{k: i.get(k) for k in ("id", "title", "category", "impact", "effort", "score")} for i in scored[:n]]


def skill_usage_30d():
    """Skills used in the last 30 days: name, count, last use (unix seconds), most used first."""
    rows = [r for r in api("GET", "/api/skill-usage/summary") if r["count_30d"] > 0]
    rows.sort(key=lambda r: r["count_30d"], reverse=True)
    return [{"skill_name": r["skill_name"], "n": r["count_30d"], "last_used_at": r["last_used_at"]} for r in rows]


_MDV2_SPECIAL = r"_*[]()~`>#+-=|{}.!\\"


def escape_mdv2(text):
    """Escape literal text for Telegram MarkdownV2. Escape your dynamic text with
    this, THEN wrap intended formatting (e.g. '*'+escape_mdv2(label)+'*' for bold)."""
    return "".join("\\" + ch if ch in _MDV2_SPECIAL else ch for ch in str(text))


def _out(v):
    print(json.dumps(v, ensure_ascii=False, indent=2) if isinstance(v, (dict, list)) else v)


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "mdv2":
        print(escape_mdv2(rest[0] if rest else sys.stdin.read()))
    elif cmd == "mem-save":
        _out(save_memory(rest[0], rest[1], rest[2] if len(rest) > 2 else "warm",
                         rest[3] if len(rest) > 3 else ""))
    elif cmd == "mem-search":
        _out(search_memory(rest[0], rest[1], rest[2] if len(rest) > 2 else None))
    elif cmd == "daily-log":
        _out(daily_log(rest[0], rest[1]))
    elif cmd == "msg":
        _out(send_message(rest[0], rest[1], rest[2]))
    elif cmd == "agents":
        _out([{"name": a.get("name"), "running": a.get("running"),
               "model": a.get("model")} for a in list_agents()])
    elif cmd == "kanban-due":
        _out(kanban_due_today())
    elif cmd == "kanban-stuck":
        _out(kanban_stuck(int(rest[0]) if rest else 14400))
    elif cmd == "kanban-status":
        _out(kanban_by_status(rest[0]))
    elif cmd == "kanban-open":
        _out(kanban_open())
    elif cmd == "mem-recent":
        _out(memories_recent(int(rest[0]) if rest else 24))
    elif cmd == "mem-health":
        _out(memory_health())
    elif cmd == "mem-stale-hot":
        _out(memories_stale_hot(int(rest[0]) if rest else 7))
    elif cmd == "mem-to-cold":
        _out(memories_to_cold(rest))
    elif cmd == "ideas-top":
        _out(ideas_top(int(rest[0]) if rest else 5))
    elif cmd == "skill-usage-30d":
        _out(skill_usage_30d())
    else:
        sys.stderr.write(f"unknown command: {cmd}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
