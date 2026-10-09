#!/usr/bin/env python3
"""Daily RBAC shadow-log summary (deterministic command task, no LLM).

Reads the last N hours (default 24) of the persisted RBAC gate decisions from
GET /api/v1/rbac/shadow-log?summary=1 and decides:

  exit 0  no would-deny and no denied rows in the window: the shadow
          observation is clean for that day
  exit 1  at least one would-deny / denied row: a possible FALSE POSITIVE of
          the gate (a legitimate non-admin request enforce mode would refuse).
          The first line of stderr is a compact one-line report, which is what
          the command-task alert carries
  exit 2  the summary could not be read (dashboard down, bad token, bad JSON)

Both non-zero exits alert through the command-task health (failThreshold 1);
the alert fires when the failure streak starts and again after a clean day,
so a persistent finding is reported once, not every morning. The full report
goes to stdout for the task log.

An EMPTY window (zero rows of any kind) is also reported on stdout: it means
"no non-admin traffic arrived", which must not be read as "no false positives".

Usage:
    python3 rbac-shadow-summary.py [--hours N]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import agent_token  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

DASHBOARD_BASE = os.environ.get("MARVEEN_DASHBOARD_BASE", "http://localhost:3420")
STORE_DIR = os.environ.get("MARVEEN_STORE_DIR") or os.path.join(REPO_ROOT, "store")
DASHBOARD_TOKEN_FILE = os.path.join(STORE_DIR, ".dashboard-token")

EXIT_CLEAN = 0
EXIT_FINDINGS = 1
EXIT_UNREADABLE = 2

TOP_SHOWN = 5
# The command-task alert keeps only the first ~200 chars of stderr.
ALERT_MAX_CHARS = 190


def fetch_summary(hours):
    # A scheduled report, run for the coordinator: its own admin token, the shared one only if missing.
    auth = agent_token.resolve(store_dir=STORE_DIR, kind=agent_token.KIND_MAIN, shared_file=DASHBOARD_TOKEN_FILE)
    if not auth.token:
        raise OSError("no dashboard token for the coordinator (own token or %s)" % DASHBOARD_TOKEN_FILE)
    req = urllib.request.Request(
        "%s/api/v1/rbac/shadow-log?summary=1&since_hours=%d" % (DASHBOARD_BASE, hours),
        headers=auth.headers(),
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def findings_count(summary):
    """would-deny + denied rows in the window."""
    by = summary.get("by_decision") or {}
    return int(by.get("would-deny", 0)) + int(by.get("denied", 0))


def alert_line(summary, hours):
    """One compact line for the alert: counts plus the single most frequent shape."""
    by = summary.get("by_decision") or {}
    line = "rbac-shadow %dh: %d would-deny, %d denied" % (
        hours, int(by.get("would-deny", 0)), int(by.get("denied", 0)),
    )
    top = (summary.get("top_denials") or [None])[0]
    if top:
        line += "; top: %s %s %s x%d" % (top["method"], top["route"], top["role"], top["count"])
    return line[:ALERT_MAX_CHARS]


def full_report(summary, hours):
    by = summary.get("by_decision") or {}
    lines = [
        "RBAC shadow log, last %d h: %d rows (would-deny %d, denied %d, permitted %d)" % (
            hours, int(summary.get("total", 0)), int(by.get("would-deny", 0)),
            int(by.get("denied", 0)), int(by.get("permitted", 0)),
        )
    ]
    if int(summary.get("total", 0)) == 0:
        lines.append("EMPTY WINDOW: no non-admin traffic reached the gate. This is no evidence about false positives.")
    for d in (summary.get("top_denials") or [])[:TOP_SHOWN]:
        lines.append("  %s %s %s (needs %s) x%d [%s]" % (
            d["method"], d["route"], d["role"], d["permission"], d["count"], d["decision"],
        ))
    for p in (summary.get("denied_principals") or [])[:TOP_SHOWN]:
        lines.append("  caller %s/%s role=%s x%d" % (
            p["principal_kind"], p["principal"] or "-", p["role"], p["count"],
        ))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    args = ap.parse_args(argv)
    if args.hours < 1:
        ap.error("--hours must be >= 1")

    try:
        summary = fetch_summary(args.hours)
    except (urllib.error.URLError, OSError, ValueError) as err:
        print("rbac-shadow: cannot read the summary: %s" % err, file=sys.stderr)
        return EXIT_UNREADABLE

    print(full_report(summary, args.hours))
    if findings_count(summary) > 0:
        print(alert_line(summary, args.hours), file=sys.stderr)
        return EXIT_FINDINGS
    return EXIT_CLEAN


if __name__ == "__main__":
    sys.exit(main())
