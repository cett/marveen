#!/usr/bin/env python3
"""daily-log-summary.py -- the evening daily-log summary, run by the seeded `daily-log-summary` command task.

Usage: python3 scripts/daily-log-summary.py <agent-id> [--date YYYY-MM-DD]

Writes ONE entry, headed "## Napi összefoglaló <date>", to the daily log of <agent-id> (the main agent): what the
install did that day, from the dashboard API only (never the database):
  - memories saved that day (the default tenant), counted per agent with a few excerpts
  - kanban cards created, finished and moved that day (the default tenant)
  - workspace documents written or changed that day (the default tenant)
  - pull requests merged that day (first-parent merge commits of this checkout)
Every quoted text is credential-scrubbed first (scrub() below). A day with none of these still gets a one-line entry: a daily log with a gap could not be told from a broken
writer (that is how the empty log of October 2026 went unnoticed).

It runs once a day: if the log already holds the header for that day the script does nothing, so a manual re-run
or a missed-run catch-up never doubles the entry. No LLM is involved: the summary is a deterministic digest.

Exit codes: 0 written, or skipped because the day already has its summary; 1 a dashboard call failed; 2 usage.

Env: DAILY_LOG_SUMMARY_API   the API wrapper to call (default: agent-api.sh next to this script), for tests.
     DAILY_LOG_SUMMARY_GIT   0 skips the merge list (tests).
"""
import json
import os
import re
import subprocess
import sys
from datetime import date as Date, datetime, timedelta

# TENANT FILTER IS MANDATORY: the dashboard answers this script as the main agent with an admin token, so every
# list it returns can hold other tenants' rows, and nothing but this script keeps them out of the default tenant's
# log. Every NEW data source added below MUST be filtered with in_default_tenant() before it is counted or listed,
# and MUST get a test row of another tenant in daily-log-summary-script.test.ts.

HERE = os.path.dirname(os.path.abspath(__file__))
API = os.environ.get("DAILY_LOG_SUMMARY_API") or os.path.join(HERE, "agent-api.sh")
ROOT = os.path.dirname(HERE)
HEADER = "## Napi összefoglaló"
MAX_LISTED = 8
EXCERPT = 90


class ApiError(Exception):
    pass


def call(method, path, body=None, max_time=120):
    cmd = ["bash", API, "--token", "main", "--max-time", str(max_time), method, path]
    if body is not None:
        cmd.append(json.dumps(body, ensure_ascii=False))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise ApiError("%s %s failed (exit %d): %s" % (method, path, r.returncode, (r.stdout or r.stderr)[:200]))
    try:
        return json.loads(r.stdout) if r.stdout.strip() else None
    except ValueError:
        raise ApiError("%s %s: not JSON: %s" % (method, path, r.stdout[:200]))


