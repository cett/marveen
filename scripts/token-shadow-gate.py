#!/usr/bin/env python3
"""Go-live gate: has the shared dashboard token really gone out of use? (machine-decidable yes/no)

Reads the Phase T2 shadow counter (GET /api/v1/token-shadow, admin-only) over a measurement window and
decides PASS / FAIL / INCONCLUSIVE, so the shared token can be rotated (and the RLS cutover can start)
on evidence instead of on a feeling. A count of zero is only evidence if the counter is alive and every
caller had its chance to run, which is why the gate has more to say than "zero rows".

  exit 0  PASS          nothing blocking, and the window is conclusive
  exit 1  FAIL          blocking rows exist (listed, with the last hit: the window restarts after it)
  exit 2  INCONCLUSIVE  the window, the coverage, the canary or the measurement itself cannot support a
                        "zero"; or the dashboard / token could not be reached. NEVER a PASS.

Window. --window-start is the first UTC day of the clock (the first 00:00 UTC after the last deploy +
restart that touched a call path; the deploy day itself is excluded because its row mixes before and
after). The window is that day .. today, and needs 7 FULL days plus today (8 days) to be conclusive.

Blocking (FAIL):
  G1  shared_token_use rows that no exception below explains
  G2  agent_id_mismatch / foreign_row_access / missing_tenant_context / shared_agent_memories_no_tenant
      rows of any kind (no exceptions: the main agent is by construction never their caller)
Reported but not blocking: fleet_skill_write_denied (each row to be explained: a delegation that was
skipped), unscoped_read (informational: the RLS context is a different topic), shared_token_refused
(after the rotation: a process that still holds the old token; its 401 is unchanged, the rows name the
straggler for the 7-day follow-up).

No actor is excused on the shared token: the main agent and the dashboard's own page both hold their
own tokens now, so a shared_token_use row of any caller blocks. The one exception is the gate's own
canary (E3).

Inconclusive (exit 2) unless satisfied:
  W   the window is at least 8 days
  C2a every enabled schedule that runs at most weekly has run since the window started
  C2b every enabled monthly-or-rarer schedule has been run by hand in the window (lastRunAt, or
      --manual-run NAME) AND its recipe dry-run is attested clean (--dry-run-clean NAME); a disabled
      monthly-or-rarer schedule needs only --dry-run-clean NAME
  C2c --uptime-confirmed: the dashboard did not stand still for more than 24 h on any window day (the
      counter cannot see its own downtime, so this is the operator's confirmation)
  C3  the canary: ONE deliberate shared-token call with X-Agent-Id: gate-canary at the start of the
      run, after which today's shared_token_use / gate-canary count must have grown by at least 1
  G5  no _overflow / _invalid rows, and no category query reached the row limit

Usage:
    python3 token-shadow-gate.py --window-start 2026-10-14 [--json] [--main-agent ID]
        [--manual-run NAME]... [--dry-run-clean NAME]... [--uptime-confirmed]
"""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import agent_token  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
DASHBOARD_BASE = os.environ.get("MARVEEN_DASHBOARD_BASE", "http://localhost:3420")
STORE_DIR = os.environ.get("MARVEEN_STORE_DIR") or os.path.join(REPO_ROOT, "store")

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_INCONCLUSIVE = 2

CANARY = "gate-canary"
ROW_LIMIT = 1000  # the endpoint's maximum; it has no offset, so a category that reaches it is cut off
MIN_WINDOW_DAYS = 8  # 7 full UTC days + today
MAX_WINDOW_DAYS = 90  # the endpoint's retention

SHARED = "shared_token_use"
BLOCKING_ALWAYS = (
    "agent_id_mismatch",
    "foreign_row_access",
    "missing_tenant_context",
    "shared_agent_memories_no_tenant",
)
EXPLAIN = "fleet_skill_write_denied"
INFO = "unscoped_read"
REFUSED = "shared_token_refused"  # the old shared token knocked AFTER the rotation; reported for the 7-day follow-up
CATEGORIES = (SHARED,) + BLOCKING_ALWAYS + (EXPLAIN, INFO, REFUSED)
MARKERS = ("_overflow", "_invalid")


