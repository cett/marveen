"""Shared helpers for the deterministic conversation-continuity ledger.

The ledger (the dashboard's conversation_log table) is a rolling TRANSCRIPT of
every channel turn -- inbound user messages AND outbound replies -- per
agent_id + chat_id. On a respawn (a fresh --channels session with no memory of
the live conversation) the SessionStart hook injects the last ~20 turns of
context PLUS the open question, so the fresh session continues where the
connection dropped -- with ZERO agent discretion.

The hooks talk to the dashboard API (/api/conversation-ledger) and never open
the database file. Reads have a short timeout and raise on failure (the callers
treat that as "ledger unavailable" and do nothing). Writes never raise: when the
dashboard cannot be reached the turn is appended to a bounded spool file
(store/.ledger-spool/<agent>.jsonl) that the next successful write flushes and
the dashboard drains at boot.

Generic across all three channel agents (marveen / dia / erno-ba): agent_id is
derived from the running session's cwd so each session only ever sees its OWN
chat. Pure stdlib -- no node startup, no jq.
"""
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dashboard_api  # noqa: E402
from hook_db_path import db_path  # noqa: E402,F401  (re-exported for the fail-closed hooks)

RECENT_LIMIT = 20


def _install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def main_agent_id():
    v = os.environ.get("MAIN_AGENT_ID")
    if v:
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    # #927: this third arm used to be silent. On a renamed install (main
    # agent id != "marveen") running from an environment where MAIN_AGENT_ID
    # is unset AND .env is unreadable (e.g. a worktree without the install's
    # .env alongside it), this fallback quietly resolves to the wrong id --
    # a caller like the destructive-gate coordinator-allowlist then compares
    # against the wrong name and can misjudge who the coordinator is, with
    # nothing in the logs to explain why. The fallback direction itself stays
    # safe and unchanged; this only makes the silent branch visible. Never
    # raise here -- hooks rely on this fallback firing cleanly.
    sys.stderr.write("ledger_lib: MAIN_AGENT_ID nem talalhato (env es .env sem), fallback: marveen\n")
    return "marveen"


def owner_name():
    """The human owner's display name, used to label inbound turns in the
    replayed conversation context. Same resolution order as main_agent_id():
    OWNER_NAME env var first, then the install-dir .env (channels.sh does NOT
    export OWNER_NAME into the hook environment, so the .env file is the path
    that actually fires at runtime), finally a neutral default. Never hardcode
    a specific person -- every install configures its own OWNER_NAME, so a
    baked-in name (e.g. "Gyula") leaks the wrong name into every user's agent."""
    v = os.environ.get("OWNER_NAME")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("OWNER_NAME="):
                    name = line.split("=", 1)[1].strip()
                    if name:
                        return name
    except Exception:
        pass
    return "A felhasználó"


def agent_id_from_cwd(cwd):
    """Which channel agent is this session? Derived from cwd so the hooks are
    generic across all three agents and never cross-contaminate:
      <install>/agents/<id>  -> <id>           (sub-agent: dia, erno-ba, ...)
      <install>               -> MAIN_AGENT_ID  (the main channels agent)
    """
    cwd = (cwd or "").rstrip("/")
    install = _install_dir().rstrip("/")
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        rel = cwd[len(agents_root) + 1:]
        return rel.split(os.sep)[0] or main_agent_id()
    if cwd == install:
        return main_agent_id()
    # Fallback: last path component (best effort), else main.
    base = os.path.basename(cwd)
    return base or main_agent_id()


# --- dashboard API client -----------------------------------------------------

READ_TIMEOUT = 2
WRITE_TIMEOUT = 2
SPOOL_MAX_ENTRIES = 500


def _store_dir():
    return dashboard_api.store_dir()


def _request(method, path, body=None, timeout=READ_TIMEOUT):
    return dashboard_api.request(method, path, body, timeout=timeout)


def _spool_path(agent_id):
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in str(agent_id))
    return os.path.join(_store_dir(), ".ledger-spool", safe + ".jsonl")


