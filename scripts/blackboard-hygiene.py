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

Three guards keep an idle agent from being flagged for its own maintenance
turns (a long-idle agent has a days-old done row, and any turn at all makes
its pane look active):
  - Maintenance attribution: an active agent whose newest delivered incoming
    message is a coordinator-sent "[memoria-heartbeat]" / "[blackboard-hygiene]"
    message younger than MAINT_WINDOW_SECONDS is running a maintenance turn,
    not real work, and is not lagging. The sender must be the coordinator, or
    anyone could silence the monitor with a prefixed message. A turn that
    outlives the window counts as real work again (accepted delay: up to the
    window plus one tick for work that starts right after a heartbeat).
  - Nudge cooldown: no new nudge while the previous one is still queued
    (status pending) or is younger than NUDGE_COOLDOWN_SECONDS with no
    blackboard update since. A held agent keeps its counter (neither raised
    nor reset), so queued nudges are never counted as separate rounds.
    "Processed" is approximated by status != pending: only the receiving
    agent can mark a message done, so a done flag is too soft to gate on.
  - Wake guard: the time of the last completed sweep is kept in agent_state.
    When more than WAKE_GUARD_SECONDS passed since (the monitor is hourly, so
    the threshold must stay above 60 minutes or every tick would be skipped),
    the machine was most likely asleep; that round sends nothing and changes
    no counter, it only records the time, so it can swallow one tick at most.
Escalation is therefore slower than two hourly ticks: at least one cooldown
between two counted nudges, longer after a sleep.

The consecutive-nudge counters live in the dashboard's agent_state store
(agent_id=<coordinator>, state_key='blackboard_hygiene_nudges', JSON
{"<agent>": <n>}), read and written through /api/agent-state. A counter is cleared as soon as the agent is fine or idle.
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
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

DASHBOARD_BASE = os.environ.get("MARVEEN_DASHBOARD_BASE", "http://localhost:3420")
STORE_DIR = os.environ.get("MARVEEN_STORE_DIR") or os.path.join(REPO_ROOT, "store")
DASHBOARD_TOKEN_FILE = os.path.join(STORE_DIR, ".dashboard-token")

sys.path.insert(0, os.path.join(SCRIPT_DIR, "hooks"))
import agent_token  # noqa: E402



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
LAST_SWEEP_KEY = "blackboard_hygiene_last_sweep"

DONE_GRACE_SECONDS = 15 * 60
STALE_SECONDS = 2 * 60 * 60
BLOCKED_IDLE_SECONDS = 60 * 60
ESCALATE_AT = 2
MAINT_WINDOW_SECONDS = 15 * 60
NUDGE_COOLDOWN_SECONDS = 30 * 60
WAKE_GUARD_SECONDS = 75 * 60
# A queued (pending) nudge holds the next one back only this long, so a stuck
# message queue cannot silence the monitor for good.
PENDING_NUDGE_HOLD_SECONDS = STALE_SECONDS
PANE_LINES = 20

# Two pane signals, OR-ed: the "esc to interrupt" status line is sometimes
# overwritten by tips, and the spinner line ("Verbing... (32m 37s") alone is
# not always on screen either. Same pair scripts/context-compact-monitor.sh uses.
SPINNER_RE = re.compile(r"\w[\w\s]*[…\.]{1,3}\s*\([\dsmh]")
PANE_MARKERS = ("esc to interrupt", "Thinking", "Cogitating")

# Every message the coordinator sends on a schedule starts with one of these
# (fleet-heartbeat-sweep.sh DIRECTIVE, NUDGE_TEXT below); a contract test keeps
# the sweep script's prefix and this tuple in step.
MAINTENANCE_PREFIXES = ("[memoria-heartbeat]", "[blackboard-hygiene]")

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