# --- the exceptions to G1: ONE place, each with its reason and when it should go -------------------
# A row of shared_token_use is excused by the first entry whose match() accepts it. Nothing else is.
# E1 (the main agent on its own authority) and E2 (an enrolled browser with no caller) are gone: they
# expired with the shared-token retirement (the three resolvers have no shared fallback any more and
# every browser holds its own enrolled token), so a main-agent or browser row on the shared token now
# blocks like any other.
def _is_canary(row, ctx):
    return row.get("caller") == CANARY


EXCEPTIONS = (
    {
        "id": "E3",
        "reason": "this gate's own canary call",
        "expires": "never (the canary is how the gate proves the counter is alive)",
        "match": _is_canary,
    },
)


def is_marker_row(row):
    return any(row.get(f) in MARKERS for f in ("route", "caller", "target"))


def split_shared_rows(rows, ctx):
    """-> (blocking rows, {exception id: [rows]}) for the shared_token_use rows."""
    blocking, excused = [], {}
    for row in rows:
        for exc in EXCEPTIONS:
            if exc["match"](row, ctx):
                excused.setdefault(exc["id"], []).append(row)
                break
        else:
            blocking.append(row)
    return blocking, excused


def cron_is_rare(expr):
    """True for a schedule that runs less often than weekly: a day-of-month or month field is set."""
    fields = str(expr or "").split()
    if len(fields) < 5:
        return True  # unreadable: treat as the stricter class
    return fields[2] != "*" or fields[3] != "*"


def utc_day(d):
    return d.strftime("%Y-%m-%d")


def parse_day(text):
    return datetime.datetime.strptime(text, "%Y-%m-%d").date()


def window_days(window_start, today):
    return (today - window_start).days + 1


def schedule_findings(schedules, window_start, manual_run, dry_run_clean):
    """C2a/C2b -> list of human-readable reasons the schedule coverage is not complete."""
    since_ms = int(datetime.datetime.combine(window_start, datetime.time.min, tzinfo=datetime.timezone.utc).timestamp() * 1000)
    reasons = []
    for s in schedules:
        name, rare, enabled = s.get("name"), cron_is_rare(s.get("schedule")), bool(s.get("enabled"))
        ran = (s.get("lastRunAt") or 0) >= since_ms
        if enabled and not rare and not ran:
            reasons.append("C2a: schedule '%s' (%s) has not run since the window started" % (name, s.get("schedule")))
        elif enabled and rare:
            if not (ran or name in manual_run):
                reasons.append("C2b: monthly-or-rarer schedule '%s' (%s) needs one manual run inside the window" % (name, s.get("schedule")))
            if name not in dry_run_clean:
                reasons.append("C2b: monthly-or-rarer schedule '%s' needs its recipe dry-run attested clean (--dry-run-clean %s)" % (name, name))
        elif not enabled and rare and name not in dry_run_clean:
            reasons.append("C2b: disabled monthly-or-rarer schedule '%s' needs its recipe dry-run attested clean (--dry-run-clean %s)" % (name, name))
    return reasons