def rows(payload, *keys):
    """A list answer, or the list under one of the keys of an envelope."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in keys:
            if isinstance(payload.get(k), list):
                return payload[k]
    return []


# Credential scrub for every piece of text that is quoted into the log (a memory, a card or document title, a merge
# subject). A port of the key shapes of src/otel-scrub.ts (KEY_SCRUBS, SCRUBS, BLOB_SCRUB), plus a PEM block and the
# Hungarian words for password and key. It is a heuristic, like the original; keep the two in step when one changes.
# It runs on the WHOLE text before the text is cut to EXCERPT characters, so a cut never leaves half a secret.
_I = re.IGNORECASE
_SCRUBS = [
    (re.compile(r"-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----.*?(?:-----END [A-Z ]*-----|$)", re.S), "***"),
    (re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}"), "***"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "***"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "***"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"), "***"),
    (re.compile(r"\bxapp-[A-Za-z0-9-]{10,}"), "***"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}"), "***"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "***"),
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://)[^\s/@]+@", _I), r"\1***@"),
    (re.compile(r"\b[^\s/@:]+:[^\s/@]+@"), "***@"),
    (re.compile(r"(\s(?:-u|--user)(?:\s+|=))\S+"), r"\1***"),
    (re.compile(r"\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?\S+", _I), r"\1***"),
    (re.compile(r"\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", _I), r"\1 ***"),
    (re.compile(r"\b((?:pass(?:word|wd)?|jelsz[óo]|token|secret|titok|api[_-]?key|access[_-]?key|kulcs)\s*[:=]\s*)\S+", _I), r"\1***"),
    (re.compile(r"(--?(?:pass(?:word|wd)?|token|secret|api[_-]?key)\s+)\S+", _I), r"\1***"),
    (re.compile(r"/(?:Users|home)/[^/\s]+"), "/~"),
    # a long run of base64-looking characters that mixes letters and digits: a key, a signature, a blob
    (re.compile(r"(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}"), "***"),
]


def scrub(text):
    out = str(text or "")
    for rx, replacement in _SCRUBS:
        out = rx.sub(replacement, out)
    return out


def one_line(text, limit=EXCERPT):
    s = " ".join(scrub(text).split())
    return s if len(s) <= limit else s[: limit - 3] + "..."


def in_default_tenant(row):
    return (row.get("tenant_id") or "default") == "default"


def ts_in(row, field, start, end):
    v = row.get(field)
    return isinstance(v, (int, float)) and start <= v < end


def day_window(day):
    start = datetime(day.year, day.month, day.day)
    end = start + timedelta(days=1)
    return start, end


def merged_prs(start, end):
    if os.environ.get("DAILY_LOG_SUMMARY_GIT") == "0":
        return []
    try:
        r = subprocess.run(
            ["git", "-C", ROOT, "log", "--first-parent", "--merges", "--since", start.strftime("%Y-%m-%d %H:%M:%S"),
             "--until", end.strftime("%Y-%m-%d %H:%M:%S"), "--pretty=%s"],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if r.returncode != 0:
        return []
    return [l.strip() for l in r.stdout.splitlines() if l.strip()]


def build(day, agent):
    start, end = day_window(day)
    s, e = start.timestamp(), end.timestamp()

    memories = [m for m in rows(call("GET", "/api/memories?limit=200&include_docs=0", max_time=180), "memories")
                if in_default_tenant(m) and ts_in(m, "created_at", s, e)]
    cards = [c for c in rows(call("GET", "/api/kanban"), "cards", "items") if in_default_tenant(c)]
    created = [c for c in cards if ts_in(c, "created_at", s, e)]
    done = [c for c in cards if c.get("status") == "done" and ts_in(c, "updated_at", s, e)]
    touched = [c for c in cards if ts_in(c, "updated_at", s, e) and c not in done and c not in created]
    docs = [d for d in rows(call("GET", "/api/workspace?limit=200&meta_only=true"), "items")
            if in_default_tenant(d) and (ts_in(d, "updated_at", s, e) or ts_in(d, "created_at", s, e))]
    merges = merged_prs(start, end)

    lines = ["%s %s" % (HEADER, day.isoformat())]
    if not (memories or created or done or touched or docs or merges):
        lines.append("Nem volt rögzített aktivitás (memória, kanban, munkadokumentum, merge).")
        return "\n".join(lines)

    def section(title, items, fmt):
        if not items:
            return
        lines.append("%s: %d" % (title, len(items)))
        for it in items[:MAX_LISTED]:
            lines.append("- " + fmt(it))
        if len(items) > MAX_LISTED:
            lines.append("- és még %d" % (len(items) - MAX_LISTED))

    if memories:
        per_agent = {}
        for m in memories:
            per_agent[m.get("agent_id") or "?"] = per_agent.get(m.get("agent_id") or "?", 0) + 1
        who = ", ".join("%s %d" % (a, n) for a, n in sorted(per_agent.items(), key=lambda kv: (-kv[1], kv[0])))
        lines.append("Új memória: %d (%s)" % (len(memories), who))
        for m in memories[:MAX_LISTED]:
            lines.append("- [%s] %s" % (m.get("agent_id") or "?", one_line(m.get("content") or m.get("title"))))
        if len(memories) > MAX_LISTED:
            lines.append("- és még %d" % (len(memories) - MAX_LISTED))
    section("Új kanban kártya", created, lambda c: "%s (%s)" % (one_line(c.get("title")), c.get("assignee") or "nincs gazda"))
    section("Lezárt kanban kártya", done, lambda c: "%s (%s)" % (one_line(c.get("title")), c.get("assignee") or "nincs gazda"))
    section("Mozgott kanban kártya", touched, lambda c: "%s -> %s" % (one_line(c.get("title")), c.get("status")))
    section("Munkadokumentum", docs, lambda d: "%s [%s]" % (one_line(d.get("title")), d.get("agent_id") or "?"))
    section("Merge-elt PR", merges, lambda m: one_line(m, 120))
    return "\n".join(lines)


def main(argv):
    args = argv[1:]
    if not args or args[0].startswith("-"):
        sys.stderr.write("usage: daily-log-summary.py <agent-id> [--date YYYY-MM-DD]\n")
        return 2
    agent = args[0]
    day = Date.today()
    if len(args) == 3 and args[1] == "--date":
        try:
            day = Date.fromisoformat(args[2])
        except ValueError:
            sys.stderr.write("daily-log-summary: --date wants YYYY-MM-DD\n")
            return 2
    elif len(args) != 1:
        sys.stderr.write("usage: daily-log-summary.py <agent-id> [--date YYYY-MM-DD]\n")
        return 2

    try:
        existing = rows(call("GET", "/api/daily-log?agent=%s&date=%s" % (agent, day.isoformat())))
        header = "%s %s" % (HEADER, day.isoformat())
        if any(header in str(e.get("content", "")) for e in existing if isinstance(e, dict)):
            print("daily-log-summary: %s already has its summary, nothing to do" % day.isoformat())
            return 0
        content = build(day, agent)
        call("POST", "/api/daily-log", {"agent_id": agent, "content": content})
    except ApiError as err:
        sys.stderr.write("daily-log-summary: %s\n" % err)
        return 1
    print("daily-log-summary: wrote the summary of %s" % day.isoformat())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