def is_maintenance_active(latest_incoming, now):
    """True when the agent's current turn was started by coordinator maintenance.

    `latest_incoming` is the newest delivered message addressed to the agent
    (dict with from_agent / content / ts) or None. Only the newest one counts:
    a later message from anyone else is real work and ends the exemption.
    """
    if not latest_incoming:
        return False
    if latest_incoming.get("from_agent") != COORDINATOR:
        return False
    if not str(latest_incoming.get("content") or "").lstrip().startswith(MAINTENANCE_PREFIXES):
        return False
    return now - int(latest_incoming.get("ts") or 0) < MAINT_WINDOW_SECONDS


def nudge_on_hold(last_nudge, row, now):
    """True when a fresh nudge would only pile on top of the previous one.

    `last_nudge` is the newest hygiene message sent to the agent (dict with
    status / ts) or None; `row` is the agent's blackboard row or None.
    """
    if not last_nudge:
        return False
    age = now - int(last_nudge.get("ts") or 0)
    if last_nudge.get("status") == "pending" and age < PENDING_NUDGE_HOLD_SECONDS:
        return True
    updated_since = row is not None and int(row.get("updated_at") or 0) > int(last_nudge.get("ts") or 0)
    return age < NUDGE_COOLDOWN_SECONDS and not updated_since


def is_wake_gap(last_sweep, now):
    """True when the previous sweep is old enough to suspect a sleeping machine."""
    return last_sweep is not None and now - last_sweep > WAKE_GUARD_SECONDS


def is_stale_blocked(row, now):
    """True when a blackboard row is 'blocked' and older than BLOCKED_IDLE_SECONDS."""
    if row is None or row.get("status") != "blocked":
        return False
    return now - int(row.get("updated_at") or 0) > BLOCKED_IDLE_SECONDS


def next_counters(counters, lagging, held=()):
    """Advance the consecutive-nudge counters after one sweep.

    `lagging` is the agents nudged this round. `held` is agents that would be
    lagging but were suppressed this round (maintenance turn, nudge cooldown):
    their counter is carried over unchanged. Every other agent (fine, idle
    or no longer running) is dropped, which is the "reset on improvement"
    rule. Returns (new_counters, escalate_list); escalated agents are reset
    to zero (removed) so the owner is not spammed every round.
    """
    new = {a: int(counters[a]) for a in held if a in counters and a not in lagging}
    escalate = []
    for agent in sorted(lagging):
        n = int(counters.get(agent, 0)) + 1
        if n >= ESCALATE_AT:
            escalate.append(agent)
        else:
            new[agent] = n
    return new, escalate


def _auth_headers():
    """The coordinator's own admin token (X-Agent-Id names it); the shared token only when that
    file is missing. Raises when there is no token at all, as the old file read did."""
    auth = agent_token.resolve(agent_id=COORDINATOR, store_dir=STORE_DIR)
    if not auth.token:
        raise FileNotFoundError("no dashboard token for %s (own token or %s)" % (COORDINATOR, DASHBOARD_TOKEN_FILE))
    return auth.headers({"Content-Type": "application/json"})