def evaluate(rows_by_category, truncated, canary, schedules, args, today, main_agent):
    """Pure decision. rows_by_category: {category: [rows]} (already limited to the window days);
    truncated: categories whose query reached the row limit; canary: True / False / None (not made).
    -> dict with state, exit_code, blocking, excused, explain, info, reasons."""
    ctx = {"main_agent": main_agent}
    days = window_days(args["window_start"], today)

    blocking = []
    excused = {}
    shared_blocking, excused = split_shared_rows(rows_by_category.get(SHARED, []), ctx)
    blocking.extend(shared_blocking)
    for cat in BLOCKING_ALWAYS:
        blocking.extend(rows_by_category.get(cat, []))

    reasons = []
    if days < MIN_WINDOW_DAYS:
        reasons.append("W: the window is %d day(s); it needs 7 full UTC days plus today (%d)" % (days, MIN_WINDOW_DAYS))
    if days > MAX_WINDOW_DAYS:
        reasons.append("W: the window is %d days; the counter keeps %d" % (days, MAX_WINDOW_DAYS))
    reasons.extend(schedule_findings(schedules, args["window_start"], set(args["manual_run"]), set(args["dry_run_clean"])))
    if not args["uptime_confirmed"]:
        reasons.append("C2c: the dashboard's uptime on every window day is not confirmed (--uptime-confirmed)")
    if canary is None:
        reasons.append("C3: the canary call could not be made, so a zero would prove nothing")
    elif canary is False:
        reasons.append("C3: the canary call did not move the counter (shared_token_use / %s did not grow): the counter may be dead" % CANARY)
    for cat in sorted(truncated):
        reasons.append("G5: the %s query reached the row limit (%d); narrow it with a caller or route filter" % (cat, ROW_LIMIT))
    marked = [r for rows in rows_by_category.values() for r in rows if is_marker_row(r)]
    if marked:
        reasons.append("G5: %d row(s) carry an _overflow / _invalid marker, so the counter dropped or rejected shapes" % len(marked))

    if blocking:
        state, code = "FAIL", EXIT_FAIL
    elif reasons:
        state, code = "INCONCLUSIVE", EXIT_INCONCLUSIVE
    else:
        state, code = "PASS", EXIT_PASS
    return {
        "state": state,
        "exit_code": code,
        "window_start": utc_day(args["window_start"]),
        "today": utc_day(today),
        "days": days,
        "main_agent": main_agent,
        "blocking": blocking,
        "excused": excused,
        "explain": rows_by_category.get(EXPLAIN, []),
        "info": rows_by_category.get(INFO, []),
        "refused": rows_by_category.get(REFUSED, []),
        "reasons": reasons,
    }