def _spool(entry):
    """Append one turn to the agent's spool. Bounded: a full spool drops the NEW
    entry (append-only, nothing is rewritten). Never raises."""
    try:
        path = _spool_path(entry["agent_id"])
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        try:
            with open(path) as f:
                if sum(1 for _ in f) >= SPOOL_MAX_ENTRIES:
                    return
        except FileNotFoundError:
            pass
        with open(path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _flush_spool(agent_id):
    """After a successful write: send what an earlier outage left in the spool.
    The file is claimed by renaming it, so a concurrent hook appends to a fresh
    one; on failure the claimed lines are put back. Never raises."""
    path = _spool_path(agent_id)
    claimed = "%s.%d.flushing" % (path, os.getpid())
    try:
        os.replace(path, claimed)
    except Exception:
        return  # nothing spooled (or another hook claimed it)
    try:
        with open(claimed) as f:
            lines = [ln for ln in f.read().split("\n") if ln.strip()]
        entries = []
        for ln in lines:
            try:
                entries.append(json.loads(ln))
            except Exception:
                pass  # a torn line is dropped
        if entries:
            try:
                _request("POST", "/api/conversation-ledger", {"entries": entries}, timeout=WRITE_TIMEOUT)
            except Exception:
                for e in entries:
                    _spool(e)
    finally:
        try:
            os.unlink(claimed)
        except Exception:
            pass


def _write(entry):
    """Send one turn; on failure spool it. Never raises."""
    try:
        _request("POST", "/api/conversation-ledger", entry, timeout=WRITE_TIMEOUT)
    except Exception:
        _spool(entry)
        return
    _flush_spool(entry["agent_id"])


def log_inbound(agent_id, chat_id, message_id, text, ts):
    """Record an inbound user message. Idempotent on (agent_id, chat_id, in, message_id)."""
    _write({
        "agent_id": str(agent_id), "chat_id": str(chat_id), "direction": "in",
        "message_id": str(message_id), "text": text, "ts": ts, "created_at": int(time.time()),
    })


def log_outbound(agent_id, chat_id, text, message_id=None):
    """Record an outbound reply.

    message_id: the Telegram message_id returned by the reply tool, or None.
    When provided, the server deduplicates on the UNIQUE constraint so a
    double-fire of the hook does not produce a duplicate row. When None the
    constraint does not trigger (NULL != NULL in SQL), preserving the existing
    behaviour for callers that do not supply a message_id.
    The write never raises: a duplicate outbound row is harmless, and we never
    want the ledger write to break the reply.
    """
    now = int(time.time())
    _write({
        "agent_id": str(agent_id), "chat_id": str(chat_id), "direction": "out",
        "message_id": str(message_id) if message_id is not None else None, "text": text,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "created_at": now,
    })


def recent(agent_id, limit=RECENT_LIMIT):
    """The last `limit` turns for this agent, oldest-first. Rows: (direction, chat_id, text, ts).
    Raises when the dashboard cannot be reached."""
    path = "/api/conversation-ledger/%s/recent?limit=%d" % (urllib.parse.quote(str(agent_id), safe=""), int(limit))
    data = _request("GET", path)
    return [(t["direction"], t["chat_id"], t["text"], t["ts"]) for t in data["turns"]]


def open_question_with_age(agent_id):
    """The most recent inbound with NO later outbound (the unanswered question),
    or None. Returns (chat_id, message_id, text, ts, created_at). Used by the
    live-drain hook, which needs the age for its grace window. Raises when the
    dashboard cannot be reached."""
    path = "/api/conversation-ledger/%s/open-question" % urllib.parse.quote(str(agent_id), safe="")
    q = _request("GET", path)["open_question"]
    if not q:
        return None
    return (q["chat_id"], q["message_id"], q["text"], q["ts"], q["created_at"])


def open_question(agent_id):
    """Like open_question_with_age() without the age: (chat_id, message_id, text, ts) or None."""
    oq = open_question_with_age(agent_id)
    return oq[:4] if oq else None