def _api(path, payload=None, method=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        DASHBOARD_BASE + path,
        data=data,
        method=method or ("POST" if payload is not None else "GET"),
        headers=_auth_headers(),
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


def _state_path(key):
    return "/api/agent-state/%s/%s" % (urllib.parse.quote(STATE_AGENT_ID, safe=""), key)


def _state_get(key):
    """Stored value for the key, None when nothing was written yet.

    Any other failure (dashboard down, auth) propagates: reading "no counters"
    on an outage would let the next write wipe the real ones.
    """
    try:
        return _api(_state_path(key))["value"]
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def _state_put(key, value):
    _api(_state_path(key), {"value": value}, method="PUT")


def read_counters():
    data = _state_get(STATE_KEY)
    return data if isinstance(data, dict) else {}


def write_counters(counters):
    _state_put(STATE_KEY, counters)


def read_last_sweep():
    value = _state_get(LAST_SWEEP_KEY)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def write_last_sweep(now):
    _state_put(LAST_SWEEP_KEY, int(now))


# GET /api/messages?agent=X returns the agent's newest messages in both
# directions; the cap is the endpoint's maximum. Only the last two hours
# matter to the hold logic below, so a mailbox busier than that errs towards
# one extra nudge, never towards silence.
MESSAGE_WINDOW = 200


def agent_messages(agent):
    return _api("/api/messages?agent=%s&limit=%d" % (urllib.parse.quote(agent, safe=""), MESSAGE_WINDOW)) or []


def latest_incoming(messages, agent):
    """Newest delivered/done message addressed to the agent, stamped with its delivery time."""
    best = None
    for m in messages:
        if m.get("to_agent") != agent or m.get("status") not in ("delivered", "done"):
            continue
        ts = m.get("delivered_at") or m.get("created_at")
        if ts is None:
            continue
        key = (ts, m.get("id") or 0)
        if best is None or key > best[0]:
            best = (key, {"from_agent": m.get("from_agent"), "content": m.get("content"), "ts": ts})
    return best[1] if best else None


def latest_nudge(messages, agent):
    """Newest hygiene message the coordinator sent to the agent (any non-failed status)."""
    prefix = "[blackboard-hygiene]"
    best = None
    for m in messages:
        if (
            m.get("from_agent") != COORDINATOR
            or m.get("to_agent") != agent
            or not (m.get("content") or "").startswith(prefix)
            or m.get("status") == "failed"
        ):
            continue
        key = (m.get("created_at") or 0, m.get("id") or 0)
        if best is None or key > best[0]:
            best = (key, {"status": m.get("status"), "ts": m.get("created_at")})
    return best[1] if best else None


def send_message(to, content):
    _api("/api/messages", {"from": COORDINATOR, "to": to, "content": content})


def main(argv):
    dry_run = "--dry-run" in argv
    now = int(time.time())

    try:
        agents = running_agents()
        board = _api("/api/blackboard") or []
        last_sweep = read_last_sweep()
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        print("FAIL dashboard read: %s" % exc)
        return 1

    send_failures = 0
    if is_wake_gap(last_sweep, now):
        if not dry_run:
            try:
                write_last_sweep(now)
            except (urllib.error.URLError, OSError, ValueError) as exc:
                print("FAIL state write: %s" % exc)
                return 1
        print("%s wake-guard: previous sweep older than %d min, skipped this round" % (
            "DRY" if dry_run else "OK", WAKE_GUARD_SECONDS // 60))
        return 0

    # Decide first, write afterwards: a read failure in the middle leaves the
    # counters and the messages untouched.
    try:
        active = [a for a in agents if pane_is_active(capture_pane(a))]
        rows = {a: blackboard_row(a, board) for a in agents}
        behind = [a for a in active if is_lagging(rows[a], now)]
        lagging, held = [], []
        for a in behind:
            messages = agent_messages(a)
            if is_maintenance_active(latest_incoming(messages, a), now) or nudge_on_hold(latest_nudge(messages, a), rows[a], now):
                held.append(a)
            else:
                lagging.append(a)
        # Idle agents with a long-standing blocked row. Active agents are excluded
        # here, so nobody gets two messages in one round.
        blocked_idle = [a for a in agents if a not in active and is_stale_blocked(rows[a], now)]
        nudged = lagging + blocked_idle

        counters = read_counters()
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        print("FAIL dashboard read: %s" % exc)
        return 1
    new_counters, escalate = next_counters(counters, nudged, held)

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
        try:
            if new_counters != counters:
                write_counters(new_counters)
            write_last_sweep(now)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            print("FAIL state write: %s" % exc)
            return 1

    print(
        "%s running=%d active=%d lagging=%s held=%s blocked_idle=%s escalated=%s"
        % (
            "DRY" if dry_run else "OK",
            len(agents),
            len(active),
            ",".join(lagging) or "-",
            ",".join(held) or "-",
            ",".join(blocked_idle) or "-",
            ",".join(escalate) or "-",
        )
    )
    return 1 if send_failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