# --- talking to the dashboard ---------------------------------------------------------------------
def _get(path, headers):
    req = urllib.request.Request(DASHBOARD_BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def reader_headers():
    """The operator's own admin token (the coordinator's as the second choice). The shared token is
    refused here: the gate's reads would then show up in the very counter it is judging."""
    for kind in (agent_token.KIND_OPERATOR, agent_token.KIND_MAIN):
        auth = agent_token.resolve(store_dir=STORE_DIR, kind=kind)
        if auth.token and auth.source in (agent_token.SOURCE_OPERATOR, agent_token.SOURCE_AGENT):
            return auth.headers()
    raise OSError("no own admin token (store/.operator-token or the coordinator's token file); the gate does not read through the shared token")


def canary_headers():
    # The one deliberate shared-token call of the gate (see agent_token.canary_shared_token): resolve()
    # never hands the shared token out. After a rotation the file is a different token or gone.
    token = agent_token.canary_shared_token(store_dir=STORE_DIR)
    if not token:
        return None
    return agent_token.Resolved(token, "shared-canary", CANARY).headers()


def fetch_category(headers, category, days, caller=None):
    qs = "days=%d&category=%s&limit=%d" % (days, category, ROW_LIMIT)
    if caller:
        qs += "&caller=%s" % caller
    return _get("/api/v1/token-shadow?" + qs, headers)


def canary_total(headers, today):
    """Today's shared_token_use count of the canary caller."""
    data = fetch_category(headers, SHARED, 1, caller=CANARY)
    return sum(int(r.get("count", 0)) for r in data.get("rows", []) if r.get("day") == utc_day(today))


def run_canary(headers, today, wait_s=5.0):
    """One shared-token call as the canary, then poll the counter. -> True / False / None (not made)."""
    shared = canary_headers()
    if shared is None:
        return None
    before = canary_total(headers, today)
    try:
        _get("/api/agents", shared)
    except urllib.error.HTTPError:
        pass  # a refusal (401 after a rotation) is not the question; whether it counted is
    deadline = time.time() + wait_s
    while True:
        if canary_total(headers, today) >= before + 1:
            return True
        if time.time() >= deadline:
            return False
        time.sleep(0.5)


def gather(headers, window_start, today):
    days = min(max(window_days(window_start, today), 1), MAX_WINDOW_DAYS)
    first = utc_day(window_start)
    rows_by_category, truncated = {}, set()
    for cat in CATEGORIES:
        data = fetch_category(headers, cat, days)
        rows = [r for r in data.get("rows", []) if str(r.get("day", "")) >= first]
        rows_by_category[cat] = rows
        if len(data.get("rows", [])) >= ROW_LIMIT:
            truncated.add(cat)
    return rows_by_category, truncated


# --- output ---------------------------------------------------------------------------------------
def _iso(ts):
    try:
        return datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    except (TypeError, ValueError, OSError):
        return "-"


def _row_line(r):
    return "  %-34s %-14s %-13s %-8s %-34s %5s  %s" % (
        r.get("category", ""), r.get("caller") or "-", r.get("caller_source") or "-", r.get("client") or "-",
        (r.get("method", "") + " " + r.get("route", "")).strip(), r.get("count", 0), _iso(r.get("last_ts")),
    )


def restart_hint(blocking):
    latest = max((int(r.get("last_ts") or 0) for r in blocking), default=0)
    if not latest:
        return None
    last_day = datetime.datetime.fromtimestamp(latest, datetime.timezone.utc).date()
    return "latest blocking hit %s; the window restarts at 00:00 UTC after it (--window-start %s)" % (
        _iso(latest), utc_day(last_day + datetime.timedelta(days=1)))


def render(result):
    out = []
    out.append("token-shadow-gate: %s  (window %s .. %s, %d day(s), main agent '%s')" % (
        result["state"], result["window_start"], result["today"], result["days"], result["main_agent"] or "?"))
    if result["blocking"]:
        out.append("")
        out.append("BLOCKING rows (%d):" % len(result["blocking"]))
        out.extend(_row_line(r) for r in result["blocking"])
        hint = restart_hint(result["blocking"])
        if hint:
            out.append("  " + hint)
    for exc in EXCEPTIONS:
        rows = result["excused"].get(exc["id"])
        if rows:
            out.append("")
            out.append("%s excused %d row(s) (%s). Expires: %s" % (exc["id"], len(rows), exc["reason"], exc["expires"]))
            out.extend(_row_line(r) for r in rows)
    if result["explain"]:
        out.append("")
        out.append("fleet_skill_write_denied (each needs an explanation: a delegation that was skipped):")
        out.extend(_row_line(r) for r in result["explain"])
    if result["info"]:
        out.append("")
        out.append("unscoped_read (informational, not part of this gate): %d row(s)" % len(result["info"]))
    if result["refused"]:
        out.append("")
        out.append("shared_token_refused (reported, not blocking: a straggler still holds the rotated-away token): %d row(s)" % len(result["refused"]))
        out.extend(_row_line(r) for r in result["refused"])
    if result["reasons"]:
        out.append("")
        out.append("NOT CONCLUSIVE because:")
        out.extend("  - " + r for r in result["reasons"])
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Token shadow counter go-live gate")
    ap.add_argument("--window-start", required=True, help="first UTC day of the measurement clock, YYYY-MM-DD")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--main-agent", default=None, help="the main agent id (default: MAIN_AGENT_ID of the install)")
    ap.add_argument("--manual-run", action="append", default=[], metavar="NAME")
    ap.add_argument("--dry-run-clean", action="append", default=[], metavar="NAME")
    ap.add_argument("--uptime-confirmed", action="store_true")
    ns = ap.parse_args(argv)
    try:
        window_start = parse_day(ns.window_start)
    except ValueError:
        ap.error("--window-start must be a YYYY-MM-DD date")

    today = datetime.datetime.now(datetime.timezone.utc).date()
    if window_start > today:
        ap.error("--window-start is in the future")
    main_agent = ns.main_agent or agent_token.main_agent_id() or ""
    args = {
        "window_start": window_start,
        "manual_run": ns.manual_run,
        "dry_run_clean": ns.dry_run_clean,
        "uptime_confirmed": ns.uptime_confirmed,
    }

    try:
        headers = reader_headers()
        canary = run_canary(headers, today)
        rows_by_category, truncated = gather(headers, window_start, today)
        schedules = _get("/api/schedules", headers)
    except (OSError, ValueError) as e:  # URLError and HTTPError are OSErrors; ValueError = bad JSON
        sys.stderr.write("token-shadow-gate: INCONCLUSIVE, could not read the dashboard: %s\n" % e)
        return EXIT_INCONCLUSIVE

    result = evaluate(rows_by_category, truncated, canary, schedules if isinstance(schedules, list) else [], args, today, main_agent)
    if ns.json:
        slim = dict(result)
        slim["excused"] = {k: v for k, v in result["excused"].items()}
        print(json.dumps(slim, indent=2, sort_keys=True))
    else:
        print(render(result))
    return result["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
