#!/usr/bin/env python3
"""Fleet Blackboard hygiene monitor (deterministic replacement for the LLM heartbeat).

Finds running agents that are ACTIVELY working (tmux pane shows the Claude
Code spinner) but whose Fleet Blackboard row is missing or stale, nudges them
over the inter-agent message queue, and escalates after two consecutive
nudges without improvement.

An agent is LAGGING when it is active on its pane AND one of:
  - it has no blackboard row at all,
  - its row is status done/blocked and older than DONE_GRACE_SECONDS (a row
    that was set to done moments ago is an honest "just finished", not lag),
  - its row is older than STALE_SECONDS.

A second case covers IDLE agents (pane not active) whose row is 'blocked' and
older than BLOCKED_IDLE_SECONDS: nothing else ever cleans a blocked row, so a
finished-but-forgotten block (or a real block nobody was told about) would
sit there forever. Such an agent is nudged with a different text (set done if
the block is gone, message the coordinator if still blocked) and counted and
escalated exactly like a lagging one. An agent gets at most one message per
round: if it is active and blocked, the lagging branch decides.

The coordinator (MAIN_AGENT_ID: env, then .env, then the same "marveen"
fallback src/config.ts uses) is never nudged.

The consecutive-nudge counters live in the SQLite agent_state table
(agent_id=<coordinator>, state_key='blackboard_hygiene_nudges', JSON
{"<agent>": <n>}). A counter is cleared as soon as the agent is fine or idle.
When it reaches ESCALATE_AT the script sends an "[ESZKALACIO] ..." inter-agent
message to the coordinator (who forwards it to the owner; a command task has
no chat tool of its own) and resets the counter.

Usage:
    python3 blackboard-hygiene.py [--dry-run]

--dry-run decides and prints, but sends no message and writes no state.

Exit codes: 0 on a completed sweep (including "nothing lagging"), non-zero
when the agent list or the blackboard cannot be read, or a nudge/escalation
message could not be delivered (so the command-task failThreshold alerting
can notice a broken monitor).
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

DASHBOARD_BASE = os.environ.get("MARVEEN_DASHBOARD_BASE", "http://localhost:3420")
STORE_DIR = os.environ.get("MARVEEN_STORE_DIR") or os.path.join(REPO_ROOT, "store")
DASHBOARD_TOKEN_FILE = os.path.join(STORE_DIR, ".dashboard-token")
DB_PATH = os.path.join(STORE_DIR, "claudeclaw.db")



def _main_agent_id():
    """MAIN_AGENT_ID from env, then REPO_ROOT/.env (parsed, never sourced)."""
    if os.environ.get("MAIN_AGENT_ID"):
        return os.environ["MAIN_AGENT_ID"]
    try:
        with open(os.path.join(REPO_ROOT, ".env"), encoding="utf-8") as f:
            for raw in f:
                key, _, val = raw.strip().partition("=")
                if key.strip() == "MAIN_AGENT_ID" and val.strip():
                    return val.strip().strip('"').strip("'")
    except OSError:
        pass
    return "marveen"


COORDINATOR = _main_agent_id()
STATE_AGENT_ID = COORDINATOR
STATE_KEY = "blackboard_hygiene_nudges"

DONE_GRACE_SECONDS = 15 * 60
STALE_SECONDS = 2 * 60 * 60
BLOCKED_IDLE_SECONDS = 60 * 60
ESCALATE_AT = 2
PANE_LINES = 20

# Two pane signals, OR-ed: the "esc to interrupt" status line is sometimes
# overwritten by tips, and the spinner line ("Verbing... (32m 37s") alone is
# not always on screen either. Same pair scripts/context-compact-monitor.sh uses.
SPINNER_RE = re.compile(r"\w[\w\s]*[…\.]{1,3}\s*\([\dsmh]")
PANE_MARKERS = ("esc to interrupt", "Thinking", "Cogitating")

NUDGE_TEXT = (
    "[blackboard-hygiene] Aktivan dolgozol, de a Fleet Blackboard sorod elavult vagy done. "
    "Frissitsd MOST: POST /api/blackboard status:active + summary arrol, min dolgozol epp. "
    "Ez kotelezo a 3+ tool-hivasos munkanal (CLAUDE.md Fleet Blackboard)."
)

BLOCKED_IDLE_NUDGE_TEXT = (
    "[blackboard-hygiene] A Fleet Blackboard sorod mar legalabb 1 oraja blocked, es nem dolgozol aktivan. "
    "Ha a blokk megszunt es a munka kesz, allitsd done-ra MOST: POST /api/blackboard status:done + rovid summary. "
    "Ha meg blokkolt vagy es mas tud segiteni (restart, auth, dontes), irj inter-agent uzenetet a fo agensnek."
)


def pane_is_active(text):
    """True when a captured pane shows a running turn."""
    return bool(SPINNER_RE.search(text) or any(m in text for m in PANE_MARKERS))


def is_lagging(row, now):
    """Decide lag from a blackboard row (dict with status/updated_at) or None."""
    if row is None:
        return True
    age = now - int(row.get("updated_at") or 0)
    if row.get("status") in ("done", "blocked") and age > DONE_GRACE_SECONDS:
        return True
    return age > STALE_SECONDS


def is_stale_blocked(row, now):
    """True when a blackboard row is 'blocked' and older than BLOCKED_IDLE_SECONDS."""
    if row is None or row.get("status") != "blocked":
        return False
    return now - int(row.get("updated_at") or 0) > BLOCKED_IDLE_SECONDS


def next_counters(counters, lagging):
    """Advance the consecutive-nudge counters after one sweep.

    `lagging` is the agents nudged this round. Every other agent (fine, idle
    or no longer running) is dropped, which is the "reset on improvement"
    rule. Returns (new_counters, escalate_list); escalated agents are reset
    to zero (removed) so the owner is not spammed every round.
    """
    new = {}
    escalate = []
    for agent in sorted(lagging):
        n = int(counters.get(agent, 0)) + 1
        if n >= ESCALATE_AT:
            escalate.append(agent)
        else:
            new[agent] = n
    return new, escalate


def _token():
    with open(DASHBOARD_TOKEN_FILE, encoding="utf-8") as f:
        return f.read().strip()


def _api(path, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        DASHBOARD_BASE + path,
        data=data,
        method="POST" if payload is not None else "GET",
        headers={"Authorization": "Bearer " + _token(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8") or "null")


def running_agents():
    agents = _api("/api/agents")
    return [a["name"] for a in agents if a.get("running") and a["name"] != COORDINATOR]


def capture_pane(agent):
    try:
        out = subprocess.run(
            ["tmux", "capture-pane", "-p", "-t", "agent-" + agent, "-S", "-%d" % PANE_LINES],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout if out.returncode == 0 else ""


def blackboard_row(agent, board):
    """Row from the top-N board listing, else the newest history event.

    GET /api/blackboard only returns the 10 freshest rows, so an agent whose
    row fell off that list would otherwise look like it has no row at all.
    """
    for row in board:
        if row.get("agent_id") == agent:
            return row
    try:
        hist = _api("/api/blackboard/history?agent_id=%s&limit=1" % agent)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    if hist:
        return {"status": hist[0].get("status"), "updated_at": hist[0].get("created_at")}
    return None


def read_counters(conn):
    row = conn.execute(
        "SELECT state_value FROM agent_state WHERE agent_id=? AND state_key=?",
        (STATE_AGENT_ID, STATE_KEY),
    ).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row[0])
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def write_counters(conn, counters):
    conn.execute(
        "INSERT INTO agent_state(agent_id,state_key,state_value,updated_at) VALUES(?,?,?,unixepoch()) "
        "ON CONFLICT(agent_id,state_key) DO UPDATE SET state_value=excluded.state_value, "
        "updated_at=excluded.updated_at",
        (STATE_AGENT_ID, STATE_KEY, json.dumps(counters, sort_keys=True)),
    )
    conn.commit()


def send_message(to, content):
    _api("/api/messages", {"from": COORDINATOR, "to": to, "content": content})


def main(argv):
    dry_run = "--dry-run" in argv
    now = int(time.time())

    try:
        agents = running_agents()
        board = _api("/api/blackboard") or []
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        print("FAIL dashboard read: %s" % exc)
        return 1

    active = [a for a in agents if pane_is_active(capture_pane(a))]
    lagging = [a for a in active if is_lagging(blackboard_row(a, board), now)]
    # Idle agents with a long-standing blocked row. Active agents are excluded
    # here, so nobody gets two messages in one round.
    blocked_idle = [a for a in agents if a not in active and is_stale_blocked(blackboard_row(a, board), now)]
    nudged = lagging + blocked_idle

    # mode=rw/ro: never create an empty DB file if the path is wrong.
    conn = sqlite3.connect("file:%s?mode=%s" % (DB_PATH, "ro" if dry_run else "rw"), uri=True, timeout=10)
    send_failures = 0
    try:
        counters = read_counters(conn)
        new_counters, escalate = next_counters(counters, nudged)

        if not dry_run:
            escalation = {
                a: (
                    "[ESZKALACIO] blackboard-hygiene: %s ket blackboard-hygiene kor ota aktivan dolgozik, "
                    "de nem frissiti a blackboardot a nudge ellenere. Tovabbitsd az ownernek Telegramon." % a
                )
                for a in lagging
            }
            escalation.update(
                {
                    a: (
                        "[ESZKALACIO] blackboard-hygiene (blocked-idle): %s sora ket blackboard-hygiene kor ota "
                        "blocked es az agens tetlen, a nudge ellenere sem frissitette. Lehet, hogy beragadt "
                        "blokk, vagy valaki segitsegere var. Tovabbitsd az ownernek Telegramon." % a
                    )
                    for a in blocked_idle
                }
            )
            outbox = [(a, NUDGE_TEXT) for a in lagging] + [(a, BLOCKED_IDLE_NUDGE_TEXT) for a in blocked_idle] + [
                (COORDINATOR, escalation[a]) for a in escalate
            ]
            for to, content in outbox:
                try:
                    send_message(to, content)
                except (urllib.error.URLError, OSError, ValueError) as exc:
                    send_failures += 1
                    print("WARN message to %s failed: %s" % (to, exc))
            if new_counters != counters:
                write_counters(conn, new_counters)
    finally:
        conn.close()

    print(
        "%s running=%d active=%d lagging=%s blocked_idle=%s escalated=%s"
        % (
            "DRY" if dry_run else "OK",
            len(agents),
            len(active),
            ",".join(lagging) or "-",
            ",".join(blocked_idle) or "-",
            ",".join(escalate) or "-",
        )
    )
    return 1 if send_failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
